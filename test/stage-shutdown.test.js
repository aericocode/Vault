/**
 * Stage on the way out (server/stage-routes.js shutdown(), called first by
 * server/index.js _gracefulExit for Ctrl+C, SIGTERM, a closed terminal and
 * Exit Vault): an open mpv Stage window is asked to quit, the way its own
 * Close does, and Vault waits for it; an mpv that does not go is killed.
 *
 * mpv here is test/fixtures/fake-mpv.js, a real child process speaking mpv's
 * JSON IPC on a real pipe, started by the real lib/stage/mpv-host.js. So the
 * child, the pipe and the quit command are all real; only the program is not.
 * (The whole shutdown, signals and Exit Vault, is in exit-vault-route.test.js.)
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-stage-shutdown-'));
process.env.VAULT_DB = process.env.VAULT_DB || path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = process.env.VAULT_SETTINGS_FILE || path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_DISABLE_NATIVE_PICKER = '1';

const express = require('express');
const { buildRouter } = require('../server/stage-routes');
const { createMpvHost } = require('../lib/stage/mpv-host');

const FAKE = path.join(__dirname, 'fixtures', 'fake-mpv.js');

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

async function stageWithFakeMpv({ ignoreQuit = false } = {}) {
  const logFile = path.join(tmp, `mpv-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  const spawnFn = (exe, args, opts) => spawn(process.execPath, [FAKE, ...args], {
    ...opts, env: { ...process.env, FAKE_MPV_LOG: logFile, FAKE_MPV_IGNORE_QUIT: ignoreQuit ? '1' : '0' },
  });
  let mpvProc = null;
  const router = buildRouter({
    hostFactory: (opts) => createMpvHost({ ...opts, spawnFn: (...a) => (mpvProc = spawnFn(...a)) }),
    find: async () => ({ found: true, path: process.execPath, version: 'v0.41.0', source: 'default' }),
    lib: { pathFor: () => ({ ok: false, reason: 'no' }), isLocked: () => false },
    env: { VAULT_STAGE_MUTE: '1', VAULT_STAGE_TEST_QUIET: '1' },
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const at = `http://127.0.0.1:${server.address().port}`;
  const open = await fetch(at + '/api/stage/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
  return {
    router, open, readLog, mpv: () => mpvProc,
    exited: () => new Promise((resolve) => {
      if (!mpvProc || mpvProc.exitCode !== null || mpvProc.signalCode !== null) return resolve();
      mpvProc.on('exit', () => resolve());
    }),
    done: async () => {
      try { if (mpvProc && mpvProc.exitCode === null) mpvProc.kill('SIGKILL'); } catch {}
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('shutdown asks an open mpv Stage to quit, waits for it, and leaves no process behind', { timeout: 30000 }, async () => {
  const t = await stageWithFakeMpv();
  try {
    assert.strictEqual(t.open.status, 200, 'Stage opened on the fake mpv');
    assert.strictEqual((await t.open.json()).mode, 'mpv');
    const pid = t.mpv().pid;
    assert.ok(pidAlive(pid), 'mpv is running');
    const r = await t.router.shutdown();
    assert.deepStrictEqual(r, { closed: true, killed: false }, 'mpv went by itself, after being asked');
    await t.exited();
    assert.strictEqual(t.mpv().exitCode, 0, 'mpv ended on its own, not killed');
    assert.match(t.readLog(), /^cmd quit$/m, 'mpv was sent quit');
    assert.match(t.readLog(), /^exit 0$/m);
    assert.ok(!pidAlive(pid), 'no mpv left behind');
  } finally { await t.done(); }
});

test('shutdown kills an mpv that does not quit when asked', { timeout: 30000 }, async () => {
  const t = await stageWithFakeMpv({ ignoreQuit: true });
  try {
    assert.strictEqual(t.open.status, 200);
    const pid = t.mpv().pid;
    const r = await t.router.shutdown({ waitMs: 400 });
    assert.deepStrictEqual(r, { closed: true, killed: true });
    await t.exited();
    assert.match(t.readLog(), /^cmd quit$/m, 'asked first');
    assert.ok(!pidAlive(pid), 'no mpv left behind');
  } finally { await t.done(); }
});

test('shutdown with no Stage open does nothing', async () => {
  const router = buildRouter({
    hostFactory: () => { throw new Error('no mpv should start'); },
    find: async () => ({ found: false }),
    lib: { pathFor: () => ({ ok: false, reason: 'no' }), isLocked: () => false },
    env: { VAULT_STAGE_MUTE: '1', VAULT_STAGE_TEST_QUIET: '1' },
  });
  assert.deepStrictEqual(await router.shutdown(), { closed: false });
});
