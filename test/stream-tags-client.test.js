/**
 * The page's side of stream tags (player-lib/stream-tags.js), run in a VM
 * with a fake server: the copy it keeps (load, a collection refreshed, a
 * tag put on and taken off), window.FlowLaneSource (lanes, cells, chips,
 * onChange), and chips that escape what the user typed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'stream-tags.js'), 'utf8');

const LANES = [
  { id: 1, name: 'Role', multi: true, sort: 0, tags: [
    { id: 1, laneId: 1, name: 'Opener', color: '#4ade80', hotkey: 'O', place: 'first', sort: 0 },
    { id: 5, laneId: 1, name: 'Closer', color: '#f472b6', hotkey: 'X', place: 'last', sort: 1 },
  ] },
  { id: 2, name: 'Mood <b>', multi: false, sort: 1, tags: [
    { id: 7, laneId: 2, name: '<img src=x onerror=alert(1)>', color: '#7dd3fc', hotkey: '1', place: 'anywhere', sort: 0 },
  ] },
];

function load() {
  const calls = [];
  let rows = [[10, 5], [10, 1], [11, 7]];
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetch = async (url, opts = {}) => {
    calls.push([url, opts.body ? JSON.parse(opts.body) : null]);
    if (url === '/api/stream-tags') return reply({ lanes: LANES });
    if (url === '/api/stream-tags/assignments') return reply({ rows });
    if (url === '/api/stream-tags/collections/3') return reply({ assignments: { 12: [1] } });
    if (url === '/api/stream-tags/assign') {
      const b = JSON.parse(opts.body);
      const out = {};
      for (const m of b.mediaIds) {
        const have = rows.filter(r => r[0] === m).map(r => r[1]);
        const next = b.op === 'add' ? [...new Set([...have, b.tagId])] : have.filter(t => t !== b.tagId);
        rows = rows.filter(r => r[0] !== m).concat(next.map(t => [m, t]));
        if (next.length) out[m] = next;
      }
      return reply({ op: b.op, changed: 1, assignments: out });
    }
    return { ok: false, status: 404, json: async () => ({ error: 'nope' }) };
  };
  const noop = () => {};
  const toasts = [];
  const ctx = {
    console, setTimeout, clearTimeout, Promise, Map, Set, JSON, Number, Object, Array, String, RegExp,
    fetch,
    showToast: (m) => toasts.push(m),
    collectionMembers: new Map([[3, [12, 13]]]),
    document: {
      readyState: 'complete', addEventListener: noop, removeEventListener: noop,
      querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
      createElement: () => ({ set innerHTML(v) { this._h = v; }, firstElementChild: null }),
    },
  };
  ctx.window = ctx;
  ctx.addEventListener = noop;
  vm.createContext(ctx);
  vm.runInContext(`${SRC}\nthis.StreamTags = StreamTags;`, ctx);
  return { ctx, calls, toasts };
}

const settle = () => new Promise(r => setTimeout(r, 10));

test('the copy loads once: lanes in order, each file\'s tags in lane order', async () => {
  const { ctx, calls } = load();
  await ctx.StreamTags.load();
  assert.strictEqual(ctx.StreamTags.loaded(), true);
  // File 10 was sent Closer first: it reads in the lane's order.
  assert.deepStrictEqual([...ctx.StreamTags.tagsOf(10).map(t => t.name)], ['Opener', 'Closer']);
  await ctx.StreamTags.load();
  assert.strictEqual(calls.filter(c => c[0] === '/api/stream-tags/assignments').length, 1);
});

test('FlowLaneSource: lanes, cells per file and lane, chips, onChange', async () => {
  const { ctx } = load();
  await ctx.StreamTags.load();
  const src = ctx.window.FlowLaneSource;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(src.lanes())), [{ key: 'lane:1', label: 'Role' }, { key: 'lane:2', label: 'Mood <b>' }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(src.cells('lane:1', [10, 11, 99]))), [
    [{ color: '#4ade80', label: 'Opener' }, { color: '#f472b6', label: 'Closer' }], [], [],
  ]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(src.cells('lane:2', [11]))), [[{ color: '#7dd3fc', label: '<img src=x onerror=alert(1)>' }]]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(src.cells('nope', [10]))), [[]]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(src.chips(10))).map(c => c.label), ['Opener', 'Closer']);
  let n = 0;
  src.onChange(() => { n++; });
  await ctx.StreamTags.apply(5, [11], 'toggle');
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(src.chips(11).map(c => c.label), ['Closer', '<img src=x onerror=alert(1)>']);
  await ctx.StreamTags.refreshCollection(3);
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(src.chips(12).map(c => c.label), ['Opener']);
});

test('toggle on several files: on all unless every one has it, then off all', async () => {
  const { ctx, calls, toasts } = load();
  await ctx.StreamTags.load();
  await ctx.StreamTags.apply(1, [10, 11], 'toggle');
  assert.strictEqual(calls.at(-1)[1].op, 'add');
  assert.deepStrictEqual(calls.at(-1)[1].mediaIds, [10, 11]);
  assert.match(toasts.at(-1), /Opener: on 2 files/);
  await ctx.StreamTags.apply(1, [10, 11], 'toggle');
  assert.strictEqual(calls.at(-1)[1].op, 'remove');
  assert.deepStrictEqual(ctx.StreamTags.tagsOf(11).map(t => t.id), [7]);
  await settle();
});

test('chips escape the names; at most two, then +n', async () => {
  const { ctx } = load();
  await ctx.StreamTags.load();
  await ctx.StreamTags.apply(7, [10], 'add');
  const html = ctx.StreamTags.tileHtml({ id: 10 });
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('title="Role: Opener"'));
  assert.ok(ctx.StreamTags.tileHtml({ id: 11 }).includes('title="Mood &lt;b&gt;: &lt;img'), 'the lane name is escaped too');
  assert.match(html, /\+1</);
  assert.strictEqual(ctx.StreamTags.tileHtml({ id: 99 }), '');
});

test('table rows: as many chips as fit the Title cell, then +n; tiles keep two', async () => {
  const { ctx } = load();
  await ctx.StreamTags.load();
  await ctx.StreamTags.apply(7, [10], 'add');            // file 10: Opener, Closer, and the Mood tag
  const chips = (html) => (html.match(/class="stag-chip"/g) || []).length;
  const more = (html) => (/stag-more[^>]*>\+(\d+)</.exec(html) || [])[1];
  ctx.tvStagFit = () => ({ budget: 2000 });
  let row = ctx.StreamTags.rowHtml({ id: 10 });
  assert.strictEqual(chips(row), 3, 'room for all three');
  assert.strictEqual(more(row), undefined);
  ctx.tvStagFit = () => ({ budget: 0 });
  row = ctx.StreamTags.rowHtml({ id: 10 });
  assert.strictEqual(chips(row), 0, 'no room even for a short chip: +n alone');
  assert.strictEqual(more(row), '3');
  assert.match(row, /title="Opener, Closer, &lt;img/, 'the rest are in the +n tooltip, escaped');
  // The chips sit in a box that can give way; +n is beside it, never inside (it must not drop away).
  ctx.tvStagFit = () => ({ budget: 100 });    // Opener (64) and +2 (28)
  row = ctx.StreamTags.rowHtml({ id: 10 });
  assert.strictEqual(chips(row), 1);
  assert.match(row, /^<span class="tile-stags tv-stags"[^>]*><span class="tv-stags-list"><span class="stag-chip"[^]*?<\/span><\/span><span class="stag-chip stag-more"/);
  ctx.tvStagFit = () => null;                         // the table not drawn yet
  assert.strictEqual(chips(ctx.StreamTags.rowHtml({ id: 10 })), 2);
  ctx.tvStagFit = () => ({ budget: 2000 });
  assert.strictEqual(chips(ctx.StreamTags.tileHtml({ id: 10 })), 2, 'a tile keeps two, then +n');
});

test('the fit rule: everything when it fits, else what fits beside +n; a short first chip, or +n alone', async () => {
  const { ctx } = load();
  const fit = ctx.StreamTags.fitChipCount;
  const more = () => 30;
  assert.strictEqual(fit([], 100, more, 4), 0);
  assert.strictEqual(fit([50, 50, 50], 158, more, 4), 3, '50+4+50+4+50 = 158: all fit, no +n needed');
  assert.strictEqual(fit([50, 50, 50], 157, more, 4), 2, 'one px short of all three: two beside +1 (50+4+50+4+30 = 138)');
  assert.strictEqual(fit([50, 50, 50, 50], 150, more, 4), 2, '50+4+50+4+30 = 138');
  assert.strictEqual(fit([50, 50, 50, 50], 137, more, 4), 1, 'one short of two beside +n');
  assert.strictEqual(fit([200, 50], 100, more, 4), 1, 'a long first chip still shows (it shortens)');
  assert.strictEqual(fit([200, 50], 74, more, 4), 1, '40 px of it beside +1: 40+4+30');
  assert.strictEqual(fit([200, 50], 73, more, 4), 0, 'less: +n alone');
  assert.strictEqual(fit([40, 40, 40], 0, more, 4), 0);
});

// The row's buttons on hover: two 24px buttons and 0.65rem (table-view.js tvActionsWidth); the chips and the name stop short of them.
const ACT = 48 + 0.65 * 16;

/** table-view.js in a vm: a canvas whose text is 7 px a character, fonts read off a fake row. */
function tableView({ withFont = true, rows = {}, flowMarks = null } = {}) {
  const noop = () => {};
  const counts = { measured: 0, styleReads: 0 };
  const canvas = { getContext: () => ({ font: '', measureText: (s) => { counts.measured++; return { width: s.length * 7 }; } }) };
  const nameEl = {};
  const ctx = {
    console, Math, Number, parseFloat, RegExp, String, Map,
    document: { readyState: 'complete', documentElement: {}, body: { classList: { contains: () => false } }, getElementById: () => null, querySelectorAll: () => [], addEventListener: noop, createElement: () => canvas },
    window: { addEventListener: noop },
    getComputedStyle: (el) => {
      counts.styleReads++;
      return el === nameEl ? { fontStyle: 'normal', fontWeight: '400', fontSize: '13.76px', fontFamily: 'Segoe UI' } : { fontSize: '16px' };
    },
    Library: { row: (id) => rows[id] || null },
    escapeHtml: (s) => String(s), vaultIconSwap: () => '',
  };
  if (flowMarks) ctx.flowMarksFor = (id) => flowMarks[id] || null;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'table-view.js'), 'utf8')
    + '\nthis.T = { TV_COLUMNS, tvTitleWidth, tvStagBudgetFor, tvStagBudget: (m) => { const f = tvStagFit(m); return f && f.budget; }, tvStagFit, tvNameMinFor, tvNameBounds, tvMarksWidth, tvMarksGive, tvNameMin, tvLearnNameFont, tvCellHtml, setTitleW: (w) => { _tvTitleW = w; } };', ctx);
  if (withFont) ctx.T.tvLearnNameFont({ querySelector: () => nameEl });
  return { T: ctx.T, counts, ctx, nameEl };
}

