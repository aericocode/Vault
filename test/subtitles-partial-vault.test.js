/**
 * Vault on: a subtitle run that never finishes gives back exactly what was
 * there before. A run that detected another language re-registers "en" as its
 * translation while it streams; if it then fails, the earlier finished English
 * track must keep its encrypted copy AND its "original" kind, or "Fix here"
 * loses the original track. Same after a restart mid-job (failStaleJobs).
 * Throwaway DBs and folders only; transcription and diarization are stubs.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-subsvault-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_TEMP_AUDIO = path.join(tmp, 'temp_audio');
process.env.VAULT_SECURE_ASSETS = path.join(tmp, 'secure_assets.db');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;
delete process.env.VAULT_SUBS;

const config = require('../config');
config.subtitles = { ...(config.subtitles || {}), idleUnloadMinutes: 0 };
const db = require('../lib/database');
const secureAssets = require('../lib/secure-assets');
const transcriber = require('../lib/video-transcriber');
const diarizer = require('../lib/subtitles/diarizer');
const subsRepo = require('../lib/subtitles/repo');
const subs = require('../lib/subtitles/service');

const PASS = 'subs-vault-test-pass';
const EN = 'WEBVTT\n\n00:00.000 --> 00:01.000\nthe finished english line';
let mediaId;

test.before(() => {
  db.init();
  mediaId = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type, duration_seconds) VALUES (?, 'j.mp4', 'video', 60)")
    .run(path.join(tmp, 'j.mp4')).lastInsertRowid);
  fs.writeFileSync(path.join(tmp, 'j.mp4'), 'x');
  secureAssets.init(PASS);
});

test.after(() => {
  try { secureAssets.close(); } catch {}
  secureAssets.init(null);
  try { db.close(); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a failed run that found Japanese leaves the finished English track as it was (copy and kind)', async () => {
  subsRepo.putTrack(mediaId, 'en', 'original', EN);
  const real = {
    hasAudioStream: transcriber.hasAudioStream, extractAudio: transcriber.extractAudio,
    stream: transcriber.transcribeSubtitlesStream, diarize: diarizer.diarize,
  };
  transcriber.hasAudioStream = async () => true;
  transcriber.extractAudio = async (_fp, dir) => { const a = path.join(dir, 'a.wav'); fs.writeFileSync(a, 'wav'); return a; };
  transcriber.transcribeSubtitlesStream = async (_a, cb) => {
    cb.onStart({ language: 'ja', duration: 60 });
    assert.strictEqual(subsRepo.getTrack(mediaId, 'en').kind, 'translated', 'the run re-registered en as its translation');
    cb.onSegment({ start: 0, end: 2, text: 'こんにちは', words: [] });
    throw new Error('Whisper server closed');
  };
  diarizer.diarize = async () => null;
  let opened;
  try {
    await assert.rejects(subs.generateForMedia(db.getById(mediaId), { onTracksOpened: (o) => { opened = o; } }), /Whisper server closed/);
  } finally {
    Object.assign(transcriber, { hasAudioStream: real.hasAudioStream, extractAudio: real.extractAudio, transcribeSubtitlesStream: real.stream });
    diarizer.diarize = real.diarize;
  }
  assert.deepStrictEqual(opened.map(o => o.lang), ['ja', 'en']);
  const en = subsRepo.getTrack(mediaId, 'en');
  assert.strictEqual(en.kind, 'original', 'kind restored');
  assert.strictEqual(subsRepo.readTrackText(mediaId, 'en'), EN, 'finished text intact');
  assert.strictEqual(subsRepo.getTrack(mediaId, 'ja'), undefined, 'the unfinished ja track is gone');
  assert.ok(!fs.existsSync(subsRepo.trackPath(mediaId, 'ja')), 'no plaintext working copy left');
  subsRepo.dropWorkingCopy(mediaId, 'en');
});

test('restart mid-job (vault on): the finished English track gets its kind back, the unfinished one goes', () => {
  const prev = subsRepo.getTrack(mediaId, 'en');
  assert.strictEqual(prev.kind, 'original');
  subsRepo.registerTrack(mediaId, 'ja', 'original');
  fs.writeFileSync(subsRepo.trackPath(mediaId, 'ja'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nhalf');
  subsRepo.registerTrack(mediaId, 'en', 'translated');
  const job = subsRepo.createJob(mediaId);
  subsRepo.updateJob(job.id, { status: 'translating', opened_tracks: JSON.stringify([{ lang: 'ja', prev: null }, { lang: 'en', prev }]) });

  subsRepo.failStaleJobs();

  assert.strictEqual(subsRepo.getJob(job.id).status, 'error');
  assert.strictEqual(subsRepo.getTrack(mediaId, 'en').kind, 'original');
  assert.strictEqual(subsRepo.readTrackText(mediaId, 'en'), EN);
  assert.strictEqual(subsRepo.getTrack(mediaId, 'ja'), undefined);
  assert.ok(!fs.existsSync(subsRepo.trackPath(mediaId, 'ja')));
});
