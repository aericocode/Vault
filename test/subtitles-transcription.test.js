/**
 * Subtitle transcription covers the whole file (bugs from a real report: a
 * 2:43 song came back as one word at 0:08, a 5:00 video stopped at 0:40).
 *
 *  - The whisper sidecar's subtitle pass no longer runs the Silero VAD gate,
 *    which threw away singing and speech over music before whisper heard it.
 *    Driven end to end through the real Node <-> Python protocol with a stub
 *    faster_whisper module, so no model is loaded.
 *  - Stock lines whisper invents over music ("Thank you.") are dropped only
 *    when whisper itself was unsure of them.
 *  - A job that dies part way leaves no half-written track behind looking like
 *    the finished one.
 *  - The pill only says "Identifying speakers" when that is really pending.
 *  - The CC button's poll offers a skipped model download when the job ends,
 *    same as the sidebar (before, only a refresh + sidebar regenerate did).
 *  - The speaker-model unpack uses Windows' own tar, not Git Bash's GNU tar.
 *
 * Throwaway DBs and folders only.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-substx-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_TEMP_AUDIO = path.join(tmp, 'temp_audio');
process.env.VAULT_SUBS = path.join(tmp, 'subs');
process.env.VAULT_SECURE_ASSETS = path.join(tmp, 'secure_assets.db');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;
delete process.env.WHISPER_SUBS_VAD;

const config = require('../config');
config.subtitles = { ...(config.subtitles || {}), idleUnloadMinutes: 0 };
const db = require('../lib/database');
const transcriber = require('../lib/video-transcriber');
const diarizer = require('../lib/subtitles/diarizer');
const generator = require('../lib/subtitles/generator');
const subsRepo = require('../lib/subtitles/repo');
const subs = require('../lib/subtitles/service');

const tick = () => new Promise(r => setImmediate(r));
let mediaId;

test.before(() => {
  db.init();
  mediaId = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type, duration_seconds) VALUES (?, 'song.mp4', 'video', 300)")
    .run(path.join(tmp, 'song.mp4')).lastInsertRowid);
  fs.writeFileSync(path.join(tmp, 'song.mp4'), 'x');
});

test.after(() => {
  transcriber.shutdownServer();
  try { db.close(); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ── stubs for the pipeline around whisper ────────────────────────────── */

function stubPipeline({ stream, diarize = async () => null }) {
  const real = {
    hasAudioStream: transcriber.hasAudioStream,
    extractAudio: transcriber.extractAudio,
    stream: transcriber.transcribeSubtitlesStream,
    diarize: diarizer.diarize,
  };
  transcriber.hasAudioStream = async () => true;
  transcriber.extractAudio = async (_fp, dir) => { const a = path.join(dir, 'a.wav'); fs.writeFileSync(a, 'wav'); return a; };
  transcriber.transcribeSubtitlesStream = stream;
  diarizer.diarize = diarize;
  return () => {
    transcriber.hasAudioStream = real.hasAudioStream;
    transcriber.extractAudio = real.extractAudio;
    transcriber.transcribeSubtitlesStream = real.stream;
    diarizer.diarize = real.diarize;
  };
}

const words = (text, start, p) => text.split(' ').map((w, i) => ({ start: start + i * 0.3, end: start + i * 0.3 + 0.3, word: ' ' + w, p }));

/* ── 1. the sidecar hears the whole file ──────────────────────────────── */

const python = process.env.PYTHON_PATH || 'python';
const noPython = spawnSync(python, ['--version'], { windowsHide: true }).status !== 0;

// A stand-in faster_whisper: records the transcribe() keyword arguments and
// yields one segment every 30 s across a 300 s file.
const STUB = `
import json, os
class _W:
    def __init__(self, s, e, w, p): self.start, self.end, self.word, self.probability = s, e, w, p
class _S:
    def __init__(self, s, e, t, words): self.start, self.end, self.text, self.words = s, e, t, words
class _I:
    language = "en"; language_probability = 0.99; duration = 300.0
class WhisperModel:
    def __init__(self, *a, **k): pass
    def transcribe(self, path, **kw):
        kw.pop("vad_parameters", None)
        with open(os.environ["FW_STUB_LOG"], "w") as f: json.dump(kw, f)
        def gen():
            for t in range(0, 300, 30):
                yield _S(t, t + 2, " line at %d" % t, [_W(t, t + 1, " line", 0.91)])
        return gen(), _I()
`;

