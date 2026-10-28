/**
 * The continuous grid's row window (player-lib/cards.js): a scroll keeps the
 * rows already drawn and only adds the rows coming in and drops the rows
 * going out; a row is drawn again only when its markup changed (a skeleton
 * whose data arrived, a tile whose state changed). A new column count or a
 * full render draws every row afresh. The table view and the filter rail's
 * per-frame header follow ride along.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'player-lib', f), 'utf8');
const CARDS = read('cards.js');
const between = (src, a, b) => src.slice(src.indexOf(a), src.indexOf(b));

/* ── A DOM just big enough for the window ─────────────────────────────── */

class El {
  constructor(html = '') {
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.html = html;
    const m = /data-row="(\d+)"/.exec(html);
    if (m) this.dataset.row = m[1];
  }
  _sib(d) { return this.parent ? this.parent.children[this.parent.children.indexOf(this) + d] || null : null; }
  get nextElementSibling() { return this._sib(1); }
  get previousElementSibling() { return this._sib(-1); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  set textContent(v) { this.children.forEach(c => { c.parent = null; }); this.children = []; }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  insertAdjacentHTML(where, html) {
    const parts = html.split(/(?=<div class="grid-row")/).filter(Boolean).map(h => new El(h));
    const host = where === 'beforeend' ? this : this.parent;
    const at = where === 'beforeend' ? host.children.length : host.children.indexOf(this);
    parts.forEach(p => { p.parent = host; });
    host.children.splice(at, 0, ...parts);
    host.parses = (host.parses || 0) + 1;
  }
}

function setup({ total = 40, cols = 4, stride = 100 } = {}) {
  const virt = new El();
  const loaded = new Set(Array.from({ length: total }, (_, i) => i));
  const selected = new Set();
  const fills = [];
  const ctx = {
    Map, Set, WeakMap, Math, Number, Infinity,
    document: { querySelector: () => virt },
    contState: { cols, stride, totalRows: Math.ceil(total / cols), first: -1, last: -1 },
    range: { first: 0, last: 3, y: 0 },
    continuousRange: () => ctx.range,
    tilesHtml(start, end) {
      let html = '';
      let missing = 0;
      const ids = [];
      for (let i = start; i < end; i++) {
        ids.push(i + 1);
        if (!loaded.has(i)) { missing++; html += '<i skel></i>'; } else html += `<i ${selected.has(i) ? 'sel' : ''}>${i}</i>`;
      }
      return { html, missing, ids };
    },
    Library: { length: () => total, pin() {}, firstPageShown() {} },
    hydrateThumbs() {},
    fillRowsThen: (a, b, then) => fills.push(then),
    markFirstTiles() {}, prefetchContinuousRows() {}, updateScrollTopPill() {},
    pageAnchor: 0, currentPage: 1, pageSize: 16,
  };
  vm.createContext(ctx);
  vm.runInContext(between(CARDS, '/** Swap in the rows for the current scroll position. */',
    '/** Where the viewport sits, expressed as a tile plus a pixel offset. */')
    + '\nglobalThis.__w = { renderContinuousWindow, continuousRowDiff };', ctx);
  return { ctx, virt, loaded, selected, fills, render: ctx.__w.renderContinuousWindow, diff: ctx.__w.continuousRowDiff };
}

const rows = (virt) => virt.children.map(c => Number(c.dataset.row));

/* ── The pure diff ────────────────────────────────────────────────────── */

test('diff: rows that left go, rows that came in are added in order, the rest stay', () => {
  const { diff } = setup();
  const m = (keys, tag = '') => new Map(keys.map(k => [k, `r${k}${tag}`]));
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepStrictEqual(plain(diff(m([0, 1, 2, 3]), m([2, 3, 4, 5]))), { remove: [0, 1], add: [4, 5] });
  assert.deepStrictEqual(plain(diff(m([4, 5, 6]), m([1, 2, 3, 4, 5]))), { remove: [6], add: [1, 2, 3] });
  assert.deepStrictEqual(plain(diff(m([0, 1]), m([0, 1]))), { remove: [], add: [] });
  assert.deepStrictEqual(plain(diff(new Map(), m([7, 3, 5]))), { remove: [], add: [3, 5, 7] }, 'add comes back ascending');
  assert.deepStrictEqual(plain(diff(m([0, 1, 2, 3]), m([5, 6, 7]))), { remove: [0, 1, 2, 3], add: [5, 6, 7] }, 'a jump replaces all');
  const want = m([0, 1, 2]);
  want.set(1, 'r1 changed');
  assert.deepStrictEqual(plain(diff(m([0, 1, 2]), want)), { remove: [1], add: [1] }, 'a row whose markup changed is drawn again');
});

/* ── The window on a page ─────────────────────────────────────────────── */

test('window: a scroll keeps the rows still in range and parses only the new ones', () => {
  const { ctx, virt, render } = setup();
  render();
  assert.deepStrictEqual(rows(virt), [0, 1, 2, 3]);
  assert.strictEqual(virt.parses, 1, 'the first draw is one parse');
  const [, , r2, r3] = virt.children;

  ctx.range = { first: 2, last: 5, y: 200 };
  render();
  assert.deepStrictEqual(rows(virt), [2, 3, 4, 5]);
  assert.strictEqual(virt.children[0], r2, 'row 2 is the same element');
  assert.strictEqual(virt.children[1], r3, 'row 3 is the same element');
  assert.strictEqual(virt.parses, 2, 'rows 4 and 5 came in one parse');
  assert.strictEqual(ctx.contState.first, 2);
  assert.strictEqual(ctx.contState.last, 5);
  assert.strictEqual(ctx.pageAnchor, 8, 'the anchor follows the first row on screen');

  // Back up one row: the new row goes in front, in order.
  ctx.range = { first: 1, last: 4, y: 100 };
  render();
  assert.deepStrictEqual(rows(virt), [1, 2, 3, 4]);
  assert.strictEqual(virt.children[1], r2);

  // Nothing moved: nothing is touched.
  const before = [...virt.children];
  const parses = virt.parses;
  render();
  assert.deepStrictEqual(virt.children, before);
  assert.strictEqual(virt.parses, parses);
});

test('window: rows are placed for their own row and the column count', () => {
  const { ctx, virt, render } = setup({ cols: 4, stride: 120 });
  ctx.range = { first: 3, last: 4, y: 360 };
  render();
  assert.match(virt.children[0].html, /data-row="3" style="top:360\.0px;grid-template-columns:repeat\(4,1fr\)"/);
  assert.match(virt.children[1].html, /<i >16<\/i>/, 'row 4 starts at tile 16');
});

test('window: a new column count or row height draws every row afresh', () => {
  const { ctx, virt, render } = setup();
  render();
  const old = [...virt.children];
  ctx.contState.cols = 5;
  render();
  assert.deepStrictEqual(rows(virt), [0, 1, 2, 3]);
  assert.ok(virt.children.every(c => !old.includes(c)), 'no row survives a column change');
  assert.match(virt.children[1].html, /repeat\(5,1fr\)/);

  const again = [...virt.children];
  ctx.contState.stride = 140;
  render();
  assert.ok(virt.children.every(c => !again.includes(c)), 'no row survives a new row height');
  assert.match(virt.children[2].html, /top:280\.0px/);
});

test('window: skeleton rows fill in when their data arrives, the others stay', () => {
  const { ctx, virt, render, loaded, fills } = setup();
  for (let i = 8; i < 12; i++) loaded.delete(i);   // row 2 is not here yet
  render();
  assert.strictEqual(fills.length, 1, 'a fetch was asked for');
  assert.match(virt.children[2].html, /skel/);
  const keep = [virt.children[0], virt.children[1], virt.children[3]];

  for (let i = 8; i < 12; i++) loaded.add(i);
  fills[0]();   // the rows landed: fillRowsThen calls back
  assert.deepStrictEqual(rows(virt), [0, 1, 2, 3]);
  assert.doesNotMatch(virt.children[2].html, /skel/);
  assert.match(virt.children[2].html, /<i >8<\/i>/);
  assert.deepStrictEqual([virt.children[0], virt.children[1], virt.children[3]], keep);
  assert.strictEqual(fills.length, 1, 'nothing missing: no second fetch');
  assert.ok(ctx.contState.last === 3);
});

test('window: a tile whose state changed redraws its row on the next pass', () => {
  const { virt, render, selected } = setup();
  render();
  const old = [...virt.children];
  selected.add(5);   // row 1
  render();
  assert.match(virt.children[1].html, /<i sel>5<\/i>/);
  assert.notStrictEqual(virt.children[1], old[1]);
  assert.strictEqual(virt.children[0], old[0]);
  assert.strictEqual(virt.children[2], old[2]);
});

test('window: rows the window did not draw (a stale innerHTML) are cleared', () => {
  const { virt, render } = setup();
  virt.insertAdjacentHTML('beforeend', '<div class="grid-row" data-row="1">old</div>');
  render();
  assert.deepStrictEqual(rows(virt), [0, 1, 2, 3]);
  assert.ok(!virt.children.some(c => c.html.includes('old')));
});

/* ── Full renders and the table ───────────────────────────────────────── */

test('a full render (filter, sort, new data) clears the window before drawing it', () => {
  const fn = between(CARDS, 'function renderContinuous()', '/** Swap in the rows for the current scroll position. */');
  assert.match(fn, /virt\.textContent = '';\s*renderContinuousWindow\(\);/);
  const tv = read('table-view.js');
  const tvc = between(tv, 'function tvRenderContinuous(', 'function tvRenderWindow(');
  assert.match(tvc, /virt\.textContent = '';[^\n]*\s*tvRenderWindow\(\);/);
  const tvw = between(tv, 'function tvRenderWindow(', '/* ── Toolbar');
  assert.match(tvw, /syncVirtRows\(virt, want,/);
  assert.doesNotMatch(tvw, /virt\.innerHTML/);
});

/* ── Filter rail: the header edge, once per change ────────────────────── */

test('filter rail: --rail-top is written only when the header edge moved', () => {
  const src = read('filter-rail.js');
  const fn = between(src, 'let _railTop', '/**\n * The Filters button.'.replace('\n', src.includes('\r\n') ? '\r\n' : '\n'));
  let bottom = 64;
  const writes = [];
  const ctx = {
    Math,
    document: {
      getElementById: () => ({ getBoundingClientRect: () => ({ bottom }) }),
      documentElement: { style: { setProperty: (k, v) => writes.push([k, v]) } },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fn + '\nglobalThis.__f = railUpdateTop;', ctx);
  ctx.__f(); ctx.__f(); ctx.__f();
  assert.deepStrictEqual(writes, [['--rail-top', '64px']]);
  bottom = 20.4;
  ctx.__f();
  bottom = 19.6;
  ctx.__f();
  assert.deepStrictEqual(writes, [['--rail-top', '64px'], ['--rail-top', '20px']]);
});
