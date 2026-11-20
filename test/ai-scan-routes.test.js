/**
 * Settings > General > AI scan, server side: the setting on /api/settings/app,
 * the routes that start an AI scan refusing while it is Off (the server is the
 * authority, hiding buttons is not enough), Auto refusing a one-file rescan
 * while something plays, the playback beat, and the vault's scan probe.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-aiscan-routes-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_STAGE_NO_MPV = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const vault = require('../lib/vault');
const queue = require('../lib/import-queue');
const mode = require('../lib/ai-scan-mode');
const playback = require('../lib/playback-activity');
const { app, _vaultScanProbe } = require('../server/index');

let server, base, fileId;

test.before(async () => {
  db.init();
  const fp = path.join(tmp, 'a.mp4');
  fs.writeFileSync(fp, 'a');
  fileId = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type, processing_error) VALUES (?, 'a.mp4', 'video', 'unscanned')")
    .run(fp).lastInsertRowid);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  mode.set('on');
  queue.cancel();
  playback._reset();
  vault._locked = false;
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const send = (method, p, body, headers = {}) => fetch(base + p, {
  method,
  headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('the setting: On by default, validated, stored, applied live', async () => {
  let r = await (await send('GET', '/api/settings/app')).json();
  assert.strictEqual(r.aiScan, 'on');
  for (const bad of ['OFF', '', null, true, 2, 'sometimes']) {
    const res = await send('POST', '/api/settings/app', { aiScan: bad });
    assert.strictEqual(res.status, 400, `refused: ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(mode.get(), 'on', 'a refused value changes nothing');
  r = await (await send('POST', '/api/settings/app', { aiScan: 'auto' })).json();
  assert.strictEqual(r.aiScan, 'auto');
  assert.strictEqual(mode.get(), 'auto', 'live, no restart');
  assert.strictEqual(JSON.parse(fs.readFileSync(process.env.VAULT_SETTINGS_FILE, 'utf8')).aiScan, 'auto');
  r = await (await send('GET', '/api/settings/app')).json();
  assert.strictEqual(r.aiScan, 'auto');
  await send('POST', '/api/settings/app', { aiScan: 'on' });
});

test('Off: every route that starts an AI scan refuses with a clear error', async () => {
  mode.set('off');
  const asks = [
    ['POST', `/api/media/${fileId}/rescan`, {}],
    ['POST', '/api/media/retry-errors', { ids: [fileId] }],
    ['POST', '/api/media/batch-rescan', { ids: [fileId], force: true }],
    ['POST', '/api/import/failures/retry', {}],
    ['POST', '/api/import/queue/resume', {}],
    ['POST', '/api/ai/scan-model/load', {}],
  ];
  for (const [m, p, b] of asks) {
    const res = await send(m, p, b);
    assert.strictEqual(res.status, 409, p);
    const j = await res.json();
    assert.strictEqual(j.code, 'AI_SCAN_OFF', p);
    assert.match(j.error, /AI scan is off\. Turn it on in Settings > General/, p);
  }
  assert.strictEqual(queue.status().pendingCount, 0, 'nothing was queued');
  assert.strictEqual(db.getById(fileId).processing_error, 'unscanned');
  mode.set('on');
});

test('Off: importing still adds the files, with nothing queued', async () => {
  mode.set('off');
  const p = path.join(tmp, 'imported.jpg');
  fs.writeFileSync(p, 'x');
  const r = await (await send('POST', '/api/import/add-paths', { paths: [p] })).json();
  assert.strictEqual(r.added.length, 1);
  assert.strictEqual(queue.status().pendingCount, 0);
  mode.set('on');
});

test('Auto: a one-file rescan while something plays is refused in plain words', async () => {
  mode.set('auto');
  playback.report('tab:route01', 'playing');
  const res = await send('POST', `/api/media/${fileId}/rescan`, {});
  assert.strictEqual(res.status, 409);
  const j = await res.json();
  assert.strictEqual(j.code, 'AI_SCAN_WAITS_FOR_PLAYBACK');
  assert.match(j.error, /waits until playback stops/);
  playback._reset();
  mode.set('on');
});

test('Auto: a one-file rescan running when playback starts is cut off, with a plain message', async () => {
  mode.set('auto');
  playback._reset();
  const scan = require('../commands/scan');
  const proc = require('../lib/proc');
  const orig = scan.processFile;
  const pidFile = path.join(tmp, 'rescan-child.pid');
  // processFile as a long step that runs a child, the way frames and the rest do.
  scan.processFile = async () => {
    await proc.run(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000)`]);
    return { success: true };
  };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const before = db.getById(fileId);
    const pending = send('POST', `/api/media/${fileId}/rescan`, {});
    const t0 = Date.now();
    while (!fs.existsSync(pidFile) && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 10));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(alive(pid), 'the rescan started');
    playback.report('tab:route02', 'playing');
    const res = await pending;
    assert.ok(Date.now() - t0 < 3000, 'answered at once');
    assert.strictEqual(res.status, 409);
    const j = await res.json();
    assert.strictEqual(j.code, 'AI_SCAN_CUT_FOR_PLAYBACK');
    assert.strictEqual(j.error, 'Scan stopped because something started playing. It was not put back in the scan line. Start it again when playback is done.');
    const t1 = Date.now();
    while (alive(pid) && Date.now() - t1 < 3000) await new Promise(r => setTimeout(r, 20));
    assert.ok(!alive(pid), 'its child process was stopped');
    assert.strictEqual(queue.status().pendingCount, 0, 'not put in the line');
    assert.strictEqual(db.getById(fileId).processing_error, before.processing_error, 'the row is as it was');
    assert.strictEqual(_vaultScanProbe(), false, 'nothing left scanning');
  } finally {
    scan.processFile = orig;
    playback._reset();
    mode.set('on');
  }
});

test('the playback beat: validated, background, and it is what Auto hears', async () => {
  playback._reset();
  const before = vault._lastActivity;
  for (const bad of [{ tab: 'x', state: 'playing' }, { tab: 'abcdef', state: 'loud' }, { state: 'playing' }, { tab: '../../../a', state: 'idle' }]) {
    const res = await send('POST', '/api/playback/beat', bad, { 'X-Vault-Background': '1' });
    assert.strictEqual(res.status, 400, JSON.stringify(bad));
  }
  let res = await send('POST', '/api/playback/beat', { tab: 'tab123', state: 'playing' }, { 'X-Vault-Background': '1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(playback.isPlaying(), true);
  assert.strictEqual(vault._lastActivity, before, 'a beat is not the user being present');
  res = await send('POST', '/api/playback/beat', { tab: 'tab123', state: 'idle' }, { 'X-Vault-Background': '1' });
  assert.strictEqual(playback.isPlaying(), false);
});

test('the vault scan probe: the import queue never counts while AI scan is Off', async () => {
  mode.set('on');
  assert.strictEqual(_vaultScanProbe(), false);
  // A file queued while waiting for a model counts in On (the queue says active)...
  const orig = queue.isActive;
  queue.isActive = () => true;
  try {
    assert.strictEqual(_vaultScanProbe(), true);
    mode.set('off');
    assert.strictEqual(_vaultScanProbe(), false, 'Off: never from the AI scan');
  } finally {
    queue.isActive = orig;
    mode.set('on');
  }
});
