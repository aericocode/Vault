/**
 * The file playing now (player-lib/now-playing.js): its tile has a clear
 * green ring while something plays, and a click on its name (the mini
 * player's, the Stage bar's) brings the tile on screen with a short glow,
 * from any tab: the list on screen if it holds the file, else the list it
 * plays from (Stage's, or the collection it was opened in), else the
 * Library. Reduced motion: no smooth scroll and no animation.
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
 * The module in a page. `lists` holds each list's ids: 'library' and
 * collection ids. The grid on screen shows `tab` (and `open`, an open
 * collection); `drawn` of its files have tiles. revealMediaIndex draws the
 * tile it is asked for, a few frames later; a switch of list lands a few
 * frames later too (a new Library.spec), as a query does.
 */
function page({
  lists = { library: [1, 2, 3, 4, 5] }, tab = 'library', open = null, drawn = [1, 2],
  reduced = false, known = true, stage = null, filtered = false, searchText = '',
} = {}) {
  const tiles = new Map(drawn.map(id => [id, fakeTile(id)]));
  const log = [];
  const frames = [];
  const listKey = () => (open != null ? open : 'library');
  let listIds = (tab === 'library' || open != null) ? (lists[listKey()] || []).slice() : [];
  let spec = { collectionId: open };
  const later = (n, fn) => { const step = () => { if (--n > 0) frames.push(step); else fn(); }; frames.push(step); };
  const land = () => later(3, () => {
    listIds = (lists[listKey()] || []).slice();
    spec = { collectionId: open };
    tiles.clear();
  });
  const ctx = {
    console, Promise, Number, String, Date, Map, Set, setImmediate,
    log, tiles,
    get currentTab() { return tab; },
    get activeCollectionId() { return open; },
    setTimeout: (fn) => { log.push(['timer']); return 0; },
    requestAnimationFrame: (fn) => frames.push(fn),
    prefersReducedMotion: () => reduced,
    showToast: (t) => log.push(['toast', t]),
    anyFilterIsSet: () => filtered,
    getCollectionById: (cid) => (lists[cid] ? { id: cid } : null),
    switchTab: (t) => {
      log.push(['tab', t]);
      if (t === tab) return;
      tab = t;
      open = null;                      // switching tabs closes a collection
      if (t === 'library') land(); else { listIds = []; spec = { collectionId: null, cards: true }; }
    },
    openCollection: async (cid) => { log.push(['open', cid]); open = cid; land(); },
    revealMediaIndex: (i) => {
      log.push(['reveal', i]);
      const id = listIds[i];
      // A page or rows on their way: the tile turns up two frames later.
      later(2, () => { if (!tiles.has(id)) tiles.set(id, fakeTile(id)); });
    },
    Library: {
      indexOf: (id) => listIds.indexOf(id),
      known: () => known,
      waitIds: async () => { known = true; return listIds; },
      get spec() { return spec; },
    },
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById: (eid) => (eid === 'searchInput' ? { value: searchText } : null),
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
  if (stage) ctx.StageControl = stage;
  vm.createContext(ctx);
  vm.runInContext(`${read('player-lib/now-playing.js')}\nglobalThis.NP = NowPlaying; globalThis.cls = nowPlayingTileClass;`, ctx);
  /** Run queued frames until the reveal settles. */
  const settle = async (p) => {
    for (let k = 0; k < 80; k++) {
      await new Promise(r => setImmediate(r));
      const fns = frames.splice(0);
      fns.forEach(f => f());
    }
    return p;
  };
  const moves = () => log.filter(([k]) => k === 'tab' || k === 'open');
  const toasts = () => log.filter(([k]) => k === 'toast').map(([, t]) => t);
  return { ctx, tiles, log, settle, moves, toasts };
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
  const { ctx, tiles, log, settle, moves } = page({ drawn: [1, 2] });
  ctx.NP.set(5);
  await settle(ctx.NP.reveal());
  assert.deepStrictEqual(log[0], ['reveal', 4], 'its index: the page holding it, or its rows');
  assert.deepStrictEqual(moves(), [], 'already on the Library tab');
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
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.media-tile\.tile-np-glow,\s*body:has\(#miniPlayer\.active\) \.media-tile\.tile-np-glow \{\s*animation: none;/);
});

test('the full id list is waited for before deciding the file is not listed', async () => {
  const { ctx, log, settle } = page({ known: false });
  ctx.NP.set(4);
  await settle(ctx.NP.reveal());
  assert.deepStrictEqual(log[0], ['reveal', 3]);
});

test('from another tab (Wall, Faces, Editor, the Collections cards): to the Library tab, then the tile', async () => {
  for (const tab of ['wall', 'faces', 'editor', 'collections']) {
    const { ctx, tiles, settle, moves, toasts } = page({ tab, drawn: [] });
    ctx.NP.set(3);                      // opened there (not from a collection)
    await settle(ctx.NP.reveal());
    assert.deepStrictEqual(moves(), [['tab', 'library']], tab);
    assert.deepStrictEqual(toasts(), [], `${tab}: no toast`);
    assert.ok(tiles.get(3) && tiles.get(3).has('tile-np-glow'), `${tab}: found and glowing`);
  }
});

test('opened in a collection: back to that collection, from any tab', async () => {
  const lists = { library: [1, 2, 3], 7: [3, 9] };
  const { ctx, tiles, settle, moves, toasts } = page({ lists, tab: 'collections', open: 7, drawn: [3, 9] });
  ctx.NP.set(9);                        // played from collection 7
  ctx.switchTab('wall');                // then the user went to the Wall
  ctx.log.length = 0;
  await settle(ctx.NP.reveal());
  assert.deepStrictEqual(moves(), [['tab', 'collections'], ['open', 7]]);
  assert.deepStrictEqual(toasts(), []);
  assert.ok(tiles.get(9) && tiles.get(9).has('tile-np-glow'));
});

test('inside a collection: a file it holds is shown right there; one it does not, in the Library', async () => {
  const lists = { library: [1, 2, 3], 7: [2, 8] };
  {
    const { ctx, tiles, settle, moves } = page({ lists, drawn: [1, 2, 3] });
    ctx.NP.set(2);                      // played from the library
    ctx.switchTab('collections'); await ctx.openCollection(7); await settle();
    ctx.log.length = 0;
    await settle(ctx.NP.reveal());
    assert.deepStrictEqual(moves(), [], 'the collection on screen holds it: no move');
    assert.ok(tiles.get(2).has('tile-np-glow'));
  }
  {
    const { ctx, tiles, settle, moves } = page({ lists, drawn: [1, 2, 3] });
    ctx.NP.set(3);                      // played from the library, not in collection 7
    ctx.switchTab('collections'); await ctx.openCollection(7); await settle();
    ctx.log.length = 0;
    await settle(ctx.NP.reveal());
    assert.deepStrictEqual(moves(), [['tab', 'library']]);
    assert.ok(tiles.get(3).has('tile-np-glow'));
  }
});

test('a collection that no longer holds the file: the Library instead', async () => {
  const lists = { library: [1, 2, 3], 7: [2, 3] };
  const { ctx, tiles, settle, moves } = page({ lists, tab: 'collections', open: 7, drawn: [2, 3] });
  ctx.NP.set(3);
  lists[7] = [2];                       // taken out of the collection
  ctx.switchTab('editor');
  ctx.log.length = 0;
  await settle(ctx.NP.reveal());
  assert.deepStrictEqual(moves(), [['tab', 'collections'], ['open', 7], ['tab', 'library']]);
  assert.ok(tiles.get(3).has('tile-np-glow'));
});

test('Stage: the list Stage plays from wins over where the file was opened', async () => {
  const lists = { library: [1, 2, 3], 7: [3, 4] };
  const stage = { isOpen: () => true, playingFrom: () => ({ cid: 7 }) };
  const { ctx, tiles, settle, moves } = page({ lists, tab: 'faces', drawn: [], stage });
  ctx.NP.set(4);                        // the next file in Stage's list; opened on Faces
  await settle(ctx.NP.reveal());
  assert.deepStrictEqual(moves(), [['tab', 'collections'], ['open', 7]]);
  assert.ok(tiles.get(4).has('tile-np-glow'));
});

test('not in the Library either: a toast that blames a search or filter only when one is set', async () => {
  {
    const { ctx, settle, toasts, log } = page({ filtered: true });
    ctx.NP.set(99);
    await settle(ctx.NP.reveal());
    assert.deepStrictEqual(toasts(), ['The file playing is not in the list on screen. A search or filter is hiding it.']);
    assert.ok(!log.some(([k]) => k === 'reveal'), 'nothing moves');
  }
  {
    const { ctx, settle, toasts } = page({ searchText: 'beach' });
    ctx.NP.set(99);
    await settle(ctx.NP.reveal());
    assert.match(toasts()[0], /A search or filter is hiding it/);
  }
  {
    const { ctx, settle, toasts } = page();
    ctx.NP.set(99);
    await settle(ctx.NP.reveal());
    assert.strictEqual(toasts().length, 1);
    assert.doesNotMatch(toasts()[0], /search or filter/);
    assert.ok(!/—/.test(toasts()[0]), 'no em dash');
  }
});

test('the look: green, apart from the previewed and selected indigo, and it wins over the previewed ring', () => {
  const vars = read('css/variables.css');
  assert.match(vars, /--now-playing: #22c55e;/);
  const css = read('css/tiles.css');
  const rule = /body:has\(#miniPlayer\.active\) \.media-tile\.tile-now-playing \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the ring rule');
  assert.match(rule[1], /outline: 3px solid var\(--now-playing\)/);
  assert.match(rule[1], /box-shadow: none/, 'the previewed / selected ring does not show through');
  assert.doesNotMatch(rule[1], /--accent/);
  assert.match(css, /\.media-tile\.tile-now-playing \.tile-thumb::before \{\s*content: 'Now playing';/);
  assert.match(read('css/table-view.css'), /tile-now-playing \{\s*outline: none;\s*box-shadow: inset 5px 0 0 var\(--now-playing\)/);
});

test('privacy (file names hidden): the names stay blurred but can still be clicked', () => {
  const settings = read('css/settings.css');
  const block = /body\.pm-names #miniPlayerTitle \{([^}]*)\}/.exec(settings);
  assert.ok(block, 'its own rule');
  assert.match(block[1], /filter: blur/);
  assert.doesNotMatch(block[1], /pointer-events/);
  assert.doesNotMatch(settings, /body\.pm-names #miniPlayerTitle,/);
  const stage = /body\.pm-names #stageBarTitle \{([^}]*)\}/.exec(read('css/stage-remote.css'));
  assert.match(stage[1], /filter: blur/);
  assert.doesNotMatch(stage[1], /pointer-events/);
});

test('wiring: every way of playing sets it, both grids render it, both names are buttons with a tooltip', () => {
  assert.match(read('player-lib/player/player-core.js'), /NowPlaying\.set\(currentMediaState\.playbackMediaId/);
  assert.match(read('player-lib/cards.js'), /nowPlayingTileClass\(media\.id\)/);
  assert.match(read('player-lib/table-view.js'), /nowPlayingTileClass\(m\.id\)/);
  const html = read('db-viewer.html');
  assert.match(html, /<button type="button" class="mini-player-title" id="miniPlayerTitle" title="Show this file in the library"/);
  assert.match(html, /<button type="button" class="sb-title" id="stageBarTitle" data-sb-act="find">/);
  assert.ok(html.indexOf('now-playing.js') > html.indexOf('stage-bar.js'));
  const bar = read('player-lib/stage-bar.js');
  assert.match(bar, /case 'find': if \(last && last\.hasFile && typeof NowPlaying !== 'undefined'\) NowPlaying\.reveal\(\);/);
  assert.match(bar, /const find = v\.hasFile \? 'Show this file in the library' : '';/);
  assert.match(bar, /title\.title = document\.body\.classList\.contains\('pm-names'\) \? find : \[v\.title, find\]/);
  assert.match(read('player-lib/stage-control.js'), /playingFrom: \(\) =>/);
  // The ring shows only while something plays (Stage keeps the mini player's box).
  assert.match(read('css/tiles.css'), /body:has\(#miniPlayer\.active\) \.media-tile\.tile-now-playing \{/);
});
