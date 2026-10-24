/**
 * Plain-words helpers of the Editor, Music ID and PMV Studio (UI audit, 3.9),
 * run from the browser files in a VM: what a Music ID scan found, what is
 * missing when Music ID cannot run, the Soundtrack count, and the PMV job
 * status and stage names people see instead of the server's codes.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, names) {
  const noop = () => {};
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Map, Set, JSON, Math, Date, Error, Number, String, Array, Object, Boolean,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    document: { readyState: 'complete', addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener: noop },
    escapeHtml: (s) => String(s),
    showToast: noop,
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', file), 'utf8');
  vm.runInContext(`${src}\n;globalThis.__x = { ${names.join(', ')} };`, ctx);
  return ctx.__x;
}

const music = load('music.js', ['musicFoundText', 'musicToolsProblem', 'musicN']);
const pmv = load('pmv.js', ['pmvStageText', 'pmvAudioCountText', 'pmvState', 'PMV_STATUS_WORDS']);

test('a Music ID result reads as "title by artist", and an unknown song by its name alone', () => {
  assert.strictEqual(music.musicFoundText([{ artist: 'Noga Erez', title: 'Not My Problem' }]), 'Not My Problem by Noga Erez');
  assert.strictEqual(
    music.musicFoundText([{ artist: 'Unknown', title: 'Unknown Song 3' }, { artist: 'Daegho', title: 'Dirty Viibe' }]),
    'Unknown Song 3; Dirty Viibe by Daegho');
  assert.strictEqual(music.musicFoundText([]), '');
});

test('what Music ID is missing is said without program jargon first', () => {
  assert.match(music.musicToolsProblem({ ok: false, fpcalcVersion: null, ffmpegVersion: '7.0' }), /^The Music ID helper \(fpcalc\) is missing/);
  assert.match(music.musicToolsProblem({ ok: false, fpcalcVersion: '1.5', ffmpegVersion: null }), /^Video tools \(ffmpeg\) are missing/);
  assert.match(music.musicToolsProblem(null), /not available/);
  for (const t of [{}, { fpcalcVersion: '1.5', ffmpegVersion: '7' }, null]) {
    const s = music.musicToolsProblem(t);
    assert.ok(!/PATH|Chromaprint|—/.test(s), s);
    assert.match(s, /\.$/);
  }
});

test('counts use real plurals, not "(s)"', () => {
  assert.strictEqual(music.musicN(1, 'file', 'files'), '1 file');
  assert.strictEqual(music.musicN(3, 'file', 'files'), '3 files');
  pmv.pmvState.audioIds = [];
  assert.strictEqual(pmv.pmvAudioCountText(), 'Choose at least one');
  pmv.pmvState.audioIds = [7];
  assert.strictEqual(pmv.pmvAudioCountText(), '1 track');
  pmv.pmvState.audioIds = [7, 8];
  assert.strictEqual(pmv.pmvAudioCountText(), '2 tracks');
});

test('PMV status and stage names are words, starting with a capital', () => {
  assert.strictEqual(pmv.pmvStageText('done'), 'Done');
  assert.strictEqual(pmv.pmvStageText('extracting clips'), 'Extracting clips');
  assert.strictEqual(pmv.pmvStageText('vl-tagging'), 'Looking at the frames (AI)');
  assert.strictEqual(pmv.pmvStageText('edl_ready'), 'Cut list ready');
  assert.strictEqual(pmv.pmvStageText(''), '');
  for (const words of Object.values(pmv.PMV_STATUS_WORDS)) assert.match(words, /^[A-Z][a-z ]+$/);
});

test('no mid-sentence emoji or "(s)" plurals left in the Editor, Music ID and PMV toasts', () => {
  for (const file of ['editor.js', 'music.js', 'pmv.js', 'search-engine.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', file), 'utf8');
    for (const m of src.matchAll(/showToast\(\s*(['`])((?:(?!\1).)*)\1/g)) {
      const body = m[2].replace(/^\S+\s/, (lead) => (/[A-Za-z]/.test(lead) ? lead : ''));   // a leading emoji is fine (Modern drops it)
      assert.ok(!/[\u{1F300}-\u{1FAFF}←-⇿⌀-⏿☀-➿⬀-⯿]/u.test(body), `${file}: ${m[2]}`);
      assert.ok(!/\(s\)/.test(m[2]), `${file}: ${m[2]}`);
    }
  }
});
