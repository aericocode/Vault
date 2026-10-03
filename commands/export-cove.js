/**
 * Move a Vault library's metadata into Cove.
 *
 *   node vault.js export-cove --cove http://127.0.0.1:5073 [--apply]
 *       [--map "D:\Media=/media"]... [--resume] [--report out.json] [--limit N]
 *
 * Cove has already scanned the same files; this command finds each Vault item
 * in Cove (by path, see lib/cove/mapping.js matchItems) and copies over what
 * Vault knows that Cove does not: the AI tags and descriptions, the AI
 * metadata as custom fields, notes, star ratings, favorites and collections.
 * Every item is stamped with custom field `vault_id`, which is how a re-run
 * (and the later Cove extensions that port Vault's AI features) find their
 * way back to the Vault record.
 *
 * DRY RUN BY DEFAULT. Without --apply every read, match and plan runs, the
 * summary and report are written, and Cove gets nothing but GET requests (the
 * client is built read-only and refuses anything else). --apply sends the
 * writes.
 *
 * ADDITIVE AND IDEMPOTENT. Nothing in Cove is deleted, cleared or replaced:
 * tags are added to what an item has, details and custom fields are only
 * filled where Cove's are empty, a rating only where Cove has none, favorites
 * only switched on, collection items only appended. A second run against the
 * same Cove finds nothing left to do and sends no writes.
 *
 * THE VAULT LIBRARY IS ONLY READ. It is opened read-only, never through
 * lib/database.js (that opens read-write and runs migrations). A leftover
 * `<db>-journal` (a write that never finished) means the file may be
 * mid-transaction: we refuse and leave every file exactly as it is. Vault
 * itself rolls the journal back correctly the next time it opens.
 *
 * Token: env COVE_TOKEN only (never a flag, so it stays out of shell history),
 * and only needed when Cove has login turned on. With login off (Cove's
 * default) a local request without one is treated as Cove's owner.
 * Encrypted library: VAULT_DB_PASSWORD, the same variable Vault reads.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { isLoopback } = require('../lib/net');
const { CoveClient, pool } = require('../lib/cove/client');
const M = require('../lib/cove/mapping');

const KINDS = ['video', 'image', 'audio'];
const CONCURRENCY = 4;
const HOT_JOURNAL_MSG = 'Vault is running or did not close cleanly. Close Vault (or open and close it once), then run this again.';
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/** Media columns this command reads. Missing ones (older libraries) read as NULL. */
const VAULT_COLUMNS = ['id', 'filepath', 'filename', 'media_type', 'filesize_bytes', 'duration_seconds',
  'language', 'themes', 'explicit', 'locations', 'quality_flag', 'description', 'tags', 'content_type',
  'media_elements', 'processed_at', 'user_notes', 'user_starred', 'user_rating', 'user_trashed', 'last_position'];

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

// ---------------------------------------------------------------------------
// Reading Vault (read-only)
// ---------------------------------------------------------------------------

/**
 * The SQLite build, loaded exactly like lib/database.js does (packaged exe:
 * runtime/node_modules beside the exe) but without requiring database.js,
 * whose module scope is shared with code that opens the library read-write.
 */
function loadSqlite() {
  const { createRequire } = require('module');
  const { ROOT, isSea } = require('../lib/approot');
  const nativeRequire = isSea ? createRequire(path.join(ROOT, 'runtime', 'index.js')) : createRequire(__filename);
  try {
    return { Database: nativeRequire('better-sqlite3-multiple-ciphers'), hasCipher: true };
  } catch {
    return { Database: nativeRequire('better-sqlite3'), hasCipher: false };
  }
}

/**
 * Open the library read-only. Refuses (touching nothing) when a -journal sits
 * next to it. Encryption is read from the file header with plain fs, so a
 * locked library without a password is refused before SQLite sees it.
 */
