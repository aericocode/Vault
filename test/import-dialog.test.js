/**
 * The Add folder dialog and the picker buttons (player-lib/importer.js), run
 * in a VM with a small fake DOM: Modern draws no emoji (line icons only) and
 * no "Workers per instance" field, Classic keeps its emoji, counts use plural
 * words, the Include subfolders switch changes what is counted, and a server
 * that cannot open the Windows picker gets its own sentence plus what still
 * works (dropping files), with the button put back afterwards.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'player-lib');
const read = (f) => fs.readFileSync(path.join(LIB, f), 'utf8');
const noop = () => {};
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

/* A DOM just big enough: innerHTML is not parsed into a tree; every id="…"
   in it becomes an element that querySelector('#id') / getElementById find.
   Anything else querySelector is asked for gets a quiet stand-in. */
function makeDom() {
  const byId = new Map();
  class El {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this._q = new Map();
      this._generic = new Map();
      this.dataset = {};
      this.style = {};
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.textContent = '';
      this.listeners = {};
      this.attrs = {};
      const cls = new Set();
      this.classList = {
        add: (...c) => c.forEach(x => cls.add(x)),
        remove: (...c) => c.forEach(x => cls.delete(x)),
        toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; },
        contains: (c) => cls.has(c),
      };
      this._html = '';
    }
    set id(v) { this._id = v; byId.set(v, this); }
    get id() { return this._id; }
    set className(v) { String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c)); }
    set innerHTML(html) {
      this._html = String(html);
      this._q.clear();
      for (const m of this._html.matchAll(/<([a-z]+)\b([^>]*?)\bid="([^"]+)"([^>]*)>/g)) {
        const e = new El(m[1]);
        e.id = m[3];
        e.checked = /\schecked(?=[\s>]|$)/.test(` ${m[2]} ${m[4]}`);
        this._q.set(`#${m[3]}`, e);
      }
    }
    get innerHTML() { return this._html; }
    querySelector(sel) {
      if (this._q.has(sel)) return this._q.get(sel);
      if (!this._generic.has(sel)) this._generic.set(sel, new El());
      return this._generic.get(sel);
    }
    querySelectorAll() { return []; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    fire(t) { for (const f of this.listeners[t] || []) f({ target: this, currentTarget: this }); }
    appendChild(c) { return c; }
    remove() { if (byId.get(this.id) === this) byId.delete(this.id); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    focus() {}
    get isConnected() { return true; }
    click() { this.fire('click'); }
  }
  const docListeners = {};
  const document = {
    hidden: false,
    activeElement: null,
    addEventListener: (t, f) => { (docListeners[t] ||= []).push(f); },
    removeEventListener: noop,
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => (sel === '.header-buttons' ? header : null),
    querySelectorAll: () => [],
    createElement: (tag) => new El(tag),
    body: new El('body'),
  };
  const header = new El('div');
  header.insertBefore = noop;
  return { document, docListeners };
}

function load({ modern = true, pick = null } = {}) {
  const dom = makeDom();
  const toasts = [];
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, Date, Promise, Error, TypeError, Symbol,
    document: dom.document,
    localStorage: { getItem: () => '1', setItem: noop, removeItem: noop },
    setInterval: () => 0, clearInterval: noop,
    setTimeout: () => 0, clearTimeout: noop,
    queuePanelStack: () => ({ appendChild: noop }),
    fetch: async (url) => (url.startsWith('/api/import/pick-') && pick
      ? { ok: false, status: pick.status, json: async () => pick.body }
      : { ok: true, status: 200, json: async () => ({}) }),
  };
  ctx.window = ctx;
  // window listeners (the dialog's Esc is a window capture listener)
  const winListeners = [];
  ctx.addEventListener = (type, fn, capture) => winListeners.push({ type, fn, capture });
  ctx.removeEventListener = (type, fn, capture) => {
    const i = winListeners.findIndex(l => l.type === type && l.fn === fn && l.capture === capture);
    if (i >= 0) winListeners.splice(i, 1);
  };
  ctx.isModernLayout = () => modern;
  vm.createContext(ctx);
  vm.runInContext(read('utils.js'), ctx);
  vm.runInContext(read('icons.js'), ctx);
  // Capture toasts (showErrorToast in utils.js goes through this too).
  ctx.showToast = (msg, opts) => toasts.push({ msg: String(msg), type: opts && opts.type });
  vm.runInContext(read('importer.js'), ctx);
  return { ctx, dom, toasts, winListeners, $: (id) => dom.document.getElementById(id) };
}

const EMOJI = /\p{Extended_Pictographic}/u;
const modernText = (html) => html.replace(/<span class="vi-c">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '');

const f = (name, size, depth = 0) => ({ path: `X:/m/${name}`, name, ext: name.split('.').pop(), size, depth });
const FOLDER = {
  mode: 'paths', roots: ['m'], path: 'X:/m', subdirs: 2, watchable: true,
  files: [f('a.mp4', 5e6), f('b.mkv', 5e6, 1), f('p.jpg', 1e5), f('s.mp3', 3e6, 1), f('x.ts', 1e6)],
};

function dialogHtml(t) {
  return t.$('importModal').innerHTML + t.$('impTypes').innerHTML;
}

