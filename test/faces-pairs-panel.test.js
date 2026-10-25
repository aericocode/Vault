/**
 * The "Same person?" review panel (player-lib/faces-review.js), run in a VM
 * with a small fake page: an Undo of Hide brings back only the pairs the
 * server still asks about; a plain new name takes that one pair (and its
 * answer) out of the list; and while a save is on its way a second Save,
 * Esc / close / backdrop never send the answers again or offer Discard.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const noop = () => {};
  const calls = { api: [], choose: 0, toast: [] };
  let release = null;
  const ctx = {
    console, setTimeout, clearTimeout, Promise, Map, Set, JSON, Math, Date, Error, Number, String, Array, Object, Boolean,
    innerWidth: 1440, innerHeight: 900,
    window: { addEventListener: noop, innerWidth: 1440, innerHeight: 900 },
    document: {
      hidden: false, addEventListener: noop, documentElement: { style: { setProperty: noop } },
      body: { classList: { contains: () => false } }, activeElement: null,
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    },
    escapeHtml: (s) => String(s),
    facesApi: (url, opts) => { calls.api.push({ url, opts }); return new Promise((r) => { release = r; }); },
    facesToastError: noop,
    showToast: (t) => calls.toast.push(t),
    vaultChoose: async () => { calls.choose++; return null; },
  };
  ctx.Element = function Element() {};
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'faces-review.js'), 'utf8');
  vm.runInContext(`${src}\n;globalThis.__x = { setFP: (v) => { FP = v; }, getFP: () => FP, fpStillOffered, fpWaitOffered, fpDropKey, fpSave, fpRequestClose, fpKey };`, ctx);
  return { x: ctx.__x, calls, release: (v) => release(v) };
}

const person = (id) => ({ id, name: null, files: 1 });
const pair = (a, b) => ({ a: person(a), b: person(b) });
const fakeEl = () => {
  const classes = new Set();
  return {
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, contains: () => false, remove() { this.removed = true; },
    classes,
  };
};

test('Undo of Hide: only the pairs the server still offers come back', () => {
  const { x } = load();
  const removed = [{ pr: pair(1, 2), i: 0, answer: 'yes' }, { pr: pair(1, 7), i: 3 }, { pr: pair(9, 1), i: 5, answer: 'no' }];
  const back = x.fpStillOffered(removed, [pair(2, 1), pair(4, 5), pair(1, 9)]);
  assert.deepStrictEqual(back.map(r => x.fpKey(r.pr)), ['1-2', '1-9'], 'order kept, either side order matches');
  assert.strictEqual(back[0].answer, 'yes', 'answers ride along');
  assert.strictEqual(x.fpStillOffered(removed, []).length, 0, 'nothing offered: nothing comes back');
  assert.strictEqual(x.fpStillOffered(removed, undefined).length, 0);
});

test('a plain new name: that pair and its answer leave the list, the rest stay', () => {
  const { x } = load();
  const st = { pairs: [pair(1, 2), pair(3, 4), pair(5, 6)], answers: new Map([['3-4', 'yes'], ['5-6', 'no']]), total: 40, shown: 3 };
  x.setFP(st);
  x.fpDropKey('3-4');
  assert.deepStrictEqual(st.pairs.map(x.fpKey), ['1-2', '5-6']);
  assert.ok(!st.answers.has('3-4'), 'its answer is gone');
  assert.strictEqual(st.answers.get('5-6'), 'no');
  assert.strictEqual(st.total, 39);
  assert.strictEqual(st.shown, 2);
  x.fpDropKey('8-9');   // not in the list: nothing changes
  assert.strictEqual(st.pairs.length, 2);
});

test('save in flight: one POST, no second ask, close waits; the answers are saved once and the panel closes', async () => {
  const { x, calls, release } = load();
  const el = fakeEl();
  const back = fakeEl();
  x.setFP({ el, back, opener: null, pairs: [pair(1, 2), pair(3, 4)], answers: new Map([['1-2', 'yes'], ['3-4', 'skip']]),
    total: 2, shown: 2, asking: false, saving: false, peek: null });
  const p = x.fpSave();
  assert.strictEqual(calls.api.length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.api[0].opts.json)), { answers: [{ a: 1, b: 2, answer: 'same' }] }, 'Skip is never sent');
  assert.ok(x.getFP().saving && el.classes.has('is-saving'));
  x.fpSave();
  await x.fpRequestClose();
  assert.strictEqual(calls.api.length, 1, 'no second POST');
  assert.strictEqual(calls.choose, 0, 'no "Save your answers?" (and so no Discard) while saving');
  assert.ok(x.getFP(), 'still open until the save answers');
  release({ done: [{ answer: 'same' }], skipped: [] });
  await p;
  assert.strictEqual(x.getFP(), null, 'closed after the save');
  assert.ok(el.removed && back.removed);
  assert.deepStrictEqual(calls.toast, ['Put 1 pair together.']);
});

test('Undo of Hide waits for the background re-score, then brings back what is offered', async () => {
  const { x } = load();
  const removed = [{ pr: pair(35, 216), i: 1, answer: 'yes' }, { pr: pair(35, 263), i: 4, answer: 'no' }, { pr: pair(35, 300), i: 6 }];
  let n = 0;
  const waits = [];
  const fetchReview = async () => { n++; if (n === 2) throw new Error('blip'); return { pairs: n < 4 ? [pair(1, 2)] : [pair(216, 35), pair(35, 263), pair(1, 2)] }; };
  const back = await x.fpWaitOffered(removed, fetchReview, { wait: async (ms) => { waits.push(ms); } });
  assert.strictEqual(n, 4, 'asked until the pairs were there (a failed request is just tried again)');
  assert.deepStrictEqual(back.map(r => [x.fpKey(r.pr), r.i, r.answer]), [['35-216', 1, 'yes'], ['35-263', 4, 'no']]);
  assert.deepStrictEqual(waits, [400, 400, 400, 400]);
  let m = 0;
  const none = await x.fpWaitOffered(removed, async () => { m++; return { pairs: [] }; }, { tries: 5, wait: async () => {} });
  assert.strictEqual(none.length, 0);
  assert.strictEqual(m, 5, 'gives up after the last try');
});
