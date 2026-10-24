/**
 * The in-app dialogs (player-lib/vault-dialogs.js) on a small fake DOM, run
 * in a VM: vaultConfirm answers true / false, vaultPrompt the text or null,
 * vaultAlert resolves; Esc cancels, Enter answers OK except on a focused
 * button; a danger dialog starts on Cancel; the message and list are
 * escaped; the key guard swallows every key while a dialog is open and
 * none when it is not; two dialogs stack; the page behind goes inert and
 * focus goes back to the opener.
 *
 * And a guard over the web UI: no native alert() / confirm() / prompt()
 * calls in player-lib or db-viewer.html (comments are fine).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'player-lib');

/* ── A fake DOM: just what the module touches ─────────────────────────── */

function makeEnv() {
  const listeners = {};          // window capture listeners by type
  const doc = { activeElement: null };

  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.className = '';
      this.attrs = {};
      this.children = [];
      this.parent = null;
      this.textContent = '';
      this.innerHTML = '';
      this.value = '';
      this.inert = false;
      this.handlers = {};
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter(c => c !== this);
      this.parent = null;
    }
    contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
    get isConnected() { for (let x = this; x; x = x.parent) if (x === doc.body) return true; return false; }
    focus() { doc.activeElement = this; }
    select() { this.selected = true; }
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
    fire(type, ev = {}) { for (const fn of this.handlers[type] || []) fn({ target: this, ...ev }); }
    click() { this.fire('mousedown'); this.fire('click'); }
    find(cls) {
      for (const c of this.children) {
        if (c.className.split(' ').includes(cls)) return c;
        const f = c.find(cls);
        if (f) return f;
      }
      return null;
    }
  }

  doc.createElement = (tag) => new El(tag);
  // Only vaultModalOpen asks: is one of the other modals (password, lock, import) up?
  doc.otherModal = null;
  doc.querySelector = (sel) => (doc.otherModal && sel.split(',').map(s => s.trim()).includes(doc.otherModal) ? {} : null);
  doc.body = new El('body');
  const app = doc.body.appendChild(new El('div'));       // the page behind
  const opener = app.appendChild(new El('button'));
  const alreadyInert = doc.body.appendChild(new El('div'));
  alreadyInert.inert = true;

  const win = {
    addEventListener(type, fn, capture) {
      assert.strictEqual(capture, true, `${type} guard is a capture listener`);
      (listeners[type] = listeners[type] || []).push(fn);
    },
  };
  const ctx = { console, Array, Object, String, Promise, Set, window: win, document: doc };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(LIB, 'vault-dialogs.js'), 'utf8'), ctx);

  /** A key event through the window guard; reports what the guard did. */
  function key(k, extra = {}, type = 'keydown') {
    const ev = {
      type, key: k, target: doc.activeElement || doc.body, shiftKey: false, repeat: false, ...extra,
      stopped: false, prevented: false,
      stopImmediatePropagation() { this.stopped = true; },
      preventDefault() { this.prevented = true; },
    };
    for (const fn of listeners[type] || []) fn(ev);
    return ev;
  }
  const overlays = () => doc.body.children.filter(c => c.className === 'vdlg-ov');
  const top = () => overlays().at(-1);
  return { win, doc, app, opener, alreadyInert, key, overlays, top, listeners };
}

/** Did the promise settle (on the microtask queue) and with what? */
async function state(p) {
  const marker = {};
  const v = await Promise.race([p, new Promise(r => setImmediate(() => r(marker)))]);
  return v === marker ? 'pending' : { value: v };
}

/* ── Answers ───────────────────────────────────────────────────────────── */

test('confirm: OK is true, Cancel is false, Esc is false', async () => {
  const E = makeEnv();
  let p = E.win.vaultConfirm('Go?');
  E.top().find('vdlg-ok').click();
  assert.deepStrictEqual(await state(p), { value: true });

  p = E.win.vaultConfirm('Go?');
  E.top().find('vdlg-cancel').click();
  assert.deepStrictEqual(await state(p), { value: false });

  p = E.win.vaultConfirm('Go?');
  const ev = E.key('Escape');
  assert.ok(ev.prevented && ev.stopped);
  assert.deepStrictEqual(await state(p), { value: false });
  assert.strictEqual(E.overlays().length, 0, 'every dialog removed');
});

