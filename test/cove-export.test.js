/**
 * `vault export-cove` end to end, against a stub Cove HTTP server on a random
 * loopback port and a temp Vault library built here. The stub mimics the
 * routes and shapes checked in Cove's source (Cove.Api/Controllers,
 * Cove.Core/DTOs), including the parts that bite: the audio list carries no
 * custom fields, PUT /images/{id} REPLACES the item's custom fields, the item
 * update would replace tags (so the stub rejects tagIds there), list pages cap
 * at 250, and video lists answer totalCount -1 with skipCount.
 *
 * Covered: the dry run sends only GETs; --apply writes the additive plan and
 * leaves Cove's own values alone; a second --apply sends no writes at all;
 * the library file is never written; an encrypted library works with its
 * password; a leftover -journal is refused with every file untouched; the CLI
 * wiring writes its report.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-cove-'));
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';           // loopback must still work
delete process.env.VAULT_DB_PASSWORD;

const Plain = require('better-sqlite3');
let Cipher = null;
try { Cipher = require('better-sqlite3-multiple-ciphers'); } catch { /* encrypted case skipped */ }
const { exportCove, parseArgs } = require('../commands/export-cove');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = 'test-token';
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const md5 = (p) => (fs.existsSync(p) ? crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') : 'absent');

// ---------------------------------------------------------------------------
// Vault library fixture
// ---------------------------------------------------------------------------

function buildLibrary(file, key) {
  const D = key ? Cipher : Plain;
  const db = new D(file);
  if (key) db.pragma(`key='${key.replace(/'/g, "''")}'`);
  db.exec(`
    CREATE TABLE media (
      id INTEGER PRIMARY KEY AUTOINCREMENT, filepath TEXT UNIQUE NOT NULL, filename TEXT NOT NULL,
      media_type TEXT NOT NULL, duration_seconds REAL, filesize_bytes INTEGER,
      language TEXT, themes TEXT, explicit INTEGER DEFAULT 0, locations TEXT, quality_flag TEXT,
      description TEXT, tags TEXT, content_type TEXT, media_elements TEXT, processed_at TEXT,
      user_notes TEXT DEFAULT '', user_starred INTEGER DEFAULT 0, user_rating INTEGER DEFAULT 0,
      user_trashed INTEGER DEFAULT 0, last_position REAL DEFAULT 0, view_count INTEGER DEFAULT 0, embedding BLOB);
    CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '',
      parent_id INTEGER, kind TEXT NOT NULL DEFAULT 'collection', sort_order INTEGER DEFAULT 0);
    CREATE TABLE collection_items (collection_id INTEGER NOT NULL, media_id INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (collection_id, media_id));
    CREATE TABLE saved_searches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    INSERT INTO saved_searches (name) VALUES ('my search');
  `);
  const ins = db.prepare(`INSERT INTO media (id, filepath, filename, media_type, filesize_bytes, duration_seconds, language,
    themes, explicit, locations, quality_flag, description, tags, content_type, media_elements, processed_at,
    user_notes, user_starred, user_rating, user_trashed, last_position)
    VALUES (@id, @filepath, @filename, @media_type, @size, 120, @language, @themes, @explicit, @locations, @quality_flag,
    @description, @tags, @content_type, @media_elements, @processed_at, @user_notes, @user_starred, @user_rating,
    @user_trashed, @last_position)`);
  const base = { language: null, themes: null, explicit: 0, locations: null, quality_flag: null, description: null,
    tags: null, content_type: null, media_elements: null, processed_at: null, user_notes: '', user_starred: 0,
    user_rating: 0, user_trashed: 0, last_position: 0 };
  const add = (o) => ins.run({ ...base, filename: path.win32.basename(o.filepath), ...o });
  add({ id: 1, filepath: 'D:\\Media\\clip one.mp4', media_type: 'video', size: 1000,
    tags: JSON.stringify(['Beach', 'Sunset']), description: 'Vault description',
    themes: JSON.stringify(['summer', 'travel']), locations: JSON.stringify(['coast']),
    media_elements: JSON.stringify([{ type: 'camera', details: 'wide' }, { type: 'camera', details: 'pan' }]),
    language: 'English', explicit: 1, processed_at: '2026-01-01', content_type: 'vlog', quality_flag: 'good',
    user_notes: JSON.stringify([{ text: 'note one' }, { text: 'note two' }]), user_rating: 4, user_starred: 1, last_position: 30 });
  add({ id: 2, filepath: 'D:\\Media\\renamed.mp4', media_type: 'video', size: 2000,
    description: 'should not replace', user_rating: 5, processed_at: '2026-01-01' });
  add({ id: 3, filepath: 'D:\\Media\\pic.gif', media_type: 'gif', size: 3000, tags: JSON.stringify(['Beach']) });
  add({ id: 4, filepath: 'D:\\Media\\song.mp3', media_type: 'audio', size: 4000, tags: JSON.stringify(['Chill']),
    user_notes: 'old plain note' });
  add({ id: 5, filepath: 'D:\\Media\\trashed.mp4', media_type: 'video', size: 5000, user_trashed: 1 });
  add({ id: 6, filepath: 'D:\\Media\\doc.pdf', media_type: 'document', size: 6000 });
  add({ id: 7, filepath: 'D:\\Media\\missing.mp4', media_type: 'video', size: 7000 });
  db.exec(`
    INSERT INTO collections (id, name, parent_id, kind) VALUES (1, 'Trips', NULL, 'folder'), (2, 'Beach Day', 1, 'collection'),
      (3, 'Existing', NULL, 'collection'), (4, 'Nothing matched', NULL, 'collection'),
      (5, 'Dup', NULL, 'collection'), (6, 'Dup', NULL, 'collection');
    INSERT INTO collection_items (collection_id, media_id, position) VALUES (2, 7, 0), (2, 3, 1), (2, 1, 2),
      (3, 1, 0), (3, 4, 1), (4, 7, 0), (5, 1, 0), (6, 3, 0);
  `);
  db.close();
}

// ---------------------------------------------------------------------------
// Stub Cove
// ---------------------------------------------------------------------------

function createStub({ loginOff = false } = {}) {
  const s = {
    requests: [],
    failOnce: new Set(),          // "METHOD path" answered 503 once
    nextId: 1000,
    tags: [
      { id: 1, name: 'Keep', aliases: [], parentIds: [] },
      { id: 2, name: 'beach', aliases: [], parentIds: [] },
      { id: 3, name: 'Relaxed', aliases: ['chill'], parentIds: [] },
    ],
    fields: [
      { id: 1, key: 'user_field', label: 'User field', type: 'text', entityTypes: ['image'], isMultiValue: false, filterable: true },
      { id: 2, key: 'user_group_note', label: 'Group note', type: 'text', entityTypes: ['group'], isMultiValue: false, filterable: true },
    ],
    media: { video: new Map(), image: new Map(), audio: new Map() },
    engagement: new Map(),
    groups: [{ id: 1, name: 'Existing', kind: 'static', customFields: {},
      items: [{ id: 1, hostType: 'video', hostId: 101, orderIndex: 0 }] }],
  };
  const media = (kind, o) => s.media[kind].set(o.id, { details: null, tagIds: [], customFields: {}, parentVideoId: null, ...o });
  media('video', { id: 101, files: [{ path: '/media/clip one.mp4', size: 1000 }], tagIds: [1] });
  media('video', { id: 102, files: [{ path: '/other/renamed.mp4', size: 2000 }], details: 'User details' });
  media('video', { id: 103, parentVideoId: 101, files: [{ path: '/media/clip one.mp4', size: 1000 }] });
  // Enough filler to need a second page.
  for (let i = 0; i < 300; i++) media('video', { id: 2000 + i, files: [{ path: `/media/filler/${i}.mp4`, size: i }] });
  media('image', { id: 201, files: [{ path: '/media/pic.gif', size: 3000 }], customFields: {} });
  media('audio', { id: 301, files: [{ path: '/media/song.mp3', size: 4000 }] });
  s.engagement.set('video|102', { isFavorite: false, rating: 60, resumeTime: 0 });

  // Like Cove's GetValuesAsync: a single-value field shows only its FIRST stored
  // value, even when more rows are still stored (left over from multi-value).
  const visible = (fields) => {
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
      const def = s.fields.find(f => f.key.toLowerCase() === k.toLowerCase());
      out[k] = Array.isArray(v) && def && !def.isMultiValue ? v[0] : v;
    }
    return Object.keys(out).length ? out : null;
  };
  const tagDto = (t) => ({ id: t.id, name: t.name, aliases: t.aliases });
  const fieldFor = (key) => s.fields.find(f => f.key.toLowerCase() === key.toLowerCase());
  const mediaDto = (kind, m, { list = false } = {}) => ({
    id: m.id, title: null, details: m.details,
    tags: m.tagIds.map(id => tagDto(s.tags.find(t => t.id === id))),
    files: m.files.map((f, i) => ({ id: m.id * 10 + i, path: f.path, basename: f.path.split('/').pop(), size: f.size })),
    // Cove's audio LIST has no custom fields; its detail and the other kinds do.
    customFields: kind === 'audio' && list ? null : visible(m.customFields),
    ...(kind === 'video' ? { parentVideoId: m.parentVideoId } : {}),
  });
  const page = (all, q, { skipCount = false } = {}) => {
    const p = Math.max(1, Number(q.get('page') || 1));
    const per = Math.min(250, Math.max(1, Number(q.get('perPage') || 25)));
    return { items: all.slice((p - 1) * per, p * per), totalCount: skipCount ? -1 : all.length, page: p, perPage: per };
  };
  const eng = (kind, id) => s.engagement.get(`${kind}|${id}`) || { isFavorite: false, rating: null, resumeTime: 0 };
  const setEng = (kind, id, patch) => s.engagement.set(`${kind}|${id}`, { ...eng(kind, id), ...patch });
  const applyFields = (kind, m, fields, replace) => {
    if (replace) m.customFields = {};
    for (const [k, v] of Object.entries(fields)) {
      const def = fieldFor(k);
      if (!def || !def.entityTypes.includes(kind)) return `Custom field '${k}' is not defined for ${kind} entities.`;
      if (Array.isArray(v) && !def.isMultiValue) return `Custom field '${k}' takes one value.`;
      m.customFields[def.key] = v;
    }
    return null;
  };

  function route(method, p, q, body) {
    let m;
    if (method === 'GET' && p === '/api/auth/me') return [200, { user: { id: '1', username: 'owner', kind: 'user' }, permissions: s.permissions || ['*'] }];
    if (method === 'GET' && p === '/api/system/status') return [200, { version: '1.5.0-test', databasePath: 'x' }];
    if ((m = p.match(/^\/api\/(video|image|audio)s$/)) && method === 'GET') {
      const kind = m[1];
      const all = [...s.media[kind].values()].map(x => mediaDto(kind, x, { list: true }));
      return [200, page(all, q, { skipCount: kind === 'video' && q.get('skipCount') === 'true' })];
    }
    if ((m = p.match(/^\/api\/(video|image|audio)s\/(\d+)$/))) {
      const kind = m[1];
      const item = s.media[kind].get(Number(m[2]));
      if (!item) return [404, null];
      if (method === 'GET') return [200, mediaDto(kind, item)];
      if (method === 'PUT') {
        if (body.tagIds) return [400, { error: 'stub: the item update replaces tags; use bulk add' }];
        if (body.details != null) item.details = body.details;
        if (body.customFields) {
          if (kind !== 'image') return [400, { error: 'stub: expected custom fields through bulk for this kind' }];
          // Cove replaces the whole set here, and silently drops keys not defined for the kind.
          const next = {};
          for (const [k, v] of Object.entries(body.customFields)) {
            const def = fieldFor(k);
            if (def && def.entityTypes.includes(kind)) next[def.key] = v;
          }
          item.customFields = next;
        }
        return [200, mediaDto(kind, item)];
      }
    }
    if ((m = p.match(/^\/api\/(video|image|audio)s\/bulk$/)) && method === 'POST') {
      const kind = m[1];
      if (body.tagIds && body.tagMode !== 'add') return [400, { error: 'stub: tags must be added, not set' }];
      if (body.customFields && kind === 'image') return [400, { error: 'stub: image bulk has no custom fields' }];
      if (body.details != null && kind === 'video') return [400, { error: 'stub: video bulk has no details' }];
      for (const id of body.ids) {
        const item = s.media[kind].get(id);
        if (!item) continue;
        if (body.tagIds) for (const t of body.tagIds) if (!item.tagIds.includes(t)) item.tagIds.push(t);
        if (body.details != null) item.details = body.details;
        if (body.customFields) {
          const err = applyFields(kind, item, body.customFields, false);
          if (err) return [400, { error: err }];
        }
      }
      return [200, { ids: body.ids }];
    }
    if (method === 'GET' && p === '/api/tags') return [200, page(s.tags.map(tagDto), q)];
    if ((m = p.match(/^\/api\/tags\/(\d+)$/))) {
      const t = s.tags.find(x => x.id === Number(m[1]));
      if (!t) return [404, null];
      if (method === 'PUT') return [400, { error: 'stub: the tag update replaces parents; use bulk add' }];
      return [200, { ...tagDto(t), parents: t.parentIds.map(id => tagDto(s.tags.find(x => x.id === id))), children: [] }];
    }
    if (method === 'POST' && p === '/api/tags/bulk') {
      if (body.parentMode !== 'add') return [400, { error: 'stub: parents must be added' }];
      for (const id of body.ids) {
        const t = s.tags.find(x => x.id === id);
        if (t) for (const pid of body.parentIds) if (pid !== id && !t.parentIds.includes(pid)) t.parentIds.push(pid);
      }
      return [200, { ids: body.ids }];
    }
    if (method === 'POST' && p === '/api/tags') {
      const n = body.name.toLowerCase();
      if (s.tags.some(t => t.name.toLowerCase() === n || t.aliases.some(a => a.toLowerCase() === n))) {
        return [409, { message: 'A tag with that name or alias already exists.' }];
      }
      const t = { id: s.nextId++, name: body.name, aliases: [], parentIds: body.parentIds || [] };
      s.tags.push(t);
      return [201, { ...tagDto(t), parents: [], children: [] }];
    }
    if (p === '/api/custom-fields' && method === 'GET') return [200, s.fields];
    if (p === '/api/custom-fields' && method === 'POST') {
      if (fieldFor(body.key)) return [400, { error: 'A custom field with that key already exists.' }];
      const f = { id: s.nextId++, key: body.key, label: body.label, type: body.type, entityTypes: body.entityTypes,
        isMultiValue: !!body.isMultiValue && body.type !== 'longText', filterable: body.type === 'longText' ? false : body.filterable !== false };
      s.fields.push(f);
      return [201, f];
    }
    if ((m = p.match(/^\/api\/custom-fields\/(\d+)$/)) && method === 'PUT') {
      const f = s.fields.find(x => x.id === Number(m[1]));
      if (body.entityTypes) f.entityTypes = body.entityTypes;
      return [200, f];
    }
    if ((m = p.match(/^\/api\/engagement\/(video|image|audio)\/(\d+)(\/rating|\/favorite)?$/))) {
      const [, kind, idStr, sub] = m;
      const id = Number(idStr);
      if (method === 'GET' && !sub) return [200, { hostId: id, ...eng(kind, id) }];
      if (method === 'PUT' && sub === '/rating') {
        if (body.aspect !== 'overall' || body.value < 0 || body.value > 100) return [400, null];
        setEng(kind, id, { rating: body.value });
        return [200, { hostId: id, ...eng(kind, id) }];
      }
      if (method === 'PUT' && sub === '/favorite') { setEng(kind, id, { isFavorite: body.isFavorite }); return [200, { hostId: id, ...eng(kind, id) }]; }
    }
    if (method === 'POST' && p === '/api/playback/intervals') {
      setEng(body.hostType, body.hostId, { resumeTime: body.currentPositionSec });
      return [204, null];
    }
    const groupDto = (g) => ({ id: g.id, name: g.name, kind: g.kind, customFields: visible(g.customFields) });
    if (method === 'GET' && p === '/api/groups') return [200, page(s.groups.map(groupDto), q)];
    if (method === 'POST' && p === '/api/groups') {
      const g = { id: s.nextId++, name: body.name, kind: body.kind || 'static', customFields: {}, items: [] };
      // Cove saves the values after creating; keys without a group definition are dropped silently.
      for (const [k, v] of Object.entries(body.customFields || {})) {
        const def = fieldFor(k);
        if (def && def.entityTypes.includes('group')) g.customFields[def.key] = v;
      }
      s.groups.push(g);
      return [201, groupDto(g)];
    }
    if ((m = p.match(/^\/api\/groups\/(\d+)$/))) {
      const g = s.groups.find(x => x.id === Number(m[1]));
      if (!g) return [404, null];
      if (method === 'GET') return [200, groupDto(g)];
      if (method === 'PUT') {
        if (body.customFields) {
          const next = {};
          for (const [k, v] of Object.entries(body.customFields)) {
            const def = fieldFor(k);
            if (def && def.entityTypes.includes('group')) next[def.key] = v;   // the rest is lost, as in Cove
          }
          g.customFields = next;
        }
        return [200, groupDto(g)];
      }
    }
    if ((m = p.match(/^\/api\/groups\/(\d+)\/items$/))) {
      const g = s.groups.find(x => x.id === Number(m[1]));
      if (!g) return [404, null];
      if (method === 'GET') return [200, g.items.map(it => ({ ...it, groupId: g.id }))];
      if (method === 'POST') {
        const it = { id: s.nextId++, hostType: body.hostType, hostId: body.hostId, kind: body.kind, orderIndex: Math.min(body.orderIndex, g.items.length) };
        g.items.splice(it.orderIndex, 0, it);
        return [201, it];
      }
    }
    return [404, { error: `stub: no route ${method} ${p}` }];
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : null;
      s.requests.push({ method: req.method, path: u.pathname, query: u.search, body, auth: req.headers.authorization });
      const send = (status, data) => {
        res.writeHead(status, data == null ? {} : { 'Content-Type': 'application/json' });
        res.end(data == null ? undefined : JSON.stringify(data));
      };
      const auth = req.headers.authorization;
      // Login off (Cove's default): a local request without a token is the owner. A wrong token is still refused.
      if (auth ? auth !== `Bearer ${TOKEN}` : !loginOff) return send(401, { code: 'UNAUTHORIZED' });
      const once = `${req.method} ${u.pathname}`;
      if (s.failOnce.has(once)) { s.failOnce.delete(once); return send(503, { error: 'busy' }); }
      if (s.beforeRequest) s.beforeRequest(req.method, u.pathname, u.searchParams);
      const [status, data] = route(req.method, u.pathname, u.searchParams, body);
      send(status, data);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    s.url = `http://127.0.0.1:${server.address().port}`;
    s.close = () => new Promise(r => server.close(r));
    resolve(s);
  }));
}

