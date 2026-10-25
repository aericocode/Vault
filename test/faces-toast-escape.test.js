/**
 * A person's name in a Faces undo toast is escaped.
 *
 * showUndoToast (selection.js) takes HTML; showToast takes text. "Remove
 * selected from <person>" passed the raw name into showUndoToast, so a person
 * named `<img src=x onerror=...>` ran script when files were taken out of
 * them. Runs the real ftRemoveSelected (player-lib/faces-tab.js) in a VM with
 * the page around it stubbed, and checks the HTML the toast got.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EVIL = '<img src=x onerror=alert(1)>';

function load() {
  const noop = () => {};
  const el = () => ({ addEventListener: noop, classList: { contains: () => false, add: noop, remove: noop, toggle: noop }, querySelectorAll: () => [], remove: noop });
  const calls = { undo: [], toast: [] };
  const ctx = {
    console, setTimeout, clearTimeout, Promise, Map, Set, JSON, Math, Date, Error, Number, String, Array, Object, Boolean, URLSearchParams,
    document: {
      readyState: 'complete', addEventListener: noop, body: el(), getElementById: () => null, querySelector: () => null,
      // The person's two files, both ticked in the grid
      querySelectorAll: (sel) => (sel.includes('media-tile') ? [{ dataset: { id: '1' } }, { dataset: { id: '2' } }] : []),
    },
    window: { addEventListener: noop },
    addEventListener: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    debounce: (f) => f,
    selectedIds: new Set([1, 2]),
    clearSelection: noop,
    facesAsk: async () => 'go',
    showUndoToast: (html) => calls.undo.push(html),
    showToast: (text) => calls.toast.push(text),
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'faces-tab.js'), 'utf8');
  vm.runInContext(src, ctx);
  // The page state a person page has, and a server that takes the files out
  vm.runInContext(`
    FT.personId = 5; FT.person = { id: 5, name: ${JSON.stringify(EVIL)}, files: 3 }; FT.fileIds = [1, 2];
    ftLoadPerson = () => {};
    ftApi = async () => ({ undo: { token: 'u1' }, person: { id: 5 } });
  `, ctx);
  return { ctx, calls };
}

test('Remove selected: the undo toast gets the name escaped', async () => {
  const { ctx, calls } = load();
  await vm.runInContext('ftRemoveSelected()', ctx);
  assert.strictEqual(calls.undo.length, 1, 'one undo toast');
  const html = calls.undo[0];
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the name is still shown, as text');
  assert.match(html, /^Took 2 files out of /);
});