test('confirm: Enter answers OK, but Enter on a focused button is left to the button', async () => {
  const E = makeEnv();
  let p = E.win.vaultConfirm('Go?');
  assert.strictEqual(E.doc.activeElement, E.top().find('vdlg-ok'), 'plain confirm starts on OK');
  E.doc.activeElement = E.doc.body;     // focus nowhere in particular
  E.key('Enter');
  assert.deepStrictEqual(await state(p), { value: true });

  p = E.win.vaultConfirm('Go?');
  E.top().find('vdlg-cancel').focus();
  const ev = E.key('Enter');
  assert.ok(ev.stopped, 'still hidden from the page');
  assert.ok(!ev.prevented, 'the button\'s own Enter activation goes ahead');
  assert.strictEqual(await state(p), 'pending', 'the guard did not answer OK');
  E.top().find('vdlg-cancel').click();  // what the browser does next
  assert.deepStrictEqual(await state(p), { value: false });

  p = E.win.vaultConfirm('Go?');
  E.doc.activeElement = E.doc.body;
  E.key('Enter', { repeat: true });
  assert.strictEqual(await state(p), 'pending', 'a held-down Enter does not confirm');
  E.key('Escape');
  await p;
});

test('confirm danger: starts on Cancel, OK is painted red, labels used', async () => {
  const E = makeEnv();
  const p = E.win.vaultConfirm('Delete?', { title: 'Delete it', okLabel: 'Delete', cancelLabel: 'Keep', danger: true });
  const box = E.top().children[0];
  assert.match(box.className, /is-danger/);
  assert.match(box.find('vdlg-ok').className, /is-danger/);
  assert.strictEqual(box.find('vdlg-ok').textContent, 'Delete');
  assert.strictEqual(box.find('vdlg-cancel').textContent, 'Keep');
  assert.strictEqual(box.find('vdlg-title').textContent, 'Delete it');
  assert.strictEqual(E.doc.activeElement, box.find('vdlg-cancel'));
  assert.strictEqual(box.getAttribute('role'), 'alertdialog');
  assert.strictEqual(box.getAttribute('aria-modal'), 'true');
  assert.strictEqual(box.getAttribute('aria-labelledby'), box.find('vdlg-title').getAttribute('id'));
  E.key('Enter');                        // lands on the focused Cancel
  box.find('vdlg-cancel').click();
  assert.deepStrictEqual(await state(p), { value: false });
});

test('prompt: Enter gives the text, Esc and Cancel give null, a backdrop click keeps it open', async () => {
  const E = makeEnv();
  let p = E.win.vaultPrompt('Name?', { value: 'PMV 1', placeholder: 'Recipe name', okLabel: 'Save' });
  const box = E.top().children[0];
  const input = box.find('vdlg-input');
  assert.strictEqual(box.getAttribute('role'), 'dialog');
  assert.strictEqual(input.value, 'PMV 1');
  assert.strictEqual(input.getAttribute('placeholder'), 'Recipe name');
  assert.strictEqual(E.doc.activeElement, input);
  assert.ok(input.selected, 'the default is selected, ready to type over');
  const typed = E.key('x');
  assert.ok(typed.stopped && !typed.prevented, 'typing reaches the box but not the page');
  input.value = 'My mix';
  E.top().fire('mousedown');             // press and release on the backdrop
  E.top().fire('click');
  assert.strictEqual(await state(p), 'pending');
  E.key('Enter');
  assert.deepStrictEqual(await state(p), { value: 'My mix' });

  p = E.win.vaultPrompt('Name?');
  assert.strictEqual(E.top().find('vdlg-input').value, '');
  E.key('Escape');
  assert.deepStrictEqual(await state(p), { value: null });

  p = E.win.vaultPrompt('Name?', { value: 'x' });
  E.top().find('vdlg-cancel').click();
  assert.deepStrictEqual(await state(p), { value: null });
});