function openVaultReadOnly(dbPath, password) {
  if (!dbPath || !fs.existsSync(dbPath)) throw fail(`No Vault library found at ${dbPath}.`, 'NO_DB');
  if (fs.existsSync(dbPath + '-journal')) throw fail(HOT_JOURNAL_MSG, 'HOT_JOURNAL');

  const header = Buffer.alloc(16);
  const fd = fs.openSync(dbPath, 'r');
  let n;
  try { n = fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (n < 16) throw fail(`${dbPath} is not a Vault library (the file is empty or cut short).`, 'NOT_A_DB');
  const encrypted = !header.equals(SQLITE_MAGIC);

  const { Database, hasCipher } = loadSqlite();
  if (encrypted && !password) {
    throw fail('This library is encrypted. Set VAULT_DB_PASSWORD to its password and run this again.', 'DB_ENCRYPTED');
  }
  if (encrypted && !hasCipher) {
    throw fail('This library is encrypted, but the encrypted-SQLite module (better-sqlite3-multiple-ciphers) is not installed.', 'VAULT_NO_CIPHER');
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (encrypted) db.pragma(`key='${String(password).replace(/'/g, "''")}'`);
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (err) {
    try { db.close(); } catch {}
    if (err && err.code === 'SQLITE_READONLY_ROLLBACK') throw fail(HOT_JOURNAL_MSG, 'HOT_JOURNAL');
    throw fail(encrypted ? 'The library password is wrong (VAULT_DB_PASSWORD).' : `Could not read ${dbPath}: ${err.message}`, 'DB_ENCRYPTED');
  }
  return { db, encrypted };
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
}

/** Everything the export needs from the library, read in one go; the connection is closed before Cove is contacted. */
function readVault(dbPath, password) {
  const { db, encrypted } = openVaultReadOnly(dbPath, password);
  try {
    const cols = tableColumns(db, 'media');
    if (!cols.has('id') || !cols.has('filepath')) throw fail(`${dbPath} does not look like a Vault library.`, 'NOT_A_DB');
    const select = VAULT_COLUMNS.map(c => (cols.has(c) ? c : `NULL AS ${c}`)).join(', ');
    const all = db.prepare(`SELECT ${select} FROM media ORDER BY id`).all();

    let collections = [];
    let collectionItems = [];
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
    if (tables.has('collections') && tables.has('collection_items')) {
      const cc = tableColumns(db, 'collections');
      collections = db.prepare(`SELECT id, name, ${cc.has('parent_id') ? 'parent_id' : 'NULL AS parent_id'},
        ${cc.has('kind') ? 'kind' : "'collection' AS kind"} FROM collections ORDER BY id`).all();
      collectionItems = db.prepare('SELECT collection_id, media_id, position FROM collection_items ORDER BY collection_id, position, media_id').all();
    }

    // What stays behind, for the report.
    const count = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
    const notCarried = {
      savedSearches: tables.has('saved_searches') ? count('SELECT count(*) AS n FROM saved_searches') : 0,
      embeddings: cols.has('embedding') ? count('SELECT count(*) AS n FROM media WHERE embedding IS NOT NULL') : 0,
      gameSaves: tables.has('game_saves') ? count('SELECT count(*) AS n FROM game_saves') : 0,
      subtitleTracks: tables.has('subtitle_tracks') ? count('SELECT count(*) AS n FROM subtitle_tracks') : 0,
      songMatches: tables.has('media_songs') ? count('SELECT count(*) AS n FROM media_songs') : 0,
    };
    return { all, collections, collectionItems, notCarried, encrypted };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

function timestamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const errMsg = (e) => (e && e.message ? e.message : String(e));

/**
 * Run the export. Returns { summary, report }. Throws (before any write) on
 * anything that makes the whole run pointless: no token, unreachable Cove,
 * rejected token, missing permissions, an unreadable library.
 *
 * @param {object} o
 * @param {string} o.coveUrl
 * @param {string} o.token
 * @param {string} o.dbPath
 * @param {string|null} [o.password]
 * @param {boolean} [o.apply]
 * @param {string[]} [o.maps]     raw --map values
 * @param {boolean} [o.resume]
 * @param {number|null} [o.limit]
 * @param {Function} [o.log]      line output (default: silent)
 * @param {Function} [o.progress] called with live counters
 * @param {number} [o.retryBaseMs]
 */
async function exportCove(o) {
  const log = o.log || (() => {});
  const progress = o.progress || (() => {});
  const apply = !!o.apply;

  let base;
  try { base = new URL(o.coveUrl); } catch { base = null; }
  if (!base || !/^https?:$/.test(base.protocol)) throw fail('--cove needs Cove\'s address, for example --cove http://127.0.0.1:5073', 'BAD_ARGS');
  if (config.net && config.net.offline && !isLoopback(base.toString())) {
    throw fail(`Network is off (VAULT_OFFLINE=1) and ${base.origin} is not on this computer. Use a local Cove address or turn VAULT_OFFLINE off.`, 'NET_OFF');
  }
  const maps = M.parseMaps(o.maps || []);
  const limit = o.limit == null ? null : Number(o.limit);

  // --- Vault ------------------------------------------------------------------
  const vault = readVault(o.dbPath, o.password || null);
  if (vault.encrypted) {
    log('Note: this Vault library is encrypted. Cove stores what is copied over without encryption.');
  }
  const summary = {
    mode: apply ? 'apply' : 'dry run',
    vault: { total: vault.all.length, trashed: 0, unsupported: 0, byKind: { video: 0, image: 0, audio: 0 } },
    cove: { video: 0, image: 0, audio: 0 },
    matched: { byKind: { video: 0, image: 0, audio: 0 }, byVaultId: 0, byPath: 0, byNameSize: 0 },
    unmatched: 0, ambiguous: 0, limitedTo: limit,
    items: { changed: 0, upToDate: 0 },
    tagsCreated: 0, tagsGivenParent: 0, fieldsCreated: 0, fieldsExtended: 0,
    groupsCreated: 0, groupItemsAdded: 0, ratingsSet: 0, favoritesSet: 0, resumePointsSet: 0,
    errors: 0,
  };
  const report = {
    generatedAt: new Date().toISOString(), mode: summary.mode, cove: { url: base.origin, version: null },
    summary, unmatched: [], ambiguous: [], skipped: { trashed: 0, unsupported: [] }, errors: [], skippedFieldWrites: [],
    notCarriedOver: {
      ...vault.notCarried,
      note: 'Saved searches, semantic-search embeddings, game saves, subtitles and song matches are not carried over. ' +
        'View, hot and done counts and watch heatmaps are not carried over either.',
    },
  };
  if (!apply) { report.planned = []; report.plannedGroups = []; }
  const addError = (e) => { report.errors.push(e); summary.errors++; };

  const rows = [];
  for (const r of vault.all) {
    if (Number(r.user_trashed) === 1) { summary.vault.trashed++; continue; }
    const kind = M.vaultKind(r.media_type);
    if (!kind) {
      summary.vault.unsupported++;
      report.skipped.unsupported.push({ vaultId: r.id, path: r.filepath, mediaType: r.media_type });
      continue;
    }
    summary.vault.byKind[kind]++;
    rows.push(r);
  }
  report.skipped.trashed = summary.vault.trashed;

  // A --map that covers no Vault path is almost always a typo (a lost backslash, the wrong drive).
  report.warnings = [];
  for (const h of M.mapHits(rows.map(r => r.filepath), maps)) {
    if (h.hits) continue;
    const w = `--map "${h.from}=${h.to}" matches no file in this Vault library. Check the folder on the left of the "=".`;
    report.warnings.push(w);
    log(`Warning: ${w}`);
  }

  // --- Cove preflight -----------------------------------------------------
  // No token is fine: Cove with login off (its default) treats a local request as its owner.
  const client = new CoveClient({ baseUrl: base.origin + base.pathname.replace(/\/+$/, ''), token: o.token || null,
    readOnly: !apply, retryBaseMs: o.retryBaseMs, rateLimitWaitMs: o.rateLimitWaitMs });
  let me;
  try {
    me = await client.me();
  } catch (e) {
    if (e.status === 401 && o.token) throw fail('Cove rejected the token in COVE_TOKEN. Create a new API token in Cove and try again.', 'TOKEN_REJECTED');
    if (e.status === 401) {
      throw fail('Cove has login turned on. Create a token under Settings > Security & access > API tokens and set COVE_TOKEN.', 'NO_TOKEN');
    }
    throw e;
  }
  const status = await client.status();
  report.cove.version = status && status.version;
  log(`Connected to Cove ${status && status.version ? status.version : '(unknown version)'} at ${base.origin}.`);

  const who = o.token ? 'The Cove token' : 'Cove';
  const perms = (me && me.permissions) || [];
  const missingRead = ['files.read', 'system.read', 'tags.read', 'groups.read'].filter(p => !M.hasPermission(perms, p));
  for (const kind of KINDS) if (summary.vault.byKind[kind] && !M.hasPermission(perms, `${kind}s.read`)) missingRead.push(`${kind}s.read`);
  if (missingRead.length) {
    const why = {
      'files.read': 'files.read (matching works by file path, so it must be able to see file paths)',
      'system.read': 'system.read (to see which custom fields Cove already has)',
      'tags.read': 'tags.read (to find existing tags instead of making duplicates)',
      'groups.read': 'groups.read (to find groups made from your collections on an earlier run)',
    };
    const list = missingRead.map(p => why[p] || `${p} (to see your ${p.split('.')[0]})`);
    throw fail(`${who} is missing permissions this needs: ${list.join('; ')}.`, 'NO_PERMISSION');
  }

  // --- Cove media ---------------------------------------------------------
  const fieldDefs = await client.listFields() || [];
  const defByKey = new Map(fieldDefs.map(d => [String(d.key).toLowerCase(), d]));
  const coveItems = [];
  for (const kind of KINDS) {
    if (!summary.vault.byKind[kind]) continue;
    const dtos = await client.listMedia(kind);
    let items = dtos.map(d => M.normalizeCoveItem(kind, d));
    // Cove's audio list leaves custom fields out. When an earlier run stamped
    // vault_id on audio, the details are needed to recognise those items.
    const vaultIdDef = defByKey.get('vault_id');
    if (kind === 'audio' && vaultIdDef && (vaultIdDef.entityTypes || []).includes('audio')) {
      items = await fillDetails(client, items, addError);
    }
    summary.cove[kind] = items.length;
    coveItems.push(...items);
  }

  const index = M.buildCoveIndex(coveItems);
  const { matches: allMatches, unmatched, ambiguous } = M.matchItems(rows, index, maps);
  const matches = limit != null && limit >= 0 ? allMatches.slice(0, limit) : allMatches;
  report.unmatched = unmatched;
  report.ambiguous = ambiguous;
  summary.unmatched = unmatched.length;
  summary.ambiguous = ambiguous.length;
  for (const m of matches) {
    summary.matched.byKind[m.item.kind]++;
    if (m.how === 'vault_id') summary.matched.byVaultId++;
    else if (m.how === 'path') summary.matched.byPath++;
    else summary.matched.byNameSize++;
  }
  const live = { matched: matches.length, updated: 0, skipped: 0, errors: 0 };
  progress(live);

  // Audio items matched without their custom fields yet: fetch them now.
  const audioNoFields = matches.filter(m => m.item.kind === 'audio' && m.item.customFields == null).map(m => m.item);
  if (audioNoFields.length) {
    const filled = await fillDetails(client, audioNoFields, addError);
    filled.forEach((it, i) => { audioNoFields[i].customFields = it.customFields || {}; audioNoFields[i].details = it.details; });
  }

  // --- tags ---------------------------------------------------------------
  const desired = matches.map(m => M.desiredForRow(m.row));
  let coveTags = [];
  try {
    coveTags = await client.listTags();
  } catch (e) {
    // Without the tag list every tag would be a guess: leave tags out of this run, keep the rest.
    addError({ step: 'read tags', message: `${errMsg(e)}. Tags were left out of this run.` });
    for (const d of desired) d.tags = [];
  }
  const tagByName = new Map();
  const tagByAlias = new Map();
  for (const t of coveTags) {
    if (!tagByName.has(t.name.toLowerCase())) tagByName.set(t.name.toLowerCase(), t);
    for (const a of t.aliases || []) if (!tagByAlias.has(String(a).toLowerCase())) tagByAlias.set(String(a).toLowerCase(), t);
  }
  const findTag = (name) => tagByName.get(name.toLowerCase()) || tagByAlias.get(name.toLowerCase()) || null;
  const vaultAiExisting = findTag(M.VAULT_AI_TAG);
  let vaultAiId = vaultAiExisting ? vaultAiExisting.id : null;

  const tagIdByName = new Map();   // lowercase name -> id, or null while it still has to be created
  const tagsToCreate = [];
  const usedExisting = new Map();  // id -> tag
  for (const d of desired) {
    for (const name of d.tags) {
      const l = name.toLowerCase();
      if (tagIdByName.has(l)) continue;
      const t = findTag(name);
      if (t) { tagIdByName.set(l, t.id); usedExisting.set(t.id, t); } else { tagIdByName.set(l, null); tagsToCreate.push(name); }
    }
  }
  // "Vault AI" itself and its ancestors can't be put under it: that would be a
  // cycle. Walk its parents up through the tag details.
  // If any step of that walk can't be read, the line is incomplete and a loop
  // can't be ruled out, so no existing tag is put under "Vault AI" this run.
  const vaultAiLine = new Set();
  let lineIncomplete = false;
  if (vaultAiId != null) {
    const queue = [vaultAiId];
    while (queue.length) {
      const id = queue.shift();
      if (vaultAiLine.has(id)) continue;
      vaultAiLine.add(id);
      try {
        const d = await client.getTag(id);
        for (const p of (d && d.parents) || []) queue.push(p.id);
      } catch (e) {
        addError({ step: 'read tag', tagId: id, message: errMsg(e) });
        lineIncomplete = true;
      }
    }
  }
  report.skippedTagParents = [];
  // Existing tags that still need "Vault AI" as a parent (read their parents first).
  const tagsToParent = [];
  const tagList = [];
  for (const t of usedExisting.values()) {
    if (lineIncomplete) {
      report.skippedTagParents.push({ tag: t.name, tagId: t.id,
        reason: `Could not read every tag above "${M.VAULT_AI_TAG}", so a loop could not be ruled out. Run again to finish.` });
      continue;
    }
    if (!vaultAiLine.has(t.id)) { tagList.push(t); continue; }
    report.skippedTagParents.push({ tag: t.name, tagId: t.id, reason: t.id === vaultAiId
      ? `This is the "${M.VAULT_AI_TAG}" tag itself.`
      : `"${M.VAULT_AI_TAG}" sits under this tag, so putting this tag under "${M.VAULT_AI_TAG}" would make a loop.` });
  }
  const details = await pool(tagList, CONCURRENCY, t => client.getTag(t.id));
  details.forEach((r, i) => {
    if (r.error) { addError({ step: 'read tag', tag: tagList[i].name, message: errMsg(r.error) }); return; }
    const parentIds = (r.value.parents || []).map(p => p.id);
    if (vaultAiId == null || !parentIds.includes(vaultAiId)) tagsToParent.push(tagList[i]);
  });

  // --- engagement + plans ---------------------------------------------------
  const engagement = await pool(matches, CONCURRENCY, (m, i) =>
    (M.needsEngagement(desired[i], m.item.kind, { resume: o.resume }) ? client.getEngagement(m.item.kind, m.item.id) : null));
  const plans = matches.map((m, i) => {
    if (engagement[i].error) {
      addError({ vaultId: m.row.id, coveId: m.item.id, kind: m.item.kind, step: 'read rating and favorite', message: errMsg(engagement[i].error) });
    }
    return M.planChanges(desired[i], m.item, tagIdByName, engagement[i].value || null, { resume: o.resume });
  });

  // Image fields go out as a whole-set replace (see applyItem). An image the
  // list already shows as unsafe is left out here, in both modes, so the dry
  // run reports it and a re-run counts it as done; the rest are checked again
  // against a fresh copy right before the write.
  plans.forEach((p, i) => {
    const m = matches[i];
    if (m.item.kind !== 'image' || !Object.keys(p.fields).length) return;
    const reason = M.fieldReplaceBlocker(m.item.customFields, defByKey, 'image');
    if (!reason) return;
    report.skippedFieldWrites.push({ vaultId: m.row.id, coveId: m.item.id, kind: 'image', path: m.row.filepath,
      reason: `Custom fields not written, because ${reason}.` });
    p.fields = {};
  });

  // --- custom field definitions ------------------------------------------
  const fieldsToCreate = [];
  const fieldsToExtend = [];
  const badFields = new Set();
  const wantDefs = new Map();      // key -> { def, kinds:Set }
  plans.forEach((p, i) => {
    for (const key of Object.keys(p.fields)) {
      if (!wantDefs.has(key)) wantDefs.set(key, { def: desired[i].fields[key].def, kinds: new Set() });
      wantDefs.get(key).kinds.add(matches[i].item.kind);
    }
  });
  /**
   * Decide what a wanted field needs: nothing, creating, or (only for our own
   * vault_* fields) extending to more entity types. Returns false when its
   * values must be left out.
   */
  const checkDef = (key, def, kinds, entityTypes) => {
    const have = defByKey.get(key);
    if (!have) { fieldsToCreate.push({ ...def, entityTypes }); return true; }
    if (String(have.type).toLowerCase() !== def.type.toLowerCase()) {
      addError({ step: 'custom field', field: key,
        message: `Cove already has a field "${key}" of type ${have.type}, not ${def.type}. Its values were left out.` });
      return false;
    }
    const missing = [...kinds].filter(k => !(have.entityTypes || []).includes(k));
    if (missing.length && !String(have.key).toLowerCase().startsWith('vault_')) {
      addError({ step: 'custom field', field: key, message: `"${key}" is not set up for ${missing.join(', ')} in Cove. Its values were left out there.` });
      return false;
    }
    if (missing.length) fieldsToExtend.push({ have, entityTypes: [...new Set([...(have.entityTypes || []), ...missing])] });
    return true;
  };
  for (const [key, { def, kinds }] of wantDefs) {
    if (!checkDef(key, def, kinds, KINDS)) { badFields.add(key); continue; }
    // A same-key field made single-valued: send the list as one "; "-joined value.
    const have = defByKey.get(key);
    if (have && def.isMultiValue && !have.isMultiValue) {
      for (const p of plans) if (Array.isArray(p.fields[key])) p.fields[key] = p.fields[key].join('; ');
    }
  }
  if (badFields.size) for (const p of plans) for (const k of badFields) delete p.fields[k];

  // --- groups (collections) -----------------------------------------------
  let groupPlan = [];
  try {
    groupPlan = await planGroups(client, vault, matches, { addError, defByKey, report });
  } catch (e) {
    addError({ step: 'collections', message: errMsg(e) });
  }
  // The vault_collection_id stamp is how a later run finds the groups again.
  let stampGroups = false;
  if (groupPlan.some(g => !g.groupId || g.stamp)) {
    stampGroups = checkDef(M.COLLECTION_FIELD.key, M.COLLECTION_FIELD, ['group'], ['group']);
  }

  // --- permission check before the first write ----------------------------
  const need = new Set();
  plans.forEach((p, i) => {
    if (p.addTags.length || p.details || Object.keys(p.fields).length) need.add(`${matches[i].item.kind}s.write`);
  });
  if (tagsToCreate.length || tagsToParent.length || (vaultAiId == null && tagIdByName.size)) need.add('tags.write');
  if (fieldsToCreate.length || fieldsToExtend.length) need.add('system.settings.write');
  if (groupPlan.some(g => !g.groupId || g.add.length)) need.add('groups.write');
  if (groupPlan.some(g => g.stamp)) need.add('groups.write');
  const missingWrite = [...need].filter(p => !M.hasPermission(perms, p));
  if (missingWrite.length && apply) {
    throw fail(`${who} is missing permissions this needs: ${missingWrite.join(', ')}. Nothing was changed.`, 'NO_PERMISSION');
  }
  if (missingWrite.length) {
    report.missingPermissionsForApply = missingWrite;
    log(`Note: to run with --apply, ${o.token ? 'the Cove token' : 'Cove'} also needs to allow: ${missingWrite.join(', ')}.`);
  }

  // --- writes (or the dry-run tally) ---------------------------------------
  if (apply) {
    if (vaultAiId == null && tagIdByName.size) {
      try {
        vaultAiId = (await client.createTag(M.VAULT_AI_TAG, [])).id;
        summary.tagsCreated++;
      } catch (e) {
        // New tags would land without their parent: make none this run (the next
        // run makes them). Tags Cove already has are still added to items.
        addError({ step: 'create tag', tag: M.VAULT_AI_TAG,
          message: `${errMsg(e)}. New tags were not made and no tag was put under "${M.VAULT_AI_TAG}" this run.` });
        tagsToCreate.length = 0;
        tagsToParent.length = 0;
      }
    }
    const dropField = (key) => {
      if (key === M.COLLECTION_FIELD.key) stampGroups = false;
      for (const p of plans) delete p.fields[key];
    };
    for (const def of fieldsToCreate) {
      try {
        const created = await client.createField({ key: def.key, label: def.label, type: def.type, entityTypes: def.entityTypes,
          filterable: def.filterable, isMultiValue: def.isMultiValue });
        defByKey.set(def.key, created && created.key ? created : { ...def });
        summary.fieldsCreated++;
      } catch (e) {
        addError({ step: 'create custom field', field: def.key, message: errMsg(e) });
        dropField(def.key);
      }
    }
    for (const f of fieldsToExtend) {
      try {
        await client.updateField(f.have.id, { entityTypes: f.entityTypes });
        f.have.entityTypes = f.entityTypes;
        summary.fieldsExtended++;
      } catch (e) {
        addError({ step: 'update custom field', field: f.have.key, message: errMsg(e) });
        dropField(String(f.have.key).toLowerCase());
      }
    }
    for (const name of tagsToCreate) {
      try {
        const t = await client.createTag(name, [vaultAiId]);
        tagIdByName.set(name.toLowerCase(), t.id);
        summary.tagsCreated++;
      } catch (e) {
        addError({ step: 'create tag', tag: name, message: errMsg(e) });
      }
    }
    // Parent added in add mode: parents Cove has (or gains meanwhile) are never dropped.
    for (let i = 0; i < tagsToParent.length; i += 100) {
      const chunk = tagsToParent.slice(i, i + 100);
      try {
        await client.addTagParent(chunk.map(t => t.id), vaultAiId);
        summary.tagsGivenParent += chunk.length;
      } catch (e) {
        addError({ step: 'add tag parent', tags: chunk.map(t => t.name), message: errMsg(e) });
      }
    }
  } else {
    summary.tagsCreated = tagsToCreate.length + (vaultAiId == null && tagIdByName.size ? 1 : 0);
    summary.tagsGivenParent = tagsToParent.length;
    summary.fieldsCreated = fieldsToCreate.length;
    summary.fieldsExtended = fieldsToExtend.length;
  }

  await pool(matches, CONCURRENCY, async (m, i) => {
    const p = plans[i];
    if (M.isEmptyPlan(p)) { summary.items.upToDate++; live.skipped++; progress(live); return; }
    if (!apply) {
      summary.items.changed++;
      if (p.rating != null) summary.ratingsSet++;
      if (p.favorite) summary.favoritesSet++;
      if (p.resumeAt != null) summary.resumePointsSet++;
      report.planned.push({ vaultId: m.row.id, path: m.row.filepath, cove: { kind: m.item.kind, id: m.item.id },
        matchedBy: m.how, changes: p });
      live.updated++;
      progress(live);
      return;
    }
    const failed = await applyItem(client, m, p, { tagIdByName, defByKey, summary, report });
    for (const f of failed) addError({ vaultId: m.row.id, coveId: m.item.id, kind: m.item.kind, path: m.row.filepath, ...f });
    summary.items.changed++;
    if (failed.length) live.errors++; else live.updated++;
    progress(live);
  });

  // --- groups ---------------------------------------------------------------
  const stamp = (cid) => ({ [M.COLLECTION_FIELD.key]: cid });
  for (const g of groupPlan) {
    if (!apply) {
      if (!g.groupId) summary.groupsCreated++;
      summary.groupItemsAdded += g.add.length;
      if (g.add.length || !g.groupId || g.stamp) {
        report.plannedGroups.push({ group: g.name, collectionId: g.cid, create: !g.groupId, matchedByName: !!g.stamp, addItems: g.add });
      }
      continue;
    }
    let groupId = g.groupId;
    try {
      if (!groupId) {
        // Not retried on failure: a repeat could make a second group. The stamp lets the next run find it.
        groupId = (await client.createGroup(g.name, stampGroups ? stamp(g.cid) : undefined)).id;
        summary.groupsCreated++;
      } else if (g.stamp && stampGroups) {
        await stampExistingGroup(client, g, defByKey, report);
      }
      let order = g.existingCount;
      for (const t of g.add) {
        await client.addGroupItem(groupId, t.kind, t.id, order++);
        summary.groupItemsAdded++;
      }
    } catch (e) {
      addError({ step: 'collection', group: g.name, message: errMsg(e) });
    }
  }

  live.errors = summary.errors;
  progress(live);
  return { summary, report };
}

/** GET each item's detail (custom fields are only on the detail for audio). Failures keep the list version. */
async function fillDetails(client, items, addError) {
  const res = await pool(items, CONCURRENCY, it => client.getMedia(it.kind, it.id));
  return items.map((it, i) => {
    if (res[i].error) {
      addError({ coveId: it.id, kind: it.kind, step: 'read details', message: errMsg(res[i].error) });
      return it;
    }
    const full = M.normalizeCoveItem(it.kind, res[i].value);
    return { ...it, customFields: full.customFields || {}, details: full.details, tagIds: full.tagIds.length ? full.tagIds : it.tagIds };
  });
}

/**
 * Collections -> static Cove groups, found again on a re-run by their
 * `vault_collection_id` stamp, not by name, so renaming either side changes
 * nothing. Only when no group carries the stamp is a name trusted, and only
 * when it is unambiguous: exactly one static group has the name, it carries
 * no stamp, and no other Vault collection produces the same name. Otherwise a
 * new group is made. Collections that produce the same name get distinct
 * ones (" (2)", ...). Missing items are appended after the group's current
 * ones, in Vault's order. Collections none of whose items reached Cove are
 * left out.
 * @returns {Array<{cid, name, groupId, existingCount, add, stamp}>} stamp: an
 *   existing group matched by name that still needs the stamp
 */
async function planGroups(client, vault, matches, { addError, defByKey, report }) {
  const { names, shared } = M.uniqueGroupNames(M.collectionGroupNames(vault.collections));
  if (!names.size) return [];
  const byVaultId = new Map(matches.map(m => [m.row.id, m.item]));
  const targets = new Map();       // collection id -> [{kind,id}]
  for (const ci of vault.collectionItems) {
    if (!names.has(ci.collection_id)) continue;
    const item = byVaultId.get(ci.media_id);
    if (!item) continue;
    if (!targets.has(ci.collection_id)) targets.set(ci.collection_id, []);
    const list = targets.get(ci.collection_id);
    if (!list.some(t => t.kind === item.kind && t.id === item.id)) list.push({ kind: item.kind, id: item.id });
  }
  if (!targets.size) return [];

  const groups = await client.listGroups();
  const isStatic = (g) => String(g.kind || 'static').toLowerCase() === 'static';
  const stampOf = (g) => {
    const v = Number(M.getField(g.customFields, M.COLLECTION_FIELD.key));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const byStamp = new Map();
  const staticByName = new Map();
  for (const g of groups) {
    const s = stampOf(g);
    if (s != null) {
      if (!byStamp.has(s)) byStamp.set(s, []);
      byStamp.get(s).push(g);
    }
    if (isStatic(g)) {
      const k = String(g.name).trim().toLowerCase();
      if (!staticByName.has(k)) staticByName.set(k, []);
      staticByName.get(k).push(g);
    }
  }

  const out = [];
  for (const [cid, list] of [...targets].sort((a, b) => a[0] - b[0])) {
    const name = names.get(cid);
    let existing = null;
    let needsStamp = false;
    const stamped = byStamp.get(cid) || [];
    if (stamped.length > 1) {
      addError({ step: 'collection', group: name, message: `Several Cove groups carry vault_collection_id ${cid}; none was changed.` });
      continue;
    }
    if (stamped.length === 1) {
      existing = stamped[0];
    } else if (!shared.has(cid)) {
      const same = staticByName.get(name.toLowerCase()) || [];
      if (same.length === 1 && stampOf(same[0]) == null) {
        existing = same[0];
        // A group with its own fields stays unstamped (the stamp would replace
        // its whole field set); the name match still adds the items.
        const reason = M.fieldReplaceBlocker(existing.customFields, defByKey, 'group');
        if (reason) {
          report.skippedFieldWrites.push({ group: existing.name, coveGroupId: existing.id, field: M.COLLECTION_FIELD.key,
            reason: `Not stamped, because ${reason}. A later run may match it by name again.` });
        } else {
          needsStamp = true;
        }
      }
    }
    if (!existing) { out.push({ cid, name, groupId: null, existingCount: 0, add: list, stamp: false }); continue; }
    try {
      const items = await client.listGroupItems(existing.id) || [];
      const have = new Set(items.map(it => `${String(it.hostType).toLowerCase()}|${it.hostId}`));
      out.push({ cid, name: existing.name, groupId: existing.id, existingCount: items.length,
        add: list.filter(t => !have.has(`${t.kind}|${t.id}`)), stamp: needsStamp });
    } catch (e) {
      addError({ step: 'collection', group: name, message: errMsg(e) });
    }
  }
  return out;
}

/**
 * Stamp a group matched by name with vault_collection_id. The group update
 * replaces all of its custom fields, so the payload is built from a copy read
 * just before, and the write is skipped (and reported) when that copy holds
 * anything the replace would lose.
 */
async function stampExistingGroup(client, g, defByKey, report) {
  const fresh = await client.getGroupFresh(g.groupId);
  const current = (fresh && fresh.customFields) || {};
  if (M.isFieldSet(M.getField(current, M.COLLECTION_FIELD.key))) return;
  const reason = M.fieldReplaceBlocker(current, defByKey, 'group');
  if (reason) {
    report.skippedFieldWrites.push({ group: g.name, coveGroupId: g.groupId, field: M.COLLECTION_FIELD.key,
      reason: `Not stamped, because ${reason}. A later run may match it by name again.` });
    return;
  }
  await client.updateGroup(g.groupId, { customFields: { ...current, [M.COLLECTION_FIELD.key]: g.cid } });
}

/**
 * Send one item's plan. Which endpoint carries what follows Cove's API:
 *  - tags always through POST /{kind}s/bulk with tagMode "add" (the item
 *    update would REPLACE the tag list, and would turn Cove's derived tags
 *    into manual ones if we sent them back);
 *  - custom fields through bulk (customFieldMode "set" on keys the item does
 *    not have) for video and audio. Image bulk has no custom fields, so images
 *    use PUT /images/{id}, whose customFields replaces the whole set: the
 *    image is read again just before, ours are added to those values, and
 *    the write is skipped (and reported) if the replace would lose anything;
 *  - details: bulk for image and audio, PUT /videos/{id} for video (video
 *    bulk has no details).
 * Returns the steps that failed; the rest still go out.
 */
async function applyItem(client, m, p, { tagIdByName, defByKey, summary, report }) {
  const { kind, id } = m.item;
  const failed = [];
  const step = async (name, fn) => {
    try { await fn(); return true; } catch (e) { failed.push({ step: name, message: errMsg(e) }); return false; }
  };

  const have = new Set(m.item.tagIds);
  const tagIds = [...new Set(p.addTags.map(n => tagIdByName.get(n.toLowerCase())).filter(t => t != null && !have.has(t)))];
  const fields = Object.keys(p.fields).length ? p.fields : null;

  const bulk = { ids: [id] };
  if (tagIds.length) { bulk.tagIds = tagIds; bulk.tagMode = 'add'; }
  if (fields && kind !== 'image') { bulk.customFields = fields; bulk.customFieldMode = 'set'; }
  if (p.details && kind !== 'video') bulk.details = p.details;
  if (Object.keys(bulk).length > 1) await step('update tags and fields', () => client.bulkUpdate(kind, bulk));

  if (p.details && kind === 'video') await step('update details', () => client.updateMedia('video', id, { details: p.details }));
  if (fields && kind === 'image') {
    await step('update fields', async () => {
      const fresh = await client.getMediaFresh('image', id);
      const current = (fresh && fresh.customFields) || {};
      // Fill-only against the fresh copy too: a value set meanwhile wins.
      const add = Object.fromEntries(Object.entries(fields).filter(([k]) => !M.isFieldSet(M.getField(current, k))));
      if (!Object.keys(add).length) return;
      const reason = M.fieldReplaceBlocker(current, defByKey, 'image');
      if (reason) {
        report.skippedFieldWrites.push({ vaultId: m.row.id, coveId: id, kind, path: m.row.filepath,
          reason: `Custom fields not written, because ${reason}.` });
        return;
      }
      await client.updateMedia('image', id, { customFields: { ...current, ...add } });
    });
  }
  if (p.rating != null && await step('set rating', () => client.setRating(kind, id, p.rating))) summary.ratingsSet++;
  if (p.favorite && await step('set favorite', () => client.setFavorite(kind, id))) summary.favoritesSet++;
  if (p.resumeAt != null) {
    const ok = await step('set resume point', () => client.recordPlayback({
      hostType: kind, hostId: id, sessionId: crypto.randomUUID(),
      mediaDurationSec: Number(m.row.duration_seconds) > 0 ? Number(m.row.duration_seconds) : 0,
      currentPositionSec: p.resumeAt, state: 'paused', intervals: [],
    }));
    if (ok) summary.resumePointsSet++;
  }
  return failed;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `
Usage: node vault.js export-cove --cove <url> [options]

Copies this library's tags, descriptions, AI details, notes, ratings,
favorites and collections into Cove. Cove must already have scanned the
same files. Nothing in Vault changes, and nothing in Cove is deleted.

Without --apply this is a dry run: it shows what would change and sends
nothing that changes Cove.

Options:
  --cove <url>          Cove's address, for example http://127.0.0.1:5073
  --apply               Make the changes (default: dry run)
  --map "<from>=<to>"   Cove sees your files under another path, for example
                        --map "D:\\Media=/media". Repeat for more folders.
  --resume              Also copy resume points (adds one playback session
                        per item to Cove's history)
  --report <file>       Where to write the JSON report
                        (default: cove-export-report-<time>.json here)
  --limit <n>           Only handle the first n matched items (to try it out)

Environment:
  COVE_TOKEN            Only when Cove has login turned on: an API token from
                        Settings > Security & access > API tokens.
  VAULT_DB_PASSWORD     Password, if the library is encrypted.
`;

function parseArgs(args) {
  const o = { apply: false, resume: false, maps: [], limit: null, report: null, cove: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    const [flag, inline] = a.startsWith('--') && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const v = args[++i];
      if (v === undefined) throw fail(`${flag} needs a value.`, 'BAD_ARGS');
      return v;
    };
    switch (flag) {
      case '--cove': o.cove = value(); break;
      case '--apply': o.apply = true; break;
      case '--resume': o.resume = true; break;
      case '--map': o.maps.push(value()); break;
      case '--report': o.report = value(); break;
      case '--limit': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0) throw fail('--limit needs a whole number.', 'BAD_ARGS');
        o.limit = n;
        break;
      }
      case '--help': case '-h': o.help = true; break;
      default: throw fail(`Unknown option: ${a}`, 'BAD_ARGS');
    }
  }
  return o;
}

function printSummary(s, reportPath, log) {
  const k = (o) => `videos ${o.video}, images ${o.image}, audio ${o.audio}`;
  const done = s.mode === 'apply';
  const verb = (past, future) => (done ? past : future);
  log('');
  log(s.mode === 'apply' ? '=== Moved to Cove ===' : '=== Dry run: nothing was changed in Cove ===');
  log(`Vault items:         ${s.vault.total} (${k(s.vault.byKind)})`);
  log(`  skipped:           ${s.vault.trashed} in the trash, ${s.vault.unsupported} documents or mixes`);
  log(`Cove items:          ${k(s.cove)}`);
  log(`Matched:             ${s.matched.byKind.video + s.matched.byKind.image + s.matched.byKind.audio} (${k(s.matched.byKind)})`);
  log(`  by path:           ${s.matched.byPath}`);
  log(`  by name and size:  ${s.matched.byNameSize}`);
  log(`  from earlier run:  ${s.matched.byVaultId}`);
  if (s.limitedTo != null) log(`  limited to:        ${s.limitedTo}`);
  log(`Not found in Cove:   ${s.unmatched}`);
  log(`Unclear matches:     ${s.ambiguous} (left alone, see the report)`);
  log(`Items ${verb('updated', 'to update')}: ${s.items.changed}, already up to date: ${s.items.upToDate}`);
  log(`Tags ${verb('created', 'to create')}: ${s.tagsCreated}, existing tags ${verb('put', 'to put')} under "Vault AI": ${s.tagsGivenParent}`);
  log(`Custom fields ${verb('created', 'to create')}: ${s.fieldsCreated}${s.fieldsExtended ? `, ${verb('extended', 'to extend')}: ${s.fieldsExtended}` : ''}`);
  log(`Ratings ${verb('set', 'to set')}: ${s.ratingsSet}, favorites: ${s.favoritesSet}${s.resumePointsSet ? `, resume points: ${s.resumePointsSet}` : ''}`);
  log(`Collections: ${s.groupsCreated} groups ${verb('created', 'to create')}, ${s.groupItemsAdded} items ${verb('added', 'to add')}`);
  log(`Errors:              ${s.errors}`);
  log(`Report:              ${reportPath}`);
  if (s.mode !== 'apply') log('\nRun again with --apply to make these changes.');
}

async function run(args) {
  const opts = parseArgs(args || []);
  if (opts.help) { console.log(USAGE); return; }
  if (!opts.cove) { console.log(USAGE); throw fail('--cove is required.', 'BAD_ARGS'); }

  const reportPath = path.resolve(opts.report || `cove-export-report-${timestamp()}.json`);
  const tty = process.stdout.isTTY;
  const progress = tty
    ? (l) => process.stdout.write(`\r  matched ${l.matched} / updated ${l.updated} / skipped ${l.skipped} / errors ${l.errors}   `)
    : () => {};

  const { summary, report } = await exportCove({
    coveUrl: opts.cove,
    token: process.env.COVE_TOKEN || null,
    dbPath: config.paths.database,
    password: config.getDbPassword(),
    apply: opts.apply,
    maps: opts.maps,
    resume: opts.resume,
    limit: opts.limit,
    log: (line) => console.log(line),
    progress,
  });
  if (tty) process.stdout.write('\n');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  printSummary(summary, reportPath, (line) => console.log(line));
  if (summary.errors) process.exitCode = 1;
}

module.exports = { run, exportCove, parseArgs, readVault, openVaultReadOnly, HOT_JOURNAL_MSG };
