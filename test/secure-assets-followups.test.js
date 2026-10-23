/**
 * Encrypted-store follow-ups (a locked library refuses every write):
 *  - the thumbnail disk limit removes stored pictures in one transaction per
 *    slice, never one commit per picture;
 *  - plain face crops are deleted only once their encrypted copy is stored;
 *  - a subtitle job whose finished tracks the store refused (the vault locked
 *    while it ran) ends as a failure, never "done", leaves no plaintext and no
 *    empty track behind; an edited track that could not be saved says so;
 *  - a PMV preview the store refused is not offered.
 * Throwaway DBs and folders only; transcription and diarization are stubs.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-safollow-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_TEMP_AUDIO = path.join(tmp, 'temp_audio');
process.env.VAULT_SECURE_ASSETS = path.join(tmp, 'secure_assets.db');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;
delete process.env.VAULT_SUBS;
delete process.env.SUB_DIARIZE;

const locate = require('../lib/ffmpeg-locate');
const FFMPEG = locate.resolve('ffmpeg');
const noFfmpeg = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status !== 0 && 'ffmpeg not available';
if (!noFfmpeg) process.env.FFMPEG_PATH = FFMPEG;

const config = require('../config');
// No whisper idle-unload timer (it would hold the test process open for minutes).
config.subtitles = { ...(config.subtitles || {}), idleUnloadMinutes: 0 };
const db = require('../lib/database');
const secureAssets = require('../lib/secure-assets');
const ownedDir = require('../lib/owned-dir');
const vault = require('../lib/vault');
const thumbnails = require('../lib/thumbnails');
const ts = require('../lib/thumb-settings');
const faces = require('../lib/faces/store');
const transcriber = require('../lib/video-transcriber');
const diarizer = require('../lib/subtitles/diarizer');
const subsRepo = require('../lib/subtitles/repo');
const subs = require('../lib/subtitles/service');
const pmv = require('../lib/pmv/service');

const PASS = 'followups-test-pass';
const tick = () => new Promise(r => setImmediate(r));

let mediaId;

/**
 * What vault.lock does to the two stores. The test library is not encrypted,
 * so database.get() would quietly reopen it; an encrypted one cannot be opened
 * without the password, so get() throws while "locked", as it would there.
 */
const realDbGet = db.get;
function lockLike() {
  vault._locked = true;
  db.close();
  db.get = () => { const e = new Error('database is locked'); e.code = 'DB_ENCRYPTED'; throw e; };
  secureAssets.close();
  vault._notify('locked');
}
function unlockLike() {
  db.get = realDbGet;
  db.init();
  secureAssets.unlock(PASS);
  vault._locked = false;
  vault._notify('unlocked');
}

test.before(() => {
  db.init();
  mediaId = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type, duration_seconds) VALUES (?, 'm.mp4', 'video', 10)")
    .run(path.join(tmp, 'm.mp4')).lastInsertRowid);
  fs.writeFileSync(path.join(tmp, 'm.mp4'), 'x');
  fs.mkdirSync(config.paths.thumbnailDir, { recursive: true });
  ownedDir.ensureManaged(config.paths.thumbnailDir, 'thumbs');
  secureAssets.init(PASS);
});

