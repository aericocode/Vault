/**
 * Skip on tracks, page side:
 *  - PlaylistTime (player-lib/playlist-time.js): the total of what plays and
 *    the time left from where the list stands, skipped files left out;
 *  - the queue's walk (player-core.js nextPlayableIndex, in a VM): Next,
 *    Previous, Repeat all and the end of the list pass over skipped files;
 *  - FlowOrder.nextAfter: the tiles' "Next" mark does the same;
 *  - the Skips store and its actions (collection-skips.js, in a VM with a
 *    fake server): skip, unskip, Unskip all and its Undo;
 *  - the count line ("40 files · 1:42:05, 18:20 skipped · playlist order");
 *  - Play all starting at the first file that is not skipped, and saying so
 *    when every file is.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PlaylistTime = require('../player-lib/playlist-time.js');
const FlowOrder = require('../player-lib/flow-order.js');

/** One top-level function of a browser script, by how it starts. */
function grab(src, sig) {
  const at = src.indexOf(sig);
  assert.ok(at >= 0, `${sig} is there`);
  let depth = 0;
  for (let i = src.indexOf(') {', at) + 2; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`${sig}: no end`);
}

/* ── PlaylistTime ─────────────────────────────────────────────────────── */

const v = (duration, skipped = false) => ({ type: 'video', duration, skipped });

test('totals: what plays, and what the skips take off', () => {
  const t = PlaylistTime.totals([v(600), v(300, true), v(900), { type: 'image', skipped: false }, v(120, true)], { imageSeconds: 8 });
  assert.deepStrictEqual(t, { files: 3, seconds: 1508, about: false, skipped: { files: 2, seconds: 420, about: false } });
});

test('totals: unknown lengths make it "about"; documents and mixes never count', () => {
  const t = PlaylistTime.totals([v(null), v(100), { type: 'document' }, { type: 'mix', duration: 50 }, v(null, true)]);
  assert.deepStrictEqual(t, { files: 2, seconds: 100, about: true, skipped: { files: 1, seconds: 0, about: true } });
  assert.deepStrictEqual(PlaylistTime.totals([]), { files: 0, seconds: 0, about: false, skipped: { files: 0, seconds: 0, about: false } });
});

test('timeLeft: the rest of the file playing, then every file after it that is not skipped', () => {
  const list = [v(600), v(300, true), v(900), v(120, true), v(60)];
  assert.deepStrictEqual(PlaylistTime.timeLeft(list, { index: 0, position: 100 }), { seconds: 500 + 900 + 60, about: false, files: 3 });
  assert.deepStrictEqual(PlaylistTime.timeLeft(list, { index: -1 }), { seconds: 600 + 900 + 60, about: false, files: 3 }, 'nothing playing yet: the whole list');
  assert.deepStrictEqual(PlaylistTime.timeLeft(list, { index: 4, position: 60 }), { seconds: 0, about: false, files: 1 }, 'at the very end');
  assert.deepStrictEqual(PlaylistTime.timeLeft(list, { index: 4, position: 999 }).seconds, 0, 'never below zero');
});

test('timeLeft: a skipped file played by hand counts from where it is', () => {
  const list = [v(600), v(300, true), v(900)];
  assert.deepStrictEqual(PlaylistTime.timeLeft(list, { index: 1, position: 50 }), { seconds: 250 + 900, about: false, files: 2 });
});

test('timeLeft: pictures and GIFs as Stage times them; unknown lengths say about', () => {
  const list = [v(100), { type: 'image' }, { type: 'gif', duration: 3 }, v(null)];
  assert.deepStrictEqual(PlaylistTime.timeLeft(list, { index: 0, position: 0, imageSeconds: 8 }), { seconds: 100 + 8 + 9, about: true, files: 4 });
  assert.strictEqual(PlaylistTime.fileSeconds({ type: 'gif', duration: 3 }, 8), 9, 'whole loops covering the picture time');
});

/* ── The queue's walk (player-core.js) ────────────────────────────────── */