const writesOf = (s) => s.requests.filter(r => r.method !== 'GET');
const run = (s, dbPath, extra = {}) => exportCove({
  coveUrl: s.url, token: TOKEN, dbPath, maps: ['D:\\Media=/media'], retryBaseMs: 1, ...extra,
});

// ---------------------------------------------------------------------------

test('dry run, apply, and a second apply that changes nothing', async (t) => {
  const dbPath = path.join(tmp, 'plain.db');
  buildLibrary(dbPath);
  const before = md5(dbPath);
  const stub = await createStub();
  t.after(() => stub.close());

  // --- dry run: reads only -------------------------------------------------
  const dry = await run(stub, dbPath);
  assert.deepStrictEqual(writesOf(stub), [], 'a dry run sends nothing but GET');
  assert.ok(stub.requests.some(r => r.path === '/api/auth/me') && stub.requests.some(r => r.path === '/api/system/status'));
  assert.ok(stub.requests.filter(r => r.path === '/api/videos').length >= 2, 'video list paged past 250');
  const s = dry.summary;
  assert.strictEqual(s.mode, 'dry run');
  assert.deepStrictEqual(s.matched.byKind, { video: 2, image: 1, audio: 1 });
  assert.strictEqual(s.matched.byPath, 3);
  assert.strictEqual(s.matched.byNameSize, 1);
  assert.strictEqual(s.vault.trashed, 1);
  assert.strictEqual(s.vault.unsupported, 1);
  assert.strictEqual(s.unmatched, 1);
  assert.strictEqual(s.items.changed, 4);
  assert.strictEqual(s.tagsCreated, 2, 'Vault AI and Sunset');
  assert.strictEqual(s.tagsGivenParent, 2, 'beach and Relaxed');
  assert.strictEqual(s.groupsCreated, 3, 'Trips / Beach Day, Dup, Dup (2)');
  assert.strictEqual(s.groupItemsAdded, 5);
  assert.deepStrictEqual(dry.report.warnings, []);
  assert.strictEqual(s.errors, 0);
  assert.deepStrictEqual(dry.report.unmatched.map(u => u.vaultId), [7]);
  assert.deepStrictEqual(dry.report.skipped.unsupported.map(u => u.vaultId), [6]);
  assert.strictEqual(dry.report.notCarriedOver.savedSearches, 1);
  const plan1 = dry.report.planned.find(p => p.vaultId === 1);
  assert.deepStrictEqual(plan1.changes.addTags, ['Beach', 'Sunset']);
  assert.strictEqual(plan1.changes.rating, 80);
  assert.strictEqual(stub.tags.length, 3, 'nothing created');

  // --- apply ---------------------------------------------------------------
  stub.requests.length = 0;
  stub.failOnce.add('GET /api/tags');       // retried, not fatal
  stub.failOnce.add('POST /api/videos/bulk');
  const done = await run(stub, dbPath, { apply: true });
  assert.strictEqual(done.summary.errors, 0, JSON.stringify(done.report.errors));
  assert.strictEqual(stub.failOnce.size, 0, 'both 503s were hit and retried');

  const vaultAi = stub.tags.find(x => x.name === 'Vault AI');
  const sunset = stub.tags.find(x => x.name === 'Sunset');
  assert.ok(vaultAi && sunset);
  assert.deepStrictEqual(sunset.parentIds, [vaultAi.id]);
  assert.deepStrictEqual(stub.tags.find(x => x.id === 2).parentIds, [vaultAi.id], 'existing "beach" reused and given the parent');
  assert.deepStrictEqual(stub.tags.find(x => x.id === 3).parentIds, [vaultAi.id], 'alias "chill" resolved to Relaxed');
  assert.deepStrictEqual(stub.tags.find(x => x.id === 1).parentIds, [], 'unrelated user tag untouched');
  assert.strictEqual(stub.tags.filter(x => x.name.toLowerCase() === 'beach').length, 1, 'no duplicate tag');

  const v1 = stub.media.video.get(101);
  assert.deepStrictEqual(v1.tagIds.sort((a, b) => a - b), [1, 2, sunset.id].sort((a, b) => a - b), 'existing tag kept');
  assert.strictEqual(v1.details, 'Vault description');
  assert.deepStrictEqual(v1.customFields, {
    vault_id: 1, vault_ai_themes: ['summer', 'travel'], vault_ai_locations: ['coast'], vault_ai_camera: 'wide; pan',
    vault_ai_language: 'English', vault_ai_content_type: 'vlog', vault_ai_quality_flag: 'good',
    vault_ai_explicit: true, vault_notes: 'note one\n\nnote two',
  });
  const v2 = stub.media.video.get(102);
  assert.strictEqual(v2.details, 'User details', 'Cove details not overwritten');
  assert.strictEqual(v2.customFields.vault_id, 2);
  assert.strictEqual(stub.engagement.get('video|102').rating, 60, 'Cove rating not overwritten');
  assert.deepStrictEqual(stub.media.video.get(103).customFields, {}, 'the clip sharing the file is left alone');

  assert.deepStrictEqual(stub.media.image.get(201).customFields, { vault_id: 3 });
  assert.deepStrictEqual(stub.media.image.get(201).tagIds, [2]);
  const a1 = stub.media.audio.get(301);
  assert.deepStrictEqual(a1.tagIds, [3]);
  assert.deepStrictEqual(a1.customFields, { vault_id: 4, vault_notes: 'old plain note' });

  assert.deepStrictEqual(stub.engagement.get('video|101'), { isFavorite: true, rating: 80, resumeTime: 0 });
  assert.ok(!stub.requests.some(r => r.path === '/api/playback/intervals'), 'no playback history without --resume');

  const notes = stub.fields.find(f => f.key === 'vault_notes');
  assert.strictEqual(notes.type, 'longText');
  assert.deepStrictEqual(stub.fields.find(f => f.key === 'vault_id').entityTypes, ['video', 'image', 'audio']);
  assert.strictEqual(stub.fields.find(f => f.key === 'vault_ai_themes').isMultiValue, true);
  assert.deepStrictEqual(stub.fields.find(f => f.key === 'user_field').entityTypes, ['image'], 'user field not altered');

  const trip = stub.groups.find(g => g.name === 'Trips / Beach Day');
  assert.deepStrictEqual(trip.items.map(i => `${i.hostType}:${i.hostId}`), ['image:201', 'video:101'], 'collection order kept');
  assert.deepStrictEqual(trip.customFields, { vault_collection_id: 2 }, 'created groups carry their stamp');
  const existing = stub.groups.find(g => g.name === 'Existing');
  assert.deepStrictEqual(existing.items.map(i => `${i.hostType}:${i.hostId}`), ['video:101', 'audio:301'], 'only the missing item appended');
  assert.deepStrictEqual(existing.customFields, { vault_collection_id: 3 }, 'matched by name and stamped');
  assert.ok(!stub.groups.some(g => g.name === 'Nothing matched'), 'no empty group');
  const dups = stub.groups.filter(g => g.name.startsWith('Dup')).map(g => [g.name, g.customFields.vault_collection_id, g.items.map(i => i.hostId)]);
  assert.deepStrictEqual(dups, [['Dup', 5, [101]], ['Dup (2)', 6, [201]]], 'same-name collections get distinct groups, by collection id');
  const collField = stub.fields.find(f => f.key === 'vault_collection_id');
  assert.deepStrictEqual(collField.entityTypes, ['group']);
  assert.ok(stub.requests.some(r => r.path === '/api/tags/bulk' && r.body.parentMode === 'add'));
  assert.ok(stub.requests.some(r => r.method === 'GET' && r.path === '/api/images/201' && /fresh=/.test(r.query)), 'image read fresh before its PUT');

  // Renaming groups in Cove changes nothing: they are found by their stamp.
  existing.name = 'Renamed by user';
  stub.groups.find(g => g.name === 'Dup').name = 'Also renamed';

  // --- second apply: nothing left to do --------------------------------------
  stub.requests.length = 0;
  const again = await run(stub, dbPath, { apply: true });
  assert.deepStrictEqual(writesOf(stub).map(r => `${r.method} ${r.path}`), [], 'second run sends no writes');
  assert.strictEqual(again.summary.items.changed, 0);
  assert.strictEqual(again.summary.items.upToDate, 4);
  assert.strictEqual(again.summary.matched.byVaultId, 4, 'recognised by the vault_id stamp');
  assert.strictEqual(stub.groups.length, 4, 'no group made twice');

  // --- --resume adds one playback session where Cove has no resume point ----
  stub.requests.length = 0;
  const resumed = await run(stub, dbPath, { apply: true, resume: true });
  assert.strictEqual(resumed.summary.resumePointsSet, 1);
  const pb = stub.requests.filter(r => r.path === '/api/playback/intervals');
  assert.strictEqual(pb.length, 1);
  assert.deepStrictEqual({ ...pb[0].body, sessionId: 'x' }, { hostType: 'video', hostId: 101, sessionId: 'x', mediaDurationSec: 120,
    currentPositionSec: 30, state: 'paused', intervals: [] });

  assert.strictEqual(md5(dbPath), before, 'the Vault library was never written');
  assert.ok(!fs.existsSync(dbPath + '-journal'));
});

