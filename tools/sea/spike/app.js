/**
 * SEA feasibility spike — runs INSIDE the packaged exe. All-sync, no open
 * handles, hard process.exit at the end so it can never hang the build.
 * Output format matches build.js's parser: "PASS:|FAIL:|SOFT-FAIL: <label> — detail".
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const t0 = Date.now();
let hardFails = 0;
const pass = (label, detail) => console.log(`PASS: ${label} — ${detail}`);
const fail = (label, detail) => { hardFails++; console.log(`FAIL: ${label} — ${detail}`); };
const soft = (label, detail) => console.log(`SOFT-FAIL: ${label} — ${detail}`);

/* ── 1. SEA runtime facts ────────────────────────────────────────────────── */
let sea = null, isSea = false;
try { sea = require('node:sea'); isSea = sea.isSea(); } catch {}
console.log(`FACT isSea=${isSea}`);
console.log(`FACT execPath=${process.execPath}`);
console.log(`FACT __dirname=${__dirname}`);
console.log(`FACT __filename=${__filename}`);
console.log(`FACT cwd=${process.cwd()}`);
console.log(`FACT node=${process.version}`);
(isSea ? pass : fail)('SEA runtime facts', `isSea=${isSea} __dirname=${__dirname}`);

const exeDir = path.dirname(process.execPath);

/* ── 2. SEA embedded asset ───────────────────────────────────────────────── */
try {
  const txt = sea.getAsset('asset.txt', 'utf8');
  (txt.includes('spike-asset-ok') ? pass : fail)('SEA asset read', `"${txt.trim()}"`);
} catch (e) {
  fail('SEA asset read', e.message);
}

/* ── 3+4. Native sqlite via sidecar runtime dir ──────────────────────────── */
const runtimeReq = createRequire(path.join(exeDir, 'runtime', 'index.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sea-spike-'));

try {
  const Database = runtimeReq('better-sqlite3');
  const db = new Database(path.join(tmp, 'plain.db'));
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello-sea');
  const row = db.prepare('SELECT v FROM t WHERE id = 1').get();
  db.close();
  (row.v === 'hello-sea' ? pass : fail)('better-sqlite3 CRUD', `roundtrip="${row.v}"`);
} catch (e) {
  fail('better-sqlite3 CRUD', e.message.slice(0, 120));
}

try {
  const DatabaseMC = runtimeReq('better-sqlite3-multiple-ciphers');
  const encPath = path.join(tmp, 'enc.db');
  let db = new DatabaseMC(encPath);
  db.pragma("key='spikepass'");
  db.exec('CREATE TABLE s (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO s (v) VALUES (?)').run('secret-roundtrip');
  db.close();

  db = new DatabaseMC(encPath);
  db.pragma("key='spikepass'");
  const row = db.prepare('SELECT v FROM s WHERE id = 1').get();
  db.close();

  let noKeyRejected = false;
  try {
    const db3 = new DatabaseMC(encPath);
    db3.prepare('SELECT v FROM s').get();          // no key → must throw
    db3.close();
  } catch { noKeyRejected = true; }

  (row.v === 'secret-roundtrip' && noKeyRejected ? pass : fail)(
    'multiple-ciphers encrypted roundtrip',
    `reopen-with-key="${row.v}" no-key-rejected=${noKeyRejected}`);
} catch (e) {
  fail('multiple-ciphers encrypted roundtrip', e.message.slice(0, 120));
}

/* ── 5. Child-process spawning ───────────────────────────────────────────── */
const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
(ff.status === 0 && /ffmpeg version/.test(ff.stdout || '') ? pass : fail)(
  'spawn ffmpeg', (ff.stdout || ff.stderr || 'no output').split('\n')[0].slice(0, 70));

const pyv = spawnSync('python', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
const pyc = spawnSync('python', ['-c', "print('py-inline-ok')"], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
(pyv.status === 0 && (pyc.stdout || '').includes('py-inline-ok') ? pass : fail)(
  'spawn python', `${(pyv.stdout || pyv.stderr || '').trim()} inline=${(pyc.stdout || '').trim()}`);

// Mirrors the whisper-sidecar pattern: write a .py at runtime, spawn it
const scriptPath = path.join(tmp, 'sidecar.py');
fs.writeFileSync(scriptPath, "print('py-file-ok')\n");
const pyf = spawnSync('python', [scriptPath], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
((pyf.stdout || '').includes('py-file-ok') ? pass : fail)(
  'spawn temp .py file', (pyf.stdout || pyf.stderr || '').trim());

/* ── fpcalc: optional (Music ID needs it, but PATH presence is per-machine) ── */
const fp = spawnSync('fpcalc', ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
if (!fp.error && fp.status === 0) pass('spawn fpcalc (optional)', (fp.stdout || '').trim().slice(0, 50));
else soft('spawn fpcalc (optional)', 'not on PATH — fine, Music ID prompts for it');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`SUMMARY hardFails=${hardFails} elapsedMs=${Date.now() - t0}`);
process.exit(hardFails === 0 ? 0 : 1);
