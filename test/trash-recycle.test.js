/**
 * Recycle Bin delete on Windows: the file path reaches PowerShell through an
 * environment variable, never as script text. The old code pasted it into a
 * single-quoted literal and doubled only ASCII ', but PowerShell also closes
 * a single-quoted string at the typographic quotes U+2018..U+201B, so a file
 * name could run code.
 *
 * Nothing here touches the real Recycle Bin: the PowerShell runs use a path
 * that does not exist, so DeleteFile fails before it moves anything.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-recycle-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_TRASH = path.join(tmp, 'trash');
delete process.env.VAULT_DB_PASSWORD;

const { recycleCommandWindows, RECYCLE_PS_SCRIPT } = require('../lib/trash');

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

// Every quote PowerShell treats as a single quote, plus the ASCII one
const QUOTES = ["'", '\u2018', '\u2019', '\u201A', '\u201B'];

test('the PowerShell script is constant and the path travels in the environment', () => {
  const p = `C:\\media\\Holiday\u2019);Start-Process calc;(\u2019.mp4`;
  const c = recycleCommandWindows(p);
  assert.strictEqual(c.command, 'powershell');
  assert.deepStrictEqual(c.args, ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_PS_SCRIPT]);
  assert.strictEqual(c.options.env.VAULT_RECYCLE_PATH, p);
  for (const arg of c.args) assert.ok(!arg.includes('Holiday'), 'the path is not in any argument');
  // Same script for every path
  assert.strictEqual(recycleCommandWindows('D:\\x.mp4').args[3], RECYCLE_PS_SCRIPT);
  assert.match(RECYCLE_PS_SCRIPT, /\$env:VAULT_RECYCLE_PATH/);
  // The rest of the environment is kept (PATH, SystemRoot and so on)
  assert.strictEqual(c.options.env.PATH ?? c.options.env.Path, process.env.PATH ?? process.env.Path);
});

test('a file name with typographic quotes does not run code (Windows only)',
  { skip: process.platform !== 'win32' && 'PowerShell recycle path is Windows only' },
  () => {
    // An injection that would create pwned.txt in the working folder if the
    // name were parsed as script. No colon in it, so DeleteFile reports the
    // file as missing rather than a bad path format.
    for (const q of QUOTES) {
      const work = fs.mkdtempSync(path.join(tmp, 'run-'));
      const evil = path.join(work, `missing${q});New-Item -ItemType File -Path pwned.txt;(${q}.mp4`);
      const c = recycleCommandWindows(evil);
      const r = spawnSync(c.command, c.args, { ...c.options, cwd: work });
      assert.notStrictEqual(r.status, 0, `missing file is reported as a failure (${JSON.stringify(q)})`);
      assert.match(r.stderr || '', /Could not find file/i, `DeleteFile saw the whole name as a path (${JSON.stringify(q)})`);
      assert.ok(!fs.existsSync(path.join(work, 'pwned.txt')), `no code ran (${JSON.stringify(q)})`);
    }
  });