test('table view: the Title column\'s width, and the chips\' share of it, from the table width', () => {
  const { T } = tableView({ withFont: false });
  const { TV_COLUMNS, tvTitleWidth, tvStagBudgetFor } = T;
  // 1400 px: sel 32 + padding 16 + 7 gaps of 12 + fixed 72+80+92+80+100 = 556; 844 shared 3:2.
  assert.ok(Math.abs(tvTitleWidth(1400, TV_COLUMNS) - 844 * 3 / 5) < 0.01);
  // Narrow: Tags at its 140 minimum, Title takes the rest (not under its own 160).
  const narrow = 32 + 16 + 7 * 12 + 424 + 140 + 200;
  assert.ok(Math.abs(tvTitleWidth(narrow, TV_COLUMNS) - 200) < 0.01, String(tvTitleWidth(narrow, TV_COLUMNS)));
  // Title alone takes everything.
  assert.ok(Math.abs(tvTitleWidth(600, TV_COLUMNS.filter(c => c.key === 'title')) - (600 - 32 - 16 - 12)) < 0.01);
  // A long name keeps 40% (at least 120 px); the spacing (0.8rem + 2) and the row's marks come off too.
  assert.strictEqual(tvStagBudgetFor(500), 500 - 200 - 14.8 | 0);
  assert.strictEqual(tvStagBudgetFor(500, 900), 285);
  assert.strictEqual(tvStagBudgetFor(200, 900), 200 - 120 - 15);
  assert.strictEqual(tvStagBudgetFor(130, 900), 0);
  assert.strictEqual(tvStagBudgetFor(500, 900, 100), 185, 'the marks this row shows');
  // A short name keeps only what it needs.
  assert.strictEqual(tvStagBudgetFor(500, 100), 385);
});

