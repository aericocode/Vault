/**
 * Loading and unloading copies through the lms CLI.
 *
 * Nothing here spawns anything. What is worth testing is the arithmetic and the
 * guards around the spawn: which identifier the next copy gets, which arguments
 * carry the original's settings, whether the endpoint is this PC, where `lms`
 * is looked for, and the rule that stops the original from being unloaded.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

// lib/lms-cli pulls in lib/ai-slots lazily, which resolves the prefs file at
// load time. Keep a test run away from the real install.
process.env.VAULT_SETTINGS_FILE = path.join(os.tmpdir(), `vault-test-lms-${process.pid}.json`);

const lms = require('../lib/lms-cli');
const aiSlots = require('../lib/ai-slots');

/* ── Identifier picking ──────────────────────────────────────────────────── */

test('nextIdentifier starts at :2 and skips what is taken', () => {
  const fam = 'mradermacher/minicpm-v-4.6-abliterated-max';
  assert.strictEqual(lms.nextIdentifier(fam, [fam]), `${fam}:2`);
  assert.strictEqual(lms.nextIdentifier(fam, [fam, `${fam}:2`]), `${fam}:3`);
  assert.strictEqual(lms.nextIdentifier(fam, [fam, `${fam}:2`, `${fam}:3`]), `${fam}:4`);
});

test('nextIdentifier reuses a gap left by an unloaded copy', () => {
  // :2 was unloaded and :3 is still up, so the next copy takes :2 back rather
  // than creeping upwards every time someone experiments.
  assert.strictEqual(lms.nextIdentifier('m', ['m', 'm:3']), 'm:2');
});

test('nextIdentifier ignores other families and unrelated suffixes', () => {
  assert.strictEqual(lms.nextIdentifier('m', ['m', 'other:2', 'm-extra:2', 'm:x']), 'm:2');
});

/* The base id is a candidate like any other. Before, numbering started at :2
   unconditionally, so a family whose original had been ejected got another
   suffix stacked on a suffixed id and ended up as `…max:2:2`. */
test('nextIdentifier takes the bare base id when nothing holds it', () => {
  const fam = 'mradermacher/minicpm-v-4.6-abliterated-max';
  assert.strictEqual(lms.nextIdentifier(fam, []), fam, 'nothing loaded: the copy is the original');
  assert.strictEqual(lms.nextIdentifier(fam, [`${fam}:2`, `${fam}:3`]), fam,
    'the base was ejected, so the next copy takes it back rather than becoming :4');
  assert.strictEqual(lms.nextIdentifier(fam, [`${fam}:3`]), fam);
  // And it is still skipped when it IS loaded.
  assert.strictEqual(lms.nextIdentifier(fam, [fam, `${fam}:3`]), `${fam}:2`);
});

test('nextIdentifier treats regex characters in a model name as text', () => {
  // Real model keys carry dots and slashes; a naive pattern would match
  // "publisher/model-v1.5:2" against "publisher/modelXv1X5".
  const fam = 'pub/model-v1.5';
  assert.strictEqual(lms.nextIdentifier(fam, [fam, 'pubXmodel-v1X5:2']), `${fam}:2`);
});

/* ── Arguments from a ps row ─────────────────────────────────────────────── */

// The shape LM Studio 0.3.x actually prints, trimmed to the fields used.
const PS_ROW = {
  type: 'llm',
  modelKey: 'mradermacher/minicpm-v-4.6-abliterated-max',
  identifier: 'mradermacher/minicpm-v-4.6-abliterated-max',
  contextLength: 75776,
  maxContextLength: 262144,
  parallel: 4,
  ttlMs: null,
  status: 'idle',
  vision: true,
};

test('loadArgs copies the original settings and confirms', () => {
  assert.deepStrictEqual(lms.loadArgs(PS_ROW, 'mradermacher/minicpm-v-4.6-abliterated-max:2'), [
    'load', 'mradermacher/minicpm-v-4.6-abliterated-max',
    '--identifier', 'mradermacher/minicpm-v-4.6-abliterated-max:2',
    '-c', '75776',
    '--parallel', '4',
    '-y',
  ]);
});

