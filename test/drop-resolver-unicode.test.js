'use strict';
// The drop resolver (server/index.js RESOLVER_PS1) hands back the paths a
// file manager has selected. PowerShell 5.1 writes stdout in the console
// code page, so a name with emoji ("⛓️ Vertical PMV 🩶.mp4") came back as
// '?' and the drop matched nothing; Directory Opus's XML was also read as
// ANSI. These run the script's own output and XML lines through the real
// powershell.exe (Windows only).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
// eslint-disable-next-line no-eval
const PS1 = eval(SRC.match(/const RESOLVER_PS1 = (`[\s\S]*?`);/)[1]);
const NAME = '\u26d3\ufe0f Vertical PMV \ud83e\ude76.mp4';
const skip = process.platform !== 'win32' && 'Windows only';

function runPs(script) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'],
    { input: script, windowsHide: true, timeout: 30000 });
  return r.stdout.toString('utf8');
}

// A PowerShell string literal holding s, built from char codes so the
// script itself stays ASCII whatever code page reads it.
const psString = (s) => `(-join @(${Array.from({ length: s.length }, (_, i) => `[char]${s.charCodeAt(i)}`).join(',')}))`;

test('the output line escapes non-ASCII, so emoji names survive the console code page', { skip }, () => {
  const tail = PS1.slice(PS1.indexOf('$json = '));
  assert.ok(tail.startsWith('$json = '), 'output line found');
  const p = 'D:\\vids\\' + NAME;
  const out = runPs(`$sources = @(,@(${psString(p)}))\n${tail}`);
  assert.match(out.trim(), /^[\x00-\x7f]+$/, 'stdout is plain ASCII');
  assert.deepStrictEqual(JSON.parse(out), [[p]]);
});

test('an empty selection is still []', { skip }, () => {
  const tail = PS1.slice(PS1.indexOf('$json = '));
  assert.deepStrictEqual(JSON.parse(runPs(`$sources = @()\n${tail}`)), []);
});

test('Directory Opus XML is read as UTF-8', { skip }, () => {
  assert.ok(PS1.includes('$x.Load($tmp)'), 'loads the XML by its declaration');
  assert.ok(!/Get-Content \$tmp/.test(PS1), 'never reads it as ANSI text');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-drop-xml-'));
  try {
    const p = 'D:\\vids\\' + NAME;
    const xmlPath = path.join(dir, 'listers.xml');
    fs.writeFileSync(xmlPath, `<?xml version="1.0" encoding="UTF-8"?>\n<results><items><item sel="1" path="${p}"/><item sel="0" path="D:\\other.mp4"/></items></results>`);
    const load = PS1.slice(PS1.indexOf('    $x = New-Object xml'), PS1.indexOf('  } catch {}'));
    const tail = PS1.slice(PS1.indexOf('$json = '));
    const out = runPs(`$sources = @()\n$tmp = '${xmlPath}'\n${load}\n${tail}`);
    assert.deepStrictEqual(JSON.parse(out), [[p]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