test('token problems stop before any write', async (t) => {
  const dbPath = path.join(tmp, 'token.db');
  buildLibrary(dbPath);
  const stub = await createStub();
  t.after(() => stub.close());
  await assert.rejects(run(stub, dbPath, { token: 'wrong' }), /rejected the token/);
  await assert.rejects(run(stub, dbPath, { token: '' }),
    (e) => e.code === 'NO_TOKEN' && e.message === 'Cove has login turned on. Create a token under Settings > Security & access > API tokens and set COVE_TOKEN.');
  await assert.rejects(exportCove({ coveUrl: 'http://cove.example.com:5073', token: TOKEN, dbPath }), /VAULT_OFFLINE/);
  assert.deepStrictEqual(writesOf(stub), []);
});

test('a read-only (dry run) client refuses to send anything but GET', async () => {
  const { CoveClient } = require('../lib/cove/client');
  let sent = 0;
  const c = new CoveClient({ baseUrl: 'http://127.0.0.1:1', token: TOKEN, readOnly: true, fetch: async () => { sent++; throw new Error('no'); } });
  await assert.rejects(c.post('/api/tags', { name: 'x' }), /Dry run tried to send POST/);
  await assert.rejects(c.put('/api/tags/1', {}), /Dry run tried to send PUT/);
  assert.strictEqual(sent, 0);
});