test('Modern: the dialog draws line icons and no emoji, and no workers field', () => {
  const t = load({ modern: true });
  t.ctx.openImportModal(FOLDER);
  const html = dialogHtml(t);
  assert.ok(!EMOJI.test(modernText(html)), modernText(html).match(EMOJI)?.[0]);
  for (const name of ['folder', 'video', 'image', 'audio', 'check', 'close', 'lock']) {
    assert.match(html, new RegExp(`class="vi vi-${name}\\b`), `${name} icon`);
  }
  assert.doesNotMatch(html, /Workers per instance|impWorkers|in flight/);
  assert.match(html, /Find songs/);
  assert.doesNotMatch(html, /—/, 'no em dash');
  // The footer uses the shared dialog buttons.
  assert.match(html, /class="vdlg-btn vdlg-ok[^"]*" id="impGo"/);
});

test('Esc closes the dialog and goes no further (window capture), and the listener goes with it', () => {
  const t = load();
  t.ctx.openImportModal(FOLDER);
  assert.ok(t.$('importModal'), 'open');
  const caps = t.winListeners.filter(l => l.type === 'keydown' && l.capture === true);
  assert.strictEqual(caps.length, 1);
  const other = { key: 'a', stopped: false, stopImmediatePropagation() { this.stopped = true; }, preventDefault() {} };
  caps[0].fn(other);
  assert.ok(t.$('importModal') && !other.stopped, 'other keys pass');
  const esc = { key: 'Escape', stopped: false, prevented: false,
    stopImmediatePropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
  caps[0].fn(esc);
  assert.ok(esc.stopped && esc.prevented, 'nothing under the dialog hears this Esc');
  assert.strictEqual(t.$('importModal'), null, 'closed');
  assert.strictEqual(t.winListeners.filter(l => l.type === 'keydown').length, 0, 'listener removed');
});

test('Classic keeps its emoji', () => {
  const t = load({ modern: false });
  t.ctx.openImportModal(FOLDER);
  const html = dialogHtml(t);
  for (const e of ['🎬', '🖼️', '🎵', '📂', '💬', '🔒']) assert.ok(html.includes(e), e);
});

test('counts read as words, and Include subfolders changes them', () => {
  const t = load();
  t.ctx.openImportModal(FOLDER);
  assert.match(t.$('impGo').textContent, /^Add 4 files$/);
  assert.match(t.$('impSummary').innerHTML, /<b>4 files<\/b> selected/);
  assert.match(t.$('impIgnored').textContent, /^1 file skipped, Vault cannot play it: ts \(1\)$/);
  const sub = t.$('impSubdirsIn');
  assert.strictEqual(sub.checked, true, 'starts on');
  sub.checked = false;
  sub.fire('change');
  assert.match(t.$('impGo').textContent, /^Add 2 files$/);
  assert.strictEqual(t.$('impSubdirs').classList.contains('on'), false, 'the Classic pill follows the switch');
});

test('a server that cannot open the picker: its sentence, what still works, and the button comes back', async () => {
  const t = load({ pick: { status: 409, body: { error: 'This copy of Vault cannot open the Windows file picker.' } } });
  await t.dom.docListeners.DOMContentLoaded.find(fn => /addFolderBtn/.test(fn.toString()))();
  const btn = t.$('addFolderBtn');
  assert.ok(btn, 'the button exists');
  await t.ctx.pickAndAddFolder();
  await flush();
  const last = t.toasts[t.toasts.length - 1];
  assert.strictEqual(last.type, 'error');
  assert.strictEqual(last.msg, 'This copy of Vault cannot open the Windows file picker. You can drag files or a folder onto this window instead.');
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.textContent, '📁 Add folder');
});

test('a raw picker failure becomes a plain sentence', async () => {
  const t = load({ pick: { status: 500, body: { error: 'spawn powershell ENOENT' } } });
  await t.ctx.pickAndAddFiles();
  await flush();
  const last = t.toasts[t.toasts.length - 1];
  assert.strictEqual(last.msg, 'Something went wrong while opening the file picker. Try again.');
});

/* A drag the way Chrome shapes it: dragging a tile's <img> lists 'Files' too,
   and setData adds its type to the list. */
function dataTransfer(types) {
  const dt = { types: [...types], dropEffect: 'none', effectAllowed: 'move' };
  dt.setData = (type) => { if (!dt.types.includes(type)) dt.types.push(type); };
  return dt;
}
function dragEvent(type, dataTransfer) {
  return { type, dataTransfer, target: null, prevented: false, preventDefault() { this.prevented = true; } };
}

test('a drag that starts on the page (a tile thumbnail, "Files" included) is not taken for an import', () => {
  const t = load();
  const fire = (ev) => { for (const fn of t.dom.docListeners[ev.type] || []) fn(ev); return ev; };
  const dt = dataTransfer(['text/uri-list', 'text/html', 'Files']);
  fire(dragEvent('dragstart', dt));
  dt.dropEffect = 'move';   // what the collection reorder sets
  const enter = fire(dragEvent('dragenter', dt));
  const over = fire(dragEvent('dragover', dt));
  assert.strictEqual(enter.prevented, false);
  assert.strictEqual(over.prevented, false);
  assert.strictEqual(dt.dropEffect, 'move', 'the reorder keeps its move, so the browser lets the drop happen');
  assert.strictEqual(t.$('vaultDropOverlay'), null, 'no import overlay');
  assert.strictEqual(fire(dragEvent('drop', dt)).prevented, false);
});

test('files dragged in from outside still import', () => {
  const t = load();
  const fire = (ev) => { for (const fn of t.dom.docListeners[ev.type] || []) fn(ev); return ev; };
  const dt = dataTransfer(['Files']);
  const enter = fire(dragEvent('dragenter', dt));
  const over = fire(dragEvent('dragover', dt));
  assert.ok(enter.prevented && over.prevented);
  assert.strictEqual(dt.dropEffect, 'copy');
});