function walker(n, skipped, { collectionId = 7 } = {}) {
  const core = read('player-lib/player/player-core.js');
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const rows = ids.map(id => ({ id, media_type: 'video', filename: `f${id}` }));
  const played = [];
  const ctx = {
    Library: { known: () => true, firstPageIds: ids, length: () => n, typeAt: () => 'video', idAt: (i) => ids[i], rowAt: (i) => rows[i], rowsForRange: async () => {}, spec: { collectionId } },
    Skips: { setFor: (cid) => (cid === 7 ? new Set(skipped) : new Set()) },
    NAV_WINDOW: 24,
    isKnownBadMedia: () => false,
    playIndexHandsFree: async (i) => { played.push(ids[i]); return true; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${grab(core, 'function queueList(')}\n${grab(core, 'function queuePassesOver(')}\n${grab(core, 'function queueSkipSet(')}\n${grab(core, 'async function nextPlayableIndex(')}\n${grab(core, 'async function playListStep(')}\nglobalThis.__w = { nextPlayableIndex, playListStep };`, ctx);
  return { ...ctx.__w, played };
}

test('queue: Next passes over skipped files to the next one that is not', async () => {
  const w = walker(5, [2, 3]);
  assert.strictEqual(await w.playListStep(1, 0, false), true);
  assert.deepStrictEqual(w.played, [4]);
});

test('queue: Previous does too', async () => {
  const w = walker(5, [3, 4]);
  assert.strictEqual(await w.playListStep(-1, 4, false), true);
  assert.deepStrictEqual(w.played, [2]);
});

test('queue: Repeat all wraps past skipped files at the top; the end of the list is the last file not skipped', async () => {
  const w = walker(5, [1, 2, 5]);
  assert.strictEqual(await w.playListStep(1, 3, true), true);
  assert.deepStrictEqual(w.played, [3], 'f5 skipped, f1 and f2 skipped: round to f3');
  const off = walker(5, [5]);
  assert.strictEqual(await off.playListStep(1, 3, false), false, 'Repeat off: f4 was the last that plays');
});

test('queue: every file skipped plays nothing; a folder (or no collection) skips nothing', async () => {
  const all = walker(3, [1, 2, 3]);
  assert.strictEqual(await all.nextPlayableIndex(-1, 1), -1);
  assert.strictEqual(await all.playListStep(1, -1, true), false);
  const folder = walker(3, [1, 2, 3], { collectionId: 9 });
  assert.strictEqual(await folder.nextPlayableIndex(-1, 1), 0);
  const lib = walker(3, [1, 2, 3], { collectionId: null });
  assert.strictEqual(await lib.nextPlayableIndex(-1, 1), 0);
});

test('queue: a list Stage keeps playing elsewhere walks with the skips it was taken with', async () => {
  const core = read('player-lib/player/player-core.js');
  const ids = [1, 2, 3, 4];
  const snap = { ids, known: () => true, firstPageIds: ids, length: () => 4, typeAt: () => 'video', idAt: (i) => ids[i], rowAt: (i) => ({ id: ids[i], media_type: 'video' }), rowsForRange: async () => {}, skips: new Set([2, 3]) };
  const ctx = {
    Library: { spec: { collectionId: null } },
    StageControl: { queueList: () => snap },
    Skips: { setFor: () => new Set() },
    NAV_WINDOW: 24,
    isKnownBadMedia: () => false,
  };
  vm.createContext(ctx);
  vm.runInContext(`${grab(core, 'function queueList(')}\n${grab(core, 'function queuePassesOver(')}\n${grab(core, 'function queueSkipSet(')}\n${grab(core, 'async function nextPlayableIndex(')}\nglobalThis.__n = nextPlayableIndex;`, ctx);
  assert.strictEqual(await ctx.__n(0, 1), 3);
});

test('stage-control: what mpv is handed next, and the bar\'s count, leave skipped files out (source)', () => {
  const sc = read('player-lib/stage-control.js');
  const up = grab(sc, 'async function computeUpcoming(');
  assert.match(up, /const skips = typeof queueSkipSet === 'function' \? queueSkipSet\(L\) : null;/);
  assert.match(up, /if \(skips && skips\.has\(L\.idAt\(i\)\)\) return false;/);
  const count = grab(sc, 'function countText(');
  assert.match(count, /skips\.has\(ids\[i\]\) \? 'skipped' : typeOf\(i\)/);
  assert.strictEqual(require('../player-lib/stage-count.js').plays('skipped'), false, 'a skipped file is not counted');
  assert.match(sc, /addEventListener\('vault:skips-changed'/);
});

/* ── The tiles' Next mark ─────────────────────────────────────────────── */

test('FlowOrder.nextAfter passes over skipped files', () => {
  const ids = [10, 20, 30, 40];
  const o = { indexOf: (id) => ids.indexOf(id), idAt: (i) => ids[i] };
  assert.deepStrictEqual(FlowOrder.nextAfter(10, { ...o, skipped: new Set([20, 30]) }), { id: 40, upNext: false });
  assert.strictEqual(FlowOrder.nextAfter(10, { ...o, skipped: new Set([20, 30, 40]) }), null);
  assert.deepStrictEqual(FlowOrder.nextAfter(10, o), { id: 20, upNext: false }, 'no skips: as before');
  assert.deepStrictEqual(FlowOrder.nextAfter(10, { ...o, upNext: [99], skipped: new Set([99]) }), { id: 99, upNext: true }, 'Up next plays what was put in it');
});

/* ── The store, the buttons and the count line (collection-skips.js) ──── */

function page({ skipped = [], kind = 'collection', counts = {} } = {}) {
  const calls = [];
  const toasts = [];
  const undos = [];
  const events = [];
  const coll = { id: 7, kind, name: 'Friday', item_count: 40, listed_count: 40, timed_count: 40, total_seconds: 7225, unknown_seconds_count: 0, ...counts };
  let server = new Set(skipped);
  const ctx = {
    console, Set, Map, Number, Array, Math, JSON, Promise, String,
    activeCollectionId: 7,
    getCollectionById: (id) => (id === 7 ? coll : null),
    Library: { spec: { collectionId: 7 } },
    takeCollectionLength: (c, d) => { c.skipped_count = d.skipped_count; c.skipped_seconds = d.skipped_seconds; c.skipped_unknown_count = d.skipped_unknown_count; },
    showToast: (t) => toasts.push(t),
    showUndoToast: (t, fn) => { toasts.push(t); undos.push(fn); },
    CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o.detail; } },
    window: { addEventListener: () => {}, dispatchEvent: (e) => events.push(e.detail.cid) },
    fetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push([opts.method, url, body]);
      const was = [...server];
      if (opts.method === 'PUT') server = new Set(body.ids);
      else for (const id of body.ids) { if (body.skip) server.add(id); else server.delete(id); }
      const list = [...server].sort((a, b) => a - b);
      return { ok: true, json: async () => ({ skipped_ids: list, was_ids: was, skipped_count: list.length, skipped_seconds: list.length * 300, skipped_unknown_count: 0 }) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${read('player-lib/stage-count.js')}\n${read('player-lib/collection-skips.js')}\nglobalThis.__p = { Skips, skipTileButton, skipTileClass, skipTileTag, skipCountParts, skipHeaderHtml, toggleSkipFile };`, ctx);
  ctx.__p.Skips.take(7, skipped);
  return { ...ctx.__p, ctx, calls, toasts, undos, events, coll };
}

test('the tile button skips and unskips one file; tiles and rows get the mark', async () => {
  const p = page();
  assert.match(p.skipTileButton(3), /aria-pressed="false"/);
  assert.match(p.skipTileButton(3), /onclick="toggleSkipFile\(3\)"/);
  assert.strictEqual(p.skipTileClass(3), '');
  await p.toggleSkipFile(3);
  assert.deepStrictEqual(p.calls[0], ['POST', '/api/collections/7/skips', { ids: [3], skip: true }]);
  assert.strictEqual(p.Skips.has(7, 3), true);
  assert.strictEqual(p.skipTileClass(3), ' tile-skipped');
  assert.match(p.skipTileTag(3), />Skipped</);
  assert.match(p.skipTileButton(3), /aria-pressed="true"/);
  assert.deepStrictEqual(p.events, [7], 'the page hears of it once');
  await p.toggleSkipFile(3);
  assert.deepStrictEqual(p.calls[1][2], { ids: [3], skip: false });
  assert.strictEqual(p.Skips.has(7, 3), false);
});

test('a folder has no Skip button and no skips', () => {
  const p = page({ kind: 'folder', skipped: [3] });
  assert.strictEqual(p.skipTileButton(3), '');
  assert.strictEqual(p.skipTileClass(3), '');
  assert.strictEqual(p.skipHeaderHtml(p.coll), '');
  assert.strictEqual(p.skipCountParts(p.coll), null);
});

test('Unskip all: one request, a toast with Undo, and Undo puts the same skips back', async () => {
  const p = page({ skipped: [2, 5, 9] });
  assert.match(p.skipHeaderHtml(p.coll), /Unskip all/);
  await p.Skips.unskipAll(7);
  assert.deepStrictEqual(p.calls[0], ['PUT', '/api/collections/7/skips', { ids: [] }]);
  assert.strictEqual(p.Skips.count(7), 0);
  assert.strictEqual(p.skipHeaderHtml(p.coll), '', 'nothing left to unskip');
  assert.deepStrictEqual(p.toasts, ['Unskipped 3 files']);
  await p.undos[0]();
  assert.deepStrictEqual(p.calls[1], ['POST', '/api/collections/7/skips', { ids: [2, 5, 9], skip: true }]);
  assert.deepStrictEqual([...p.Skips.setFor(7)], [2, 5, 9]);
  assert.strictEqual(p.toasts.pop(), 'Skips put back');
});

test('the count line\'s skip part: what plays, and what the skips take off', () => {
  const p = page({ skipped: [1, 2, 3], counts: { skipped_count: 3, skipped_seconds: 1100, skipped_unknown_count: 0 } });
  const parts = p.skipCountParts(p.coll);
  assert.strictEqual(parts.seconds, 7225 - 1100);
  assert.strictEqual(parts.note, '18:20 skipped');
  assert.match(parts.title, /3 files skipped\. It plays for 1:42:05; with them it would be 2:00:25\./);
  // No lengths known for them: the count alone.
  const q = page({ skipped: [1], counts: { skipped_count: 1, skipped_seconds: 0 } });
  assert.deepStrictEqual([q.skipCountParts(q.coll).seconds, q.skipCountParts(q.coll).note], [null, '1 file skipped']);
  assert.strictEqual(page().skipCountParts(page().coll), null, 'nothing skipped: nothing said');
});

test('a saved order showing with its own skips: they are read, the count line uses its length and names it', () => {
  const p = page({ skipped: [1], counts: { skipped_count: 1, skipped_seconds: 300, skipped_unknown_count: 0 } });
  p.Skips.useVariant({ cid: 7, sid: 4, name: 'Night', skips: [2, 3], length: { skipped_count: 2, skipped_seconds: 600, skipped_unknown_count: 0 }, save: async () => {} });
  assert.deepStrictEqual([...p.Skips.setFor(7)], [2, 3]);
  assert.deepStrictEqual(p.events, [7], 'the page hears of the change');
  const parts = p.skipCountParts(p.coll);
  assert.deepStrictEqual([parts.seconds, parts.note], [7225 - 600, '10:00 skipped']);
  assert.match(parts.title, /2 files skipped in “Night”/);
  // The same again: nothing to tell.
  p.Skips.useVariant({ cid: 7, sid: 4, name: 'Night', skips: [3, 2], length: { skipped_count: 2, skipped_seconds: 600 }, save: async () => {} });
  assert.deepStrictEqual(p.events, [7]);
  // None of its own: the playlist's, with the collection's numbers.
  p.Skips.useVariant({ cid: 7, sid: 5, name: 'Old', skips: null, length: null, save: async () => {} });
  assert.deepStrictEqual([...p.Skips.setFor(7)], [1]);
  assert.strictEqual(p.skipCountParts(p.coll).note, '5:00 skipped');
  // Back to the playlist.
  p.Skips.useVariant(null);
  assert.deepStrictEqual([...p.Skips.setFor(7)], [1]);
});

test('collectionCountText puts it together: "40 files · 1:42:05, 18:20 skipped · playlist order"', () => {
  const p = page({ skipped: [1, 2, 3], counts: { skipped_count: 3, skipped_seconds: 1100 } });
  const src = read('player-lib/collections.js');
  vm.runInContext(`${grab(src, 'function collFiles(')}\n${grab(src, 'function collectionCountText(')}\nglobalThis.__cc = collectionCountText;`, Object.assign(p.ctx, { currentSortField: () => 'playlist', document: { querySelector: () => null } }));
  assert.strictEqual(p.ctx.__cc(p.coll), '40 files · 1:42:05, 18:20 skipped · playlist order');
  p.coll.skipped_count = 0; p.Skips.take(7, []);
  assert.strictEqual(p.ctx.__cc(p.coll), '40 files · 2:00:25 · playlist order', 'as before with nothing skipped');
});

test('takeCollectionLength keeps the skip numbers a skip answer brings (so the count line follows)', () => {
  const ctx = vm.createContext({});
  vm.runInContext(`${grab(read('player-lib/collections.js'), 'function takeCollectionLength(')}\nglobalThis.__t = takeCollectionLength;`, ctx);
  const c = { skipped_count: 0, skipped_seconds: 0 };
  ctx.__t(c, { listed_count: 6, timed_count: 6, total_seconds: 120, unknown_seconds_count: 0, skipped_count: 2, skipped_timed_count: 2, skipped_seconds: 60, skipped_unknown_count: 0 });
  assert.deepStrictEqual([c.total_seconds, c.skipped_count, c.skipped_timed_count, c.skipped_seconds, c.skipped_unknown_count], [120, 2, 2, 60, 0]);
  ctx.__t(c, { listed_count: 6, timed_count: 6, total_seconds: 180, unknown_seconds_count: 0 });
  assert.strictEqual(c.skipped_count, 2, 'an older server sends no skip numbers: left as they were');
});

/* ── Play all ─────────────────────────────────────────────────────────── */

function playAll(skipped, n = 4) {
  const src = read('player-lib/collections.js');
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const played = [];
  const toasts = [];
  const ctx = {
    activeCollectionId: 7,
    getCollectionById: () => ({ id: 7, kind: 'collection' }),
    Library: { length: () => n, shuffled: false, waitIds: async () => Uint32Array.from(ids), rowsForRange: async (a) => [{ id: ids[a], filepath: `/f${ids[a]}`, filename: `f${ids[a]}`, media_type: 'video' }] },
    Skips: { setFor: () => new Set(skipped) },
    currentSortField: () => 'playlist',
    repeatMode: () => 'off',
    playMedia: (m) => played.push(m.filename),
    showToast: (t) => toasts.push(t),
  };
  vm.createContext(ctx);
  vm.runInContext(`${grab(src, 'async function playCollection(')}\nglobalThis.__play = playCollection;`, ctx);
  return { play: () => ctx.__play(7, false), played, toasts };
}

test('Play all starts at the first file that is not skipped', async () => {
  const a = playAll([1, 2]);
  await a.play();
  assert.deepStrictEqual(a.played, ['f3']);
  const b = playAll([]);
  await b.play();
  assert.deepStrictEqual(b.played, ['f1'], 'nothing skipped: the first file, as before');
});

test('Play all with every file skipped plays nothing and says why', async () => {
  const a = playAll([1, 2, 3, 4]);
  await a.play();
  assert.deepStrictEqual(a.played, []);
  assert.deepStrictEqual(a.toasts, ['Every file here is skipped. Unskip some to play them.']);
});

test('skipped tiles and rows are styled in both looks, with a [hidden] rule for the Unskip all holder', () => {
  const css = read('css/skips.css');
  assert.match(css, /\.media-tile\.tile-skipped \.tile-img/);
  assert.match(css, /\.media-tile\.tv-row\.tile-skipped \.tv-name/);
  assert.match(css, /\.coll-skips\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.grid-table\.tv-skips \.tv-c-title \{ padding-right: calc\(72px \+ 0\.9rem\); \}/, 'room for the third row button');
  const html = read('db-viewer.html');
  assert.match(html, /css\/skips\.css/);
  assert.match(html, /player-lib\/playlist-time\.js/);
  assert.match(html, /player-lib\/collection-skips\.js/);
  assert.ok(!/—/.test(read('player-lib/collection-skips.js').replace(/\/\*[\s\S]*?\*\//g, '')), 'no em dash in what the user reads');
});

/* ── Fix round: stale skips, quick clicks, the count line's order ──────── */

test('a saved order\'s skips of files gone: the server\'s 0 is believed, Unskip all goes, the page\'s count leaves gone files out', () => {
  const p = page({ counts: { skipped_count: 0, skipped_seconds: 0 } });
  p.ctx.collectionMembers = new Map([[7, [1, 2, 3, 4, 5]]]);
  // Its own skips still hold file 6 (taken out since); its length from the server says none.
  p.Skips.useVariant({ cid: 7, sid: 4, name: 'Smooth A', skips: [6], length: { skipped_count: 0, skipped_seconds: 0, skipped_unknown_count: 0 }, save: async () => {} });
  assert.strictEqual(p.skipCountParts(p.coll), null, 'nothing skipped is said');
  assert.strictEqual(p.Skips.count(7), 0);
  assert.strictEqual(p.skipHeaderHtml(p.coll), '', 'no Unskip all');
});

test('the tooltip says whose skips they are: the saved order\'s own, or the playlist\'s while it has none of its own', () => {
  const p = page({ skipped: [1, 2, 3, 4], counts: { skipped_count: 4, skipped_seconds: 1200, skipped_unknown_count: 0 } });
  p.Skips.useVariant({ cid: 7, sid: 4, name: 'Smooth A', skips: null, length: null, save: async () => {} });
  const t = p.skipCountParts(p.coll).title;
  assert.doesNotMatch(t, /skipped in “Smooth A”/);
  assert.match(t, /4 files skipped \(the playlist's skips; “Smooth A” has none of its own yet\)/);
  p.Skips.useVariant({ cid: 7, sid: 4, name: 'Smooth A', skips: [1], length: { skipped_count: 1, skipped_seconds: 300 }, save: async () => {} });
  assert.match(p.skipCountParts(p.coll).title, /1 file skipped in “Smooth A”/);
});

test('two quick skips in a saved order both count (its writes go one after another)', async () => {
  const p = page();
  const sent = [];
  let own = [];
  const v = () => ({
    cid: 7, sid: 4, name: 'Night', skips: own, length: null,
    // Slow, like the server: each write answers later, then the page takes the row (flow.js syncSkips).
    save: async (ids) => {
      sent.push(ids.slice());
      await new Promise(r => setTimeout(r, 20));
      own = ids.slice();
      p.Skips.useVariant(v());
      return { skips: own };
    },
  });
  p.Skips.useVariant(v());
  await Promise.all([p.toggleSkipFile(5), p.toggleSkipFile(7)]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sent)), [[5], [5, 7]]);
  assert.deepStrictEqual([...p.Skips.setFor(7)].sort((a, b) => a - b), [5, 7]);
  // A failed write does not stop the next one.
  let fail = true;
  const base = v();
  p.Skips.useVariant({ ...base, save: async (ids) => { if (fail) { fail = false; throw new Error('no'); } return base.save(ids); } });
  const r = await Promise.all([p.Skips.set(7, [9], true), p.Skips.set(7, [8], true)]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), [false, true]);
  assert.deepStrictEqual([...p.Skips.setFor(7)].sort((a, b) => a - b), [5, 7, 8]);
});

test('fetchCollectionMembers stores the new lengths before the skips redraw the count line', async () => {
  const src = read('player-lib/collections.js');
  const order = [];
  const coll = { id: 3 };
  const ctx = vm.createContext({
    collectionMembers: new Map([[3, [1, 2]]]), activeCollectionId: 3,
    fetch: async () => ({ json: async () => ({ media_ids: [1], skipped_ids: [], skipped_count: 0, total_seconds: 30 }) }),
    getCollectionById: () => coll,
    takeCollectionLength: (c, d) => { order.push('length'); c.skipped_count = d.skipped_count; },
    Skips: { take: () => true, changed: () => order.push(`redraw sees skipped_count=${coll.skipped_count}`) },
    _untickLeftOpenCollection: () => {},
    flowSavedStale: (id) => order.push(`saved orders read again ${id}`),
  });
  coll.skipped_count = 1;
  vm.runInContext(`${grab(src, 'async function fetchCollectionMembers(')}\nglobalThis.__f = fetchCollectionMembers;`, ctx);
  await ctx.__f(3, true);
  assert.deepStrictEqual(order, ['length', 'redraw sees skipped_count=0', 'saved orders read again 3']);
});

test('Stage\'s count: a skipped file played by hand is counted (the bar does not go blank)', () => {
  const src = read('player-lib/stage-control.js');
  assert.match(src, /const typeAt = skips \? \(i\) => \(i !== anchor && skips\.has\(ids\[i\]\) \? 'skipped' : typeOf\(i\)\) : typeOf;/);
  const StageCount = require('../player-lib/stage-count.js');
  // Files 1..4, file 1 skipped and playing: counted as the anchor, "Track 1 of 4".
  const skips = new Set([1]);
  const ids = [1, 2, 3, 4];
  const anchor = 0;
  const typeAt = (i) => (i !== anchor && skips.has(ids[i]) ? 'skipped' : 'video');
  const sum = StageCount.summary({ types: typeAt, length: 4, anchor, upNext: [], rest: [{ type: 'video', duration: 30 }, { type: 'video', duration: 30 }, { type: 'video', duration: 30 }], current: { t: 0, d: 30 } });
  assert.ok(sum, 'something to show');
  assert.deepStrictEqual([sum.index, sum.total, sum.left], [1, 4, 120]);
});