test('table view: the name keeps min(its width, 120px); the marks stay whole; a long name gives way to the chips', () => {
  const flowMarks = { 5: { pos: '123 · was 340', playing: true, next: false } };
  const long = 'x'.repeat(100);            // 700 px
  const rows = { 1: { id: 1, filename: long }, 2: { id: 2, filename: 'a.mp4' }, 5: { id: 5, filename: long, user_starred: 1 } };
  const { T } = tableView({ rows, flowMarks });
  // The least: all of a short name, 120px of a long one; under that only when what must stay whole needs it.
  assert.strictEqual(T.tvNameMinFor(35, 0, 400), 35);
  assert.strictEqual(T.tvNameMinFor(700, 0, 400), 120);
  assert.strictEqual(T.tvNameMinFor(700, 300, 400), 98, 'the marks take 300 of 400');
  assert.strictEqual(T.tvNameMinFor(700, 390, 400), 8, 'the name takes what is left');
  assert.strictEqual(T.tvNameMinFor(700, 420, 400), 0);
  T.setTitleW(431);
  // A long name is held to what its chips leave, so the chips do not give way to it.
  const b = T.tvNameBounds(rows[1], 150);
  assert.strictEqual(b.min, 120);
  assert.strictEqual(b.max, Math.floor(431 - ACT - 150 - 14.8));
  assert.strictEqual(T.tvNameBounds(rows[1], 0).max, Math.floor(431 - ACT), 'no chips: all of it but where the buttons go on hover');
  // Playing, a Flow position and the heart: the name gives way, the marks keep their room
  // (all but Playing's progress line and the faint "· was 340", which give way first), short of the buttons.
  const marks = T.tvMarksWidth(rows[5], flowMarks[5]);
  const marksLeast = marks - T.tvMarksGive(flowMarks[5]);
  assert.ok(T.tvMarksGive(flowMarks[5]) > 48, 'the line and "· was 340"');
  T.setTitleW(280);
  const r5 = T.tvNameBounds(rows[5], 0);
  assert.ok(r5.min < 120, String(r5.min));
  assert.ok(r5.min + marksLeast <= 280 - ACT, `name ${r5.min} + marks ${marksLeast} fit ${280 - ACT}`);
  // With stream tags, +n stays whole too: the name gives way a little more.
  const t5 = T.tvNameBounds(rows[5], 32);
  assert.ok(t5.min < r5.min, `${t5.min} < ${r5.min}`);
  assert.ok(t5.min + marksLeast + 32 + 14.8 <= 280 - ACT, `name ${t5.min} + marks + +n fit ${280 - ACT}`);
  assert.strictEqual(T.tvStagFit(rows[5]).budget, 0, 'no room for a chip: +n alone');
});