test('alert: one OK button, resolves to undefined on OK, Enter or Esc', async () => {
  const E = makeEnv();
  let p = E.win.vaultAlert('Done.', { okLabel: 'Got it' });
  assert.strictEqual(E.top().find('vdlg-cancel'), null);
  assert.strictEqual(E.top().find('vdlg-ok').textContent, 'Got it');
  E.top().find('vdlg-ok').click();
  assert.deepStrictEqual(await state(p), { value: undefined });
  p = E.win.vaultAlert('Done.');
  E.key('Escape');
  assert.deepStrictEqual(await state(p), { value: undefined });
});

test('a backdrop click cancels a confirm; a drag that ends there does not', async () => {
  const E = makeEnv();
  const p = E.win.vaultConfirm('Go?');
  const ov = E.top();
  ov.children[0].fire('mousedown', { target: ov.children[0] });   // press inside the card
  ov.handlers.click.forEach(fn => fn({ target: ov }));             // release on the backdrop
  assert.strictEqual(await state(p), 'pending');
  ov.click();
  assert.deepStrictEqual(await state(p), { value: false });
});

/* ── Escaping ──────────────────────────────────────────────────────────── */

test('message, list and title are text, never HTML', async () => {
  const E = makeEnv();
  const nasty = '<img src=x onerror=alert(1)> & "q" \'s';
  const p = E.win.vaultConfirm(`Remove ${nasty}?\n\nSecond line\nthird`, { title: nasty, list: [nasty, '', null, 'b'] });
  const box = E.top().children[0];
  const html = box.find('vdlg-msg').innerHTML;
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot; &#39;s'), html);
  assert.strictEqual((html.match(/<p>/g) || []).length, 2, 'a blank line starts a paragraph');
  assert.ok(html.includes('Second line<br>third'), 'a single break stays a line break');
  assert.strictEqual((html.match(/<li>/g) || []).length, 2, 'empty items dropped');
  assert.strictEqual(box.find('vdlg-title').textContent, nasty, 'title set as text');
  assert.strictEqual(box.find('vdlg-title').innerHTML, '');
  E.key('Escape');
  await p;
  assert.strictEqual(E.win.vaultDialogMessageHtml('a\r\nb'), '<p>a<br>b</p>');
  assert.strictEqual(E.win.vaultDialogMessageHtml(''), '');
});

/* ── The page behind ───────────────────────────────────────────────────── */

test('key guard: every key swallowed while open, none when closed', async () => {
  const E = makeEnv();
  for (const t of ['keydown', 'keypress', 'keyup']) assert.ok(E.listeners[t]?.length, `${t} guarded`);
  assert.ok(!E.key('Delete').stopped, 'no dialog, no interference');
  const p = E.win.vaultConfirm('Go?');
  assert.strictEqual(E.win.vaultDialogOpen(), true);
  for (const k of ['Delete', ' ', 'ArrowRight', 'k', 'f']) assert.ok(E.key(k).stopped, k);
  assert.ok(E.key('Delete', {}, 'keyup').stopped);
  E.key('Escape');
  await p;
  assert.strictEqual(E.win.vaultDialogOpen(), false);
  assert.ok(!E.key('Delete').stopped);
});

test('vaultModalOpen: true for these dialogs and for the password, lock and import ones', async () => {
  const E = makeEnv();
  assert.strictEqual(E.win.vaultModalOpen(), false);
  const p = E.win.vaultConfirm('Go?');
  assert.strictEqual(E.win.vaultModalOpen(), true);
  E.top().find('vdlg-cancel').click();
  await p;
  assert.strictEqual(E.win.vaultModalOpen(), false);
  for (const sel of ['.vault-modal-overlay', '.import-overlay', '#vaultLockScreen']) {
    E.doc.otherModal = sel;
    assert.strictEqual(E.win.vaultModalOpen(), true, sel);
  }
  E.doc.otherModal = '.modal-overlay';
  assert.strictEqual(E.win.vaultModalOpen(), false, 'not every overlay');
});

