/**
 * Folder watchers (lib/watchers/, WATCHERS_SPEC week 1), without a real
 * watch: rules (skip patterns, types, smaller than), nested folders, the
 * settle logic on fake time, event coalescing, new / changed / missing /
 * back / moved through the manager on a fake disk and a fake library, Add
 * only versus Add and analyse, catch-up diffing on a real temp folder, and
 * the lock: watchers stop and write nothing while locked, then catch up.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rules = require('../lib/watchers/rules');
const { Settler } = require('../lib/watchers/settle');
const { catchUp, matchMoves, keyOf } = require('../lib/watchers/catchup');

/** Like store.rowsUnder: (path NOCASE, id) order, keyset after a row, no forward-slash rows. */
function sortedRowsUnder(list) {
  const cmp = (a, b) => keyOf(a.filepath).compare(keyOf(b.filepath)) || (a.id - b.id);
  return (root, after, limit, sep) => {
    if (sep === '/') return [];
    const pre = keyOf(root + path.sep);
    return list().filter(r => {
      const k = keyOf(r.filepath);
      return k.length >= pre.length && k.compare(pre, 0, pre.length, 0, pre.length) === 0 && !r.user_trashed
        && (!after || cmp(r, after) > 0);
    }).sort(cmp).slice(0, limit);
  };
}
const { WatchManager, MOVE_WINDOW_MS, HEALTH_MS, CONFIRM_MS } = require('../lib/watchers/manager');

const ROOT = path.resolve(os.tmpdir(), 'vault-fake-watch-root');
const P = (...parts) => path.join(ROOT, ...parts);

/* ── Rules ──────────────────────────────────────────────────────────────── */

test('skip patterns: defaults, wildcards, folders, hidden files, case', () => {
  const skip = rules.compileSkip(rules.DEFAULT_SKIP_PATTERNS);
  for (const rel of ['clip.mp4.part', 'a\\b\\movie.crdownload', 'x.TMP', '~$doc.mp4', 'thumbs.db', 'Desktop.ini',
    '@eaDir\\clip.mp4', 'sub\\@eaDir\\x\\y.jpg', '.DS_Store', '.hidden.mp4', 'sub\\.cache\\a.mp4']) {
    assert.ok(skip(rel), `${rel} is skipped`);
  }
  for (const rel of ['clip.mp4', 'sub\\holiday.jpg', 'part.mp4', 'tmp\\a.mp4', 'eaDir\\a.mp4']) {
    assert.ok(!skip(rel), `${rel} is kept`);
  }
  const user = rules.compileSkip(['Temp\\', 'sample*', 'Old/raw/*.mkv']);
  assert.ok(user('Temp\\a.mp4'));
  assert.ok(user('x\\temp\\a.mp4'), 'folder patterns match at any depth, any case');
  assert.ok(user('SAMPLE-01.mp4'));
  assert.ok(user('Old\\raw\\a.mkv'), 'a pattern with a separator matches the relative path');
  assert.ok(!user('Old\\a.mkv'));
  assert.ok(!user('templates\\a.mp4'));
});

test('patterns: one per line, trimmed, deduped, capped; regex characters are literal', () => {
  assert.deepStrictEqual(rules.normalizePatterns(' *.part \n\n*.part\r\n(x)+[y]\n'), ['*.part', '(x)+[y]']);
  assert.ok(rules.compileSkip(['(x)+[y]'])('(x)+[y]'));
  assert.ok(!rules.compileSkip(['(x)+[y]'])('xx[y]'));
  assert.strictEqual(rules.normalizePatterns(Array.from({ length: 300 }, (_, i) => `p${i}`)).length, 100);
});

test('types: offered chips only, Documents not offered yet; GIFs count as pictures', () => {
  assert.deepStrictEqual(rules.normalizeTypes(['audio', 'video', 'document', 'nope']), ['video', 'audio']);
  assert.strictEqual(rules.typeOfExt('.GIF'), 'image');
  assert.strictEqual(rules.typeOfExt('.MkV'), 'video');
  assert.strictEqual(rules.typeOfExt('.js'), null, 'code files are never documents');
  assert.strictEqual(rules.TYPES.document.offered, false);
});

test('accepts: type chips, subfolders, skips, and smaller than for videos and pictures only', () => {
  const folder = { types: ['video', 'image', 'audio'], skipPatterns: ['*.part'], minSizeBytes: 100 * 1024, includeSubfolders: true };
  assert.deepStrictEqual(rules.accepts(folder, 'a.mp4', 5e6), { ok: true, type: 'video' });
  assert.strictEqual(rules.accepts(folder, 'a.mp4', 1000).reason, 'small');
  assert.strictEqual(rules.accepts(folder, 'a.jpg', 1000).reason, 'small');
  assert.strictEqual(rules.accepts(folder, 'a.mp3', 10).ok, true, 'audio is never dropped for size');
  assert.strictEqual(rules.accepts(folder, 'a.txt', 10).reason, 'type');
  assert.strictEqual(rules.accepts(folder, 'a.mp4.part', 5e6).reason, 'type');
  assert.strictEqual(rules.accepts({ ...folder, minSizeBytes: 0 }, 'tiny.jpg', 1).ok, true, 'off by default');
  assert.strictEqual(rules.accepts({ ...folder, includeSubfolders: false }, 'sub\\a.mp4', 5e6).reason, 'subfolder');
  assert.strictEqual(rules.accepts({ ...folder, types: ['video'] }, 'a.jpg', 5e6).reason, 'type');
});

test('nested folders: inside a watched tree is covered, above one absorbs it, same is a duplicate', () => {
  const existing = [
    { id: 1, path: P('Media'), includeSubfolders: true },
    { id: 2, path: P('Other', 'Top'), includeSubfolders: false },
  ];
  assert.strictEqual(rules.nesting(P('Media', 'Clips'), existing).coveredBy.id, 1);
  assert.strictEqual(rules.nesting(P('media'), existing).duplicate?.id, process.platform === 'win32' ? 1 : undefined);
  assert.strictEqual(rules.nesting(P('Other', 'Top', 'Deeper'), existing).coveredBy, null,
    'a parent that does not watch subfolders covers nothing');
  assert.deepStrictEqual(rules.nesting(P('Other'), existing).absorbs.map(f => f.id), [2]);
  assert.deepStrictEqual(rules.nesting(P('Other'), existing, false).absorbs, [], 'no subfolders, nothing absorbed');
  assert.strictEqual(rules.nesting(P('Med'), existing).coveredBy, null, 'a name prefix is not a parent');
  assert.ok(rules.isInside(P('Media', 'a.mp4'), P('Media')));
  assert.ok(!rules.isInside(P('MediaX', 'a.mp4'), P('Media')));
});

test('drive roots need a confirm; network shares default to a timer', () => {
  if (process.platform === 'win32') {
    assert.ok(rules.isDriveRoot('C:\\'));
    assert.ok(rules.isDriveRoot('D:'));
    assert.ok(!rules.isDriveRoot('C:\\Media'));
    assert.ok(rules.isNetworkPath('\\\\nas\\video\\archive'));
  }
  assert.ok(!rules.isNetworkPath(P('Media')));
});

/* ── Settle on fake time ─────────────────────────────────────────────────── */

function fakeStatFs(files) {
  return async (p) => {
    const f = files.get(p);
    if (!f) { const e = new Error('gone'); e.code = 'ENOENT'; throw e; }
    return { size: f.size, mtimeMs: f.mtimeMs, isFile: () => true };
  };
}

test('settle: a growing file waits; it is handed on once, after holding steady', async () => {
  let t = 0;
  const files = new Map([['f', { size: 10, mtimeMs: 1 }]]);
  const settled = [];
  const s = new Settler({ now: () => t, stat: fakeStatFs(files), canOpen: async () => true, onSettled: (e, st) => settled.push([e.path, st.size]) });
  s.observe('f', { folderId: 1 });
  for (let i = 0; i < 6; i++) {           // a slow copy: grows on every look
    await s.tick();
    files.get('f').size += 1000;
    files.get('f').mtimeMs += 500;
    t += 2000;
  }
  assert.deepStrictEqual(settled, [], 'never added while it grows');
  await s.tick(); t += 2000;               // stops growing: 3 equal looks
  await s.tick(); t += 2000;
  assert.deepStrictEqual(settled, []);
  await s.tick(); t += 2000;
  assert.deepStrictEqual(settled, [['f', 6010]], 'added with its final size');
  await s.tick();
  assert.strictEqual(settled.length, 1, 'exactly once');
  assert.strictEqual(s.size, 0);
});

