/**
 * Next and Previous on the player are enabled only when pressing them would
 * play something (player-core.js playerHasNext / playerHasPrev, in a VM):
 * skipped tracks in a collection, known-bad files and documents after the
 * file on screen do not count, Up next does, and Next pressed by hand never
 * wraps, whatever Repeat says (UpNextRule.plan). Each answer is checked
 * against what the move itself does (playListStep).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

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

const core = read('player-lib/player/player-core.js');

/**
 * A list of n videos (ids 1..n) open as collection 7, the file at `anchor`
 * on screen. types: per-index media types; bad: ids known not to play;
 * uncached: ids whose rows are not loaded; upNext: files in Up next.
 */
function player(n, { skipped = [], anchor = 0, types = null, bad = [], uncached = [], upNext = 0, fromUpNext = false, known = true, repeat = 'off' } = {}) {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const typeAt = (i) => (types ? types[i] : 'video');
  const rows = ids.map((id, i) => ({ id, media_type: typeAt(i), filename: `f${id}` }));
  const played = [];
  const ctx = {
    Library: {
      known: () => known, firstPageIds: ids, length: () => n, typeAt, idAt: (i) => ids[i],
      rowAt: (i) => (uncached.includes(ids[i]) ? null : rows[i]), rowsForRange: async () => {},
      indexOf: (id) => ids.indexOf(id), spec: { collectionId: 7 },
    },
    Skips: { setFor: (cid) => (cid === 7 ? new Set(skipped) : new Set()) },
    UpNext: { count: () => upNext },
    UpNextRule: { anchorIndex: (a, f) => f(a), NO_ANCHOR: null, plan: null },
    NAV_WINDOW: 24,
    isKnownBadMedia: (row) => bad.includes(row.id),
    playIndexHandsFree: async (i) => { played.push(ids[i]); return true; },
    repeatMode: () => repeat,
  };
  vm.createContext(ctx);
  vm.runInContext([
    'function queueList(', 'function queuePassesOver(', 'function queueSkipSet(', 'async function nextPlayableIndex(',
    'async function playListStep(', 'function listAnchorIndex(', 'function upNextCount(', 'function listHasPlayable(',
    'function playerHasNext(', 'function playerHasPrev(',
  ].map(s => grab(core, s)).join('\n') + `\nlet listAnchor = ${ids[anchor] ?? -1}; let playingFromUpNext = ${fromUpNext};
    globalThis.__p = { playerHasNext, playerHasPrev, playListStep };`, ctx);
  const p = ctx.__p;
  // What the buttons would actually do (UpNextRule.plan for a press by hand: no wrap).
  p.nextMoves = async () => upNext > 0 || await p.playListStep(1, anchor, false);
  p.prevMoves = async () => p.playListStep(-1, fromUpNext ? anchor + 1 : anchor, false);
  p.played = played;
  return p;
}

test('the last track not skipped, only skipped ones after it: Next is off, and Next would do nothing', async () => {
  for (const repeat of ['off', 'all', 'one']) {
    const p = player(5, { skipped: [4, 5], anchor: 2, repeat });
    assert.strictEqual(p.playerHasNext(), false, `repeat ${repeat}`);
    assert.strictEqual(await p.nextMoves(), false);
  }
  const ok = player(5, { skipped: [4], anchor: 2 });
  assert.strictEqual(ok.playerHasNext(), true, 'one not skipped further on');
  assert.strictEqual(await ok.nextMoves(), true);
  assert.deepStrictEqual(ok.played, [5]);
});

test('Previous mirrors it: only skipped tracks before the file on screen', async () => {
  const p = player(5, { skipped: [1, 2], anchor: 2 });
  assert.strictEqual(p.playerHasPrev(), false);
  assert.strictEqual(await p.prevMoves(), false);
  const ok = player(5, { skipped: [2], anchor: 2 });
  assert.strictEqual(ok.playerHasPrev(), true);
  assert.strictEqual(player(5, { anchor: 0 }).playerHasPrev(), false, 'the first file');
});

test('Up next counts for Next, never for Previous', async () => {
  const p = player(3, { skipped: [3], anchor: 1, upNext: 2 });
  assert.strictEqual(p.playerHasNext(), true);
  assert.strictEqual(await p.nextMoves(), true);
  assert.strictEqual(player(3, { skipped: [1], anchor: 1, upNext: 2 }).playerHasPrev(), false);
});

test('a file Up next played: Previous goes back to the list file it came after', async () => {
  const p = player(4, { anchor: 0, fromUpNext: true });
  assert.strictEqual(p.playerHasPrev(), true);
  assert.strictEqual(await p.prevMoves(), true);
  assert.deepStrictEqual(p.played, [1]);
  assert.strictEqual(player(4, { anchor: 0, fromUpNext: true, skipped: [1] }).playerHasPrev(), false);
});

test('known-bad files and documents after the file are passed over too', async () => {
  const p = player(4, { anchor: 1, bad: [3], types: ['video', 'video', 'video', 'document'] });
  assert.strictEqual(p.playerHasNext(), false);
  assert.strictEqual(await p.nextMoves(), false);
});

test('not loaded yet is not "nothing there": Next stays on until the list says otherwise', () => {
  assert.strictEqual(player(4, { anchor: 1, uncached: [3, 4], bad: [3, 4] }).playerHasNext(), true);
  assert.strictEqual(player(4, { anchor: 3, known: false }).playerHasNext(), true, 'count not in yet');
  assert.strictEqual(player(4, { anchor: 3 }).playerHasNext(), false, 'the last file, nothing after');
});

test('the player asks these when it draws its buttons, and repaints them when skips change', () => {
  assert.match(core, /const hasPrev = playerHasPrev\(\);\s+const hasNext = playerHasNext\(\);/);
  assert.match(core, /addEventListener\('vault:skips-changed', \(\) => refreshPlayerNavButtons\(\)\)/);
});