test('sidecar subtitle pass: no VAD gate, every segment to the end of the file, word confidence included', { skip: noPython && 'python not found' }, async () => {
  const stubDir = path.join(tmp, 'pystub', 'faster_whisper');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, '__init__.py'), STUB);
  const log = path.join(tmp, 'fw-kwargs.json');
  const env = { PYTHONPATH: process.env.PYTHONPATH, FW_STUB_LOG: process.env.FW_STUB_LOG };
  process.env.PYTHONPATH = path.join(tmp, 'pystub');
  process.env.FW_STUB_LOG = log;
  const audio = path.join(tmp, 'a.wav');
  fs.writeFileSync(audio, 'wav');
  try {
    const out = await transcriber.transcribeSubtitles(audio, {});
    assert.strictEqual(out.duration, 300);
    assert.strictEqual(out.segments.length, 10, 'every segment, not just the opening');
    assert.strictEqual(out.segments.at(-1).start, 270);
    assert.strictEqual(out.segments[0].words[0].p, 0.91, 'word confidence reaches Node');
    const kw = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.ok(!kw.vad_filter, `no VAD gate on the subtitle pass (${JSON.stringify(kw)})`);
    assert.strictEqual(kw.word_timestamps, true);
    assert.strictEqual(kw.condition_on_previous_text, false);
    assert.strictEqual(kw.hallucination_silence_threshold, 2.0);

    // The opt-back-in still works (WHISPER_SUBS_VAD=1 -> config.subtitles.subtitleVad),
    // even with the scan-snippet VAD switched off (WHISPER_VAD=0)
    transcriber.shutdownServer();
    config.subtitles.subtitleVad = true;
    config.subtitles.vad = false;
    await transcriber.transcribeSubtitles(audio, {});
    assert.strictEqual(JSON.parse(fs.readFileSync(log, 'utf8')).vad_filter, true);
  } finally {
    config.subtitles.subtitleVad = false;
    config.subtitles.vad = true;
    transcriber.shutdownServer();
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

/* ── 2. stock hallucinations ──────────────────────────────────────────── */

test('stock lines are dropped only when whisper was unsure of them', () => {
  const seg = (text, p) => ({ text, words: words(text, 0, p) });
  assert.strictEqual(generator.isLikelyHallucination(seg('Thank you.', 0.59)), true);
  assert.strictEqual(generator.isLikelyHallucination(seg("We'll be right back.", 0.64)), true);
  assert.strictEqual(generator.isLikelyHallucination(seg('You', 0.07)), true);
  assert.strictEqual(generator.isLikelyHallucination(seg('Thank you.', 0.95)), false, 'a clearly spoken thank-you stays');
  assert.strictEqual(generator.isLikelyHallucination(seg('Bust it, bust it', 0.2)), false, 'any other text always stays');
  assert.strictEqual(generator.isLikelyHallucination({ text: 'Thank you.' }), false, 'no confidence, no drop');
});

/* ── 3. the pipeline writes the whole file, minus invented lines ──────── */

test('generateForMedia: cues to the end of a 5:00 file, invented stock lines left out, no false speaker wait', async () => {
  const restore = stubPipeline({
    stream: async (_a, cb) => {
      await tick();   // whisper always takes a moment; speaker detection settles meanwhile
      cb.onModelReady?.();
      cb.onStart({ language: 'en', duration: 300 });
      for (let t = 0; t < 300; t += 20) cb.onSegment({ start: t, end: t + 2, text: `sung line ${t}`, words: words(`sung line ${t}`, t, 0.9) });
      cb.onSegment({ start: 250, end: 251, text: "Thank you.", words: words("Thank you.", 250, 0.59) });
      cb.onSegment({ start: 298, end: 299, text: 'Thank you.', words: words('Thank you.', 298, 0.97) });
    },
  });
  const stages = [];
  try {
    const res = await subs.generateForMedia(db.getById(mediaId), { onProgress: (s, p, phase) => stages.push({ s, p, phase }), translate: false });
    assert.deepStrictEqual(res.tracks, ['en']);
  } finally { restore(); }
  const cues = generator.parseVTT(subsRepo.readTrackText(mediaId, 'en'));
  assert.strictEqual(cues.length, 16);
  assert.ok(cues.at(-1).start >= 298, 'last cue is at the end of the file');
  assert.ok(!cues.some(c => c.start === 250), 'the unsure "Thank you." is gone');
  assert.ok(cues.some(c => c.start === 298 && /Thank you/.test(c.text)), 'the confident one stays');
  assert.ok(!stages.some(x => /Identifying speakers/.test(x.s)), 'no speaker wait when speaker detection had nothing to do');
  assert.strictEqual(stages.at(-1).phase, 'done');
  subsRepo.deleteTrack(mediaId, 'en');
});

test('generateForMedia: the pill says "Identifying speakers" while speaker detection is really still running', async () => {
  let release;
  const restore = stubPipeline({
    stream: async (_a, cb) => {
      cb.onStart({ language: 'en', duration: 10 });
      cb.onSegment({ start: 0, end: 2, text: 'hello there', words: words('hello there', 0, 0.9) });
    },
    diarize: () => new Promise(r => { release = r; }),
  });
  const stages = [];
  try {
    const p = subs.generateForMedia(db.getById(mediaId), { onProgress: (s) => stages.push(s), translate: false });
    for (let i = 0; i < 500 && !stages.some(s => /Identifying speakers/.test(s)); i++) await tick();
    assert.ok(stages.some(s => /Identifying speakers/.test(s)));
    release(null);
    await p;
  } finally { restore(); }
  subsRepo.deleteTrack(mediaId, 'en');
});

/* ── 4. a run that dies part way is not saved as the track ────────────── */

test('a job that fails mid-transcription leaves no partial track behind, and reports the failure', async () => {
  let wrote = false;
  const restore = stubPipeline({
    stream: async (_a, cb) => {
      cb.onStart({ language: 'en', duration: 300 });
      cb.onSegment({ start: 0, end: 2, text: 'first line', words: words('first line', 0, 0.9) });
      cb.onSegment({ start: 8, end: 9, text: 'second line', words: words('second line', 8, 0.9) });
      wrote = fs.existsSync(subsRepo.trackPath(mediaId, 'en'));
      throw new Error('Whisper server closed');
    },
  });
  let jobId;
  try {
    jobId = subs.enqueue(mediaId).id;
    for (let i = 0; i < 1000 && subsRepo.getJob(jobId).status !== 'error'; i++) await tick();
  } finally { restore(); }
  assert.ok(wrote, 'cues were streaming into the working track');
  assert.strictEqual(subsRepo.getJob(jobId).status, 'error');
  const info = subs.infoFor(mediaId);
  assert.strictEqual(info.status, 'error');
  assert.deepStrictEqual(info.tracks, [], 'no partial track offered as the subtitles');
  assert.ok(!fs.existsSync(subsRepo.trackPath(mediaId, 'en')), 'partial file removed');
});

/* ── 5. CC button: offer skipped downloads when the job ends ──────────── */

test('player growth poll: a finished job offers any model download it went without', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'player', 'player-subtitles.js'), 'utf8');
  const offered = [];
  const ctx = {
    console, Math, Number, String, Object, JSON, Promise, Map, setTimeout, clearTimeout, requestAnimationFrame: () => {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: () => null, addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} },
    currentMediaState: { currentMediaData: { id: 7 }, type: 'video' },
    showToast() {}, escapeHtml: (s) => String(s),
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ready', tracks: [], progress: 100 }) }),
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx.subtitlesOfferPendingConsent = () => { offered.push(true); };
  ctx._subsStartGrowthPoll({ id: 7 });
  for (let i = 0; i < 100 && !offered.length; i++) await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(offered.length, 1);
});

