/**
 * Subtitle track keys (?lang=) are checked before they reach a file name.
 *
 * DELETE /api/media/:id/subtitles?lang=... used to unlink
 * path.join(tracksDir, `${id}.${lang}.vtt`) whether or not the track existed,
 * so lang=../../somewhere/x deleted any .vtt the server could reach. Now every
 * track route refuses a lang that is not a track key, and deleteTrack only
 * removes the file of a track row that exists.
 *
 * Real app, throwaway library and folders.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-subslang-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_SUBS = path.join(tmp, 'subs');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const repo = require('../lib/subtitles/repo');
const { app } = require('../server/index');

const VTT = 'WEBVTT\n\n00:00.000 --> 00:01.000\nhello';
let server;
let port;
let mediaId;

test.before(async () => {
  db.init();
  mediaId = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, 'a.mp4', 'video')")
    .run(path.join(tmp, 'a.mp4')).lastInsertRowid);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/** Raw request so the path goes out byte for byte (fetch would normalise ../). */
function raw(method, target, body) {
  return new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('track keys: what the app makes passes, anything path-like does not', () => {
  for (const ok of ['en', 'ja', 'zh', 'haw', 'yue', 'unknown', 'pt-br', 'zh_hant', 'EN']) {
    assert.strictEqual(repo.isValidTrackLang(ok), true, ok);
  }
  for (const bad of ['', '../x', '..\\x', 'en/../../x', 'en.vtt', 'e', 'english', 'en-', '../../../../tmp/victim',
    'en\0', ' en', 'en ', 'c:', '%2e%2e', null, undefined, 42, ['en']]) {
    assert.strictEqual(repo.isValidTrackLang(bad), false, JSON.stringify(bad));
  }
  assert.throws(() => repo.trackPath(mediaId, '../x'), /not a subtitle language/);
});

test('DELETE with a traversal lang is refused and the outside file survives', async () => {
  // A .vtt outside the subtitles folder, where ../ from it would land
  const victimDir = path.join(tmp, 'elsewhere');
  fs.mkdirSync(victimDir, { recursive: true });
  const victim = path.join(victimDir, 'victim.vtt');
  fs.writeFileSync(victim, VTT);
  const rel = path.relative(repo.TRACKS_DIR, path.join(victimDir, 'victim')).split(path.sep).join('/');
  // `${id}.${lang}.vtt` → `${id}.` + '/../' + rel + '.vtt'
  const lang = `/../${rel}`;
  for (const v of [lang, encodeURIComponent(lang)]) {
    const r = await raw('DELETE', `/api/media/${mediaId}/subtitles?lang=${v}`);
    assert.strictEqual(r.status, 400, `${v}: ${r.text}`);
  }
  assert.ok(fs.existsSync(victim), 'the outside .vtt is still there');
});

test('every track route refuses a bad lang', async () => {
  const bad = encodeURIComponent('../x');
  assert.strictEqual((await raw('GET', `/api/media/${mediaId}/subtitles?lang=${bad}`)).status, 400);
  assert.strictEqual((await raw('PUT', `/api/media/${mediaId}/subtitles?lang=${bad}`, { vtt: VTT })).status, 400);
  assert.strictEqual((await raw('DELETE', `/api/media/${mediaId}/subtitles?lang=${bad}`)).status, 400);
  assert.strictEqual((await raw('DELETE', `/api/media/${mediaId}/subtitles?lang=en&lang=ja`)).status, 400, 'two values');
  // No lang: GET defaults to en, PUT and DELETE still say it is required
  assert.strictEqual((await raw('GET', `/api/media/${mediaId}/subtitles`)).status, 404);
  assert.strictEqual((await raw('DELETE', `/api/media/${mediaId}/subtitles`)).status, 400);
});

test('DELETE of a track that does not exist is a 404 and touches no file', async () => {
  // A file where trackPath would point, with no row behind it
  fs.mkdirSync(repo.TRACKS_DIR, { recursive: true });
  const orphan = path.join(repo.TRACKS_DIR, `${mediaId}.fr.vtt`);
  fs.writeFileSync(orphan, VTT);
  const r = await raw('DELETE', `/api/media/${mediaId}/subtitles?lang=fr`);
  assert.strictEqual(r.status, 404);
  assert.ok(fs.existsSync(orphan), 'no row, no unlink');
  assert.strictEqual(repo.deleteTrack(mediaId, 'fr'), null);
});

test('a real track still reads, saves and deletes', async () => {
  repo.putTrack(mediaId, 'ja', 'original', VTT);
  const p = repo.getTrack(mediaId, 'ja').path;
  assert.ok(fs.existsSync(p));
  let r = await raw('GET', `/api/media/${mediaId}/subtitles?lang=ja`);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /hello/);
  r = await raw('PUT', `/api/media/${mediaId}/subtitles?lang=ja`, { vtt: `${VTT} again` });
  assert.strictEqual(r.status, 200, r.text);
  r = await raw('DELETE', `/api/media/${mediaId}/subtitles?lang=ja`);
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(!fs.existsSync(p), 'the track file went with the row');
  assert.strictEqual(repo.getTrack(mediaId, 'ja'), undefined);
});
