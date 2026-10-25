/**
 * PMV cut list edits cannot point FFmpeg at other files.
 *
 * PUT /api/pmv/jobs/:id/edl stored the client's entry objects as they came,
 * and the renderer handed entry.videoPath / centerVideoPath to FFmpeg as
 * inputs (and entry effects into its filter graph). Now the PUT keeps only
 * which cuts stay, by id, taking each cut from the server's stored copy, and
 * renderEntries looks every source path up again from the job's own videos.
 *
 * Real app, throwaway library. Nothing is rendered.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-pmvedl-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const pmvRepo = require('../lib/pmv/repo');
const pmvService = require('../lib/pmv/service');
const { app } = require('../server/index');

const SECRET = path.join(tmp, 'not-in-this-job.mp4');
let server;
let base;
const vids = {};

function addVideo(name) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, 'x');
  return { id: Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'video')").run(p, name).lastInsertRowid), path: p };
}

function entry(id, sourceVideo, extra = {}) {
  return {
    id, sourceVideo, videoPath: [vids.a.path, vids.b.path][sourceVideo],
    sourceIn: id, sourceOut: id + 1, editIn: id, editOut: id + 1, duration: 1,
    effects: [], ...extra,
  };
}

function makeJob({ videoInfos = true } = {}) {
  const job = pmvRepo.createJob({ video_ids: [vids.a.id, vids.b.id], audio_ids: [vids.a.id], options: {} });
  pmvRepo.updateJob(job.id, {
    edl: {
      entries: [entry(0, 0), entry(1, 1, { centerSourceVideo: 0, centerVideoPath: vids.a.path }), entry(2, 0)],
      seed: 1,
      ...(videoInfos ? { videoInfos: [{ index: 0, media_id: vids.a.id, duration: 9 }, { index: 1, media_id: vids.b.id, duration: 9 }] } : {}),
    },
    status: 'edl_ready',
  });
  return job.id;
}

test.before(async () => {
  db.init();
  vids.a = addVideo('a.mp4');
  vids.b = addVideo('b.mp4');
  vids.other = addVideo('not-in-this-job.mp4');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const put = (jobId, entries) => fetch(`${base}/api/pmv/jobs/${jobId}/edl`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }),
});

test('PUT keeps the server copy of each cut, whatever else the client sends', async () => {
  const jobId = makeJob();
  const before = pmvRepo.getJob(jobId).edl.entries;
  // Removing cut 1 (what the review screen does), with tampered fields
  const tampered = [
    { ...before[2], videoPath: SECRET, centerVideoPath: SECRET, sourceIn: 999, effects: [{ type: 'color', filter: 'movie=C\\:/x' }] },
    { ...before[0], videoPath: SECRET, transition: { type: 'xfade', effect: 'evil', duration: 5 } },
  ];
  const res = await put(jobId, tampered);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true, totalEdits: 2 });
  const after = pmvRepo.getJob(jobId).edl;
  assert.deepStrictEqual(after.entries, [before[2], before[0]], 'the stored cuts, in the client order, unchanged');
  assert.ok(Array.isArray(after.videoInfos) && after.seed === 1, 'the rest of the EDL is kept');
});

test('PUT refuses an id it does not have, a missing id, or the same cut twice', async () => {
  const jobId = makeJob();
  const before = pmvRepo.getJob(jobId).edl.entries;
  for (const entries of [
    [{ id: 7, videoPath: SECRET }],
    [{ videoPath: SECRET }],
    [{ id: '0' }],
    [before[0], before[0]],
    [null],
  ]) {
    const res = await put(jobId, entries);
    assert.strictEqual(res.status, 400, JSON.stringify(entries));
    assert.match((await res.json()).error, /does not match/);
  }
  assert.deepStrictEqual(pmvRepo.getJob(jobId).edl.entries, before, 'nothing stored');
  assert.strictEqual((await put(jobId, [])).status, 400);
});

test('render sources come from the job\'s own videos, never a stored path on its own', () => {
  const jobId = makeJob();
  const job = pmvRepo.getJob(jobId);
  // As if an old PUT had stored foreign paths
  job.edl.entries[0].videoPath = SECRET;
  job.edl.entries[1].centerVideoPath = SECRET;
  const out = pmvService.renderEntries(job);
  assert.strictEqual(out[0].videoPath, vids.a.path, 'from videoInfos[0].media_id');
  assert.strictEqual(out[1].videoPath, vids.b.path);
  assert.strictEqual(out[1].centerVideoPath, vids.a.path, 'center from centerSourceVideo');
  assert.strictEqual(out[2].centerVideoPath, vids.a.path, 'no center source: the side clip');
  assert.ok(out.every(e => e.videoPath !== SECRET && e.centerVideoPath !== SECRET));
  // The current filepath wins (a file moved since the analysis)
  const moved = path.join(tmp, 'moved-b.mp4');
  db.get().prepare('UPDATE media SET filepath = ? WHERE id = ?').run(moved, vids.b.id);
  assert.strictEqual(pmvService.renderEntries(job)[1].videoPath, moved);
  db.get().prepare('UPDATE media SET filepath = ? WHERE id = ?').run(vids.b.path, vids.b.id);
});

test('an old job with no media ids keeps its paths only when they are the job\'s videos', () => {
  const job = pmvRepo.getJob(makeJob({ videoInfos: false }));
  assert.deepStrictEqual(pmvService.renderEntries(job).map(e => e.videoPath), [vids.a.path, vids.b.path, vids.a.path]);
  job.edl.entries[0].videoPath = SECRET;   // a library file, but not one of this job's
  job.edl.entries[2].videoPath = 'C:\\Windows\\win.ini';
  const out = pmvService.renderEntries(job);
  assert.strictEqual(out[0].videoPath, null, 'renderEDL skips a cut with no source');
  assert.strictEqual(out[2].videoPath, null);
  assert.strictEqual(out[1].videoPath, vids.b.path);
});

test('a video removed from the library since leaves its cuts without a source', () => {
  const job = pmvRepo.getJob(makeJob());
  job.video_ids = [vids.a.id];   // b no longer part of the job's rows
  const out = pmvService.renderEntries(job);
  assert.strictEqual(out[1].videoPath, null);
  assert.strictEqual(out[0].videoPath, vids.a.path);
});
