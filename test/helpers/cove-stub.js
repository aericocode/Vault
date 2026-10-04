/**
 * Shared Cove test fixtures: a stub Cove HTTP server on a random loopback port
 * and a small Vault library. Used by test/cove-export.test.js (the command
 * line) and test/cove-routes.test.js (the Settings routes).
 *
 * The stub mimics the routes and shapes checked in Cove's source
 * (Cove.Api/Controllers, Cove.Core/DTOs), including the parts that bite: the
 * audio list carries no custom fields, PUT /images/{id} REPLACES the item's
 * custom fields, the item update would replace tags (so the stub rejects
 * tagIds there), list pages cap at 250, and video lists answer totalCount -1
 * with skipCount.
 */

const path = require('node:path');
const http = require('node:http');

const TOKEN = 'test-token';

// ---------------------------------------------------------------------------
// Vault library fixture
// ---------------------------------------------------------------------------

/** A fresh library file with the tables the export reads, filled by fillLibrary. */
function buildLibrary(file, key) {
  const D = key ? require('better-sqlite3-multiple-ciphers') : require('better-sqlite3');
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
  fillLibrary(db);
  db.close();
}

/** The fixture rows, into an open library whose tables already exist (here or Vault's own schema). */
function fillLibrary(db) {
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
    // Cove's whole config (a slice of the real shape is enough: PUT replaces all of it).
    config: {
      covePaths: [{ path: '/other', excludeVideo: false, excludeImage: true, excludeAudio: false, excludeText: false }],
      generatedPath: '/data/generated', host: '0.0.0.0', port: 5073, maxParallelTasks: 3,
      downloaderSiteCredentials: [{ id: 'c1', site: 'example.com', username: 'me', password: 'stored-secret', hasPassword: true }],
      videoExtensions: ['.mp4', '.mkv'], imageExtensions: ['.gif', '.jpg'], audioExtensions: ['.mp3'],
      excludePatterns: ['*.tmp'], ui: { title: 'My Cove', keybindingOverrides: { play: 'k' } },
      security: { enabled: true, username: 'owner', knownProxies: [], trustedHosts: [] },
      pluginConfigurations: { p1: { a: 1 } }, disabledPlugins: ['x'],
    },
    // Scans: POST /api/metadata/scan bodies, and Cove jobs by id. A job completes after
    // scanPolls GETs (or ends as scanOutcome); onScanComplete(body) can add the files it "found".
    scans: [],
    jobs: new Map(),
    scanPolls: 2,
    scanOutcome: 'completed',
    onScanComplete: null,
    scanStaysPending: false,      // jobs never leave Cove's queue
    jobsForgotten: false,         // GET/DELETE /api/jobs/{id} answer 404
    cancelFails: false,           // DELETE /api/jobs/{id} is refused
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
    if (method === 'GET' && p === '/api/system/status') return [200, { version: '1.5.0-test', databasePath: 'x', authEnabled: !loginOff }];
    // Like SystemController: GET never returns downloader passwords; PUT replaces the whole
    // config, keeping a stored password (by credential id) when the save leaves it out.
    if (p === '/api/system/config' && method === 'GET') {
      const c = JSON.parse(JSON.stringify(s.config));
      c.downloaderSiteCredentials = c.downloaderSiteCredentials.map(x => ({ ...x, password: null }));
      return [200, c];
    }
    if (p === '/api/system/config' && method === 'PUT') {
      const stored = new Map(s.config.downloaderSiteCredentials.map(x => [x.id, x.password]));
      const next = JSON.parse(JSON.stringify(body));
      next.downloaderSiteCredentials = (next.downloaderSiteCredentials || []).map(x => ({ ...x, password: x.password || stored.get(x.id) || '' }));
      s.config = next;
      return route('GET', p, q, null);
    }
    if (method === 'POST' && p === '/api/metadata/scan') {
      const id = `job-${s.nextId++}`;
      s.scans.push(body);
      s.jobs.set(id, { id, type: 'scan', status: 'pending', progress: 0, polls: 0, body, unitsTotal: 10, unitsCompleted: 0 });
      return [200, { jobId: id }];
    }
    if ((m = p.match(/^\/api\/jobs\/([^/]+)$/))) {
      const j = s.jobs.get(decodeURIComponent(m[1]));
      if (!j || s.jobsForgotten) return [404, null];
      if (method === 'DELETE') {
        if (s.permissions && !s.permissions.includes('*') && !s.permissions.includes('jobs.cancel')) return [403, { error: 'forbidden' }];
        if (s.cancelFails) return [409, { error: 'job cannot be cancelled now' }];
        j.status = 'cancelled';
        return [200, null];
      }
      if (method === 'GET') {
        if (s.scanStaysPending && j.status === 'pending') return [200, { id: j.id, type: 'scan', status: 'pending', progress: 0 }];
        if (j.status === 'pending' || j.status === 'running') {
          j.polls++;
          j.status = 'running';
          j.unitsCompleted = Math.min(10, j.polls * 4);
          j.progress = j.unitsCompleted / 10;
          if (j.polls >= s.scanPolls) {
            j.status = s.scanOutcome;
            if (j.status === 'failed') j.error = 'disk on fire';
            if (j.status === 'completed' && s.onScanComplete) s.onScanComplete(j.body);
          }
        }
        const { polls, body: _b, ...dto } = j;
        return [200, { ...dto, etaSeconds: j.status === 'running' ? 3 : null }];
      }
    }
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
    req.on('end', async () => {
      // A test can hold every request on a promise (s.hold) to catch a job mid-run.
      if (s.hold) await s.hold;
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

module.exports = { TOKEN, buildLibrary, fillLibrary, createStub, writesOf };
