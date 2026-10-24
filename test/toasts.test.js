/**
 * The shared toast (player-lib/utils.js showToast) and friendlyError(), run
 * in a VM: a newer toast gets its own full time (the old timer is cleared),
 * error / success types, the Modern-only type icon, and raw error text
 * turned into words a person can act on.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'player-lib');

function load({ modern = true } = {}) {
  const classes = new Set();
  const attrs = {};
  const toast = {
    textContent: '', html: '',
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    insertAdjacentHTML(where, h) { this.html = h + this.html; },
    setAttribute: (k, v) => { attrs[k] = v; },
  };
  // A fake clock: timers run only when the test says so.
  let now = 0; let seq = 0; const timers = new Map();
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, Error, TypeError, SyntaxError,
    setTimeout: (fn, ms) => { timers.set(++seq, { fn, at: now + ms }); return seq; },
    clearTimeout: (id) => { timers.delete(id); },
    document: { addEventListener() {}, getElementById: (id) => (id === 'toast' ? toast : null), querySelector: () => null },
  };
  ctx.window = ctx;
  ctx.isModernLayout = () => modern;
  vm.createContext(ctx);
  for (const f of ['utils.js', 'icons.js']) vm.runInContext(fs.readFileSync(path.join(LIB, f), 'utf8'), ctx);
  ctx.advance = (ms) => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
  };
  return { ctx, toast, classes, attrs };
}

test('a second toast gets its own full time: the first timer no longer hides it early', () => {
  const { ctx, toast, classes } = load();
  ctx.showToast('First');
  ctx.advance(2500);
  ctx.showToast('Second');
  assert.strictEqual(toast.textContent, 'Second');
  ctx.advance(1000);                     // the first toast's 3 s are up
  assert.ok(classes.has('active'), 'still showing');
  ctx.advance(2100);
  assert.ok(!classes.has('active'), 'gone after its own 3 s');
});

test('duration: 3 s, longer for a long sentence, 7 s at most, or what the caller asks', () => {
  const { ctx } = load();
  assert.strictEqual(ctx.toastDuration('Saved'), 3000);
  assert.ok(ctx.toastDuration('x'.repeat(100)) > 3000);
  assert.strictEqual(ctx.toastDuration('x'.repeat(1000)), 7000);
  const { ctx: c2, classes } = load();
  c2.showToast('Copied', { duration: 1000 });
  c2.advance(1001);
  assert.ok(!classes.has('active'));
});

test('types: error and success set the class and a Modern-only icon; a leading ⚠ counts as an error', () => {
  const { ctx, toast, classes, attrs } = load();
  ctx.showToast('Could not save the note.', { type: 'error' });
  assert.ok(classes.has('error'));
  assert.match(toast.html, /vi-alert toast-ic modern-only/);
  assert.strictEqual(attrs.role, 'alert');
  ctx.showToast('Saved', 'success');
  assert.ok(classes.has('success') && !classes.has('error'), 'the old type is cleared');
  ctx.showToast('Plain');
  assert.ok(!classes.has('success') && !classes.has('error'));
  assert.strictEqual(attrs.role, 'status');
  ctx.showToast('⚠ Folder appears to be empty');
  assert.ok(classes.has('error'));
  assert.strictEqual(toast.textContent, 'Folder appears to be empty', 'Modern drops the glyph');
  assert.strictEqual(ctx.toastType('❌ Nope'), 'error');
  assert.strictEqual(ctx.toastType('Saved ⚠'), '');
});

test('Classic keeps the message as written', () => {
  const { ctx, toast } = load({ modern: false });
  ctx.showToast('⚠ Folder appears to be empty');
  assert.strictEqual(toast.textContent, '⚠ Folder appears to be empty');
});

test('friendlyError: network, locked and timeouts get their own words', () => {
  const { ctx } = load();
  const f = ctx.friendlyError;
  const offline = 'Could not reach Vault. Is it still running?';
  assert.strictEqual(f(new TypeError('Failed to fetch'), 'searching'), offline);
  assert.strictEqual(f('NetworkError when attempting to fetch resource.'), offline);
  assert.strictEqual(f({ status: 423, error: 'vault is locked' }), 'The library is locked. Unlock it and try again.');
  assert.strictEqual(f('vault is locked'), 'The library is locked. Unlock it and try again.');
  const abort = new Error('The operation was aborted.'); abort.name = 'AbortError';
  assert.strictEqual(f(abort), 'Vault took too long to answer. Try again.');
});

test('friendlyError: raw codes and fragments become a plain sentence', () => {
  const { ctx } = load();
  const f = ctx.friendlyError;
  const g = 'Something went wrong while saving the note. Try again.';
  assert.strictEqual(f('HTTP 500', 'saving the note'), g);
  assert.strictEqual(f(new Error('HTTP 404'), 'saving the note'), g);
  assert.strictEqual(f('Server returned 500', 'saving the note'), g);
  assert.strictEqual(f(new Error('Request failed with status code 502'), 'saving the note'), g);
  assert.strictEqual(f('could not read folder', 'saving the note'), g, 'lowercase server text');
  assert.strictEqual(f('media_ids required (2+)', 'saving the note'), g);
  assert.strictEqual(f(new TypeError("Cannot read properties of undefined (reading 'x')"), 'saving the note'), g);
  assert.strictEqual(f(new SyntaxError('Unexpected token < in JSON at position 0'), 'saving the note'), g);
  assert.strictEqual(f('Internal Server Error', 'saving the note'), g);
  assert.strictEqual(f('ENOENT: no such file or directory', 'saving the note'), g);
  assert.strictEqual(f(null), 'Something went wrong. Try again.');
  assert.strictEqual(f(''), 'Something went wrong. Try again.');
});

test('friendlyError: a server sentence is kept, tidied', () => {
  const { ctx } = load();
  const f = ctx.friendlyError;
  assert.strictEqual(f(new Error('That photo is too big (25 MB at most).'), 'x'), 'That photo is too big (25 MB at most).');
  assert.strictEqual(f({ error: 'A file picker is already open' }), 'A file picker is already open.');
  assert.strictEqual(f('⚠ That folder no longer exists.'), 'That folder no longer exists.');
  assert.strictEqual(f('PMV job could not start because no songs are picked.'), 'PMV job could not start because no songs are picked.');
});

test('showErrorToast: friendly words, error type', () => {
  const { ctx, toast, classes } = load();
  ctx.showErrorToast(new TypeError('Failed to fetch'), 'refreshing the library');
  assert.strictEqual(toast.textContent, 'Could not reach Vault. Is it still running?');
  assert.ok(classes.has('error'));
});
