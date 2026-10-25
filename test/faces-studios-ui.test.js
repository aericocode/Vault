/**
 * UI audit (WP-H), pure helpers run in a VM: the selection bar's Faces label
 * (a count only when part of the selection can be checked), the Studio
 * menu's take-out row (offered only when a selected file is in a studio, or
 * a row does not say), and the face setup size the Faces tab card quotes
 * (the same three models the consent downloads, from lib/faces/models.js).
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'player-lib');

function load(file, names) {
  const noop = () => {};
  const el = () => ({ addEventListener: noop, classList: { contains: () => false, add: noop, remove: noop, toggle: noop }, querySelectorAll: () => [], remove: noop });
  const ctx = {
    console, setTimeout, clearTimeout, Promise, Map, Set, JSON, Math, Date, Error, Number, String, Array, Object, Boolean, URLSearchParams,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    document: { readyState: 'complete', addEventListener: noop, body: el(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    debounce: (f) => f,
    showToast: noop, ftView: () => null,
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(LIB, file), 'utf8');
  vm.runInContext(`${src}\n;globalThis.__x = { ${names.join(', ')} };`, ctx);
  return ctx.__x;
}

test('Faces selection button: no count when every selected file can be checked', () => {
  const { facesSelLabel } = load('faces.js', ['facesSelLabel']);
  assert.strictEqual(facesSelLabel(3, 3), 'Faces');
  assert.strictEqual(facesSelLabel(2, 3), 'Faces (2)');
  assert.strictEqual(facesSelLabel(1200, 5000), 'Faces (1,200)');
});

test('face setup size: grunt models plus the chosen face model match lib/faces/models.js', () => {
  const f = load('faces.js', ['facesSetupMB', 'FACES_KEEPERS', 'FACES_GRUNT_MB']);
  const { FACE_MODELS } = require('../lib/faces/models');
  const mb = (k) => FACE_MODELS[k].bytes / 1e6;
  const grunt = mb('face:detect') + mb('face:embed');
  assert.ok(Math.abs(f.FACES_GRUNT_MB - grunt) < 1, `grunt ${grunt} MB vs ${f.FACES_GRUNT_MB}`);
  assert.ok(Math.abs(f.FACES_KEEPERS.ir50.mb - mb('face:keeper-ir50')) < 1);
  assert.ok(Math.abs(f.FACES_KEEPERS.ir101.mb - mb('face:keeper-ir101')) < 1);
  assert.strictEqual(f.facesSetupMB(), f.FACES_GRUNT_MB + f.FACES_KEEPERS.ir50.mb);
});

test('Faces tab Off card quotes the setup size, not a fixed number', () => {
  const src = fs.readFileSync(path.join(LIB, 'faces-tab.js'), 'utf8');
  assert.match(src, /Vault downloads three models \(about \$\{facesSetupMB\(\)\} MB\) once\./);
  assert.doesNotMatch(src, /39 MB/);
});

test('Studio menu: take-out row only when a selected file is in a studio, or a row does not say', () => {
  const { stSelectionInStudio } = load('studios.js', ['stSelectionInStudio']);
  const rows = {
    1: { id: 1, studio_id: null },
    2: { id: 2, studio_id: 7, studio_name: 'Seven' },
    3: { id: 3 },                       // row without the column: unknown
  };
  const rowOf = (id) => rows[id] || null;
  assert.strictEqual(stSelectionInStudio([1], rowOf), 'no');
  assert.strictEqual(stSelectionInStudio([1, 2], rowOf), 'yes');
  assert.strictEqual(stSelectionInStudio([1, 3], rowOf), 'unknown');
  assert.strictEqual(stSelectionInStudio([1, 99], rowOf), 'unknown');   // not loaded
  assert.strictEqual(stSelectionInStudio([], rowOf), 'no');
});
