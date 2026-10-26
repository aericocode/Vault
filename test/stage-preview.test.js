/**
 * Stage preview (player-lib/stage-preview.js), in a VM: with Stage closed a
 * click and a double click are left to the grid; with Stage open the pane
 * comes on with Stage (not on the first click), a click previews and never
 * plays, a double click plays only the file both clicks were on (not after
 * the layout moved, not from a tile's controls), and closing Stage gives the
 * pane back to the user's own setting.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'stage-preview.js'), 'utf8');

function load({ wide = true } = {}) {
  const calls = [];
  const listeners = {};
  let shown = false;
  let t = 1000;
  const ctx = {
    console, localStorage: { getItem: () => null, setItem: () => {} },
    performance: { now: () => t },
    StageBar: { shown: () => shown },
    showToast: (m) => calls.push(['toast', m]),
    hideTilePopover: () => {},
    playMediaById: (id) => calls.push(['play', id]),
    showDetailsById: (id) => calls.push(['details', id]),
    dockSelect: (id) => calls.push(['preview', id]),
    dockRepaintAll: () => calls.push(['repaint']),
  };
  ctx.dockSync = () => calls.push(['sync', ctx.stagePreviewForcing()]);
  ctx.dockIsShown = () => wide && ctx.stagePreviewForcing();
  ctx.window = ctx;
  ctx.addEventListener = (k, fn) => { listeners[k] = fn; };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const stage = (on) => { shown = on; listeners['vault:stage-bar']({ detail: { on } }); };
  const wait = (ms) => { t += ms; };
  // A double click as the browser sends it: click, click, dblclick.
  const dbl = (first, second = first, gap = 120, ev = {}) => {
    ctx.stagePreviewClick(first); wait(gap); ctx.stagePreviewClick(second); wait(5);
    return ctx.stagePreviewDblClick(second, ev);
  };
  const plays = () => calls.filter(c => c[0] === 'play').map(c => c[1]);
  return { ctx, calls, stage, wait, dbl, plays };
}

const control = (sel) => ({ target: { closest: (s) => (s.split(',').some(x => x.trim() === sel) ? {} : null) } });

test('Stage closed: clicks are the grid\'s, as before', () => {
  const { ctx, calls } = load();
  assert.strictEqual(ctx.stagePreviewClick(5), false);
  assert.strictEqual(ctx.stagePreviewDblClick(5), false);
  assert.strictEqual(ctx.stagePreviewHintHtml(), '');
  assert.deepStrictEqual(calls, []);
});

test('the pane comes on as Stage opens (not on a click) and goes when it closes; its Stage line is painted again both times', () => {
  const { ctx, calls, stage } = load();
  stage(true);
  assert.deepStrictEqual(calls.slice(0, 2), [['sync', true], ['repaint']]);
  assert.strictEqual(ctx.stagePreviewForcing(), true);
  assert.match(ctx.stagePreviewHintHtml(), /double-click/);
  stage(false);
  assert.strictEqual(ctx.stagePreviewForcing(), false);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'sync').at(-1), ['sync', false]);
  assert.strictEqual(ctx.stagePreviewClick(7), false);
});

test('Stage open: a click previews and never plays; a double click on one file plays exactly that file', () => {
  const { ctx, calls, stage, wait, dbl, plays } = load();
  stage(true);
  wait(1000);
  assert.strictEqual(ctx.stagePreviewClick(5), true);
  assert.ok(calls.some(c => c[0] === 'preview' && c[1] === 5));
  assert.deepStrictEqual(plays(), []);
  assert.ok(calls.some(c => c[0] === 'toast' && /click to preview, double-click to play on Stage/.test(c[1])));
  wait(1000);
  assert.strictEqual(dbl(6, 6, 40), true);
  wait(1000);
  dbl(8, 8, 150);
  assert.deepStrictEqual(plays(), [6, 8]);
});

test('a double click whose clicks landed on two files (the grid moved) plays nothing', () => {
  const { stage, wait, dbl, plays } = load();
  stage(true);
  wait(1000);
  assert.strictEqual(dbl(5, 9), true);
  assert.deepStrictEqual(plays(), []);
});

test('a double click just after the layout changed plays nothing', () => {
  const { ctx, stage, wait, dbl, plays } = load();
  stage(true);
  // Straight after Stage opened (the pane came on): too soon.
  dbl(5, 5, 40);
  assert.deepStrictEqual(plays(), []);
  wait(1000);
  // The grid moved between the two clicks (a resize, the rail).
  ctx.stagePreviewClick(5); wait(60); vm.runInContext('StagePreview.noteLayout()', ctx); wait(60); ctx.stagePreviewClick(5);
  ctx.stagePreviewDblClick(5, {});
  assert.deepStrictEqual(plays(), []);
  wait(1000);
  dbl(5, 5, 60);
  assert.deepStrictEqual(plays(), [5]);
});

test('a double click on a tile\'s controls (tick box, heart, flag, a row\'s buttons) never plays', () => {
  const { stage, wait, dbl, plays } = load();
  stage(true);
  for (const sel of ['input', 'button', 'label', 'a', '.tile-actions', '.tile-select', '.tv-actions']) {
    wait(1000);
    dbl(5, 5, 60, control(sel));
  }
  assert.deepStrictEqual(plays(), []);
});

test('Stage open, a window too narrow for the pane: the details instead', () => {
  const { ctx, calls, stage, plays } = load({ wide: false });
  stage(true);
  assert.strictEqual(ctx.stagePreviewClick(9), true);
  assert.ok(calls.some(c => c[0] === 'details' && c[1] === 9));
  assert.deepStrictEqual(plays(), []);
});

test('outside Stage: tileThumbDblClick ignores its controls too (cards.js)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'cards.js'), 'utf8');
  const fn = src.slice(src.indexOf('function tileThumbDblClick'), src.indexOf('function showDetailsById'));
  const played = [];
  const ctx = { dockIsShown: () => true, playMediaById: (id) => played.push(id) };
  vm.createContext(ctx);
  vm.runInContext(fn, ctx);
  ctx.tileThumbDblClick(3, control('.tile-actions'));
  ctx.tileThumbDblClick(3, control('input'));
  ctx.tileThumbDblClick(4, { target: { closest: () => null } });
  assert.deepStrictEqual(played, [4]);
  // Both the grid and the table pass the event.
  assert.match(src, /ondblclick="tileThumbDblClick\(\$\{media\.id\}, event\)"/);
  const tv = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'table-view.js'), 'utf8');
  assert.strictEqual((tv.match(/tileThumbDblClick\(\$\{id\}, event\)/g) || []).length, 2);
});