test('settle: not before its time, a busy (held) file waits, empty files wait, gone files drop', async () => {
  let t = 0;
  let open = false;
  const files = new Map([['a', { size: 5, mtimeMs: 1 }], ['e', { size: 0, mtimeMs: 1 }], ['g', { size: 5, mtimeMs: 1 }]]);
  const settled = [];
  const gone = [];
  const s = new Settler({ now: () => t, stat: fakeStatFs(files), canOpen: async () => open,
    onSettled: (e) => settled.push(e.path), onGone: (e) => gone.push(e.path) });
  s.observe('a'); s.observe('e'); s.observe('g');
  await s.tick();
  await s.tick();                           // same instant: nothing is due again yet
  files.delete('g');
  for (let i = 0; i < 4; i++) { t += 2000; await s.tick(); }
  assert.deepStrictEqual(settled, [], 'held by the writer');
  assert.deepStrictEqual(gone, ['g']);
  open = true;
  t += 2000; await s.tick();
  assert.deepStrictEqual(settled, ['a'], 'let go: added; the empty file still waits');
  assert.ok(s.waiting.has('e'));
});

test('settle: a new event on a waiting file starts its count again', async () => {
  let t = 0;
  const files = new Map([['a', { size: 5, mtimeMs: 1 }]]);
  const settled = [];
  const s = new Settler({ now: () => t, stat: fakeStatFs(files), canOpen: async () => true, onSettled: (e) => settled.push(e.path) });
  s.observe('a');
  await s.tick(); t += 2000; await s.tick(); t += 1000;
  s.observe('a');                            // it changed again
  t += 1000; await s.tick(); t += 2000; await s.tick(); t += 2000; await s.tick();
  assert.deepStrictEqual(settled, [], 'three fresh looks are needed after the reset');
  t += 2000; await s.tick();
  assert.deepStrictEqual(settled, ['a']);
});

/* ── Fake disk and library for the manager ──────────────────────────────── */

function fakeDisk() {
  const nodes = new Map();      // path -> { kind, size, mtimeMs }
  const calls = { lstat: 0 };
  const hold = new Map();       // dir -> promise opendir waits on (a busy walk)
  let inoSeq = 0;               // a folder made again is a different folder
  const err = (code) => { const e = new Error(code); e.code = code; return e; };
  const statOf = (n) => ({
    size: n.size || 0, mtimeMs: n.mtimeMs || 0, dev: 1, ino: n.ino || 0,
    isFile: () => n.kind === 'file', isDirectory: () => n.kind === 'dir', isSymbolicLink: () => n.kind === 'link',
  });
  // ci: look paths up without case, like Windows (off by default).
  const find = (p) => nodes.get(p) || (disk.ci ? nodes.get([...nodes.keys()].find(k => k.toLowerCase() === p.toLowerCase())) : undefined);
  const disk = {
    ci: false,
    nodes, calls, hold,
    dir(p) { nodes.set(p, { kind: 'dir', ino: ++inoSeq }); },
    // hash: the file's content, as the quick fingerprint sees it (null = unknown)
    file(p, size, mtimeMs = 1000, hash = null) {
      let d = path.dirname(p);
      while (d.length >= ROOT.length && !nodes.has(d)) { nodes.set(d, { kind: 'dir', ino: ++inoSeq }); d = path.dirname(d); }
      nodes.set(p, { kind: 'file', size, mtimeMs, hash });
    },
    link(p) { nodes.set(p, { kind: 'link' }); },
    rm(p) { for (const k of [...nodes.keys()]) if (k === p || k.startsWith(p + path.sep)) nodes.delete(k); },
    mv(a, b) {
      for (const k of [...nodes.keys()]) {
        if (k === a || k.startsWith(a + path.sep)) { nodes.set(b + k.slice(a.length), nodes.get(k)); nodes.delete(k); }
      }
    },
    fs: {
      async lstat(p) { calls.lstat++; const n = find(p); if (!n) throw err('ENOENT'); return statOf(n); },
      async stat(p) { const n = find(p); if (!n || n.kind === 'link') throw err('ENOENT'); return statOf(n); },
      // The real case of a path, like fs.promises.realpath on Windows.
      async realpath(p) {
        const k = [...nodes.keys()].find(x => x.toLowerCase() === p.toLowerCase());
        if (!k) throw err('ENOENT');
        return k;
      },
      async opendir(p) {
        if (hold.has(p)) await hold.get(p);
        const n = nodes.get(p);
        if (!n || n.kind !== 'dir') throw err('ENOENT');
        const kids = [...nodes.entries()].filter(([k]) => path.dirname(k) === p && k !== p);
        return (async function* () {
          for (const [k, v] of kids) {
            yield { name: path.basename(k), isFile: () => v.kind === 'file', isDirectory: () => v.kind === 'dir' };
          }
        })();
      },
    },
  };
  disk.dir(ROOT);
  return disk;
}

function fakeLibrary() {
  const rows = new Map();       // id -> row
  let nextId = 1;
  const writes = [];
  // Like store.rowAt: exact first, then (Windows) any case.
  const byPath = (p) => [...rows.values()].find(r => r.filepath === p)
    || (process.platform === 'win32' ? [...rows.values()].find(r => r.filepath.replace(/[A-Z]/g, c => c.toLowerCase()) === p.replace(/[A-Z]/g, c => c.toLowerCase())) : null) || null;
  const itemId = (x) => (typeof x === 'object' ? x.id : x);
  const here = (x) => {
    const it = typeof x === 'object' ? x : { id: x };
    const r = rows.get(it.id);
    return r && (!it.path || r.filepath === it.path) ? r : null;
  };
  const lib = {
    rows, writes,
    put(p, size, mtimeMs, extra = {}) {
      const r = { id: nextId++, filepath: p, filesize_bytes: size, file_mtime_ms: mtimeMs, missing_since: null, processing_error: null, user_trashed: 0, ...extra };
      rows.set(r.id, r);
      return r;
    },
    byPath,
    folders: [],
    notes: [],
    store: {
      listFolders: () => lib.folders.map(f => ({ ...f })),
      rowAt: (p) => byPath(p),
      rowsBelow: (dir) => [...rows.values()].filter(r => r.filepath.startsWith(dir + path.sep)),
      rowsUnder: sortedRowsUnder(() => [...rows.values()]),
      missingCandidates: (size, mtimeMs) => [...rows.values()]
        .filter(r => r.missing_since != null && r.filesize_bytes === size && (r.file_mtime_ms === mtimeMs || r.file_mtime_ms == null)),
      // Like store.setQuickHash: only into a row with none, whose size and time are the copy's.
      setQuickHash: (list) => {
        writes.push(['hash', list.map(i => i.id)]);
        let n = 0;
        for (const it of list) {
          const r = here(it);
          if (r && r.quick_hash == null && r.filesize_bytes === it.size && r.file_mtime_ms === it.mtimeMs) { r.quick_hash = it.hash; n++; }
        }
        return n;
      },
      // Writes land only while the row is still at the path they name (store.js).
      markMissing: (items, at) => {
        writes.push(['missing', items.map(itemId)]);
        let n = 0;
        for (const x of items) { const r = here(x); if (r && r.missing_since == null) { r.missing_since = at; n++; } }
        return n;
      },
      clearMissing: (items) => {
        writes.push(['back', items.map(itemId)]);
        let n = 0;
        for (const x of items) { const r = here(x); if (r && r.missing_since != null) { r.missing_since = null; n++; } }
        return n;
      },
      backfillStats: (list) => { writes.push(['backfill', list.map(i => i.id)]); for (const it of list) rows.get(it.id).file_mtime_ms = it.mtimeMs; return list.length; },
      markChanged: (list) => {
        writes.push(['changed', list.map(i => i.id)]);
        const out = [];
        for (const it of list) {
          const r = here(it);
          if (!r) continue;
          const analysed = !r.processing_error;
          Object.assign(r, { filesize_bytes: it.size, file_mtime_ms: it.mtimeMs, missing_since: null, quick_hash: it.hash || null });
          if (r.processing_error) r.processing_error = 'unscanned';
          out.push({ id: it.id, analysed });
        }
        return out;
      },
      applyMoves: (list) => {
        writes.push(['moves', list.map(i => [i.id, i.newPath])]);
        let n = 0;
        for (const it of list) {
          const r = rows.get(it.id);
          if (!r || (it.oldPath && r.filepath !== it.oldPath)) continue;
          const occ = byPath(it.newPath);
          if (occ && occ.id !== it.id) continue;
          Object.assign(r, { filepath: it.newPath, missing_since: null });
          n++;
        }
        return n;
      },
      noteFolder: (id, fields) => { lib.notes.push([id, fields]); },
      activityCounts: () => ({ newBy: new Map(), missingBy: new Map(), newTotal: 0 }),
    },
  };
  return lib;
}

