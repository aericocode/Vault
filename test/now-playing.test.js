/**
 * The file playing now (player-lib/now-playing.js): its tile has a clear
 * accent border while something plays, and a click on its name (the mini
 * player's, the Stage bar's) brings the tile on screen with a short glow,
 * on another page or further down a continuous grid where it is not drawn
 * yet. Reduced motion: no smooth scroll and no animation.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function fakeTile(id) {
  const classes = new Set(['media-tile']);
  return {
    dataset: { id: String(id) },
    offsetWidth: 100,
    scrolled: null,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
    },
    has: (c) => classes.has(c),
    scrollIntoView(o) { this.scrolled = o; },
  };
}

/**
 * The module with a grid of `ids` (of which `drawn` have tiles on screen).
 * revealMediaIndex draws the tile it is asked for, a few frames later.
 */
function page({ ids = [1, 2, 3, 4, 5], drawn = [1, 2], reduced = false, known = true, stage = null } = {}) {
  const tiles = new Map(drawn.map(id => [id, fakeTile(id)]));
  const log = [];
  const frames = [];
  let listIds = ids.slice();
  const ctx = {
    console, Promise, Number, String, Date, Map, Set, setImmediate,
    log, tiles,
    setTimeout: (fn) => { log.push(['timer']); return 0; },
    requestAnimationFrame: (fn) => frames.push(fn),
    prefersReducedMotion: () => reduced,
    showToast: (t) => log.push(['toast', t]),
    revealMediaIndex: (i) => {
      log.push(['reveal', i]);
      const id = listIds[i];
      // A page or rows on their way: the tile turns up two frames later.
      let n = 0;
      const later = () => { if (++n < 2) frames.push(later); else if (!tiles.has(id)) tiles.set(id, fakeTile(id)); };
      frames.push(later);
    },
    Library: {
      indexOf: (id) => listIds.indexOf(id),
      known: () => known,
      waitIds: async () => { known = true; return listIds; },
    },
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById: () => null,
      querySelectorAll: (sel) => {
        const m = /\[data-id="(\d+)"\]/.exec(sel);
        if (m) return tiles.has(Number(m[1])) ? [tiles.get(Number(m[1]))] : [];
        if (sel.includes('.tile-now-playing')) return [...tiles.values()].filter(t => t.has('tile-now-playing'));
        return [];
      },
      querySelector: (sel) => {
        const m = /\[data-id="(\d+)"\]/.exec(sel);
        return m && tiles.has(Number(m[1])) ? tiles.get(Number(m[1])) : null;
      },
    },
  };
  if (stage) ctx.StageControl = stage(ctx, (next) => { listIds = next; });
  vm.createContext(ctx);
  vm.runInContext(`${read('player-lib/now-playing.js')}\nglobalThis.NP = NowPlaying; globalThis.cls = nowPlayingTileClass;`, ctx);
  /** Run queued frames until the reveal settles. */
  const settle = async (p) => {
    for (let k = 0; k < 50; k++) {
      await new Promise(r => setImmediate(r));
      const fns = frames.splice(0);
      fns.forEach(f => f());
    }
    return p;
  };
  return { ctx, tiles, log, settle };
}

test('the playing file\'s tile carries the class, at render and live as the file changes', () => {
  const { ctx, tiles } = page();
  assert.strictEqual(ctx.cls(1), '');
  ctx.NP.set(1);
  assert.strictEqual(ctx.cls(1), ' tile-now-playing');
  assert.strictEqual(ctx.cls(2), '');
  assert.ok(tiles.get(1).has('tile-now-playing'));
  ctx.NP.set(2);
  assert.ok(!tiles.get(1).has('tile-now-playing'), 'moved off the last file');
  assert.ok(tiles.get(2).has('tile-now-playing'));
  ctx.NP.set(null);
  assert.ok(!tiles.get(2).has('tile-now-playing'));
});

test('a click on the name: a tile on another page (or not drawn yet) is brought on screen, then glows', async () => {
  const { ctx, tiles, log, settle } = page({ drawn: [1, 2] });
  ctx.NP.set(5);
  await settle(ctx.NP.reveal());
  assert.deepStrictEqual(log[0], ['reveal', 4], 'its index: the page holding it, or its rows');
  const t = tiles.get(5);
  assert.ok(t, 'drawn');
  assert.ok(t.has('tile-np-glow'), 'glows');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.scrolled)), { block: 'center', behavior: 'smooth' });
});

test('reduced motion: no smooth scroll (the CSS swaps the glow for a steady ring)', async () => {
  const { ctx, tiles, settle } = page({ reduced: true });
  ctx.NP.set(2);
  await settle(ctx.NP.reveal());
  assert.deepStrictEqual(JSON.parse(JSON.stringify(tiles.get(2).scrolled)), { block: 'center', behavior: 'auto' });
  const css = read('css/tiles.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.media-tile\.tile-np-glow \{\s*animation: none;/);
});

test('the full id list is waited for before deciding the file is not listed', async () => {
  const { ctx, log, settle } = page({ known: false });
  ctx.NP.set(4);
  await settle(ctx.NP.reveal());
  assert.deepStrictEqual(log[0], ['reveal', 3]);
});

test('a file the grid does not list: a plain toast, nothing moves', async () => {
  const { ctx, log, settle } = page();
  ctx.NP.set(99);
  await settle(ctx.NP.reveal());
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0][0], 'toast');
  assert.ok(!/—/.test(log[0][1]), 'no em dash');
});

test('Stage playing from a list the user left: Back to Stage takes over', async () => {
  let backs = 0;
  const { ctx, log, settle } = page({
    stage: (c, setList) => ({ isOpen: () => true, backToStage: async () => { backs++; setList([7, 8, 9]); } }),
  });
  ctx.NP.set(8);
  await settle(ctx.NP.reveal());
  assert.strictEqual(backs, 1);
  assert.ok(!log.some(([k]) => k === 'toast'), 'no toast: Back to Stage showed it');
});

test('wiring: every way of playing sets it, both grids render it, both names are buttons', () => {
  assert.match(read('player-lib/player/player-core.js'), /NowPlaying\.set\(currentMediaState\.playbackMediaId/);
  assert.match(read('player-lib/cards.js'), /nowPlayingTileClass\(media\.id\)/);
  assert.match(read('player-lib/table-view.js'), /nowPlayingTileClass\(m\.id\)/);
  const html = read('db-viewer.html');
  assert.match(html, /<button type="button" class="mini-player-title" id="miniPlayerTitle"/);
  assert.match(html, /<button type="button" class="sb-title" id="stageBarTitle" data-sb-act="find">/);
  assert.ok(html.indexOf('now-playing.js') > html.indexOf('stage-bar.js'));
  assert.match(read('player-lib/stage-bar.js'), /case 'find': if \(last && last\.hasFile && typeof NowPlaying !== 'undefined'\) NowPlaying\.reveal\(\);/);
  // The border shows only while something plays (Stage keeps the mini player's box).
  assert.match(read('css/tiles.css'), /body:has\(#miniPlayer\.active\) \.media-tile\.tile-now-playing \{/);
});
