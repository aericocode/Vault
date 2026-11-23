/**
 * lib/own-children.js: on Linux the graceful shutdown asks Vault's own child
 * processes to stop (a Vault with no terminal has no Ctrl+C to reach them).
 * Run against a fake /proc folder, so it is the same on every OS; the last
 * test uses the real /proc where there is one.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { listOwnChildren, stopOwnChildren, readStat } = require('../lib/own-children');

/** A fake /proc: { pid: [comm, state, ppid, sid] }. */
function fakeProc(procs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-proc-'));
  for (const [pid, [comm, state, ppid, sid]] of Object.entries(procs)) {
    fs.mkdirSync(path.join(dir, pid));
    fs.writeFileSync(path.join(dir, pid, 'stat'), `${pid} (${comm}) ${state} ${ppid} ${sid} ${sid} 0 -1 4194304 0 0`);
  }
  fs.mkdirSync(path.join(dir, 'self'));
  fs.writeFileSync(path.join(dir, 'uptime'), '1.0 1.0');
  return dir;
}

test('readStat reads the fields after the last ")" (names with spaces and brackets)', () => {
  const dir = fakeProc({ 42: ['odd ) name (x)', 'S', 7, 9] });
  try {
    assert.deepStrictEqual(readStat(dir, 42), { pid: 42, state: 'S', ppid: 7, sid: 9 });
    assert.strictEqual(readStat(dir, 43), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only running, non-detached children of Vault are listed', () => {
  const dir = fakeProc({
    100: ['node', 'S', 1, 100],          // Vault itself
    101: ['ffmpeg', 'R', 100, 100],      // a child: listed
    102: ['mpv', 'S', 100, 100],         // a child: listed
    103: ['ffmpeg', 'Z', 100, 100],      // exited, not reaped: no
    104: ['LM Studio', 'S', 100, 104],   // detached (its own session): no
    105: ['bash', 'S', 1, 105],          // someone else's: no
    106: ['grandchild', 'S', 101, 100],  // a child's child: no
  });
  try {
    assert.deepStrictEqual(listOwnChildren({ procDir: dir, pid: 100 }).sort(), [101, 102]);
    assert.deepStrictEqual(listOwnChildren({ procDir: path.join(dir, 'missing'), pid: 100 }), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stopOwnChildren: SIGTERM to each child, waits for them to go, Linux only', async () => {
  const dir = fakeProc({ 100: ['node', 'S', 1, 100], 101: ['ffmpeg', 'R', 100, 100], 102: ['python', 'S', 100, 100] });
  try {
    const sent = [];
    // Off Linux: nothing listed, nothing signalled.
    assert.deepStrictEqual(await stopOwnChildren({ procDir: dir, pid: 100, platform: 'win32', kill: (p, s) => sent.push([p, s]) }), { asked: 0, left: 0 });
    assert.deepStrictEqual(sent, []);
    // Linux: each child gets SIGTERM; "dying" removes it from the fake /proc.
    const r = await stopOwnChildren({
      procDir: dir, pid: 100, platform: 'linux', stepMs: 5,
      kill: (p, s) => { sent.push([p, s]); fs.rmSync(path.join(dir, String(p)), { recursive: true, force: true }); },
    });
    assert.deepStrictEqual(r, { asked: 2, left: 0 });
    assert.deepStrictEqual(sent.sort(), [[101, 'SIGTERM'], [102, 'SIGTERM']]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stopOwnChildren gives up after waitMs and says how many are left', async () => {
  const dir = fakeProc({ 100: ['node', 'S', 1, 100], 101: ['stubborn', 'S', 100, 100] });
  try {
    const r = await stopOwnChildren({ procDir: dir, pid: 100, platform: 'linux', waitMs: 30, stepMs: 10, kill: () => {} });
    assert.deepStrictEqual(r, { asked: 1, left: 1 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real /proc (Linux): a child of this process is found and stopped', { skip: process.platform !== 'linux' }, async () => {
  const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const gone = new Promise(r => kid.on('exit', (code, signal) => r(signal)));
  await new Promise(r => setTimeout(r, 200));
  assert.ok(listOwnChildren().includes(kid.pid), 'listed');
  const r = await stopOwnChildren();
  assert.ok(r.asked >= 1);
  assert.strictEqual(await gone, 'SIGTERM');
});
