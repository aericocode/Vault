/**
 * Stage preview (player-lib/stage-preview.js), in a VM: with Stage closed a
 * click and a double click are left to the grid; with Stage open a click
 * previews (the pane, forced on; the details when the window is too narrow)
 * and never plays, a double click plays, and closing Stage gives the pane
 * back to the user's own setting.
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
  const ctx = {
    console, localStorage: { getItem: () => null, setItem: () => {} },
    StageBar: { shown: () => shown },
    showToast: (m) => calls.push(['toast', m]),
    hideTilePopover: () => {},
    playMediaById: (id) => calls.push(['play', id]),
    showDetailsById: (id) => calls.push(['details', id]),
    dockSelect: (id) => calls.push(['preview', id]),
    dockRefresh: () => {},
  };
  ctx.dockSync = () => calls.push(['sync', ctx.stagePreviewForcing()]);
  ctx.dockIsShown = () => wide && ctx.stagePreviewForcing();
  ctx.window = ctx;
  ctx.addEventListener = (k, fn) => { listeners[k] = fn; };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const stage = (on) => { shown = on; listeners['vault:stage-bar']({ detail: { on } }); };
  return { ctx, calls, stage };
}

test('Stage closed: clicks are the grid\'s, as before', () => {
  const { ctx, calls } = load();
  assert.strictEqual(ctx.stagePreviewClick(5), false);
  assert.strictEqual(ctx.stagePreviewDblClick(5), false);
  assert.strictEqual(ctx.stagePreviewHintHtml(), '');
  assert.deepStrictEqual(calls, []);
});

test('Stage open: a click previews and never plays; a double click plays; closing gives the pane back', () => {
  const { ctx, calls, stage } = load();
  stage(true);
  assert.strictEqual(ctx.stagePreviewClick(5), true);
  assert.ok(calls.some(c => c[0] === 'preview' && c[1] === 5));
  assert.ok(!calls.some(c => c[0] === 'play'));
  assert.ok(calls.some(c => c[0] === 'toast' && /click to preview, double-click to play on Stage/.test(c[1])));
  assert.match(ctx.stagePreviewHintHtml(), /double-click/);
  assert.strictEqual(ctx.stagePreviewDblClick(6), true);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'play'), [['play', 6]]);
  stage(false);
  assert.strictEqual(ctx.stagePreviewForcing(), false);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'sync').at(-1), ['sync', false]);
  assert.strictEqual(ctx.stagePreviewClick(7), false);
});

test('Stage open, a window too narrow for the pane: the details instead', () => {
  const { ctx, calls, stage } = load({ wide: false });
  stage(true);
  assert.strictEqual(ctx.stagePreviewClick(9), true);
  assert.ok(calls.some(c => c[0] === 'details' && c[1] === 9));
  assert.ok(!calls.some(c => c[0] === 'play'));
});