test('a leftover -journal is refused and every file is left exactly as it was', async (t) => {
  const dbPath = path.join(tmp, 'hot.db');
  buildLibrary(dbPath);
  // A journal header is enough: the command must refuse on sight, not interpret it.
  fs.writeFileSync(dbPath + '-journal', Buffer.concat([Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]), crypto.randomBytes(4088)]));
  const before = [md5(dbPath), md5(dbPath + '-journal')];
  const stub = await createStub();
  t.after(() => stub.close());
  await assert.rejects(run(stub, dbPath, { apply: true }), (e) => e.code === 'HOT_JOURNAL' && /Vault is running or did not close cleanly/.test(e.message));
  assert.deepStrictEqual([md5(dbPath), md5(dbPath + '-journal')], before);
  assert.strictEqual(stub.requests.length, 0, 'Cove never contacted');
});

test('an encrypted library opens with its password, read-only', { skip: Cipher ? false : 'better-sqlite3-multiple-ciphers is not installed' }, async (t) => {
  const dbPath = path.join(tmp, 'enc.db');
  const KEY = "s3cret'quote";
  buildLibrary(dbPath, KEY);
  const before = md5(dbPath);
  const stub = await createStub();
  t.after(() => stub.close());

  await assert.rejects(run(stub, dbPath), (e) => e.code === 'DB_ENCRYPTED' && /VAULT_DB_PASSWORD/.test(e.message));
  await assert.rejects(run(stub, dbPath, { password: 'wrong' }), /password is wrong/);
  const lines = [];
  const r = await run(stub, dbPath, { password: KEY, log: (l) => lines.push(l) });
  assert.strictEqual(r.summary.matched.byKind.video, 2);
  assert.ok(lines.some(l => /encrypted/.test(l) && /without encryption/.test(l)), 'warns that Cove stores it unencrypted');
  assert.deepStrictEqual(writesOf(stub), []);
  assert.strictEqual(md5(dbPath), before);
});