test('loadArgs turns a ttl in milliseconds into seconds', () => {
  const args = lms.loadArgs({ ...PS_ROW, ttlMs: 3_600_000 }, 'm:2');
  assert.deepStrictEqual(args.slice(-3), ['--ttl', '3600', '-y']);
});

test('loadArgs leaves out settings LM Studio did not report', () => {
  // A missing context length means "use the model's default", which is a better
  // guess than passing 0 and having the load fail.
  const args = lms.loadArgs({ modelKey: 'm' }, 'm:2');
  assert.deepStrictEqual(args, ['load', 'm', '--identifier', 'm:2', '-y']);
});

test('findPsRow matches on identifier or model key', () => {
  const rows = [PS_ROW, { modelKey: 'm', identifier: 'm:2' }];
  assert.strictEqual(lms.findPsRow(rows, 'm:2'), rows[1]);
  assert.strictEqual(lms.findPsRow(rows, PS_ROW.identifier), rows[0]);
  assert.strictEqual(lms.findPsRow(rows, 'nope'), null);
});

/* ── Local-host gating ───────────────────────────────────────────────────── */

test('isLocalEndpoint accepts only this PC', () => {
  for (const url of [
    'http://localhost:1234/v1/chat/completions',
    'http://127.0.0.1:1234/v1/chat/completions',
    'http://127.0.0.1:5678/v1/chat/completions',   // another port is still here
    'http://[::1]:1234/v1/chat/completions',
  ]) assert.strictEqual(lms.isLocalEndpoint(url), true, url);

  for (const url of [
    'http://192.168.1.50:1234/v1/chat/completions',
    'http://gpu-box.lan:1234/v1/chat/completions',
    'https://example.com/v1/chat/completions',
    'not a url',
    '',
    null,
  ]) assert.strictEqual(lms.isLocalEndpoint(url), false, String(url));
});

/* ── Where lms is looked for ─────────────────────────────────────────────── */

test('findLms prefers PATH over the LM Studio bin folder', () => {
  const onPath = path.join('C:\\tools', 'lms.exe');
  const inBin = path.join('C:\\Users\\me', '.lmstudio', 'bin', 'lms.exe');
  const env = { PATH: ['C:\\other', 'C:\\tools'].join(path.delimiter), PATHEXT: '.EXE', USERPROFILE: 'C:\\Users\\me' };
  // PATHEXT is upper case on a real machine and NTFS does not care, so the
  // stub file system must not care either.
  const has = (p) => [onPath, inBin].some(k => k.toLowerCase() === p.toLowerCase());
  const found = lms._findLmsIn({ env, platform: 'win32', exists: has });
  assert.strictEqual(found.toLowerCase(), onPath.toLowerCase());
});

test('findLms falls back to the LM Studio bin folder', () => {
  const inBin = path.join('C:\\Users\\me', '.lmstudio', 'bin', 'lms.exe');
  const env = { PATH: 'C:\\other', PATHEXT: '.EXE', USERPROFILE: 'C:\\Users\\me' };
  assert.strictEqual(
    lms._findLmsIn({ env, platform: 'win32', exists: p => p.toLowerCase() === inBin.toLowerCase() }),
    inBin,
  );
});

test('findLms uses the extension-less name off Windows', () => {
  const inBin = path.join('/home/me', '.lmstudio', 'bin', 'lms');
  const env = { PATH: ['/usr/bin', '/usr/local/bin'].join(path.delimiter), HOME: '/home/me' };
  assert.strictEqual(
    lms._findLmsIn({ env, platform: 'linux', exists: p => p === path.join('/usr/local/bin', 'lms') }),
    path.join('/usr/local/bin', 'lms'),
  );
  assert.strictEqual(
    lms._findLmsIn({ env, platform: 'linux', exists: p => p === inBin }),
    inBin,
  );
});