test('Tab stays inside the dialog', async () => {
  const E = makeEnv();
  const p = E.win.vaultPrompt('Name?');
  const box = E.top().children[0];
  const [input, cancel, ok] = ['vdlg-input', 'vdlg-cancel', 'vdlg-ok'].map(c => box.find(c));
  E.key('Tab'); assert.strictEqual(E.doc.activeElement, cancel);
  E.key('Tab'); assert.strictEqual(E.doc.activeElement, ok);
  E.key('Tab'); assert.strictEqual(E.doc.activeElement, input);
  E.key('Tab', { shiftKey: true }); assert.strictEqual(E.doc.activeElement, ok);
  E.listeners.focusin[0]({ target: E.opener });   // focus wanders behind
  assert.strictEqual(E.doc.activeElement, input, 'pulled back in');
  E.key('Escape');
  await p;
});

test('the page goes inert while open and comes back; focus returns to the opener', async () => {
  const E = makeEnv();
  E.opener.focus();
  const p = E.win.vaultConfirm('Go?');
  assert.strictEqual(E.app.inert, true);
  assert.strictEqual(E.top().inert, false);
  E.key('Escape');
  await p;
  assert.strictEqual(E.app.inert, false, 'restored');
  assert.strictEqual(E.alreadyInert.inert, true, 'something inert before stays inert');
  assert.strictEqual(E.doc.activeElement, E.opener);
});

test('two dialogs stack: the newest has the keys, each closes on its own', async () => {
  const E = makeEnv();
  E.opener.focus();
  const first = E.win.vaultConfirm('First?');
  const firstOv = E.top();
  const second = E.win.vaultPrompt('Second?', { value: 'v' });
  assert.strictEqual(E.overlays().length, 2);
  assert.strictEqual(firstOv.inert, true, 'the lower dialog is behind the top one');
  E.key('Escape');
  assert.deepStrictEqual(await state(second), { value: null });
  assert.strictEqual(await state(first), 'pending');
  assert.strictEqual(firstOv.inert, false);
  assert.strictEqual(E.doc.activeElement, firstOv.find('vdlg-ok'), 'focus goes to the dialog still open');
  E.key('Enter', { target: E.doc.body });
  assert.deepStrictEqual(await state(first), { value: true });
  assert.strictEqual(E.doc.activeElement, E.opener);
  assert.strictEqual(E.app.inert, false);
});

test('page: the dialogs load before shortcuts.js and every caller, with their stylesheet', () => {
  const html = fs.readFileSync(path.join(ROOT, 'db-viewer.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="\.\/player-lib\/([^"]+)"/g)].map(m => m[1]);
  const i = scripts.indexOf('vault-dialogs.js');
  assert.ok(i >= 0, 'loaded');
  for (const f of ['shortcuts.js', 'metadata-edit.js', 'selection.js', 'pmv.js', 'player/player-subtitles.js']) {
    assert.ok(scripts.indexOf(f) > i, `${f} after vault-dialogs.js`);
  }
  assert.match(html, /<link rel="stylesheet" href="\.\/css\/dialogs\.css">/);
});

/* ── No native dialogs in the web UI ───────────────────────────────────── */

function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function webFiles() {
  const out = [path.join(ROOT, 'db-viewer.html')];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.js$/.test(e.name) && !/\.min\.js$/.test(e.name)) out.push(p);
    }
  };
  walk(LIB);
  return out;
}

const NATIVE = /(^|[^\w$.])(?:(?:window|globalThis|self|top|parent)\s*\.\s*)?(alert|confirm|prompt)\s*\(/;

test('no native alert / confirm / prompt calls in the web UI', () => {
  const hits = [];
  for (const f of webFiles()) {
    stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
      if (NATIVE.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(hits, [], 'use vaultAlert / vaultConfirm / vaultPrompt (player-lib/vault-dialogs.js)');
});

test('the native-call guard catches the forms it should, and lets comments and methods be', () => {
  for (const s of ['confirm("x")', 'if (!confirm(msg)) return;', 'window.confirm(1)', 'x = prompt(\'a\')',
    'alert (1)', 'globalThis.alert(1)', '  await window . prompt("n")']) {
    assert.ok(NATIVE.test(stripComments(s)), s);
  }
  for (const s of ['// confirm(x)', '/* alert(1) */', 'vaultConfirm(x)', 'cfg.prompt(name)', 'onConfirm()',
    'const confirmed = 1;', 'prompts.video.prompt(f)']) {
    assert.ok(!NATIVE.test(stripComments(s)), s);
  }
});
