/**
 * The face results strip's breakdown (FACES_REVIEW_SPEC F1), run from
 * player-lib/faces.js in a VM: which results are already the target, which
 * are in no one yet (the review, picking), which are other named people
 * (Compare), and the words of the three groups. Faces the user said are not
 * the target are in none of them; nothing offers a one-click add.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFaces() {
  const noop = () => {};
  const el = () => ({ addEventListener: noop, classList: { contains: () => false, add: noop, remove: noop, toggle: noop }, querySelectorAll: () => [], remove: noop });
  const ctx = {
    console, setTimeout, clearTimeout, Promise, Map, Set, JSON, Math, Date, Error, Number, String, Array, Object, Boolean,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    document: { readyState: 'complete', addEventListener: noop, body: el(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener: noop },
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    showToast: noop,
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'faces.js'), 'utf8');
  vm.runInContext(`${src}\n;globalThis.__f = { facesSplitResults, facesBannerGroups, facesFocusTarget };`, ctx);
  // Plain objects of this realm (deepStrictEqual compares prototypes).
  const plain = (x) => JSON.parse(JSON.stringify(x));
  return {
    facesSplitResults: (r, T) => {
      const o = ctx.__f.facesSplitResults(r, T);
      return { inT: plain(o.inT), addable: plain(o.addable), others: new Map([...o.others].map(([k, v]) => [k, plain(v)])) };
    },
    facesBannerGroups: (b, opts) => plain(ctx.__f.facesBannerGroups(b, opts)),
    facesFocusTarget: (f) => { const t = ctx.__f.facesFocusTarget(f); return t == null ? t : plain(t); },
  };
}

const F = loadFaces();
const who = (T) => (T && T.name ? T.name : 'this person');
const name = (n) => n;

// Ten results: 1-3 Barack (the target), 4-6 not in anyone (5 is an unnamed person), 7-8 Joe, 9 Kamala, 10 not Barack (rejected).
const res = {
  ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  match: {
    1: { groupId: 11, personId: 100, personName: 'Barack' }, 2: { groupId: 12, personId: 100, personName: 'Barack' },
    3: { groupId: 13, personId: 100, personName: 'Barack' },
    4: { groupId: 14, personId: null, personName: null }, 5: { groupId: 15, personId: 300, personName: null },
    6: { groupId: 16, personId: null, personName: null },
    7: { groupId: 17, personId: 200, personName: 'Joe' }, 8: { groupId: 18, personId: 200, personName: 'Joe' },
    9: { groupId: 19, personId: 201, personName: 'Kamala' },
    10: { groupId: 20, personId: null, personName: null },
  },
  rejected: new Set([10]),
};

test('breakdown: already the target, not in anyone yet (unnamed people count), other named people; rejected faces nowhere', () => {
  const b = F.facesSplitResults(res, { id: 100, name: 'Barack' });
  assert.deepStrictEqual(b.inT, [1, 2, 3]);
  assert.deepStrictEqual(b.addable.map(a => [a.mediaId, a.groupId]), [[4, 14], [5, 15], [6, 16]]);
  assert.deepStrictEqual([...b.others.keys()], [200, 201]);
  assert.deepStrictEqual(b.others.get(200), { name: 'Joe', ids: [7, 8], groups: [17, 18] });
  const all = [...b.inT, ...b.addable.map(a => a.mediaId), ...[...b.others.values()].flatMap(o => o.ids)];
  assert.ok(!all.includes(10), 'the face the user said No to');
});

test('banner groups: the mockup words, each only while it has faces; Review and Compare, never "Add the N"', () => {
  const T = { id: 100, name: 'Barack' };
  const g = F.facesBannerGroups({ T, ...F.facesSplitResults(res, T) }, { who, name });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g)), [
    { kind: 'in', n: 3, text: '3 already Barack' },
    { kind: 'new', n: 3, text: '3 not in anyone yet', button: 'Review 3 faces' },
    { kind: 'other', n: 3, text: '3 are other people: Joe (2), Kamala (1)', button: 'Compare' },
  ]);
  for (const x of g) assert.ok(!/\bAdd\b/.test(`${x.text} ${x.button || ''}`), 'no one-click add');
  // Only one group with faces: the others are not shown.
  const only = { ids: [1, 4], match: { 1: res.match[1], 4: res.match[4] } };
  const g2 = F.facesBannerGroups({ T, ...F.facesSplitResults(only, T) }, { who, name });
  assert.deepStrictEqual(g2.map(x => x.kind), ['in', 'new']);
  assert.strictEqual(g2[1].button, 'Review 1 face');
  const one = { ids: [9], match: { 9: res.match[9] } };
  assert.strictEqual(F.facesBannerGroups({ T, ...F.facesSplitResults(one, T) }, { who, name })[0].text, '1 is someone else: Kamala (1)');
});

test('no target yet (a photo with no clear person): "this person", every unnamed result to review, no Compare', () => {
  const b = F.facesSplitResults(res, null);
  assert.deepStrictEqual(b.inT, []);
  assert.deepStrictEqual(b.addable.map(a => a.mediaId), [4, 5, 6]);
  const g = F.facesBannerGroups({ T: null, ...b }, { who, name });
  assert.deepStrictEqual(g.map(x => x.kind), ['new', 'other']);
  assert.strictEqual(g[1].button, null, 'Compare needs a person to compare with');
  // A name given in the review but no person yet: still nothing "already" them.
  const pending = { id: null, name: 'Michelle', pending: true };
  assert.deepStrictEqual(F.facesSplitResults(res, pending).inT, []);
});

test('the target: the clicked face\'s person, a photo\'s likely person, else the name given in the review', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(F.facesFocusTarget({ src: { kind: 'group' }, source: { personId: 5, personName: 'A' } }))), { id: 5, name: 'A' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(F.facesFocusTarget({ src: { kind: 'query' }, likelyPerson: { id: 6, name: null } }))), { id: 6, name: null });
  assert.strictEqual(F.facesFocusTarget({ src: { kind: 'query' }, likelyPerson: null }), null);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(F.facesFocusTarget({ src: { kind: 'query' }, likelyPerson: null, named: { id: null, name: 'M' } }))),
    { id: null, name: 'M', pending: true });
});