test('findLms prefers a .exe over the .cmd beside it', () => {
  // npm-style shims land a lms.cmd in the same folder as the real lms.exe, and
  // PATHEXT lists .CMD too. Node cannot start the .cmd on its own, so the .exe
  // has to win even when PATHEXT's own order puts .CMD first.
  const env = { PATH: 'C:\\tools', PATHEXT: '.COM;.CMD;.BAT;.EXE', USERPROFILE: 'C:\\Users\\me' };
  const found = lms._findLmsIn({
    env,
    platform: 'win32',
    exists: p => /[\\/]lms\.(exe|cmd)$/i.test(p),
  });
  assert.match(found.toLowerCase(), /lms\.exe$/);
});

test('spawnSpec runs a .cmd through the command interpreter', () => {
  // Node answers `spawn EINVAL` for a .cmd started without a shell. It is
  // handed to ComSpec instead, with the pieces still separate: no command line
  // is built out of a model name full of slashes and colons.
  const prev = process.env.ComSpec;
  process.env.ComSpec = 'C:\\Windows\\system32\\cmd.exe';
  try {
    const spec = lms.spawnSpec('C:\\npm\\lms.cmd', ['load', 'pub/model', '--identifier', 'pub/model:2', '-y']);
    assert.deepStrictEqual(spec, {
      command: 'C:\\Windows\\system32\\cmd.exe',
      argv: ['/c', 'C:\\npm\\lms.cmd', 'load', 'pub/model', '--identifier', 'pub/model:2', '-y'],
    });
    assert.deepStrictEqual(
      lms.spawnSpec('C:\\npm\\lms.BAT', ['ps', '--json']).argv,
      ['/c', 'C:\\npm\\lms.BAT', 'ps', '--json'],
    );
  } finally {
    if (prev === undefined) delete process.env.ComSpec; else process.env.ComSpec = prev;
  }
});

test('spawnSpec leaves a real executable alone', () => {
  assert.deepStrictEqual(lms.spawnSpec('C:\\tools\\lms.exe', ['ps', '--json']), {
    command: 'C:\\tools\\lms.exe',
    argv: ['ps', '--json'],
  });
  assert.deepStrictEqual(lms.spawnSpec('/home/me/.lmstudio/bin/lms', ['unload', 'm:2']), {
    command: '/home/me/.lmstudio/bin/lms',
    argv: ['unload', 'm:2'],
  });
});

test('findLms answers null when the CLI is nowhere', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/me' };
  assert.strictEqual(lms._findLmsIn({ env, platform: 'linux', exists: () => false }), null);
});

/* ── The never-unload-the-last-copy guard ────────────────────────────────── */

/* The route counts how many of the identifiers `lms ps` reports share the
   family and refuses only when unloading would empty it. Which copy is the
   "original" is no longer part of the question: after ejecting the base in LM
   Studio the remaining copies still have to be unloadable from Vault. */
test('the unload guard refuses only the last copy of a family', () => {
  const guarded = (id, siblings) =>
    siblings.filter(s => aiSlots.familyOf(s) === aiSlots.familyOf(id)).length < 2;

  assert.strictEqual(guarded('m', ['m', 'm:2']), false, 'the base goes while :2 remains');
  assert.strictEqual(guarded('m:2', ['m', 'm:2']), false, 'a copy can be unloaded');
  assert.strictEqual(guarded('m:3', ['m', 'm:2', 'm:3']), false);
  // The base was ejected in LM Studio: :2 and :3 are still one family, and
  // either may go while the other is holding the model.
  assert.strictEqual(guarded('m:2', ['m:2', 'm:3']), false);
  assert.strictEqual(guarded('m:3', ['m:3']), true, 'the last copy is refused');
  assert.strictEqual(guarded('m', ['m']), true);
  // An Ollama style tag is a model in its own right, never a copy of anything.
  assert.strictEqual(guarded('llava:13b', ['llava:13b']), true);
});

/* ── Job list ────────────────────────────────────────────────────────────── */

test('jobs starts empty and pendingIdentifiers reports nothing', () => {
  lms._reset();
  assert.deepStrictEqual(lms.jobs(), []);
  assert.deepStrictEqual(lms.pendingIdentifiers(), []);
  assert.strictEqual(lms.activeJob('m'), null);
});