function setup({ newFiles = 'analyse', locked = false, folderOpts = {} } = {}) {
  let t = 0;
  const disk = fakeDisk();
  const lib = fakeLibrary();
  lib.folders.push({ id: 1, path: ROOT, enabled: true, mode: 'live', intervalMin: 15, newFiles, includeSubfolders: true,
    types: ['video', 'image', 'audio'], skipPatterns: rules.DEFAULT_SKIP_PATTERNS.slice(), minSizeBytes: 0, ...folderOpts });
  const state = { locked, added: [], scans: [], refreshed: [], watches: [], reads: 0, inFlight: 0, maxInFlight: 0 };
  const m = new WatchManager({
    store: lib.store,
    fs: disk.fs,
    now: () => t,
    manualTimers: true,
    isLocked: () => state.locked,
    isMigrating: () => !!state.migrating,
    watch: (p, o, cb) => {
      if (state.watchError) { const e = new Error(state.watchError); e.code = state.watchError; throw e; }
      const w = { p, o, cb, closed: false, on() {}, close() { this.closed = true; } };
      state.watches.push(w);
      return w;
    },
    settings: { get: () => ({ paused: !!state.paused, checkOnStart: true }), set: (x) => { if (x.paused !== undefined) state.paused = x.paused; } },
    settleOpts: { stat: disk.fs.stat, canOpen: async () => true, checks: 2, intervalMs: 1000 },
    hash: async (p) => { state.reads++; const n = disk.nodes.get(p); return n && n.kind === 'file' ? n.hash || null : null; },
    hashStat: async (p) => {
      state.reads++; state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      if (state.holdReads) await state.holdReads;
      state.inFlight--;
      const n = state.staleStat || disk.nodes.get(p);
      return n && n.size != null ? { hash: n.hash || 'H?', size: n.size, mtimeMs: n.mtimeMs } : null;
    },
    addFiles: (paths, opts) => {
      state.added.push({ paths, opts });
      const added = paths.map(p => { const st = disk.nodes.get(p); const r = lib.put(p, st.size, st.mtimeMs, { processing_error: 'unscanned', watch_new: 1, quick_hash: opts.stats?.get(p)?.hash || null }); return { id: r.id, row: r }; });
      if (opts.analyse) for (const a of added) state.scans.push(a.id);
      return { added };
    },
    afterAdd: async () => {},
    refresh: async (ids) => { state.refreshed.push(...ids); },
    enqueueScan: (item) => state.scans.push(item.id),
    getRow: (id) => ({ ...lib.rows.get(id), media_type: 'video', filename: 'x' }),
  });
  const advance = async (ms) => { t += ms; await m.tick(); };
  return { m, disk, lib, state, advance, now: () => t };
}

test('coalescing: a burst of events on one path is one look', async () => {
  const { m, disk } = setup();
  m.start();
  disk.file(P('a.mp4'), 100);
  for (let i = 0; i < 50; i++) m.onEvent(1, i % 2 ? 'change' : 'rename', 'a.mp4');
  assert.strictEqual(m.pending.size, 1);
  const before = disk.calls.lstat;
  await m.flush();
  assert.strictEqual(disk.calls.lstat - before, 1, 'one lstat for fifty events');
  assert.strictEqual(m.settler.size, 1);
});

test('new file: waits to settle, then added once like Add folder (Add and analyse queues the AI scan)', async () => {
  const { m, disk, lib, state, advance } = setup();
  m.start();
  disk.file(P('sub', 'clip.mp4'), 100, 5);
  m.onEvent(1, 'rename', 'sub\\clip.mp4'.replace(/\\/g, path.sep));
  await advance(0);
  assert.strictEqual(state.added.length, 0, 'not before it settles');
  disk.file(P('sub', 'clip.mp4'), 5000, 6);     // still copying
  await advance(1000);
  assert.strictEqual(state.added.length, 0);
  await advance(1000);
  assert.strictEqual(state.added.length, 1);
  assert.deepStrictEqual(state.added[0].paths, [P('sub', 'clip.mp4')]);
  assert.strictEqual(state.added[0].opts.analyse, true);
  assert.strictEqual(state.added[0].opts.watchNew, true);
  assert.strictEqual(state.added[0].opts.stats.get(P('sub', 'clip.mp4')).size, 5000, 'the settled size');
  assert.strictEqual(state.scans.length, 1);
  await advance(5000);
  assert.strictEqual(state.added.length, 1, 'exactly once');
  assert.strictEqual(lib.byPath(P('sub', 'clip.mp4')).filesize_bytes, 5000);
});

test('Add only: the file is added, nothing goes to the AI scan queue', async () => {
  const { m, disk, state, advance } = setup({ newFiles: 'add_only' });
  m.start();
  disk.file(P('clip.mp4'), 100);
  m.onEvent(1, 'rename', 'clip.mp4');
  await advance(0); await advance(1000);
  assert.strictEqual(state.added.length, 1);
  assert.strictEqual(state.added[0].opts.analyse, false);
  assert.deepStrictEqual(state.scans, []);
});

test('skips and small files never reach the library', async () => {
  const { m, disk, state, advance } = setup({ folderOpts: { minSizeBytes: 1000 } });
  m.start();
  disk.file(P('a.mp4.part'), 5000);
  disk.file(P('Thumbs.db'), 5000);
  disk.file(P('tiny.jpg'), 10);
  disk.file(P('song.mp3'), 10);
  disk.file(P('notes.txt'), 10);
  for (const n of ['a.mp4.part', 'Thumbs.db', 'tiny.jpg', 'song.mp3', 'notes.txt']) m.onEvent(1, 'rename', n);
  await advance(0); await advance(1000);
  assert.deepStrictEqual(state.added.map(a => a.paths).flat(), [P('song.mp3')]);
});

test('delete marks Missing after the move window (every field kept); restore clears it', async () => {
  const { m, disk, lib, advance } = setup();
  const row = lib.put(P('keep.mp4'), 300, 7, { user_notes: 'mine', user_rating: 5 });
  m.start();
  m.onEvent(1, 'rename', 'keep.mp4');          // deleted
  await advance(0);
  assert.strictEqual(row.missing_since, null, 'not yet: it may be a move');
  await advance(MOVE_WINDOW_MS);
  assert.ok(row.missing_since != null, 'marked missing');
  assert.strictEqual(row.user_notes, 'mine');
  assert.strictEqual(row.user_rating, 5);
  assert.strictEqual(lib.rows.size, 1, 'the row is never deleted');
  disk.file(P('keep.mp4'), 300, 7);             // restored
  m.onEvent(1, 'rename', 'keep.mp4');
  await advance(0);
  assert.strictEqual(row.missing_since, null, 'back');
});

test('a file deleted and put straight back (a safe save) is never marked missing', async () => {
  const { m, disk, lib, advance } = setup();
  const row = lib.put(P('doc.mp4'), 300, 7);
  m.start();
  m.onEvent(1, 'rename', 'doc.mp4');
  await m.flush();
  disk.file(P('doc.mp4'), 300, 7);
  m.onEvent(1, 'rename', 'doc.mp4');
  await advance(0);
  await advance(MOVE_WINDOW_MS + 1);
  assert.strictEqual(row.missing_since, null);
});