test('table view: name, chips, +n and marks fit the Title cell short of the row\'s buttons, at any width', () => {
  const flowMarks = { 5: { pos: '12 · was 40', playing: true, next: false }, 6: { pos: '3 · was 9', playing: false, next: true } };
  const rows = {
    1: { id: 1, filename: 'x'.repeat(80) },
    2: { id: 2, filename: 'a.mp4' },
    3: { id: 3, filename: 'x'.repeat(30), user_starred: 1, user_flagged_delete: 1, watch_new: 1 },
    5: { id: 5, filename: 'x'.repeat(40), user_starred: 1 },
    6: { id: 6, filename: 'b.mp4', user_starred: 1, user_flagged_delete: 1, watch_new: 1 },
  };
  const { T } = tableView({ rows, flowMarks });
  const spacing = 14.8, more = 32;
  for (let titleW = 160; titleW <= 900; titleW += 7) {
    T.setTitleW(titleW);
    const free = titleW - ACT;
    for (const id of Object.keys(rows).map(Number)) {
      const m = rows[id], fm = flowMarks[id] || null;
      const marks = T.tvMarksWidth(m, fm);
      const marksLeast = marks - T.tvMarksGive(fm);   // Playing's line and "· was N" give way first
      const at = `title ${titleW} row ${id}`;
      // The name at its least beside the marks and +n: inside the free width, or, with no room, the name takes what is left.
      const nb = T.tvNameBounds(m, more);
      if (Math.floor(free - marksLeast - more - spacing - 2) >= 0) assert.ok(nb.min + marksLeast + more + spacing <= free, `${at}: least ${nb.min}`);
      else assert.strictEqual(nb.min, 0, at);
      // The chips' room comes out of the free width, the name keeping its share.
      const { budget } = T.tvStagFit(m);
      const share = Math.min(7 * m.filename.length, Math.max(120, free * 0.4));
      if (budget > 0) assert.ok(share + marks + spacing + budget <= free + 1, `${at}: budget ${budget}`);
      // With chips of that width, the name is held to what is left of the free width.
      if (budget > 0) {
        const b = T.tvNameBounds(m, budget);
        assert.ok(b.max === b.min || b.max + marks + spacing + budget <= free + 1, `${at}: name max ${b.max}`);
      }
    }
  }
});

