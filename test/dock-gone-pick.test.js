/**
 * The preview pane (player-lib/dock.js) showing a file that has just left
 * the library. Library.fetchRows answers at once, with nothing, for an id
 * it knows is gone; dockRender used to paint again on every answer and ask
 * again, a promise loop that never let the page breathe: the tab froze on
 * "Remove from library" with that file in the pane.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'player-lib');
const FILE = { id: 7, filename: 'Night Drive.mp4', filepath: 'D:\\Media\\Night Drive.mp4', media_type: 'video' };

/** dock.js in a VM with a fake Library; fetchRows stops answering after `cap` calls. */
function load({ rows = new Map(), gone = new Set(), fetchAnswer = () => null, cap = 50 } = {}) {
  const calls = { fetch: 0 };
  const body = { innerHTML: '', scrollTop: 0, querySelector: () => null, querySelectorAll: () => [] };
  const Library = {
    row: (id) => rows.get(id) || null,
    needsFetch: (id) => !gone.has(id) && !rows.has(id),
    pin() {},
    fetchRows(ids) {
      calls.fetch++;
      // A runaway loop would spin here for ever: stop answering instead.
      if (calls.fetch > cap) return new Promise(() => {});
      return Promise.resolve(ids.map((id) => fetchAnswer(id)));
    },
  };
  const ctx = {
    console, Math, Number, String, Array, Object, JSON, Map, Set, Promise, Date,
    Library,
    window: { innerWidth: 1600, addEventListener() {} },
    document: {
      readyState: 'loading', addEventListener() {},
      getElementById: (id) => (id === 'dockBody' ? body : null),
      querySelector: () => null,
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    escapeHtml: (s) => String(s),
    formatFileSize: () => '', formatDuration: () => '',
    vaultTypeIcon: () => '', vaultIconSwap: (e) => e, vaultIcon: () => '', thumbImgAttrs: () => '',
    UpNext: {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(LIB, 'notes.js'), 'utf8'), ctx);
  vm.runInContext(`${fs.readFileSync(path.join(LIB, 'dock.js'), 'utf8')}
    globalThis.__d = {
      show(id) { _dockShown = true; _dockSelectedId = id; _dockSig = ''; },
      dockRender,
      get painted() { return _dockPaintedId; },
    };`, ctx);
  return { D: ctx.__d, calls, body, rows };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('a file removed from the library: the pane does not ask for it at all, and stays calm', async () => {
  const { D, calls, body } = load({ gone: new Set([7]) });
  D.show(7);
  D.dockRender();
  await settle();
  assert.strictEqual(calls.fetch, 0, 'a known-gone id is never asked for');
  assert.match(body.innerHTML, /Click a tile to preview it here/, 'the pane shows its empty state meanwhile');
});

test('a row the server no longer has: one ask, no repaint loop', async () => {
  // Not known to be gone yet, and the server answers with nothing.
  const { D, calls } = load();
  D.show(7);
  D.dockRender();
  await settle();
  assert.strictEqual(calls.fetch, 1, 'asked once, not again on its own empty answer');
});

test('a row not loaded yet is fetched and painted when it arrives', async () => {
  const rows = new Map();
  const { D, calls, body } = load({ rows, fetchAnswer: (id) => { rows.set(id, FILE); return FILE; } });
  D.show(7);
  D.dockRender();
  await settle();
  assert.strictEqual(calls.fetch, 1);
  assert.strictEqual(D.painted, 7, 'the arrived row is painted');
  assert.match(body.innerHTML, /Night Drive/);
});