test('simple move: same size and mtime appearing in the window keeps the row; ambiguity does not', async () => {
  const { m, disk, lib, state, advance } = setup();
  // A rename is proven by the quick fingerprint (the name changed).
  const row = lib.put(P('a', 'old.mp4'), 4242, 99, { user_notes: 'keep me', quick_hash: 'H-old' });
  disk.file(P('b', 'new name.mp4'), 4242, 99, 'H-old');
  m.start();
  m.onEvent(1, 'rename', path.join('a', 'old.mp4'));
  m.onEvent(1, 'rename', path.join('b', 'new name.mp4'));
  await advance(0);
  assert.strictEqual(row.filepath, P('b', 'new name.mp4'), 'repointed at once, no settle wait');
  assert.strictEqual(row.user_notes, 'keep me');
  assert.strictEqual(state.added.length, 0, 'not added as a new file');
  // Two candidates with the same size and mtime: leave it as delete + add.
  const x = lib.put(P('x1.mp4'), 10, 1);
  const y = lib.put(P('x2.mp4'), 10, 1);
  disk.file(P('z.mp4'), 10, 1);
  m.onEvent(1, 'rename', 'x1.mp4'); m.onEvent(1, 'rename', 'x2.mp4'); m.onEvent(1, 'rename', 'z.mp4');
  await advance(0); await advance(1000);
  assert.strictEqual(x.filepath, P('x1.mp4'));
  assert.strictEqual(y.filepath, P('x2.mp4'));
  assert.deepStrictEqual(state.added.map(a => a.paths).flat(), [P('z.mp4')]);
});

test('a renamed folder: its files move with it (folder event only, as Windows reports it)', async () => {
  const { m, disk, lib, advance } = setup();
  const r1 = lib.put(P('Old', 'a.mp4'), 11, 1);
  const r2 = lib.put(P('Old', 'deep', 'b.jpg'), 22, 2);
  disk.file(P('Old', 'a.mp4'), 11, 1);
  disk.file(P('Old', 'deep', 'b.jpg'), 22, 2);
  m.start();
  disk.mv(P('Old'), P('New'));
  m.onEvent(1, 'rename', 'Old');
  m.onEvent(1, 'rename', 'New');
  await m.flush();
  await m._subWalkDone;
  await advance(0);
  assert.strictEqual(r1.filepath, P('New', 'a.mp4'));
  assert.strictEqual(r2.filepath, P('New', 'deep', 'b.jpg'));
  assert.strictEqual(r1.missing_since, null);
});

test('changed file: probed again, thumbnails redone, error cleared; AI only if never analysed in an analyse folder', async () => {
  const { m, disk, lib, state, advance } = setup();
  const done = lib.put(P('done.mp4'), 100, 1);
  const broken = lib.put(P('broken.mp4'), 50, 1, { processing_error: 'Could not read media info' });
  disk.file(P('done.mp4'), 200, 2);
  disk.file(P('broken.mp4'), 900, 2);           // the copy finished after the scan
  m.start();
  m.onEvent(1, 'change', 'done.mp4');
  m.onEvent(1, 'change', 'broken.mp4');
  await advance(0); await advance(1000);
  assert.deepStrictEqual(state.refreshed.sort(), [done.id, broken.id].sort());
  assert.strictEqual(broken.processing_error, 'unscanned', 'the stale error is gone');
  assert.strictEqual(broken.filesize_bytes, 900);
  assert.strictEqual(done.processing_error, null, 'an analysed file keeps its analysis');
  assert.deepStrictEqual(state.scans, [broken.id], 'AI only for the never-analysed file');
});

test('links and junctions are never followed', async () => {
  const { m, disk, state, advance } = setup();
  disk.link(P('jn'));
  disk.nodes.set(P('jn', 'a.mp4'), { kind: 'file', size: 5, mtimeMs: 1 });
  disk.link(P('l.mp4'));
  m.start();
  m.onEvent(1, 'rename', path.join('jn', 'a.mp4'));
  m.onEvent(1, 'rename', 'l.mp4');
  await advance(0); await advance(1000); await advance(1000);
  assert.deepStrictEqual(state.added, []);
});

test('a dropped event (null name) walks the folder instead', async () => {
  const { m, disk, state, advance } = setup();
  m.start();
  disk.file(P('flood', 'f1.mp4'), 5);
  m.onEvent(1, 'change', null);
  assert.strictEqual(m.catchQueue.length, 1);
  await m.runCatchUps();
  await advance(0); await advance(1000);
  assert.deepStrictEqual(state.added.map(a => a.paths).flat(), [P('flood', 'f1.mp4')]);
});

test('lock: watches close, queues drop, nothing is written; unlock catches up', async () => {
  const { m, disk, lib, state, advance } = setup();
  const row = lib.put(P('gone.mp4'), 5, 1);
  disk.file(P('gone.mp4'), 5, 1);
  m.start();
  assert.strictEqual(state.watches.length, 1);
  disk.file(P('new.mp4'), 6, 2);
  m.onEvent(1, 'rename', 'new.mp4');
  await m.flush();
  // Lock (lib/watchers/index.js calls stop() on 'locking').
  state.locked = true;
  m.stop();
  assert.ok(state.watches[0].closed);
  assert.strictEqual(m.settler.size, 0);
  disk.rm(P('gone.mp4'));
  m.onEvent(1, 'rename', 'gone.mp4');           // a late event from the closed watch
  await advance(MOVE_WINDOW_MS * 2);
  assert.deepStrictEqual(lib.writes, [], 'no database work while locked');
  assert.deepStrictEqual(state.added, []);
  assert.strictEqual(m.queueCatchUp(1), false);
  // Unlock: start with a catch-up walk, which finds both changes.
  state.locked = false;
  m.start({ catchUpAll: true });
  assert.strictEqual(state.watches.length, 2);
  await m.runCatchUps();
  await advance(0); await advance(1000);
  assert.ok(row.missing_since != null, 'the delete made while locked is found');
  assert.deepStrictEqual(state.added.map(a => a.paths).flat(), [P('new.mp4')]);
});

test('a lock in the middle of a catch-up walk stops it before it writes', async () => {
  const { m, disk, lib, state } = setup();
  for (let i = 0; i < 1200; i++) disk.file(P(`f${i}.mp4`), 5, 1);
  lib.put(P('was-here.mp4'), 5, 1);
  m.start();
  m.queueCatchUp(1);
  const run = m.runCatchUps();
  await new Promise(r => setImmediate(r));
  state.locked = true;
  m.stop();
  await run;
  assert.deepStrictEqual(lib.writes, []);
  assert.strictEqual(m.ops.missing.length, 0);
});

test('Pause all stops watching until Resume, which catches up', async () => {
  const { m, disk, state } = setup();
  m.start();
  m.pauseAll();
  assert.strictEqual(state.paused, true);
  assert.ok(state.watches[0].closed);
  assert.strictEqual(m.start(), false, 'stays stopped while paused');
  disk.file(P('while-paused.mp4'), 5);
  m.d.manualTimers = true;
  m.resumeAll();
  assert.strictEqual(state.paused, false);
  assert.strictEqual(m.catchQueue.length, 1, 'resume walks the folder');
});

test('unreadable folder: an error in plain words, nothing marked missing', async () => {
  const { m, disk, lib } = setup();
  const row = lib.put(P('a.mp4'), 5, 1);
  disk.rm(ROOT);
  m.start();
  m.queueCatchUp(1);
  await m.runCatchUps();
  await m.tick();
  assert.strictEqual(row.missing_since, null);
  assert.strictEqual(m.statusOf(m.folders.get(1)).state, 'error');
  assert.match(m.statusOf(m.folders.get(1)).error, /not found/i);
});

/* ── Catch-up diffing on a real folder ─────────────────────────────────── */

