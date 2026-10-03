/**
 * Vault -> Cove migration: the pure part.
 *
 * Everything here is a plain function of its inputs (no I/O, no network, no
 * clock), so the rules that decide WHAT gets written to Cove are unit-tested
 * on their own (test/cove-mapping.test.js). commands/export-cove.js does the
 * reading and the talking; lib/cove/client.js does the HTTP.
 *
 * Shapes:
 *   Vault row   - a media row as read from the library (see VAULT_COLUMNS in
 *                 commands/export-cove.js), only rows with user_trashed = 0.
 *   Cove item   - { kind, id, files: [{ path, basename, size }], details,
 *                   customFields, tagIds } normalized from Cove's VideoDto /
 *                   ImageDto / AudioDto by normalizeCoveItem().
 */

const VAULT_AI_TAG = 'Vault AI';

/** Vault media_type -> Cove kind. document / mix (and anything new) is not carried over. */
function vaultKind(mediaType) {
  switch (String(mediaType || '').toLowerCase()) {
    case 'video': return 'video';
    case 'image':
    case 'gif': return 'image';
    case 'audio': return 'audio';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Backslash -> slash, duplicate slashes collapsed, trailing slash dropped. Case kept. */
function slashPath(p) {
  let s = String(p || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** The comparison form of a path: slashPath + lowercase (Windows libraries are case-insensitive). */
function normPath(p) {
  return slashPath(p).toLowerCase();
}

/** Last path segment, either separator. */
function baseName(p) {
  const s = slashPath(p);
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Parse --map values ("D:\Media=/media"). The split is at the first '=' so a
 * Cove path may itself contain one. Longest source prefix wins when applied.
 * Throws on a value without a usable left and right side.
 */
function parseMaps(values) {
  const maps = [];
  for (const v of values || []) {
    const i = String(v).indexOf('=');
    const from = i > 0 ? String(v).slice(0, i).trim() : '';
    const to = i > 0 ? String(v).slice(i + 1).trim() : '';
    if (!from || !to) throw new Error(`--map needs the form "VaultFolder=CoveFolder", got: ${v}`);
    maps.push({ from: slashPath(from), to: slashPath(to) });
  }
  return maps.sort((a, b) => b.from.length - a.from.length);
}

/**
 * Rewrite a Vault path's prefix per --map. The prefix compare is
 * case-insensitive and must end on a folder boundary, so "D:/Media" never
 * rewrites "D:/Media2/x.mp4". Paths no map covers come back slash-normalized.
 */
function applyMaps(p, maps) {
  const s = slashPath(p);
  const lower = s.toLowerCase();
  for (const m of maps || []) {
    const from = m.from.toLowerCase();
    if (lower === from || lower.startsWith(from.endsWith('/') ? from : from + '/')) {
      const rest = s.slice(m.from.length).replace(/^\//, '');
      return rest ? slashPath(m.to + '/' + rest) : m.to;
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Cove side
// ---------------------------------------------------------------------------

/** Case-insensitive lookup in a Cove customFields dictionary (keys are definition keys). */
function getField(customFields, key) {
  if (!customFields) return undefined;
  if (Object.prototype.hasOwnProperty.call(customFields, key)) return customFields[key];
  const k = key.toLowerCase();
  for (const name of Object.keys(customFields)) if (name.toLowerCase() === k) return customFields[name];
  return undefined;
}

/** A custom field counts as set when it holds something other than null / '' / []. */
function isFieldSet(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.some(isFieldSet);
  return true;
}

/** Reduce a Cove list/detail DTO to what matching and planning need. */
function normalizeCoveItem(kind, dto) {
  return {
    kind,
    id: dto.id,
    title: dto.title || null,
    details: dto.details == null ? null : dto.details,
    customFields: dto.customFields || null,
    tagIds: (dto.tags || []).map(t => t.id),
    files: (dto.files || []).map(f => ({ path: f.path || '', basename: f.basename || baseName(f.path || ''), size: Number(f.size) })),
    parentVideoId: dto.parentVideoId == null ? null : dto.parentVideoId,
  };
}

/**
 * Index Cove items for matching: full path, basename+size, and the vault_id
 * stamp a previous run left. Sub-videos (clips) share their parent's file, so
 * they never take part in file matching.
 */
function buildCoveIndex(items) {
  const byPath = new Map();
  const byNameSize = new Map();
  const byVaultId = new Map();
  const push = (map, key, item) => {
    const list = map.get(key);
    if (!list) map.set(key, [item]);
    else if (!list.includes(item)) list.push(item);
  };
  for (const item of items) {
    const vid = Number(getField(item.customFields, 'vault_id'));
    if (Number.isFinite(vid) && vid > 0) push(byVaultId, `${item.kind}|${vid}`, item);
    if (item.parentVideoId != null) continue;
    for (const f of item.files) {
      if (f.path) push(byPath, `${item.kind}|${normPath(f.path)}`, item);
      const name = (f.basename || baseName(f.path)).toLowerCase();
      if (name && Number.isFinite(f.size)) push(byNameSize, `${item.kind}|${name}|${f.size}`, item);
    }
  }
  return { byPath, byNameSize, byVaultId };
}

/**
 * Pair Vault rows with Cove items. Order of trust:
 *   1. vault_id stamp from an earlier run (same item, even if the file moved),
 *   2. normalized full path (after --map),
 *   3. basename + exact size, only when that pair is unique on BOTH sides.
 * A Cove item is never given to two Vault rows; anything doubtful goes to
 * `ambiguous`, anything not found to `unmatched`. Nothing is guessed.
 * @param {Array} rows  Vault rows with a supported kind
 */
function matchItems(rows, index, maps) {
  const matches = [];
  const unmatched = [];
  const ambiguous = [];
  const claimed = new Map();   // cove "kind|id" -> vault id

  // Vault-side uniqueness of basename+size, per kind.
  const vaultNameSize = new Map();
  for (const r of rows) {
    const k = `${vaultKind(r.media_type)}|${baseName(r.filepath).toLowerCase()}|${Number(r.filesize_bytes)}`;
    vaultNameSize.set(k, (vaultNameSize.get(k) || 0) + 1);
  }

  const take = (row, item, how) => {
    const ck = `${item.kind}|${item.id}`;
    if (claimed.has(ck)) {
      ambiguous.push({ vaultId: row.id, path: row.filepath, kind: item.kind,
        reason: `Cove ${item.kind} ${item.id} already matched Vault item ${claimed.get(ck)}`, candidates: [item.id] });
      return;
    }
    claimed.set(ck, row.id);
    matches.push({ row, item, how });
  };

  for (const row of rows) {
    const kind = vaultKind(row.media_type);
    const stamped = index.byVaultId.get(`${kind}|${row.id}`);
    if (stamped && stamped.length === 1) { take(row, stamped[0], 'vault_id'); continue; }
    if (stamped && stamped.length > 1) {
      ambiguous.push({ vaultId: row.id, path: row.filepath, kind, reason: 'several Cove items carry this vault_id',
        candidates: stamped.map(i => i.id) });
      continue;
    }

    const mapped = applyMaps(row.filepath, maps);
    const byPath = index.byPath.get(`${kind}|${normPath(mapped)}`);
    if (byPath && byPath.length === 1) { take(row, byPath[0], 'path'); continue; }
    if (byPath && byPath.length > 1) {
      ambiguous.push({ vaultId: row.id, path: row.filepath, kind, reason: 'several Cove items have this path',
        candidates: byPath.map(i => i.id) });
      continue;
    }

    const nsKey = `${kind}|${baseName(row.filepath).toLowerCase()}|${Number(row.filesize_bytes)}`;
    const byName = Number.isFinite(Number(row.filesize_bytes)) ? index.byNameSize.get(nsKey) : null;
    if (byName && byName.length === 1 && vaultNameSize.get(nsKey) === 1) { take(row, byName[0], 'name_size'); continue; }
    if (byName && byName.length > 0) {
      ambiguous.push({ vaultId: row.id, path: row.filepath, kind,
        reason: byName.length > 1 ? 'name and size match several Cove items' : 'name and size match several Vault items',
        candidates: byName.map(i => i.id) });
      continue;
    }
    unmatched.push({ vaultId: row.id, path: row.filepath, kind, coveLookupPath: mapped });
  }
  return { matches, unmatched, ambiguous };
}

// ---------------------------------------------------------------------------
// Vault row -> desired Cove values
// ---------------------------------------------------------------------------

/** Parse a JSON array column; '' / null / bad JSON -> []. */
function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null || raw === '') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Trimmed, non-empty, de-duplicated (case-insensitive, first spelling kept) strings. */
function cleanList(values) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    if (v == null || typeof v === 'object') continue;
    const s = String(v).trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

/** "camera_angle" / "body-language" -> "Camera Angle" / "Body Language". */
function titleCase(s) {
  return String(s).trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
    .split(' ').map(w => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join(' ');
}

/**
 * Cove's custom-field key normalization (CustomFieldService.NormalizeKey):
 * letters/digits/underscore kept and lowercased, any other run becomes one
 * '_', then '_' trimmed from both ends. Keys we send come back
 * exactly like this, so we compare against the same form.
 */
function slugKey(s) {
  let out = '';
  let prevSep = false;
  for (const ch of String(s).trim()) {
    if (/[\p{L}\p{N}_]/u.test(ch)) { out += ch.toLowerCase(); prevSep = false; }
    else if (!prevSep && out.length > 0) { out += '_'; prevSep = true; }
  }
  return out.replace(/^_+|_+$/g, '');
}

/** Fixed custom fields (key -> definition). Element fields are added per type. */
const FIXED_FIELDS = {
  vault_id: { key: 'vault_id', label: 'Vault ID', type: 'number', isMultiValue: false, filterable: true },
  vault_ai_themes: { key: 'vault_ai_themes', label: 'AI: Themes', type: 'text', isMultiValue: true, filterable: true },
  vault_ai_locations: { key: 'vault_ai_locations', label: 'AI: Locations', type: 'text', isMultiValue: true, filterable: true },
  vault_ai_language: { key: 'vault_ai_language', label: 'AI: Language', type: 'text', isMultiValue: false, filterable: true },
  vault_ai_explicit: { key: 'vault_ai_explicit', label: 'AI: Explicit', type: 'boolean', isMultiValue: false, filterable: true },
  vault_ai_content_type: { key: 'vault_ai_content_type', label: 'AI: Content type', type: 'text', isMultiValue: false, filterable: true },
  vault_ai_quality_flag: { key: 'vault_ai_quality_flag', label: 'AI: Quality flag', type: 'text', isMultiValue: false, filterable: true },
  // Cove never makes long text filterable; asking for it would just be ignored.
  vault_notes: { key: 'vault_notes', label: 'Vault notes', type: 'longText', isMultiValue: false, filterable: false },
};

/** The stamp on a Cove group made from a Vault collection (group entity only). */
const COLLECTION_FIELD = { key: 'vault_collection_id', label: 'Vault collection ID', type: 'number', isMultiValue: false, filterable: true };

/** Definition for a media_elements type. A slug that lands on a fixed key gets an "element_" infix. */
function elementField(type) {
  const slug = slugKey(type);
  if (!slug) return null;
  let key = slugKey(`vault_ai_${slug}`);
  if (FIXED_FIELDS[key]) key = slugKey(`vault_ai_element_${slug}`);
  return { key, label: `AI: ${titleCase(type)}`, type: 'text', isMultiValue: false, filterable: true };
}

/** user_notes (JSON array of {text} objects, plain strings, or legacy free text) -> one text block. */
function notesText(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s || s === '[]') return '';
  let parsed;
  try { parsed = JSON.parse(s); } catch { return s; }   // legacy plain-text note
  if (!Array.isArray(parsed)) return typeof parsed === 'string' ? parsed.trim() : '';
  return parsed
    .map(n => (n && typeof n === 'object' ? n.text : n))
    .filter(t => t != null && String(t).trim() !== '')
    .map(t => String(t).trim())
    .join('\n\n');
}

/** Vault 1-5 stars -> Cove 0-100. 0 / missing / out of range -> null (unrated, nothing to send). */
function coveRating(userRating) {
  const r = Number(userRating);
  return Number.isInteger(r) && r >= 1 && r <= 5 ? r * 20 : null;
}

/**
 * Everything one Vault row wants in Cove, before looking at what Cove already
 * has. fields: { key: { def, value } }.
 */
function desiredForRow(row) {
  const fields = {};
  const put = (def, value) => { if (def) fields[def.key] = { def, value }; };

  put(FIXED_FIELDS.vault_id, Number(row.id));

  const themes = cleanList(parseJsonArray(row.themes));
  if (themes.length) put(FIXED_FIELDS.vault_ai_themes, themes);
  const locations = cleanList(parseJsonArray(row.locations));
  if (locations.length) put(FIXED_FIELDS.vault_ai_locations, locations);

  // media_elements: [{type, details}] -> one text field per type, details joined.
  const byType = new Map();
  for (const el of parseJsonArray(row.media_elements)) {
    if (!el || typeof el !== 'object' || el.type == null) continue;
    const details = Array.isArray(el.details) ? el.details.join(', ') : el.details;
    if (details == null || String(details).trim() === '') continue;
    const def = elementField(el.type);
    if (!def) continue;
    if (!byType.has(def.key)) byType.set(def.key, { def, parts: [] });
    const parts = byType.get(def.key).parts;
    const d = String(details).trim();
    if (!parts.includes(d)) parts.push(d);
  }
  for (const { def, parts } of byType.values()) put(def, parts.join('; '));

  const text = (v) => (v == null ? '' : String(v).trim());
  if (text(row.language)) put(FIXED_FIELDS.vault_ai_language, text(row.language));
  if (text(row.content_type)) put(FIXED_FIELDS.vault_ai_content_type, text(row.content_type));
  if (text(row.quality_flag)) put(FIXED_FIELDS.vault_ai_quality_flag, text(row.quality_flag));
  // explicit defaults to 0 on every row, analysed or not. Only an analysed row's
  // 0 means "not explicit"; on an unanalysed stub it means nothing.
  if (row.explicit != null && row.processed_at) put(FIXED_FIELDS.vault_ai_explicit, Number(row.explicit) === 1);

  const notes = notesText(row.user_notes);
  if (notes) put(FIXED_FIELDS.vault_notes, notes);

  return {
    tags: cleanList(parseJsonArray(row.tags)).filter(t => t.toLowerCase() !== VAULT_AI_TAG.toLowerCase()),
    details: text(row.description) || null,
    fields,
    rating: coveRating(row.user_rating),
    favorite: Number(row.user_starred) === 1,
    lastPosition: Number(row.last_position) > 0 ? Number(row.last_position) : 0,
  };
}

/**
 * The additive diff for one matched pair. Cove's current values always win:
 * details only when Cove's is empty, a custom field only when Cove has no
 * value for that key, a rating only when Cove has none, favorite only ever
 * switched on. tagIds: the tags (already resolved to ids, or null for tags
 * that will be created) the item is missing.
 * @param {object} desired     desiredForRow(row)
 * @param {object} item        normalized Cove item
 * @param {Map}    tagIdByName lowercase tag name -> Cove tag id (or null = to be created)
 * @param {object|null} engagement  Cove EntityEngagementDto, when fetched
 * @param {{resume?: boolean}} opts
 */
function planChanges(desired, item, tagIdByName, engagement, opts = {}) {
  const plan = { addTags: [], details: null, fields: {}, rating: null, favorite: false, resumeAt: null };

  const have = new Set(item.tagIds);
  for (const name of desired.tags) {
    const id = tagIdByName.get(name.toLowerCase());
    if (id == null || !have.has(id)) plan.addTags.push(name);
  }

  if (desired.details && !(item.details && String(item.details).trim())) plan.details = desired.details;

  for (const [key, { value }] of Object.entries(desired.fields)) {
    if (!isFieldSet(getField(item.customFields, key))) plan.fields[key] = value;
  }

  if (engagement) {
    if (desired.rating != null && (engagement.rating == null || engagement.rating === 0)) plan.rating = desired.rating;
    if (desired.favorite && !engagement.isFavorite) plan.favorite = true;
    if (opts.resume && desired.lastPosition > 0 && (item.kind === 'video' || item.kind === 'audio')
        && !(Number(engagement.resumeTime) > 0)) {
      plan.resumeAt = desired.lastPosition;
    }
  }
  return plan;
}

/** True when a plan would change nothing. */
function isEmptyPlan(p) {
  return !p.addTags.length && !p.details && !Object.keys(p.fields).length && p.rating == null && !p.favorite && p.resumeAt == null;
}

/** Whether a row needs Cove's engagement record (rating / favorite / resume) looked up. */
function needsEngagement(desired, kind, opts = {}) {
  return desired.rating != null || desired.favorite
    || (!!opts.resume && desired.lastPosition > 0 && (kind === 'video' || kind === 'audio'));
}

// ---------------------------------------------------------------------------
// Collections, permissions
// ---------------------------------------------------------------------------

/**
 * Cove group name for every Vault collection (kind 'collection'): nested ones
 * are prefixed with their folder chain, "Folder / Sub / Name". Folders
 * themselves hold no media and get no group. A parent cycle stops the walk.
 * @returns {Map<number, string>} collection id -> group name
 */
function collectionGroupNames(collections) {
  const byId = new Map(collections.map(c => [c.id, c]));
  const out = new Map();
  for (const c of collections) {
    if ((c.kind || 'collection') !== 'collection') continue;
    const parts = [String(c.name).trim()];
    const seen = new Set([c.id]);
    let p = c.parent_id == null ? null : byId.get(c.parent_id);
    while (p && !seen.has(p.id)) {
      seen.add(p.id);
      parts.unshift(String(p.name).trim());
      p = p.parent_id == null ? null : byId.get(p.parent_id);
    }
    out.set(c.id, parts.join(' / '));
  }
  return out;
}

/**
 * Make group names distinct. Collections that end up with the same name
 * (case-insensitive) share it in collection-id order: the lowest id keeps
 * the plain name, the next gets " (2)", then " (3)", skipping any name
 * already taken. Deterministic, so a re-run produces the same names.
 * @param {Map<number,string>} names  collection id -> name
 * @returns {{names: Map<number,string>, shared: Set<number>}} shared: ids whose
 *   plain name more than one collection produced (never matched by name).
 */
function uniqueGroupNames(names) {
  const ids = [...names.keys()].sort((a, b) => a - b);
  const count = new Map();
  for (const id of ids) {
    const k = names.get(id).toLowerCase();
    count.set(k, (count.get(k) || 0) + 1);
  }
  const taken = new Set();
  const out = new Map();
  const shared = new Set();
  // Plain names first, so a " (2)" never takes a name a collection has itself.
  for (const id of ids) {
    const k = names.get(id).toLowerCase();
    if (count.get(k) > 1) shared.add(id);
    if (!taken.has(k)) { taken.add(k); out.set(id, names.get(id)); }
  }
  for (const id of ids) {
    if (out.has(id)) continue;
    const base = names.get(id);
    let n = 2;
    while (taken.has(`${base} (${n})`.toLowerCase())) n++;
    taken.add(`${base} (${n})`.toLowerCase());
    out.set(id, `${base} (${n})`);
  }
  return { names: new Map(ids.map(id => [id, out.get(id)])), shared };
}

/**
 * Before replacing an entity's whole custom-field set (PUT on an image or a
 * group sends every value): would Cove drop or refuse anything it has now?
 * It keeps only keys whose definition covers `entityType`, and a list for a
 * single-value field is not taken back as it was. Returns null when the
 * write is safe, else the reason it is not.
 * @param {object|null} current  the entity's custom fields, freshly read
 * @param {Map<string,object>} defByKey  lowercase key -> definition
 */
function unsafeFieldReplace(current, defByKey, entityType) {
  for (const [key, value] of Object.entries(current || {})) {
    if (!isFieldSet(value)) continue;
    const def = defByKey.get(key.toLowerCase());
    if (!def) return `it has a value for "${key}", a field Cove no longer lists`;
    if (!(def.entityTypes || []).includes(entityType)) return `it has a value for "${key}", a field not set up for ${entityType}s`;
    if (Array.isArray(value) && !def.isMultiValue) return `it has a list of values for "${key}", which now takes one value`;
  }
  return null;
}

/**
 * Whether we may replace an entity's whole custom-field set at all. Cove
 * reads back only the FIRST stored value of a single-value field, yet keeps
 * any further rows (a field switched from multi to single keeps them), and
 * the replace deletes every row before writing what it was sent. Those
 * hidden rows can't be seen through the API, and a "vault_" key may have
 * been made or edited by the user too. A hidden row always sits behind a
 * visible first value, so the only provably safe case is an entity showing
 * no values at all: any value blocks the write. Returns null when safe,
 * else the reason.
 */
function fieldReplaceBlocker(current, defByKey, entityType) {
  const held = Object.entries(current || {}).filter(([, v]) => isFieldSet(v));
  if (held.length) {
    return `it already has custom fields in Cove (${held.map(([k]) => k).join(', ')}); ` +
      'Vault fields were not added so nothing there gets overwritten';
  }
  return null;
}

/** How many Vault paths each --map prefix covers (a map that covers none is probably mistyped). */
function mapHits(paths, maps) {
  return maps.map(m => {
    const from = m.from.toLowerCase();
    const prefix = from.endsWith('/') ? from : from + '/';
    let hits = 0;
    for (const p of paths) {
      const l = slashPath(p).toLowerCase();
      if (l === from || l.startsWith(prefix)) hits++;
    }
    return { from: m.from, to: m.to, hits };
  });
}

/**
 * Cove's permission check (CovePrincipal.Has): '*', the exact key,
 * '<resource>.*' or '*.<verb>'.
 */
function hasPermission(perms, permission) {
  if (!Array.isArray(perms)) return false;
  if (perms.includes('*') || perms.includes(permission)) return true;
  const dot = permission.indexOf('.');
  if (dot < 0) return false;
  return perms.includes(`${permission.slice(0, dot)}.*`) || perms.includes(`*.${permission.slice(dot + 1)}`);
}

module.exports = {
  VAULT_AI_TAG,
  FIXED_FIELDS,
  COLLECTION_FIELD,
  vaultKind,
  slashPath,
  normPath,
  baseName,
  parseMaps,
  applyMaps,
  getField,
  isFieldSet,
  normalizeCoveItem,
  buildCoveIndex,
  matchItems,
  parseJsonArray,
  cleanList,
  titleCase,
  slugKey,
  elementField,
  notesText,
  coveRating,
  desiredForRow,
  planChanges,
  isEmptyPlan,
  needsEngagement,
  collectionGroupNames,
  uniqueGroupNames,
  unsafeFieldReplace,
  fieldReplaceBlocker,
  mapHits,
  hasPermission,
};