test('CLI: arguments, and the dry run writes its report', async (t) => {
  assert.deepStrictEqual(parseArgs(['--cove', 'http://h:1', '--map', 'a=b', '--map=c=d', '--limit', '2', '--apply']),
    { apply: true, resume: false, maps: ['a=b', 'c=d'], limit: 2, report: null, cove: 'http://h:1', help: false });
  assert.throws(() => parseArgs(['--token', 'x']), /Unknown option/);
  assert.throws(() => parseArgs(['--limit', 'many']), /whole number/);

  const dbPath = path.join(tmp, 'cli.db');
  buildLibrary(dbPath);
  const stub = await createStub();
  t.after(() => stub.close());
  const reportPath = path.join(tmp, 'report.json');
  const env = { ...process.env, VAULT_DB: dbPath, COVE_TOKEN: TOKEN, VAULT_OFFLINE: '1' };
  const out = await new Promise((resolve, reject) => {
    cp.execFile(process.execPath, ['vault.js', 'export-cove', '--cove', stub.url, '--map', 'D:\\Media=/media',
      '--report', reportPath, '--limit', '1'], { cwd: ROOT, env, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\n${stdout}\n${stderr}`)); else resolve(stdout);
    });
  });
  assert.match(out, /Dry run: nothing was changed in Cove/);
  assert.doesNotMatch(out, /\u2014/, 'no em dashes in user-facing text');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.strictEqual(report.mode, 'dry run');
  assert.strictEqual(report.planned.length, 1, '--limit 1');
  assert.deepStrictEqual(writesOf(stub), []);
});

test('Cove with login off needs no token', async (t) => {
  const dbPath = path.join(tmp, 'nologin.db');
  buildLibrary(dbPath);
  const stub = await createStub({ loginOff: true });
  t.after(() => stub.close());
  const dry = await run(stub, dbPath, { token: null });
  assert.strictEqual(dry.summary.matched.byKind.video, 2);
  assert.deepStrictEqual(writesOf(stub), []);
  const done = await run(stub, dbPath, { token: null, apply: true });
  assert.strictEqual(done.summary.errors, 0, JSON.stringify(done.report.errors));
  assert.strictEqual(stub.media.video.get(101).customFields.vault_id, 1);
  assert.ok(stub.requests.every(r => r.auth === undefined), 'no Authorization header sent');
  // A token that is set but wrong is still refused, login or not.
  await assert.rejects(run(stub, dbPath, { token: 'wrong' }), /rejected the token/);
});

test('custom fields are never written over values the API cannot fully show', async (t) => {
  const dbPath = path.join(tmp, 'imgskip.db');
  buildLibrary(dbPath);
  const stub = await createStub();
  t.after(() => stub.close());
  const putImage = () => stub.requests.filter(r => r.method === 'PUT' && r.path === '/api/images/201');

  // 1. A user field that once was multi-value still stores a hidden second value; Cove shows only the first.
  stub.media.image.get(201).customFields = { user_field: ['keep me', 'hidden'] };
  const dry = await run(stub, dbPath);
  assert.strictEqual(dry.report.skippedFieldWrites.length, 1, 'the dry run already reports it');
  const done = await run(stub, dbPath, { apply: true });
  assert.deepStrictEqual(stub.media.image.get(201).customFields, { user_field: ['keep me', 'hidden'] }, 'hidden value kept');
  assert.strictEqual(putImage().length, 0);
  const skip = done.report.skippedFieldWrites.find(x => x.coveId === 201);
  assert.match(skip.reason, /already has custom fields in Cove \(user_field\); Vault fields were not added so nothing there gets overwritten/);
  assert.deepStrictEqual(stub.media.image.get(201).tagIds, [2], 'the rest of the item still went out');
  stub.requests.length = 0;
  await run(stub, dbPath, { apply: true });
  assert.deepStrictEqual(writesOf(stub), [], 'a re-run counts it as done');

  // 2. A user value that appears between the list and the write: caught by the fresh read.
  stub.media.image.get(201).customFields = {};
  stub.requests.length = 0;
  stub.beforeRequest = (method, p, q) => {
    if (method === 'GET' && p === '/api/images/201' && q.get('fresh')) stub.media.image.get(201).customFields = { user_field: 'just typed' };
  };
  const raced = await run(stub, dbPath, { apply: true });
  stub.beforeRequest = null;
  assert.strictEqual(putImage().length, 0);
  assert.deepStrictEqual(stub.media.image.get(201).customFields, { user_field: 'just typed' });
  assert.ok(raced.report.skippedFieldWrites.some(x => x.coveId === 201));

  // 3. A vault_ field holding a value (here one no longer set up for images,
  // which the replace would drop): any value at all blocks the write.
  stub.fields.push({ id: 3, key: 'vault_old', label: 'Old', type: 'text', entityTypes: ['video'], isMultiValue: false, filterable: true });
  stub.media.image.get(201).customFields = { vault_old: 'precious' };
  stub.requests.length = 0;
  const own = await run(stub, dbPath, { apply: true });
  assert.strictEqual(putImage().length, 0);
  assert.deepStrictEqual(stub.media.image.get(201).customFields, { vault_old: 'precious' });
  assert.match(own.report.skippedFieldWrites.find(x => x.coveId === 201).reason, /already has custom fields in Cove \(vault_old\)/);
});

test('a group matched by name that has its own fields is left unstamped, and still gets its items', async (t) => {
  const dbPath = path.join(tmp, 'grpskip.db');
  buildLibrary(dbPath);
  const stub = await createStub();
  t.after(() => stub.close());
  stub.groups[0].customFields = { user_group_note: ['mine', 'hidden'] };
  const done = await run(stub, dbPath, { apply: true });
  assert.strictEqual(done.summary.errors, 0, JSON.stringify(done.report.errors));
  const g = stub.groups[0];
  assert.deepStrictEqual(g.customFields, { user_group_note: ['mine', 'hidden'] });
  assert.ok(!stub.requests.some(r => r.method === 'PUT' && r.path === '/api/groups/1'));
  assert.deepStrictEqual(g.items.map(i => `${i.hostType}:${i.hostId}`), ['video:101', 'audio:301']);
  assert.match(done.report.skippedFieldWrites.find(x => x.coveGroupId === 1).reason, /already has custom fields/);
  stub.requests.length = 0;
  await run(stub, dbPath, { apply: true });
  assert.deepStrictEqual(writesOf(stub), [], 'found by name again, nothing to add');
});

test('tags: a failing "Vault AI" create is recorded, and its ancestors are never put under it', async (t) => {
  const dbPath = path.join(tmp, 'tags.db');
  buildLibrary(dbPath);
  const stub = await createStub();
  t.after(() => stub.close());
  stub.failOnce.add('POST /api/tags');                // the first create is "Vault AI"
  const first = await run(stub, dbPath, { apply: true });
  assert.ok(first.report.errors.some(e => e.step === 'create tag' && e.tag === 'Vault AI'));
  assert.ok(!stub.tags.some(x => x.name === 'Sunset'), 'no parentless new tags');
  assert.strictEqual(stub.media.video.get(101).customFields.vault_id, 1, 'the rest of the run went on');

  // "Vault AI" now exists under "beach"; "beach" must not be put under "Vault AI".
  stub.tags.push({ id: 50, name: 'Vault AI', aliases: [], parentIds: [2] });
  const second = await run(stub, dbPath, { apply: true });
  assert.strictEqual(second.summary.errors, 0, JSON.stringify(second.report.errors));
  assert.deepStrictEqual(stub.tags.find(x => x.id === 2).parentIds, [], 'no loop made');
  assert.deepStrictEqual(stub.tags.find(x => x.id === 3).parentIds, [50]);
  assert.match(second.report.skippedTagParents.find(x => x.tagId === 2).reason, /loop/);
});

test('missing read permissions are explained one by one', async (t) => {
  const dbPath = path.join(tmp, 'perm.db');
  buildLibrary(dbPath);
  const stub = await createStub();
  t.after(() => stub.close());
  stub.permissions = ['files.read', 'system.read', 'videos.read', 'images.read', 'audios.read'];
  await assert.rejects(run(stub, dbPath), (e) => e.code === 'NO_PERMISSION'
    && /tags\.read \(to find existing tags/.test(e.message) && /groups\.read \(to find groups/.test(e.message)
    && !/file path/.test(e.message));
});

test('a create that fails is not retried; the next run finishes the job without duplicates', async (t) => {
  const dbPath = path.join(tmp, 'noretry.db');
  buildLibrary(dbPath);
  const stub = await createStub();
  t.after(() => stub.close());
  stub.failOnce.add('POST /api/groups');
  const first = await run(stub, dbPath, { apply: true });
  assert.strictEqual(stub.requests.filter(r => r.method === 'POST' && r.path === '/api/groups').length, 3, 'the failed create was sent once');
  assert.strictEqual(first.summary.errors, 1);
  assert.strictEqual(first.report.errors[0].step, 'collection');
  assert.strictEqual(stub.groups.length, 3);
  const second = await run(stub, dbPath, { apply: true });
  assert.strictEqual(second.summary.errors, 0);
  assert.strictEqual(second.summary.groupsCreated, 1);
  assert.strictEqual(stub.groups.length, 4);
  assert.strictEqual(new Set(stub.groups.map(g => g.name.toLowerCase())).size, 4);
});

test('a --map that matches nothing is warned about', async (t) => {
  const dbPath = path.join(tmp, 'map.db');
  buildLibrary(dbPath);
  const stub = await createStub();
  t.after(() => stub.close());
  const lines = [];
  const r = await run(stub, dbPath, { maps: ['D:Media=/media'], log: (l) => lines.push(l) });
  assert.strictEqual(r.report.warnings.length, 1);
  assert.match(r.report.warnings[0], /D:Media=\/media" matches no file/);
  assert.ok(lines.some(l => /^Warning: --map/.test(l)));
});

test('client retries: 429 always, 5xx and dropped connections only when safe to repeat', async () => {
  const { CoveClient } = require('../lib/cove/client');
  const make = (answers) => {
    const calls = [];
    const waits = [];
    const c = new CoveClient({
      baseUrl: 'http://127.0.0.1:1', token: TOKEN, retryBaseMs: 5,
      sleep: async (ms) => { waits.push(ms); },
      fetch: async (url, opts) => {
        calls.push(opts.method);
        const a = answers.shift();
        if (a === 'drop') throw new Error('socket hang up');
        return new Response(a.body == null ? null : JSON.stringify(a.body), { status: a.status, headers: a.headers || {} });
      },
    });
    return { c, calls, waits };
  };
  let t = make([{ status: 429 }, { status: 200, body: { ok: 1 } }]);
  assert.deepStrictEqual(await t.c.post('/api/groups', {}), { ok: 1 });
  assert.deepStrictEqual(t.waits, [60000], 'no Retry-After: wait out the 1-minute window');

  t = make([{ status: 429, headers: { 'Retry-After': '2' } }, { status: 200, body: {} }]);
  await t.c.get('/x');
  assert.deepStrictEqual(t.waits, [2000], 'Retry-After honoured');

  t = make([{ status: 503 }, { status: 200, body: {} }]);
  await assert.rejects(t.c.post('/api/groups', {}), /503/);
  assert.strictEqual(t.calls.length, 1, 'a create is not repeated after a 5xx');

  t = make(['drop', { status: 200, body: {} }]);
  await assert.rejects(t.c.post('/api/groups/1/items', {}), /Could not reach Cove/);
  assert.strictEqual(t.calls.length, 1, 'nor after a dropped connection');

  t = make([{ status: 503 }, 'drop', { status: 200, body: {} }]);
  await t.c.bulkUpdate('video', { ids: [1] });
  assert.strictEqual(t.calls.length, 3, 'bulk add is safe to repeat');

  t = make(['drop', { status: 502 }, { status: 200, body: {} }]);
  await t.c.put('/api/videos/1', {});
  assert.strictEqual(t.calls.length, 3, 'PUT is safe to repeat');
});