test('catch-up: new, changed, back, gone, backfill; skipped files still count as present', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-watch-catchup-'));
  try {
    const w = (rel, bytes) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes)); return p; };
    const same = w('same.mp4', 10);
    const changed = w('sub/changed.mp4', 20);
    const back = w('back.jpg', 30);
    const old = w('old.mkv', 40);
    const skippedButKnown = w('clip.mp4.part', 50);
    w('brand-new.mp4', 60);
    w('ignored.txt', 5);
    const st = (p) => fs.statSync(p);
    const rows = [
      { id: 1, filepath: same, filesize_bytes: 10, file_mtime_ms: Math.trunc(st(same).mtimeMs), missing_since: null },
      { id: 2, filepath: changed, filesize_bytes: 999, file_mtime_ms: 1, missing_since: null },
      { id: 3, filepath: back, filesize_bytes: 30, file_mtime_ms: Math.trunc(st(back).mtimeMs), missing_since: 123 },
      { id: 4, filepath: old, filesize_bytes: 40, file_mtime_ms: null, missing_since: null },
      { id: 5, filepath: skippedButKnown, filesize_bytes: 50, file_mtime_ms: Math.trunc(st(skippedButKnown).mtimeMs), missing_since: null },
      { id: 6, filepath: path.join(dir, 'deleted.mp4'), filesize_bytes: 70, file_mtime_ms: 5, missing_since: null },
      { id: 7, filepath: path.join(dir, 'already-missing.mp4'), filesize_bytes: 70, file_mtime_ms: 5, missing_since: 9 },
    ];
    const folder = { path: dir, includeSubfolders: true, types: ['video', 'image'], skipPatterns: rules.DEFAULT_SKIP_PATTERNS, minSizeBytes: 0 };
    const rowsUnder = sortedRowsUnder(() => rows);
    const res = await catchUp(folder, { rowsUnder });
    assert.strictEqual(res.error, undefined);
    assert.deepStrictEqual(res.newFiles.map(f => path.basename(f.path)), ['brand-new.mp4']);
    assert.deepStrictEqual(res.changed.map(c => c.id), [2]);
    assert.deepStrictEqual(res.back.map(c => c.id), [3]);
    assert.deepStrictEqual(res.backfill.map(c => c.id), [4], 'no recorded mtime, same size: recorded, not changed');
    assert.deepStrictEqual(res.gone.map(g => g.id), [6], 'the skipped-but-known file is present; already missing stays out');
    const flat = await catchUp({ ...folder, includeSubfolders: false }, { rowsUnder });
    assert.ok(!flat.changed.some(c => c.id === 2), 'without subfolders, deeper rows are nobody\'s');
    assert.ok(!flat.gone.some(g => g.id === 2));
    const missingRoot = await catchUp({ ...folder, path: path.join(dir, 'nope') }, { rowsUnder });
    assert.strictEqual(missingRoot.error, 'ENOENT');
    assert.deepStrictEqual(missingRoot.gone, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('move matcher: unique size + mtime pairs; copies pair by path; ambiguity is left alone', () => {
  const r = matchMoves(
    [{ id: 1, path: 'x/a', size: 5, mtimeMs: 1 }, { id: 2, path: 'x/b', size: 6, mtimeMs: 1 }, { id: 3, path: 'x/c', size: 6, mtimeMs: 1 }, { id: 4, path: 'x/d', size: 0, mtimeMs: 1 }],
    [{ path: 'y/q', size: 5, mtimeMs: 1 }, { path: 'y/r', size: 6, mtimeMs: 1 }, { path: 'y/d', size: 0, mtimeMs: 1 }],
  );
  assert.deepStrictEqual(r.moves.map(m => [m.id, m.newPath]), [[1, 'y/q']], 'a lone pair moves whatever its name');
  assert.deepStrictEqual(r.gone.map(g => g.id), [2, 3, 4], 'two candidates, no name to tell them apart');
  assert.deepStrictEqual(r.found.map(f => f.path), ['y/r', 'y/d'], 'empty files never pair');
  // Identical copies in a renamed folder: by name, then by folder name.
  const d = matchMoves(
    [{ id: 1, path: 'D/c1.jpg', size: 5, mtimeMs: 1 }, { id: 2, path: 'D/c2.jpg', size: 5, mtimeMs: 1 },
      { id: 3, path: 'D/a/x.jpg', size: 5, mtimeMs: 1 }, { id: 4, path: 'D/b/x.jpg', size: 5, mtimeMs: 1 }],
    [{ path: 'D2/b/x.jpg', size: 5, mtimeMs: 1 }, { path: 'D2/c2.jpg', size: 5, mtimeMs: 1 },
      { path: 'D2/a/x.jpg', size: 5, mtimeMs: 1 }, { path: 'D2/c1.jpg', size: 5, mtimeMs: 1 }],
  );
  assert.deepStrictEqual(d.moves.map(m => [m.id, m.newPath]).sort((a, b) => a[0] - b[0]),
    [[1, 'D2/c1.jpg'], [2, 'D2/c2.jpg'], [3, 'D2/a/x.jpg'], [4, 'D2/b/x.jpg']]);
});

/* ── Data safety (verifier round 1) ─────────────────────────────────────── */

test('busy queue: a folder renamed while another folder is being walked keeps its rows', async () => {
  const { m, disk, lib, state, advance } = setup();
  const OTHER = path.join(path.dirname(ROOT), 'vault-fake-watch-other');
  disk.dir(OTHER);
  disk.nodes.set(path.join(OTHER, 'x.jpg'), { kind: 'file', size: 5, mtimeMs: 1 });
  lib.folders.push({ ...lib.folders[0], id: 2, path: OTHER });
  const rows = [0, 1, 2].map(i => {
    disk.file(P('B', 'Pics', `p${i}.jpg`), 1000 + i, 7);
    return lib.put(P('B', 'Pics', `p${i}.jpg`), 1000 + i, 7, { user_notes: `note${i}` });
  });
  m.start();
  let release;
  disk.hold.set(OTHER, new Promise(r => { release = r; }));
  m.queueCatchUp(2);
  const busy = m.runCatchUps();                // stuck on the other folder
  disk.mv(P('B', 'Pics'), P('B', 'Pics2'));
  m.onEvent(1, 'rename', path.join('B', 'Pics'));
  m.onEvent(1, 'rename', path.join('B', 'Pics2'));
  await m.flush();
  await m._subWalkDone;                        // not queued behind the busy walk
  await advance(MOVE_WINDOW_MS * 3);
  release();
  await busy;
  await advance(1000); await advance(1000);
  rows.forEach((r, i) => {
    assert.strictEqual(r.filepath, P('B', 'Pics2', `p${i}.jpg`));
    assert.strictEqual(r.missing_since, null);
    assert.strictEqual(r.user_notes, `note${i}`);
  });
  assert.ok(!state.added.some(a => a.paths.some(p => p.includes('Pics2'))), 'no duplicate rows');
});

test('the move window stays open while a renamed folder is still being walked', async () => {
  const { m, disk, lib, advance } = setup();
  const row = lib.put(P('Old', 'a.mp4'), 11, 1);
  disk.file(P('Old', 'a.mp4'), 11, 1);
  m.start();
  disk.mv(P('Old'), P('New'));
  let release;
  disk.hold.set(P('New'), new Promise(r => { release = r; }));
  m.onEvent(1, 'rename', 'Old');
  m.onEvent(1, 'rename', 'New');
  await m.flush();
  await advance(MOVE_WINDOW_MS * 2);           // the subfolder walk is slow
  assert.strictEqual(row.missing_since, null, 'not called missing while its new home is being walked');
  release();
  await m._subWalkDone;
  await advance(0);
  assert.strictEqual(row.filepath, P('New', 'a.mp4'));
});

test('re-pair: a Missing file that turns up elsewhere in the folder gets its row back (live and catch-up)', async () => {
  const { m, disk, lib, state, advance } = setup();
  const gone = lib.put(P('a', 'clip.mp4'), 4242, 9, { user_notes: 'keep', missing_since: 123, quick_hash: 'H-clip' });
  const outside = lib.put(path.join(path.dirname(ROOT), 'elsewhere', 'z.mp4'), 777, 3, { missing_since: 5 });
  m.start();
  disk.file(P('b', 'renamed.mp4'), 4242, 9, 'H-clip');
  m.onEvent(1, 'rename', path.join('b', 'renamed.mp4'));
  await advance(0);
  assert.strictEqual(gone.filepath, P('b', 'renamed.mp4'));
  assert.strictEqual(gone.missing_since, null);
  assert.strictEqual(gone.user_notes, 'keep');
  assert.deepStrictEqual(state.added, []);
  // Catch-up: a file matching a Missing row outside this folder is just new.
  disk.file(P('c', 'z.mp4'), 777, 3);
  m.queueCatchUp(1);
  await m.runCatchUps();
  await advance(0); await advance(1000);
  assert.strictEqual(outside.missing_since, 5, 'rows outside the watched folder are not taken');
  assert.deepStrictEqual(state.added.map(a => a.paths).flat(), [P('c', 'z.mp4')]);
  // And by catch-up: gone while Vault was closed, back under another name.
  const g2 = lib.put(P('d', 'e.jpg'), 31, 4, { missing_since: 9, quick_hash: 'H-e' });
  disk.file(P('d2', 'e-copy.jpg'), 31, 4, 'H-e');
  m.queueCatchUp(1);
  await m.runCatchUps();
  await advance(0);
  assert.strictEqual(g2.filepath, P('d2', 'e-copy.jpg'));
  assert.strictEqual(g2.missing_since, null);
});

test('re-pair ties: two Missing copies go by name, never by guess', async () => {
  const { m, disk, lib, state, advance } = setup();
  const c1 = lib.put(P('x', 'c1.jpg'), 50, 2, { missing_since: 1 });
  const c2 = lib.put(P('x', 'c2.jpg'), 50, 2, { missing_since: 1 });
  m.start();
  disk.file(P('y', 'c2.jpg'), 50, 2);
  disk.file(P('y', 'other.jpg'), 50, 2);
  m.onEvent(1, 'rename', path.join('y', 'c2.jpg'));
  m.onEvent(1, 'rename', path.join('y', 'other.jpg'));
  await advance(0); await advance(1000);
  assert.strictEqual(c2.filepath, P('y', 'c2.jpg'));
  assert.strictEqual(c1.filepath, P('x', 'c1.jpg'), 'ambiguous: left missing');
  assert.deepStrictEqual(state.added.map(a => a.paths).flat(), [P('y', 'other.jpg')]);
});

test('identical copies in a renamed folder keep their own rows', async () => {
  const { m, disk, lib, state, advance } = setup();
  const c1 = lib.put(P('D', 'c1.jpg'), 2000, 5, { user_notes: 'n1' });
  const c2 = lib.put(P('D', 'c2.jpg'), 2000, 5, { user_notes: 'n2' });
  disk.file(P('D', 'c1.jpg'), 2000, 5);
  disk.file(P('D', 'c2.jpg'), 2000, 5);
  m.start();
  disk.mv(P('D'), P('D2'));
  m.onEvent(1, 'rename', 'D');
  m.onEvent(1, 'rename', 'D2');
  await m.flush();
  await m._subWalkDone;
  await advance(0);
  assert.strictEqual(c1.filepath, P('D2', 'c1.jpg'));
  assert.strictEqual(c2.filepath, P('D2', 'c2.jpg'));
  assert.deepStrictEqual(state.added, []);
});

test('case-only rename keeps the row and takes the new case (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const { m, disk, lib, state, advance } = setup();
  const row = lib.put(P('a.jpg'), 5000, 3, { user_notes: 'tagged' });
  disk.file(P('A.jpg'), 5000, 3);              // already renamed on disk
  m.start();
  m.onEvent(1, 'rename', 'a.jpg');
  m.onEvent(1, 'rename', 'A.jpg');
  await advance(0); await advance(1000);
  await advance(MOVE_WINDOW_MS + 1);
  assert.strictEqual(row.filepath, P('A.jpg'));
  assert.strictEqual(row.missing_since, null);
  assert.strictEqual(lib.rows.size, 1, 'no second row');
  assert.deepStrictEqual(state.added, []);
  // And found by a catch-up walk (renamed while Vault was closed).
  const r2 = lib.put(P('b.jpg'), 6000, 3);
  disk.file(P('B.JPG'), 6000, 3);
  m.queueCatchUp(1);
  await m.runCatchUps();
  await advance(0); await advance(1000);
  assert.strictEqual(r2.filepath, P('B.JPG'));
  assert.strictEqual(lib.rows.size, 2);
});