test('table view: the room for chips leaves out only the marks a row shows', () => {
  const flowMarks = { 5: { pos: '12 · was 40', playing: true, next: false }, 6: { pos: null, playing: false, next: true } };
  const rows = {
    1: { id: 1, filename: 'plain.mp4' },
    2: { id: 2, filename: 'plain.mp4', user_starred: 1, user_flagged_delete: 1, watch_new: 1 },
    5: { id: 5, filename: 'plain.mp4' },
    6: { id: 6, filename: 'plain.mp4' },
  };
  const { T } = tableView({ rows, flowMarks });
  T.setTitleW(600);
  const plain = T.tvStagBudget(rows[1]);
  assert.strictEqual(T.tvMarksWidth(rows[1], null), 0, 'no marks, nothing kept for them');
  assert.strictEqual(plain, Math.floor(600 - ACT - 63 - 14.8), 'all but the name and the spacing');
  const marked = T.tvStagBudget(rows[2]);
  assert.ok(plain - marked >= 3 * 6.4 + 12 + 12 + 21, `heart, flag and New take room: ${plain - marked}`);
  const playing = T.tvStagBudget(rows[5]);
  // gap 6.4 + margin 8 + "12 · was 40" (11 chars) 77 + 12, 6 between, "Playing" 49 + 14, 6, the 48px line
  assert.strictEqual(plain - playing, Math.floor(600 - ACT - 63 - 14.8) - Math.floor(600 - ACT - 63 - 14.8 - (6.4 + 8 + 89 + 6 + 63 + 6 + 48)));
  const next = T.tvStagBudget(rows[6]);
  assert.strictEqual(plain - next, Math.floor(600 - ACT - 63 - 14.8) - Math.floor(600 - ACT - 63 - 14.8 - (6.4 + 8 + 28 + 14)));
  assert.strictEqual(T.tvStagBudget({ id: 6 }), next, 'a repaint with only the id finds the row');
});

test('table view: names and mark texts are measured once each; the fonts are read once, off one row', () => {
  const { T, counts } = tableView({ withFont: false });
  T.setTitleW(500);
  assert.strictEqual(T.tvStagBudget({ id: 1, filename: 'a.mp4' }), Math.floor((500 - ACT) * 0.6 - 14.8), 'no font known yet: the 40% rule');
  let reads = 0;
  const nameEl = {};
  T.tvLearnNameFont({ querySelector: () => { reads++; return nameEl; } });
  T.tvLearnNameFont({ querySelector: () => { reads++; return nameEl; } });
  assert.strictEqual(reads, 1, 'learned once');
  const styleReads = counts.styleReads;
  const m0 = counts.measured;
  T.tvStagBudget({ id: 1, filename: 'a.mp4' });
  T.tvStagBudget({ id: 1, filename: 'a.mp4' });
  assert.strictEqual(counts.measured - m0, 1, 'one measure per name');
  assert.strictEqual(counts.styleReads, styleReads, 'no style or layout read per row');
});

test('every tag is a visible chip or in +n, at any width, hovered or not', async () => {
  const { ctx } = load();
  await ctx.StreamTags.load();
  for (const t of [1, 5, 7]) await ctx.StreamTags.apply(t, [12], 'add');
  const names = ctx.StreamTags.tagsOf(12).map(t => t.name);
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  for (let budget = 0; budget <= 400; budget += 3) {
    ctx.tvStagFit = () => ({ budget });
    const row = ctx.StreamTags.rowHtml({ id: 12 });
    const shown = [...row.matchAll(/<span class="stag-chip" [^>]*>([^<]*)<\/span>/g)].map(m => unesc(m[1]));
    const more = /class="stag-chip stag-more" title="([^"]*)">\+(\d+)</.exec(row);
    const listed = more ? unesc(more[1]).split(', ') : [];
    assert.deepStrictEqual([...shown, ...listed].sort(), names.slice().sort(), `budget ${budget}`);
    if (more) assert.strictEqual(Number(more[2]), listed.length);
  }
  // Hover: the row's buttons sit over the Title cell and take no room in it, so the fit
  // above is what shows whether the row is hovered or not.
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'table-view.css'), 'utf8');
  const rule = /\.grid-table \.tv-actions \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the buttons\' rule');
  assert.match(rule[1], /position:\s*absolute/);
  assert.doesNotMatch(rule[1], /margin-left:\s*auto/);
  assert.match(css, /\.grid-table \.tv-c-title \{[^}]*position:\s*relative/);
});