/* ── 6. speaker-model unpack on Windows ───────────────────────────────── */

test('speaker models unpack with the System32 tar on Windows, plain tar elsewhere', () => {
  const sys = 'C:\\Windows\\System32\\tar.exe';
  assert.strictEqual(diarizer.tarCommand('win32', { SystemRoot: 'C:\\Windows' }, (p) => p === sys), sys);
  assert.strictEqual(diarizer.tarCommand('win32', { SystemRoot: 'C:\\Windows' }, () => false), 'tar');
  assert.strictEqual(diarizer.tarCommand('linux', {}, () => true), 'tar');
});

test('a model the user declined is not offered again after every job', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'player', 'player-subtitles.js'), 'utf8');
  let state;
  const shown = [];
  const ctx = {
    console, Math, Number, String, Object, JSON, Promise, Map, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: () => null },
    fetch: async () => ({ json: async () => state }),
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx.subtitlesShowModelConsent = (p) => { shown.push(p.key); };
  const pending = [{ key: 'diarize', kind: 'diarize' }];
  state = { envAllows: true, consents: { diarize: false }, pending };
  await ctx.subtitlesOfferPendingConsent();
  assert.deepStrictEqual(shown, [], 'declined: not asked again');
  state = { envAllows: true, consents: {}, pending };
  await ctx.subtitlesOfferPendingConsent();
  assert.deepStrictEqual(shown, ['diarize'], 'never answered: asked');
});