test('root deleted: "Folder not found", nothing marked missing; recreated: watched again and walked', async () => {
  const { m, disk, lib, state, advance } = setup();
  const rows = [0, 1, 2].map(i => { disk.file(P('S', `f${i}.jpg`), 100 + i, 1); return lib.put(P('S', `f${i}.jpg`), 100 + i, 1); });
  m.start();
  await advance(0);                            // first health look learns the folder
  disk.rm(ROOT);
  for (let i = 0; i < 3; i++) m.onEvent(1, 'rename', path.join('S', `f${i}.jpg`));
  await advance(0);
  await advance(MOVE_WINDOW_MS + 3000);        // window over, health look due
  rows.forEach(r => assert.strictEqual(r.missing_since, null, 'a vanished folder marks nothing'));
  const st = m.statusOf(m.folders.get(1));
  assert.strictEqual(st.state, 'error');
  assert.match(st.error, /not found/i);
  assert.ok(state.watches[0].closed, 'the dead watch is closed');
  // The folder comes back (a new folder: new identity) with a new file.
  disk.dir(ROOT);
  disk.file(P('new.jpg'), 2000, 1);
  await advance(13000);
  await advance(6000);                          // the new watch held: now walked
  assert.ok(state.watches.length >= 2 && !state.watches.at(-1).closed, 'watched again');
  await m.runCatchUps();
  await advance(0); await advance(1000);
  assert.deepStrictEqual(state.added.map(a => a.paths).flat(), [P('new.jpg')]);
  assert.strictEqual(m.statusOf(m.folders.get(1)).state, 'live');
});

test('root replaced between two looks: the dead watch is replaced and the folder walked', async () => {
  const { m, disk, state, advance } = setup();
  m.start();
  await advance(0);
  disk.rm(ROOT);
  disk.dir(ROOT);                               // same name, a different folder
  disk.file(P('n.jpg'), 3000, 2);
  await advance(13000);
  await advance(6000);                          // the new watch held: now walked
  assert.strictEqual(state.watches.length, 2);
  assert.ok(state.watches[0].closed);
  await m.runCatchUps();
  await advance(0); await advance(1000);
  assert.deepStrictEqual(state.added.map(a => a.paths).flat(), [P('n.jpg')]);
});

test('a relink between the decision and the write: nothing lands on the moved row', async () => {
  const { m, disk, lib, advance } = setup();
  const row = lib.put(P('v.mp4'), 10, 1);
  m.start();
  m.onEvent(1, 'rename', 'v.mp4');             // looks deleted
  await advance(0);
  row.filepath = path.join(path.dirname(ROOT), 'relinked', 'v.mp4');   // a migrate repointed it
  await advance(MOVE_WINDOW_MS + 1);
  assert.strictEqual(row.missing_since, null, 'the missing mark named the old path');
  // A queued move whose row was repointed meanwhile is dropped too.
  const r2 = lib.put(P('w.mp4'), 20, 2);
  m.ops.moves.push({ id: r2.id, oldPath: P('somewhere-else.mp4'), newPath: P('w2.mp4'), size: 20, mtimeMs: 2, folderId: 1 });
  disk.file(P('w.mp4'), 20, 2);
  await advance(0);
  assert.strictEqual(r2.filepath, P('w.mp4'));
});

/* ── Verifier round 2 ───────────────────────────────────────────────────── */

test('case race: a new file renamed in case before it settles is one row, in the case on disk (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const { m, disk, state, advance } = setup();
  disk.ci = true;
  m.start();
  for (let i = 0; i < 3; i++) disk.file(P(`n${i}.jpg`), 3000 + i, 5);
  for (let i = 0; i < 3; i++) m.onEvent(1, 'rename', `n${i}.jpg`);
  await advance(0);
  for (let i = 0; i < 3; i++) { disk.mv(P(`n${i}.jpg`), P(`N${i}.JPG`)); m.onEvent(1, 'rename', `n${i}.jpg`); m.onEvent(1, 'rename', `N${i}.JPG`); }
  await advance(0); await advance(1000); await advance(1000);
  const added = state.added.map(a => a.paths).flat().sort();
  assert.deepStrictEqual(added, [P('N0.JPG'), P('N1.JPG'), P('N2.JPG')]);
});

