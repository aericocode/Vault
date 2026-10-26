/**
 * Up next (PLAYLISTS_SPEC, build step 4): the pure planner (lib/play-queue.js),
 * the advance rule the player follows (player-lib/up-next-rule.js), the
 * one-transaction writes (db.changePlayQueue) and /api/queue over HTTP,
 * including the lock gate, the request guards and a reopen of the library.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-up-next-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const Q = require('../lib/play-queue');
const Rule = require('../player-lib/up-next-rule');
const db = require('../lib/database');
const vault = require('../lib/vault');
const { app } = require('../server/index');

const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

// ── The planner ────────────────────────────────────────────────────────────

const A = [1, 2, 3, 4];

test('add: to the front or the end, in the order given', () => {
  assert.deepStrictEqual(Q.planAdd(A, [9], 'next'), [9, 1, 2, 3, 4]);
  assert.deepStrictEqual(Q.planAdd(A, [9], 'end'), [1, 2, 3, 4, 9]);
  assert.deepStrictEqual(Q.planAdd(A, [8, 9], 'next'), [8, 9, 1, 2, 3, 4]);
  assert.deepStrictEqual(Q.planAdd(A, [9, 8], 'end'), [1, 2, 3, 4, 9, 8]);
  assert.deepStrictEqual(Q.planAdd([], [5, 6], 'next'), [5, 6]);
});

test('add: a file already queued moves (never twice), repeats count once', () => {
  assert.deepStrictEqual(Q.planAdd(A, [3], 'next'), [3, 1, 2, 4]);
  assert.deepStrictEqual(Q.planAdd(A, [1], 'end'), [2, 3, 4, 1]);
  assert.deepStrictEqual(Q.planAdd(A, [4, 9, 2], 'next'), [4, 9, 2, 1, 3]);
  assert.deepStrictEqual(Q.planAdd(A, [9, 9, 9], 'end'), [1, 2, 3, 4, 9]);
  assert.deepStrictEqual(Q.planAdd(A, [2, 1], 'next'), [2, 1, 3, 4]);
});

test('add: strict ids and where', () => {
  for (const bad of [[], 'x', null, [0], [-1], [1.5], ['2'], [2, '3']]) {
    assert.strictEqual(code(() => Q.planAdd(A, bad, 'end')), 'BAD_IDS', JSON.stringify(bad));
  }
  assert.strictEqual(code(() => Q.planAdd(A, [9], 'top')), 'BAD_WHERE');
  assert.strictEqual(code(() => Q.planAdd(A, [9])), 'BAD_WHERE');
  assert.strictEqual(code(() => Q.planAdd(A, Array.from({ length: Q.MAX_IDS + 1 }, (_, i) => i + 1), 'end')), 'TOO_MANY');
  assert.strictEqual(Q.parseSource(undefined), null);
  assert.strictEqual(Q.parseSource('dock'), 'dock');
  assert.strictEqual(code(() => Q.parseSource(5)), 'BAD_SOURCE');
  assert.strictEqual(code(() => Q.parseSource('x'.repeat(65))), 'BAD_SOURCE');
});

test('move: a block, as a collection reorder does, in Up next words', () => {
  assert.deepStrictEqual(Q.planMove(A, [4], 1), [4, 1, 2, 3]);
  assert.deepStrictEqual(Q.planMove(A, [1], null), [2, 3, 4, 1]);
  assert.deepStrictEqual(Q.planMove(A, [3, 1], 4), [2, 1, 3, 4]);
  assert.strictEqual(code(() => Q.planMove(A, [9], null)), 'NOT_MEMBER');
  try { Q.planMove(A, [9], null); } catch (e) { assert.match(e.message, /Up next/); }
  assert.strictEqual(code(() => Q.planMove(A, [2], 9)), 'BEFORE_NOT_MEMBER');
  assert.strictEqual(code(() => Q.planMove(A, [2], 2)), 'BEFORE_IN_MOVE');
  assert.strictEqual(code(() => Q.planMove(A, [2])), 'BAD_BEFORE');
  assert.strictEqual(code(() => Q.planMove(A, [], null)), 'BAD_MOVE');
});

test('remove and replace', () => {
  assert.deepStrictEqual(Q.planRemove(A, [2, 9]), [1, 3, 4]);
  assert.deepStrictEqual(Q.planRemove(A, [1, 2, 3, 4]), []);
  assert.strictEqual(code(() => Q.planRemove(A, [])), 'BAD_IDS');
  assert.deepStrictEqual(Q.planReplace([4, 3, 9]), [4, 3, 9]);
  assert.deepStrictEqual(Q.planReplace([]), []);
  assert.strictEqual(code(() => Q.planReplace([1, 1])), 'BAD_IDS', 'Undo names each file once');
  assert.strictEqual(code(() => Q.planReplace('1,2')), 'BAD_IDS');
  assert.strictEqual(code(() => Q.planReplace([1, 'a'])), 'BAD_IDS');
});

// ── The advance rule ───────────────────────────────────────────────────────

test('rule: Next and a file ending take Up next first, then the list from its anchor', () => {
  const base = { anchor: 4, fromUpNext: false, repeat: 'off' };
  assert.deepStrictEqual(Rule.plan({ ...base, dir: 'next', auto: false, upNextCount: 2 }), { take: 'upnext' });
  assert.deepStrictEqual(Rule.plan({ ...base, dir: 'next', auto: true, upNextCount: 1 }), { take: 'upnext' });
  assert.deepStrictEqual(Rule.plan({ ...base, dir: 'next', auto: true, upNextCount: 0 }),
    { take: 'list', from: 4, step: 1, wrap: false });
  // From an Up next file the list still carries on from the anchor.
  assert.deepStrictEqual(Rule.plan({ ...base, fromUpNext: true, dir: 'next', auto: true, upNextCount: 0 }),
    { take: 'list', from: 4, step: 1, wrap: false });
});

test('rule: Repeat all wraps the list on its own, never on a press, and Up next still comes first', () => {
  const all = { anchor: 9, fromUpNext: false, repeat: 'all' };
  assert.deepStrictEqual(Rule.plan({ ...all, dir: 'next', auto: true, upNextCount: 0 }),
    { take: 'list', from: 9, step: 1, wrap: true });
  assert.deepStrictEqual(Rule.plan({ ...all, dir: 'next', auto: false, upNextCount: 0 }),
    { take: 'list', from: 9, step: 1, wrap: false });
  assert.deepStrictEqual(Rule.plan({ ...all, dir: 'next', auto: true, upNextCount: 3 }), { take: 'upnext' });
  // Repeat one is the element's own loop: a press still moves on.
  assert.deepStrictEqual(Rule.plan({ anchor: 2, repeat: 'one', dir: 'next', auto: false, upNextCount: 1 }), { take: 'upnext' });
});

test('rule: Previous stays in the list; from an Up next file it goes back to the list file first', () => {
  assert.deepStrictEqual(Rule.plan({ dir: 'prev', anchor: 4, fromUpNext: false, upNextCount: 5 }),
    { take: 'list', from: 4, step: -1, wrap: false });
  assert.deepStrictEqual(Rule.plan({ dir: 'prev', anchor: 4, fromUpNext: true, upNextCount: 5 }),
    { take: 'list', from: 5, step: -1, wrap: false }, 'walks down from just past the anchor: the anchor is tried first');
  assert.deepStrictEqual(Rule.plan({ dir: 'prev', anchor: -1, fromUpNext: true, upNextCount: 0 }),
    { take: 'list', from: -1, step: -1, wrap: false }, 'nothing from the list played: nowhere to go back to');
});

test('rule: the anchor moves with list files only', () => {
  let a = Rule.NO_ANCHOR;
  a = Rule.anchorAfterPlay(a, { id: 7, index: 3 });
  assert.deepStrictEqual(a, { id: 7, index: 3 });
  // An Up next file, and the same file reopened (Maximize), leave it.
  assert.deepStrictEqual(Rule.anchorAfterPlay(a, { fromUpNext: true, id: 50, index: 10 }), a);
  assert.deepStrictEqual(Rule.anchorAfterPlay(a, { keep: true, id: null, index: -1 }), a);
  // A file outside the list starts the list over from the top, as before.
  assert.deepStrictEqual(Rule.anchorAfterPlay(a, { id: null, index: -1 }), { id: null, index: -1 });
  // Where it sits now: by id while the file is in the list, else its old place.
  const order = [5, 6, 7, 8];
  const indexOf = (id) => order.indexOf(id);
  assert.strictEqual(Rule.anchorIndex({ id: 7, index: 3 }, indexOf), 2);
  assert.strictEqual(Rule.anchorIndex({ id: 99, index: 3 }, indexOf), 3);
  assert.strictEqual(Rule.anchorIndex(Rule.NO_ANCHOR, indexOf), -1);
  assert.strictEqual(Rule.anchorIndex(null, indexOf), -1);
});

// ── The database and the routes ────────────────────────────────────────────

let server;
let base;
let port;
const m = [];        // media ids m[0] .. m[5]
let trashed;

const queued = () => db.get().prepare('SELECT media_id, position FROM play_queue ORDER BY position').all();
const idsOf = (items) => items.map(i => i.id);

async function listen() {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
}

test.before(async () => {
  db.init();
  const ins = db.get().prepare('INSERT INTO media (filepath, filename, media_type, duration_seconds) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 6; i++) m.push(Number(ins.run(`/q/f${i}.mp4`, `f${i}.mp4`, 'video', 60 + i).lastInsertRowid));
  trashed = Number(ins.run('/q/gone.mp4', 'gone.mp4', 'video', 10).lastInsertRowid);
  db.get().prepare('UPDATE media SET user_trashed = 1 WHERE id = ?').run(trashed);
  await listen();
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const post = (p, body, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}),
});

test('changePlayQueue: add, move, remove, positions always 0..n-1', () => {
  let r = db.changePlayQueue('add', { ids: [m[0], m[1]], where: 'end', source: 'library' });
  assert.deepStrictEqual(idsOf(r.items), [m[0], m[1]]);
  r = db.changePlayQueue('add', { ids: [m[2]], where: 'next' });
  assert.deepStrictEqual(idsOf(r.items), [m[2], m[0], m[1]]);
  // Adding a queued file moves it.
  r = db.changePlayQueue('add', { ids: [m[1]], where: 'next', source: 'dock' });
  assert.deepStrictEqual(idsOf(r.items), [m[1], m[2], m[0]]);
  assert.strictEqual(r.items[0].source, 'dock');
  r = db.changePlayQueue('move', { move: [m[0]], before: m[1] });
  assert.deepStrictEqual(idsOf(r.items), [m[0], m[1], m[2]]);
  r = db.changePlayQueue('remove', { ids: [m[1]] });
  assert.deepStrictEqual(idsOf(r.items), [m[0], m[2]]);
  assert.deepStrictEqual(queued(), [{ media_id: m[0], position: 0 }, { media_id: m[2], position: 1 }]);
  // What a row needs to be drawn
  const it = r.items[0];
  for (const k of ['id', 'filename', 'filepath', 'media_type', 'duration_seconds', 'thumb_version']) assert.ok(k in it, k);
  assert.strictEqual(it.filename, 'f0.mp4');
  db.changePlayQueue('clear');
  assert.deepStrictEqual(queued(), []);
});

test('changePlayQueue: trashed and unknown files are refused and named; a bad request changes nothing', () => {
  db.changePlayQueue('add', { ids: [m[0]], where: 'end' });
  const r = db.changePlayQueue('add', { ids: [trashed, m[3], 999999], where: 'end' });
  assert.deepStrictEqual(idsOf(r.items), [m[0], m[3]]);
  assert.deepStrictEqual(r.refused, [{ id: trashed, reason: 'trashed' }, { id: 999999, reason: 'not_found' }]);
  assert.strictEqual(code(() => db.changePlayQueue('add', { ids: ['1'], where: 'end' })), 'BAD_IDS');
  assert.strictEqual(code(() => db.changePlayQueue('move', { move: [m[5]], before: null })), 'NOT_MEMBER');
  assert.strictEqual(code(() => db.changePlayQueue('nope', {})), 'BAD_OP');
  assert.deepStrictEqual(idsOf(db.getPlayQueue()), [m[0], m[3]]);
  db.changePlayQueue('clear');
});

test('getPlayQueue drops files gone from the library or put in the trash', () => {
  db.changePlayQueue('replace', { ids: [m[4], m[5], m[0]] });
  // A row whose media no longer exists (removed behind the queue's back)
  db.get().prepare('INSERT INTO play_queue (media_id, position) VALUES (?, ?)').run(888888, 9);
  db.get().prepare('UPDATE media SET user_trashed = 1 WHERE id = ?').run(m[5]);
  try {
    assert.deepStrictEqual(idsOf(db.getPlayQueue()), [m[4], m[0]]);
    assert.deepStrictEqual(queued().map(q => q.media_id), [m[4], m[0]], 'the stale rows are gone from the table too');
  } finally {
    db.get().prepare('UPDATE media SET user_trashed = 0 WHERE id = ?').run(m[5]);
  }
  // Removing a record from the library takes it out of Up next.
  const extra = Number(db.get().prepare('INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, ?)')
    .run('/q/extra.mp4', 'extra.mp4', 'video').lastInsertRowid);
  db.changePlayQueue('add', { ids: [extra], where: 'end' });
  db.deleteRecords([extra]);
  assert.ok(!queued().some(q => q.media_id === extra));
  db.changePlayQueue('clear');
});

test('routes: add / move / remove / replace / clear answer the whole list', async () => {
  let res = await post('/api/queue/add', { ids: [m[0], m[1], m[2]], where: 'end' });
  assert.strictEqual(res.status, 200);
  let j = await res.json();
  assert.deepStrictEqual(idsOf(j.items), [m[0], m[1], m[2]]);
  assert.deepStrictEqual(j.refused, []);
  res = await post('/api/queue/add', { ids: [m[3], trashed], where: 'next', source: 'selection' });
  j = await res.json();
  assert.deepStrictEqual(idsOf(j.items), [m[3], m[0], m[1], m[2]]);
  assert.deepStrictEqual(j.refused, [{ id: trashed, reason: 'trashed' }]);
  res = await post('/api/queue/move', { move: [m[3]], before: null });
  assert.deepStrictEqual(idsOf((await res.json()).items), [m[0], m[1], m[2], m[3]]);
  res = await post('/api/queue/remove', { ids: [m[1]] });
  assert.deepStrictEqual(idsOf((await res.json()).items), [m[0], m[2], m[3]]);
  res = await fetch(base + '/api/queue');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(idsOf((await res.json()).items), [m[0], m[2], m[3]]);
  // Undo puts back the exact earlier list.
  res = await post('/api/queue/replace', { ids: [m[0], m[1], m[2], m[3]] });
  assert.deepStrictEqual(idsOf((await res.json()).items), [m[0], m[1], m[2], m[3]]);
  res = await post('/api/queue/clear');
  assert.deepStrictEqual((await res.json()).items, []);
  res = await post('/api/queue/replace', { ids: [] });
  assert.strictEqual(res.status, 200);
});

test('routes: 400 with a code for a bad request, and nothing changes', async () => {
  await post('/api/queue/add', { ids: [m[0], m[1]], where: 'end' });
  const cases = [
    ['/api/queue/add', { ids: [m[2]] }, 'BAD_WHERE'],
    ['/api/queue/add', { ids: [m[2]], where: 'middle' }, 'BAD_WHERE'],
    ['/api/queue/add', { ids: 'all', where: 'end' }, 'BAD_IDS'],
    ['/api/queue/add', { ids: [String(m[2])], where: 'end' }, 'BAD_IDS'],
    ['/api/queue/add', { ids: [m[2]], where: 'end', source: { x: 1 } }, 'BAD_SOURCE'],
    ['/api/queue/move', { move: [m[4]], before: null }, 'NOT_MEMBER'],
    ['/api/queue/move', { move: [m[0]] }, 'BAD_BEFORE'],
    ['/api/queue/move', { move: [m[0]], before: m[4] }, 'BEFORE_NOT_MEMBER'],
    ['/api/queue/remove', { ids: [] }, 'BAD_IDS'],
    ['/api/queue/replace', { ids: [m[0], m[0]] }, 'BAD_IDS'],
    ['/api/queue/replace', {}, 'BAD_IDS'],
  ];
  for (const [p, body, c] of cases) {
    const res = await post(p, body);
    assert.strictEqual(res.status, 400, `${p} ${JSON.stringify(body)}`);
    assert.strictEqual((await res.json()).code, c, `${p} ${JSON.stringify(body)}`);
  }
  assert.deepStrictEqual(idsOf(db.getPlayQueue()), [m[0], m[1]], 'nothing changed');
});

test('routes: 423 while the vault is locked', async () => {
  vault.bootLocked();
  try {
    let res = await fetch(base + '/api/queue');
    assert.strictEqual(res.status, 423);
    for (const op of ['add', 'move', 'remove', 'clear', 'replace']) {
      res = await post(`/api/queue/${op}`, { ids: [m[5]], where: 'end', move: [m[0]], before: null });
      assert.strictEqual(res.status, 423, op);
    }
  } finally {
    vault._locked = false;
  }
  assert.deepStrictEqual(idsOf(db.getPlayQueue()), [m[0], m[1]]);
});

test('routes: the request guards (CSRF, Host) cover Up next like every other route', async () => {
  const ownPort = require('../config').server.port;
  const own = `http://127.0.0.1:${ownPort}`;
  let res = await post('/api/queue/add', { ids: [m[2]], where: 'end' }, { Origin: own, 'Sec-Fetch-Site': 'same-origin' });
  assert.strictEqual(res.status, 200);
  for (const h of [
    { Origin: 'https://evil.example' },
    { Origin: 'null' },
    { Origin: `http://127.0.0.1:${ownPort + 1}` },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
  ]) {
    res = await post('/api/queue/clear', {}, h);
    assert.strictEqual(res.status, 403, JSON.stringify(h));
    res = await post('/api/queue/add', { ids: [m[5]], where: 'next' }, h);
    assert.strictEqual(res.status, 403, JSON.stringify(h));
  }
  res = await fetch(base + '/api/queue', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.strictEqual(res.status, 403);
  // A Host Vault does not answer to
  const http = require('node:http');
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/queue', headers: { Host: 'evil.example:80' } }, (r) => {
      r.resume(); r.on('end', () => resolve(r.statusCode));
    }).on('error', reject);
  });
  assert.strictEqual(status, 403);
  assert.deepStrictEqual(idsOf(db.getPlayQueue()), [m[0], m[1], m[2]], 'refused requests changed nothing');
});

test('Up next survives closing and reopening the library', async () => {
  const before = idsOf(db.getPlayQueue());
  assert.ok(before.length >= 2);
  db.close();
  db.init();
  assert.deepStrictEqual(idsOf(db.getPlayQueue()), before);
  const res = await fetch(base + '/api/queue');
  assert.deepStrictEqual(idsOf((await res.json()).items), before);
});

// ── Undo inverts one change against Up next as it is now ───────────────────

test('undo remove: back before the file that followed it, never twice, never a file that played since', () => {
  // [6, 7], ✕ on 6 -> [7]; then 7 starts playing -> []: Undo puts back 6 only.
  assert.deepStrictEqual(Rule.undoRemove([], [6, 7], [6], [7]), [6]);
  assert.deepStrictEqual(Rule.undoRemove([7], [6, 7], [6]), [6, 7]);
  assert.deepStrictEqual(Rule.undoRemove([1, 3, 9], [1, 2, 3], [2]), [1, 2, 3, 9], 'before its old follower');
  assert.deepStrictEqual(Rule.undoRemove([1, 9], [1, 2, 3], [2]), [1, 2, 9], 'follower gone too: old place, clamped');
  assert.deepStrictEqual(Rule.undoRemove([1], [1, 2, 3], [3]), [1, 3], 'was last: back at the end');
  assert.deepStrictEqual(Rule.undoRemove([2, 1], [1, 2], [2]), [2, 1], 'already back: left alone');
  assert.deepStrictEqual(Rule.undoRemove([1, 4], [1, 2, 3, 4], [2, 3]), [1, 2, 3, 4], 'a block keeps its order');
  assert.deepStrictEqual(Rule.undoRemove([1], [1, 2], [2], [2]), [1], 'played since: not put back');
});

test('undo clear: cleared files not queued now go back at the front, in their old order', () => {
  assert.deepStrictEqual(Rule.undoClear([], [6, 7, 8]), [6, 7, 8]);
  assert.deepStrictEqual(Rule.undoClear([9, 7], [6, 7, 8]), [6, 8, 9, 7], 'a file queued again is not doubled');
  assert.deepStrictEqual(Rule.undoClear([], [6, 7, 8], [6]), [7, 8], 'the one that started playing stays out');
});

test('undo add: only the files it put in come out; a moved file goes back beside its old neighbour', () => {
  assert.deepStrictEqual(Rule.undoAdd([5, 4], [5], [4]), [5], 'the second of two quick adds');
  assert.deepStrictEqual(Rule.undoAdd([9, 1, 2], [1, 2], [9]), [1, 2]);
  assert.deepStrictEqual(Rule.undoAdd([1, 2], [1, 2], [9]), [1, 2], 'it already played: nothing to take out');
  // [1, 2, 3], Shift+U on 3 moved it to the front -> [3, 1, 2]; Undo: after 2 again
  assert.deepStrictEqual(Rule.undoAdd([3, 1, 2], [1, 2, 3], [3]), [1, 2, 3]);
  // moved 2 to the end, then 1 played: 2 goes back at the front (its old neighbour 1 is gone, 3 follows)
  assert.deepStrictEqual(Rule.undoAdd([3, 2], [1, 2, 3], [2]), [2, 3]);
  // a mixed add: 9 new, 1 moved
  assert.deepStrictEqual(Rule.undoAdd([9, 1, 2, 3], [1, 2, 3], [9, 1]), [1, 2, 3]);
  // files added since are kept
  assert.deepStrictEqual(Rule.undoAdd([4, 1, 2, 8], [1, 2], [4]), [1, 2, 8]);
});

// ── The client module: every change one after another, from fresh state ──

function loadUpNextClient() {
  const vm = require('node:vm');
  let server = [];
  const meta = (id) => ({ id, filename: `f${id}.mp4`, media_type: 'video' });
  const calls = [];
  const undos = [];
  const hang = { next: 0 };   // this many requests never answer
  const fakeFetch = (url, opts = {}) => {
    const op = url === '/api/queue' ? 'get' : url.split('/').pop();
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push(op);
    if (hang.next > 0) {
      hang.next--;
      // Never answers; only the client's own timeout ends it.
      return new Promise((_, reject) => {
        if (opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    // Answer after a random delay, so requests sent together could cross.
    return new Promise((resolve) => setTimeout(() => {
      if (op === 'add') server = Q.planAdd(server, body.ids, body.where);
      else if (op === 'remove') server = Q.planRemove(server, body.ids);
      else if (op === 'clear') server = [];
      else if (op === 'replace') server = Q.planReplace(body.ids);
      else if (op === 'move') server = Q.planMove(server, body.move, body.before);
      const items = server.map(meta);
      resolve({ ok: true, json: async () => ({ items, refused: [] }) });
    }, Math.floor(Math.random() * 15)));
  };
  const noop = () => {};
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, Promise, Error,
    setTimeout, clearTimeout, fetch: fakeFetch, UpNextRule: Rule, AbortController,
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    showToast: noop, showUndoToast: (msg, fn) => undos.push(fn),
  };
  ctx.window = ctx;
  ctx.addEventListener = noop;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'up-next.js'), 'utf8') + '\n;globalThis.__U = UpNext;', ctx);
  return { U: ctx.__U, undos, calls, hang, server: () => server.slice(), set: (list) => { server = list.slice(); } };
}

test('client: two quick adds, then Undo of the second leaves the first', async () => {
  const c = loadUpNextClient();
  await c.U.settled();
  await Promise.all([c.U.add([5], 'end'), c.U.add([4], 'end')]);
  assert.deepStrictEqual([...c.U.ids()], [5, 4]);
  assert.strictEqual(c.undos.length, 2);
  c.undos[1]();
  await c.U.settled();
  assert.deepStrictEqual(c.server(), [5]);
  assert.deepStrictEqual([...c.U.ids()], [5]);
});

test('client: a file ending right after Shift+U plays the new first file', async () => {
  const c = loadUpNextClient();
  await c.U.settled();
  await c.U.add([1, 2], 'end');
  const adding = c.U.add([9], 'next');           // still on its way
  const item = await c.U.shift();
  await adding;
  assert.strictEqual(item.id, 9);
  await c.U.settled();
  assert.deepStrictEqual(c.server(), [1, 2]);
  assert.deepStrictEqual([...c.U.ids()], [1, 2]);
});

test('client: Undo after an auto-advance never brings back the file that played', async () => {
  const c = loadUpNextClient();
  await c.U.settled();
  await c.U.add([6, 7], 'end');
  await c.U.removeId(6);                         // ✕ on 6 -> [7]
  const played = await c.U.shift();              // 7 ends... and starts playing
  assert.strictEqual(played.id, 7);
  c.undos[c.undos.length - 1]();                 // Undo the ✕
  await c.U.settled();
  assert.deepStrictEqual(c.server(), [6]);
  // Clear, then the first file plays, then Undo: the rest come back, not that one
  await c.U.add([1, 2, 3], 'end');
  await c.U.clear();
  c.set([]);
  await c.U.add([8], 'end');
  c.undos[c.undos.length - 2]();                 // Undo the Clear
  await c.U.settled();
  assert.deepStrictEqual(c.server(), [6, 1, 2, 3, 8]);
});

test('client: a move asked while an add is on its way lands on the fresh list', async () => {
  const c = loadUpNextClient();
  await c.U.settled();
  await c.U.add([1, 2], 'end');
  const adding = c.U.add([3], 'end');
  const moving = c.U.move(3, 1);                 // 3 is not in the list yet when asked
  await Promise.all([adding, moving]);
  await c.U.settled();
  assert.deepStrictEqual(c.server(), [3, 1, 2]);
  assert.deepStrictEqual([...c.U.ids()], [3, 1, 2]);
});

test('client: a request that never answers fails after the limit, Next never waits on it, the queue carries on', async () => {
  const c = loadUpNextClient();
  c.U._limits.request = 150;
  c.U._limits.wait = 40;
  await c.U.settled();
  await c.U.add([1, 2], 'end');
  c.hang.next = 1;
  const t0 = Date.now();
  const stuck = c.U.add([9], 'next');            // never answered
  // Next / a file ending: waits a moment at most, then plays the first file shown.
  await c.U.settled(c.U._limits.wait);
  assert.ok(Date.now() - t0 < 140, 'did not wait for the stuck request');
  const item = await c.U.shift();
  assert.ok(Date.now() - t0 < 140, 'shift did not wait for the stuck request');
  assert.strictEqual(item.id, 1);
  assert.deepStrictEqual([...c.U.ids()], [2]);
  await stuck;                                   // failed after the limit, like a network error
  await c.U.settled();
  // The queue carries on: the removal of 1 followed, and new changes work.
  assert.deepStrictEqual(c.server(), [2]);
  await c.U.add([7], 'end');
  assert.deepStrictEqual(c.server(), [2, 7]);
  assert.deepStrictEqual([...c.U.ids()], [2, 7]);
});

test('client: Next waits once, not twice: shift() with no budget left decides at once', async () => {
  const c = loadUpNextClient();
  c.U._limits.request = 400;
  c.U._limits.wait = 150;
  await c.U.settled();
  await c.U.add([1, 2], 'end');
  c.hang.next = 1;
  const stuck = c.U.add([9], 'next');
  const t0 = Date.now();
  await c.U.settled(c.U._limits.wait);           // the move's one wait (player-core.js queueMove)
  const item = await c.U.shift({ wait: 0 });     // nothing left of the budget
  const took = Date.now() - t0;
  assert.strictEqual(item.id, 1);
  assert.ok(took < 2 * c.U._limits.wait, `waited ${took} ms in all`);
  await stuck;
  await c.U.settled();
  assert.deepStrictEqual(c.server(), [2]);
});