test.after(() => {
  vault._locked = false;
  db.get = realDbGet;
  thumbnails.clearMemory();          // stops the disk-limit timers
  try { secureAssets.close(); } catch {}
  secureAssets.init(null);
  try { db.close(); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ── 1. disk limit: one commit per slice ──────────────────────────────── */

test('disk limit: stored pictures go in budgeted slices, one transaction each, never one commit per picture', async () => {
  const c = secureAssets.conn();
  const pic = Buffer.alloc(4000, 1);
  const ins = c.prepare("INSERT INTO assets (media_id, kind, lang, data, size, updated_at) VALUES (?, ?, '', ?, ?, ?)");
  c.transaction(() => {
    for (let id = 1; id <= 150; id++) {
      // older ids were shown longer ago, so they go first
      const when = `2020-01-01 00:${String(Math.floor(id / 60)).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}`;
      ins.run(id, 'thumb', pic, pic.length, when);
      ins.run(id, 'scrub0', pic, pic.length, when);
    }
    ins.run(1, 'face-77', pic, pic.length, '2020-01-01 00:00:00');
  })();

  // Every delete must happen inside an explicit transaction.
  let outside = 0;
  let inside = 0;
  c.function('probe_tx', () => { if (c.inTransaction) inside++; else outside++; return 0; });
  c.exec('CREATE TEMP TRIGGER probe_del AFTER DELETE ON assets BEGIN SELECT probe_tx(); END');

  const realOne = secureAssets.deleteKinds;
  const realMany = secureAssets.deleteKindsMany;
  const slices = [];
  let perId = 0;
  secureAssets.deleteKinds = (...a) => { perId++; return realOne(...a); };
  secureAssets.deleteKindsMany = (kinds, ids) => { slices.push(ids.length); return realMany(kinds, ids); };

  const prevSettings = ts.get();
  const up = ts.update({ make: 'shown', keep: 'cap' });
  assert.ok(!up.error, up.error);
  thumbnails.settingsChanged(prevSettings, up.value);
  thumbnails.clearMemory();
  thumbnails.onUnlock();
  const realGet = ts.get;
  const cur = ts.get();
  // Room for 20 media (cover + frame each).
  ts.get = () => ({ ...cur, diskCapMB: (20 * 2 * pic.length + 100) / 0.95 / (1024 * 1024) });
  try {
    const r = await thumbnails.trimToCap({ max: Infinity });
    assert.strictEqual(r.removed, 130, JSON.stringify(r));
  } finally {
    ts.get = realGet;
    secureAssets.deleteKinds = realOne;
    secureAssets.deleteKindsMany = realMany;
    c.exec('DROP TRIGGER temp.probe_del');
  }

  assert.strictEqual(perId, 0, 'no per-picture deleteKinds calls');
  assert.ok(slices.length >= 3, `more than one slice (${slices.join(',')})`);
  assert.ok(slices.every(n => n >= 1 && n <= 64), `slices of at most 64 ids (${slices.join(',')})`);
  assert.strictEqual(outside, 0, 'no delete ran in autocommit (one commit per row)');
  assert.strictEqual(inside, 260, 'covers and frames of 130 media');
  const left = c.prepare("SELECT kind, COUNT(*) AS n, MIN(media_id) AS lo FROM assets GROUP BY kind ORDER BY kind").all();
  assert.deepStrictEqual(left.map(r => [r.kind, r.n, r.lo]),
    [['face-77', 1, 1], ['scrub0', 20, 131], ['thumb', 20, 131]], 'the 20 most recently shown stay, face crops untouched');
  c.exec('DELETE FROM assets');
});

test('deleteKindsMany: nothing while sealed, and the caller stops', () => {
  secureAssets.put(5, 'thumb', Buffer.from('x'));
  secureAssets.close();
  assert.strictEqual(secureAssets.deleteKindsMany(['thumb'], [5]), 0);
  secureAssets.unlock(PASS);
  assert.ok(secureAssets.get(5, 'thumb'), 'still there');
  assert.strictEqual(secureAssets.deleteKindsMany(['thumb'], [5, 6]), 2);
  assert.strictEqual(secureAssets.get(5, 'thumb'), null);
});

/* ── 2. face crops ────────────────────────────────────────────────────── */

test('face crops: deleted only once the encrypted copy is stored; nothing while sealed', () => {
  const g = db.get();
  const addGroup = () => Number(g.prepare("INSERT INTO face_groups (media_id, best_bbox, model, created_at) VALUES (?, '[0,0,1,1]', 'test', datetime('now'))")
    .run(mediaId).lastInsertRowid);
  const ok = addGroup();
  const fails = addGroup();
  const orphan = 999999;
  const write = (gid, body) => { fs.mkdirSync(path.dirname(faces.cropPath(gid)), { recursive: true }); fs.writeFileSync(faces.cropPath(gid), body); };
  write(ok, 'crop ok');
  write(fails, 'crop refused');
  write(orphan, 'no group');

  // Sealed: nothing at all happens, not even the orphan cleanup.
  lockLike();
  assert.strictEqual(secureAssets.migrateFromDisk().deferred, true);
  unlockLike();
  for (const gid of [ok, fails, orphan]) assert.ok(fs.existsSync(faces.cropPath(gid)), `kept while sealed: ${gid}`);
  // The crop migrator on its own, store sealed but the library database open
  // (where put() quietly returns false): still nothing deleted.
  secureAssets.close();
  try {
    assert.strictEqual(faces.migratePlainCrops(), 0);
  } finally {
    secureAssets.unlock(PASS);
  }
  for (const gid of [ok, fails, orphan]) assert.ok(fs.existsSync(faces.cropPath(gid)), `kept, store sealed: ${gid}`);

  // One write refused (as a full disk would): that file stays.
  const c = secureAssets.conn();
  c.exec(`CREATE TEMP TRIGGER fail_crop BEFORE INSERT ON assets WHEN NEW.kind = 'face-${fails}'
          BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  try {
    secureAssets.migrateFromDisk();
  } finally {
    c.exec('DROP TRIGGER temp.fail_crop');
  }
  assert.ok(!fs.existsSync(faces.cropPath(ok)), 'stored crop: plaintext deleted');
  assert.strictEqual(secureAssets.get(mediaId, `face-${ok}`).toString(), 'crop ok');
  assert.strictEqual(fs.readFileSync(faces.cropPath(fails), 'utf8'), 'crop refused', 'refused crop left in place');
  assert.strictEqual(secureAssets.get(mediaId, `face-${fails}`), null);
  assert.ok(!fs.existsSync(faces.cropPath(orphan)), 'a crop with no face group is leftover and goes');

  // The next run picks the refused one up.
  secureAssets.migrateFromDisk();
  assert.ok(!fs.existsSync(faces.cropPath(fails)));
  assert.strictEqual(secureAssets.get(mediaId, `face-${fails}`).toString(), 'crop refused');
});

/* ── 3. subtitles ─────────────────────────────────────────────────────── */

test('subtitle commit: false only when the store refused a working file', () => {
  const p = subsRepo.trackPath(mediaId, 'de');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  assert.strictEqual(subsRepo.commitTrack(mediaId, 'de'), true, 'no working file: nothing to commit');
  fs.writeFileSync(p, 'WEBVTT\n\n00:00.000 --> 00:01.000\nhallo');
  secureAssets.close();
  assert.strictEqual(subsRepo.commitTrack(mediaId, 'de'), false, 'sealed store refuses it');
  secureAssets.unlock(PASS);
  assert.strictEqual(subsRepo.commitTrack(mediaId, 'de'), true);
  assert.match(secureAssets.get(mediaId, 'subtitle', 'de').toString(), /hallo/);
  subsRepo.dropWorkingCopy(mediaId, 'de');
});

test('an edited track the store refuses is reported as not saved, and leaves no plaintext', () => {
  subsRepo.putTrack(mediaId, 'fr', 'original', 'WEBVTT\n\n00:00.000 --> 00:01.000\nbonjour');
  assert.match(secureAssets.get(mediaId, 'subtitle', 'fr').toString(), /bonjour/);
  secureAssets.close();
  try {
    assert.throws(() => subsRepo.putTrack(mediaId, 'fr', 'original', 'WEBVTT\n\n00:00.000 --> 00:01.000\nau revoir'),
      (e) => e.code === 'SUBS_NOT_SAVED');
    assert.ok(!fs.existsSync(subsRepo.trackPath(mediaId, 'fr')), 'working copy removed');
  } finally {
    secureAssets.unlock(PASS);
  }
  assert.match(secureAssets.get(mediaId, 'subtitle', 'fr').toString(), /bonjour/, 'the earlier text is intact');
  subsRepo.deleteTrack(mediaId, 'fr');
});

test('subtitle job: the vault locks before the tracks are saved, so the job fails (never done), no plaintext, no empty track', async () => {
  const real = {
    hasAudioStream: transcriber.hasAudioStream,
    extractAudio: transcriber.extractAudio,
    stream: transcriber.transcribeSubtitlesStream,
    diarize: diarizer.diarize,
  };
  let releaseDiar;
  let streamed = false;
  transcriber.hasAudioStream = async () => true;
  transcriber.extractAudio = async (_fp, dir) => { const a = path.join(dir, 'a.wav'); fs.writeFileSync(a, 'wav'); return a; };
  transcriber.transcribeSubtitlesStream = async (_audio, cb) => {
    cb.onStart({ language: 'en', duration: 10 });
    cb.onSegment({ start: 0, end: 2, text: 'hello there friend' });
    cb.onSegment({ start: 2, end: 4, text: 'a second line' });
    streamed = true;
  };
  // Speaker detection is the last wait before the tracks are saved: lock then.
  diarizer.diarize = () => new Promise((r) => { releaseDiar = r; });

  const working = subsRepo.trackPath(mediaId, 'en');
  let jobId;
  try {
    jobId = subs.enqueue(mediaId).id;
    for (let i = 0; i < 500 && !(streamed && releaseDiar); i++) await tick();
    assert.ok(streamed && releaseDiar, 'stub pipeline reached the speaker wait');
    assert.ok(fs.existsSync(working), 'working copy exists while it runs');

    lockLike();
    releaseDiar(null);
    for (let i = 0; i < 500 && subs._pendingFailureCount() === 0; i++) await tick();
    assert.strictEqual(subs._pendingFailureCount(), 1, 'the failure is kept until the database is open');
    assert.ok(!fs.existsSync(working), 'no plaintext working copy left while locked');
    const left = fs.readdirSync(process.env.VAULT_TEMP_AUDIO);
    assert.deepStrictEqual(left.filter(n => n.startsWith('subs_')), [], `audio work dir removed (${left.join(',')})`);

    unlockLike();
  } finally {
    transcriber.hasAudioStream = real.hasAudioStream;
    transcriber.extractAudio = real.extractAudio;
    transcriber.transcribeSubtitlesStream = real.stream;
    diarizer.diarize = real.diarize;
    if (vault._locked) unlockLike();
  }

  assert.strictEqual(subs._pendingFailureCount(), 0, 'written on unlock');
  const job = subsRepo.getJob(jobId);
  assert.strictEqual(job.status, 'error');
  assert.match(job.error, /locked before the subtitles could be saved/);
  assert.strictEqual(secureAssets.get(mediaId, 'subtitle', 'en'), null, 'nothing stored');
  const info = subs.infoFor(mediaId);
  assert.strictEqual(info.status, 'error', 'the player sees a failure, not ready/done');
  assert.match(info.error, /locked/);
  assert.ok(!info.tracks.some(t => t.lang === 'en'), 'no empty track offered');
});

/* ── 3b. PMV previews ─────────────────────────────────────────────────── */

test('PMV preview stills: a refused write offers no preview and leaves no file', { skip: noFfmpeg }, async () => {
  const clip = path.join(tmp, 'clip.mp4');
  const ff = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10:d=2',
    '-c:v', 'mpeg4', clip], { windowsHide: true });
  assert.strictEqual(ff.status, 0, String(ff.stderr));
  const tempFiles = () => (fs.existsSync(config.paths.tempDir) ? fs.readdirSync(config.paths.tempDir).filter(n => n.startsWith('pmvprev_')) : []);

  const sealedEntry = { videoPath: clip, sourceIn: 0, duration: 1 };
  secureAssets.close();
  try {
    await pmv.extractPreviews('job-sealed', [sealedEntry]);
  } finally {
    secureAssets.unlock(PASS);
  }
  assert.strictEqual(sealedEntry.preview, undefined, 'no preview URL for a still the store refused');
  assert.strictEqual(secureAssets.getPmvPreview('job-sealed', 0), null);
  assert.deepStrictEqual(tempFiles(), [], 'rendered still deleted');

  const openEntry = { videoPath: clip, sourceIn: 0, duration: 1 };
  await pmv.extractPreviews('job-open', [openEntry]);
  assert.strictEqual(openEntry.preview, '/api/pmv/previews/job-open/p_0000.jpg');
  assert.ok(secureAssets.getPmvPreview('job-open', 0).length > 100);
  assert.deepStrictEqual(tempFiles(), []);
});