test('fingerprint: a different file with the same size and time never takes a Missing row', async () => {
  const { m, disk, lib, state, advance } = setup();
  const a = lib.put(P('S1', 'a.jpg'), 5000, 7, { user_notes: 'tagged-a', missing_since: 1, quick_hash: 'H-A' });
  m.start();
  disk.file(P('S2', 'zebra.jpg'), 5000, 7, 'H-Z');
  disk.file(P('S3', 'a.jpg'), 5000, 7, 'H-Q');            // same name too, other content
  m.onEvent(1, 'rename', path.join('S2', 'zebra.jpg'));
  m.onEvent(1, 'rename', path.join('S3', 'a.jpg'));
  await advance(0); await advance(1000);
  assert.strictEqual(a.filepath, P('S1', 'a.jpg'));
  assert.ok(a.missing_since != null);
  assert.deepStrictEqual(state.added.map(x => x.paths).flat().sort(), [P('S2', 'zebra.jpg'), P('S3', 'a.jpg')].sort());
  // The real file, back under a new name: its fingerprint proves it.
  disk.file(P('S4', 'renamed.jpg'), 5000, 7, 'H-A');
  m.onEvent(1, 'rename', path.join('S4', 'renamed.jpg'));
  await advance(0);
  assert.strictEqual(a.filepath, P('S4', 'renamed.jpg'));
  assert.strictEqual(a.user_notes, 'tagged-a');
});

test('no fingerprint yet: a Missing row only comes back to a file with its own name', async () => {
  const { m, disk, lib, state, advance } = setup();
  const b = lib.put(P('S2', 'b.jpg'), 5000, 7, { user_notes: 'nb', missing_since: 1 });
  m.start();
  disk.file(P('S3', 'c.jpg'), 5000, 7, 'H-C');
  m.onEvent(1, 'rename', path.join('S3', 'c.jpg'));
  await advance(0); await advance(1000);
  assert.strictEqual(b.filepath, P('S2', 'b.jpg'), 'another name: not this row');
  disk.file(P('S3', 'b.jpg'), 5000, 7, 'H-B');
  m.onEvent(1, 'rename', path.join('S3', 'b.jpg'));
  await advance(0);
  assert.strictEqual(b.filepath, P('S3', 'b.jpg'), 'same name, same size and time, no fingerprint to say otherwise');
  assert.deepStrictEqual(state.added.map(x => x.paths).flat(), [P('S3', 'c.jpg')]);
});

test('move window: a different file appearing right after a delete does not take the row', async () => {
  const { m, disk, lib, state, advance } = setup();
  const a = lib.put(P('a.mp4'), 8000, 3, { user_notes: 'tagged-a', quick_hash: 'H-A' });
  const old = lib.put(P('old.mp4'), 9000, 3, { user_notes: 'legacy' });   // no fingerprint
  m.start();
  m.onEvent(1, 'rename', 'a.mp4');
  m.onEvent(1, 'rename', 'old.mp4');
  await advance(0);
  disk.file(P('other', 'b.mp4'), 8000, 3, 'H-B');
  disk.file(P('other', 'c.mp4'), 9000, 3, 'H-C');
  m.onEvent(1, 'rename', path.join('other', 'b.mp4'));
  m.onEvent(1, 'rename', path.join('other', 'c.mp4'));
  await advance(0); await advance(1000);
  await advance(MOVE_WINDOW_MS + 1);
  assert.strictEqual(a.filepath, P('a.mp4'));
  assert.ok(a.missing_since != null);
  assert.strictEqual(old.filepath, P('old.mp4'), 'no fingerprint and another name: not proven');
  assert.deepStrictEqual(state.added.map(x => x.paths).flat().sort(), [P('other', 'b.mp4'), P('other', 'c.mp4')].sort());
});

test('between watched folders: a live move keeps its row; an old Missing row is never taken across', async () => {
  const { m, disk, lib, state, advance } = setup();
  const W2 = path.join(path.dirname(ROOT), 'vault-fake-watch-w2');
  disk.dir(W2);
  lib.folders.push({ ...lib.folders[0], id: 2, path: W2 });
  const a = lib.put(P('a.jpg'), 4000, 2, { user_notes: 'tag-a', quick_hash: 'H-A' });
  const b = lib.put(P('b.jpg'), 4100, 2, { user_notes: 'tag-b', missing_since: 1, quick_hash: 'H-B' });
  m.start();
  disk.nodes.set(path.join(W2, 'a.jpg'), { kind: 'file', size: 4000, mtimeMs: 2, hash: 'H-A' });
  m.onEvent(1, 'rename', 'a.jpg');
  m.onEvent(2, 'rename', 'a.jpg');
  await advance(0);
  assert.strictEqual(a.filepath, path.join(W2, 'a.jpg'), 'moved inside the window: row kept');
  disk.nodes.set(path.join(W2, 'b.jpg'), { kind: 'file', size: 4100, mtimeMs: 2, hash: 'H-B' });
  m.onEvent(2, 'rename', 'b.jpg');
  await advance(0); await advance(1000);
  assert.strictEqual(b.filepath, P('b.jpg'), 'a Missing row stays with its own folder');
  assert.deepStrictEqual(state.added.map(x => x.paths).flat(), [path.join(W2, 'b.jpg')]);
});

test('rows from before modified times: a live move keeps the row by size and name', async () => {
  const { m, disk, lib, advance } = setup();
  const row = lib.put(P('Sub', 'a.jpg'), 4000, null, { user_notes: 'tag-a' });
  m.start();
  disk.file(P('Other', 'a.jpg'), 4000, 77);
  m.onEvent(1, 'rename', path.join('Sub', 'a.jpg'));
  m.onEvent(1, 'rename', path.join('Other', 'a.jpg'));
  await advance(0);
  assert.strictEqual(row.filepath, P('Other', 'a.jpg'));
  assert.strictEqual(row.user_notes, 'tag-a');
});

test('a watch that keeps failing (EPERM) backs off and is not walked until it holds', async () => {
  const { m, state, advance } = setup();
  state.watchError = 'EPERM';
  m.start();
  assert.ok(m.errors.has(1));
  assert.ok(!m.offline.has(1), 'not taken as gone');
  const waits = [m.backoff.get(1).until - m.now()];
  for (let i = 0; i < 3; i++) {
    await advance(HEALTH_MS);
    m._retryArm(1);                    // fails again
    waits.push(m.backoff.get(1).until - m.now());
  }
  assert.ok(waits[1] > waits[0] && waits[2] > waits[1], `pauses grow: ${waits}`);
  assert.strictEqual(m.catchQueue.length, 0, 'no walk while it keeps failing');
  state.watchError = null;
  m._retryArm(1);
  assert.strictEqual(m.catchQueue.length, 0, 'not yet: the watch has to hold first');
  await advance(CONFIRM_MS);
  assert.strictEqual(m.catchQueue.length, 1, 'held: one walk');
  assert.ok(!m.errors.has(1));
  assert.ok(!m.backoff.has(1));
});

test('ENOENT is gone (offline, nothing marked); other codes are passing', () => {
  const { m } = setup();
  m.start();
  const f = m.folders.get(1);
  m._fail(f, 'EBUSY');
  assert.ok(!m.offline.has(1));
  m._fail(f, 'ENOENT');
  assert.ok(m.offline.has(1));
});

test('during a migrate: no backfill, no folder notes, no writes; they run after', async () => {
  const { m, disk, lib, state, advance } = setup();
  const row = lib.put(P('legacy.jpg'), 10, null);
  disk.file(P('legacy.jpg'), 10, 5);
  const gone = lib.put(P('gone.jpg'), 20, 6);
  m.start();
  state.migrating = true;
  m.queueCatchUp(1);
  await m.runCatchUps();
  await advance(0);
  assert.deepStrictEqual(lib.writes, [], 'nothing written while paths are being rewritten');
  assert.deepStrictEqual(lib.notes, []);
  assert.strictEqual(row.file_mtime_ms, null);
  state.migrating = false;
  await advance(0);
  assert.ok(gone.missing_since != null, 'the queued work lands after the migrate');
});