/* ── 7. sidecar dies while loading: callers get an error, not a hang ─── */

test('a sidecar that crashes during model load fails the startup with an error', { skip: noPython && 'python not found' }, async () => {
  const stubDir = path.join(tmp, 'pystub-crash', 'faster_whisper');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, '__init__.py'), 'import os\nclass WhisperModel:\n    def __init__(self, *a, **k): os._exit(3)\n');
  const prev = process.env.PYTHONPATH;
  process.env.PYTHONPATH = path.join(tmp, 'pystub-crash');
  const audio = path.join(tmp, 'a.wav');
  fs.writeFileSync(audio, 'wav');
  transcriber.shutdownServer();
  try {
    await assert.rejects(transcriber.transcribeSubtitles(audio, {}), /exited \(code 3\) before it was ready/);
    assert.strictEqual(transcriber.isServerRunning(), false);
  } finally {
    transcriber.shutdownServer();
    if (prev === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = prev;
  }
});

/* ── 8. subtitle VAD setting: env wins over the settings file ────────── */

test('subtitle VAD: WHISPER_SUBS_VAD overrides the stored setting, default off', () => {
  const r = config._resolveSubtitleVad;
  assert.strictEqual(r({}, undefined), false);
  assert.strictEqual(r({}, true), true);
  assert.strictEqual(r({ WHISPER_SUBS_VAD: '0' }, true), false);
  assert.strictEqual(r({ WHISPER_SUBS_VAD: '1' }, false), true);
});

/* ── 9. restart mid-job: the half-written track goes with the job ──────── */

test('failStaleJobs: a job interrupted by a restart drops the track it opened, and only that one', () => {
  const other = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, 'b.mp4', 'video')")
    .run(path.join(tmp, 'b.mp4')).lastInsertRowid);
  subsRepo.putTrack(other, 'de', 'original', 'WEBVTT\n\n00:00.000 --> 00:01.000\nfertig');   // finished, untouched
  subsRepo.registerTrack(other, 'en', 'original');
  fs.writeFileSync(subsRepo.trackPath(other, 'en'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nhalf');
  const job = subsRepo.createJob(other);
  subsRepo.updateJob(job.id, { status: 'transcribing', opened_tracks: JSON.stringify([{ lang: 'en', prev: null }]) });

  subsRepo.failStaleJobs();

  assert.strictEqual(subsRepo.getJob(job.id).status, 'error');
  assert.strictEqual(subsRepo.getTrack(other, 'en'), undefined, 'half-written track row gone');
  assert.ok(!fs.existsSync(subsRepo.trackPath(other, 'en')), 'and its file');
  assert.match(subsRepo.readTrackText(other, 'de'), /fertig/, 'a track the run never opened stays');
});