test('catch-up merge order: names that sort around a folder (a b, a!x, A1, a/x) are all matched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-watch-order-'));
  try {
    const names = ['a b.jpg', 'a!x.jpg', 'A1.jpg', path.join('a', 'x.jpg'), path.join('a', 'b', 'c.jpg'), 'a.jpg', 'Z.jpg', 'é.jpg', path.join('a b', 'q.jpg')];
    let id = 0;
    const rows = names.map((n) => {
      const p = path.join(dir, n);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.alloc(10));
      const st = fs.statSync(p);
      return { id: ++id, filepath: p, filesize_bytes: 10, file_mtime_ms: Math.trunc(st.mtimeMs), missing_since: null, quick_hash: 'h' };
    });
    const folder = { path: dir, includeSubfolders: true, types: ['image'], skipPatterns: [], minSizeBytes: 0 };
    const res = await catchUp(folder, { rowsUnder: sortedRowsUnder(() => rows) });
    assert.deepStrictEqual(res.gone, []);
    assert.deepStrictEqual(res.newFiles, []);
    assert.deepStrictEqual(res.changed, []);
    assert.strictEqual(res.seen, names.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ── Verifier round 3 ───────────────────────────────────────────────────── */

test('backfill never overwrites a fingerprint, nor fills one from an older copy', async () => {
  const { m, disk, lib, state, advance } = setup();
  const row = lib.put(P('zz.jpg'), 5000, 1, { user_notes: 'precious' });
  disk.file(P('zz.jpg'), 5000, 1, 'H-OLD');
  m.start();
  m.hashQ.push({ id: row.id, path: row.filepath, size: 5000 });
  // The file is edited; the change lands with the new fingerprint first.
  disk.file(P('zz.jpg'), 5011, 2, 'H-NEW');
  m.onEvent(1, 'change', 'zz.jpg');
  state.staleStat = { size: 5000, mtimeMs: 1, hash: 'H-OLD' };   // the backfill read the old copy
  await advance(0); await advance(1000);
  assert.strictEqual(row.quick_hash, 'H-NEW');
  await advance(0);
  assert.strictEqual(row.quick_hash, 'H-NEW', 'the stale backfill did not land');
  // And a row with none still gets one only when size and time match the copy read.
  const r2 = lib.put(P('y.jpg'), 10, 3);
  disk.file(P('y.jpg'), 10, 3, 'H-Y');
  state.staleStat = { size: 99, mtimeMs: 3, hash: 'H-WRONG' };
  m.hashQ.push({ id: r2.id, path: r2.filepath, size: 10 });
  await advance(0);
  assert.ok(r2.quick_hash == null, 'size differs from the copy read: not stored');
  state.staleStat = null;
  m.hashQ.push({ id: r2.id, path: r2.filepath, size: 10 });
  await advance(0);
  assert.strictEqual(r2.quick_hash, 'H-Y');
});

test('ticks never overlap, and backfill reads go one at a time', async () => {
  const { m, disk, lib, state } = setup();
  for (let i = 0; i < 40; i++) { disk.file(P(`f${i}.jpg`), 10 + i, 1); const r = lib.put(P(`f${i}.jpg`), 10 + i, 1); m.hashQ.push({ id: r.id, path: r.filepath, size: 10 + i }); }
  m.start();
  let release;
  state.holdReads = new Promise(r => { release = r; });
  const ticks = [m.tick(), m.tick(), m.tick(), m.tick()];
  await new Promise(r => setImmediate(r));
  assert.strictEqual(state.maxInFlight, 1, 'one read in flight');
  release();
  await Promise.all(ticks);
  assert.strictEqual(state.maxInFlight, 1);
  assert.strictEqual(state.reads, 8, 'one batch: the other ticks returned at once');
});

test('network shares: no fingerprint backfill, no read for a plain add, one file operation at a time', async () => {
  const { m, lib, state } = setup();
  m.start();
  const share = '\\\\nas\\media';
  for (let i = 0; i < 5; i++) m.hashQ.push({ id: 900 + i, path: `${share}\\f${i}.jpg`, size: 1 });
  await m._backfillHashes();
  assert.strictEqual(state.reads, 0, 'nothing read on the share');
  assert.ok(m._isNetwork(`${share}\\x`));
  m.driveTypes = new Map([['N:', 4]]);
  assert.ok(m._isNetwork('N:\\movies\\a.mp4'), 'a mapped network drive');
  assert.ok(!m._isNetwork(P('a.mp4')));
  // Serialised per share: the second waits for the first.
  let active = 0, peak = 0;
  const op = () => m._io(`${share}\\a`, async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; });
  await Promise.all([op(), op(), op()]);
  assert.strictEqual(peak, 1);
  // Local paths are not queued behind each other.
  active = 0; peak = 0;
  const lop = () => m._io(P('a'), async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; });
  await Promise.all([lop(), lop()]);
  assert.strictEqual(peak, 2);
  assert.ok(lib);
});

test('NTFS-style case: é/É meet, ß/ẞ stay apart; ç.jpg in the library and Ç.jpg on disk is one file', async () => {
  assert.strictEqual(rules.foldCase('été.jpg'), rules.foldCase('ÉTÉ.JPG'));
  assert.notStrictEqual(rules.foldCase('ß.jpg'), rules.foldCase('ẞ.jpg'));
  assert.strictEqual(rules.foldCase('ab'), 'AB');
  if (process.platform !== 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-watch-ucase-'));
  try {
    const onDisk = path.join(dir, 'Ça.jpg');
    fs.writeFileSync(onDisk, Buffer.alloc(4004));            // edited too
    const rows = [{ id: 1, filepath: path.join(dir, 'ça.jpg'), filesize_bytes: 4000, file_mtime_ms: 5, missing_since: null, quick_hash: null }];
    const folder = { path: dir, includeSubfolders: true, types: ['image'], skipPatterns: [], minSizeBytes: 0 };
    const res = await catchUp(folder, { rowsUnder: sortedRowsUnder(() => rows) });
    assert.deepStrictEqual(res.gone, [], 'not missing');
    assert.deepStrictEqual(res.newFiles, [], 'not new');
    assert.deepStrictEqual(res.recase.map(r => [r.id, path.basename(r.newPath)]), [[1, 'Ça.jpg']]);
    assert.deepStrictEqual(res.changed.map(c => c.id), [1], 'the edit is seen');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Settler keys paths the NTFS way (one entry for é and É)', async () => {
  const { m } = setup();
  m.start();
  m.settler.observe(P('été.jpg'), { folderId: 1, kind: 'new' });
  m.settler.observe(P('ÉTÉ.jpg'), { folderId: 1, kind: 'new' });
  assert.strictEqual(m.settler.size, process.platform === 'win32' ? 1 : 2);
});

test('live non-ASCII case-only rename: the event for the old spelling finds the row, the file system gives the new case (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const { m, disk, lib, state, advance } = setup();
  disk.ci = true;
  const row = lib.put(P('\u00e9t\u00e9.jpg'), 4000, 3, { user_notes: 'tagged' });
  disk.file(P('\u00c9T\u00c9.jpg'), 4000, 3);
  m.start();
  m.onEvent(1, 'rename', '\u00e9t\u00e9.jpg');
  m.onEvent(1, 'rename', '\u00c9T\u00c9.jpg');
  await advance(0); await advance(1000); await advance(1000);
  assert.strictEqual(row.filepath, P('\u00c9T\u00c9.jpg'));
  assert.strictEqual(row.user_notes, 'tagged');
  assert.deepStrictEqual(state.added, [], 'no second row');
  assert.strictEqual(lib.rows.size, 1);
});

test('fold whitelist is frozen: only ASCII, Latin-1, Latin Ext-A, Greek and basic Cyrillic fold', () => {
  const same = (a, b) => rules.foldCase('\u00e9' + a) === rules.foldCase('\u00e9' + b);
  // Inside the whitelist: folded.
  for (const [a, b] of [['a', 'A'], ['\u00e9', '\u00c9'], ['\u00ff', '\u0178'], ['\u0101', '\u0100'], ['\u03b1', '\u0391'], ['\u0436', '\u0416'], ['\u045f', '\u040f']]) {
    assert.ok(same(a, b), `${a}/${b} fold`);
  }
  // Outside: never folded (NTFS keeps many of these apart; a wrong merge drops a file).
  for (const [a, b, what] of [
    ['\u10d0', '\u1c90', 'Georgian Mkhedruli/Mtavruli'], ['\uab70', '\u13a0', 'Cherokee'],
    ['\u{10428}', '\u{10400}', 'Deseret'], ['\u{1e922}', '\u{1e900}', 'Adlam'],
    ['\ua77a', '\ua779', 'Latin Ext-D'], ['\u0180', '\u0243', 'Latin Ext-B'], ['\u1ea1', '\u1ea0', 'Latin Ext Additional'],
    ['\u0501', '\u0500', 'Cyrillic Supplement'], ['\u03f3', '\u037f', 'Greek Yot'], ['\u01c5', '\u01c6', 'titlecase'],
  ]) {
    assert.ok(!same(a, b), `${what}: ${a}/${b} stay apart`);
  }
});
