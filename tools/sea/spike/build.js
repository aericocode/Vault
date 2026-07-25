'use strict';
// SEA spike build script.
// RUN FROM ANYWHERE via:  node tools/sea/spike/build.js
// (This script chdir-independent: all paths are derived from __dirname.)
//
// Reproduces the whole spike:
//   1. esbuild bundle app.js -> dist/bundle.js (better-sqlite3* external)
//   2. node --experimental-sea-config sea-config.json -> dist/sea-prep.blob
//   3. copy node.exe -> dist/vault-spike.exe
//   4. postject inject NODE_SEA_BLOB
//   5. assemble dist/runtime/node_modules/ sidecar
//   6. run the exe, capture stdout/stderr live, measure cold-start
//   7. print exe size
//   8. print PASS/FAIL summary

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SPIKE = __dirname;
const ROOT = path.resolve(SPIKE, '..', '..', '..'); // repo root
const DIST = path.join(SPIKE, 'dist');
const ROOT_NM = path.join(ROOT, 'node_modules');

const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function step(msg) { console.log('\n### ' + msg); }
function stepFail(name, err) {
  console.log('BUILD STEP FAILED: ' + name + ' — ' + (err && err.message ? err.message : String(err)));
}

// Recursive copy (Node 16.7+ has fs.cpSync).
function copyDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true, force: true });
}

fs.mkdirSync(DIST, { recursive: true });

// ---------------------------------------------------------------------------
// Step 1: esbuild bundle
// ---------------------------------------------------------------------------
step('Step 1: esbuild bundle');
try {
  const esbuild = require(path.join(ROOT_NM, 'esbuild'));
  esbuild.buildSync({
    absWorkingDir: SPIKE,          // anchor resolution to the spike dir (Windows-safe)
    entryPoints: ['app.js'],       // relative to absWorkingDir
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(DIST, 'bundle.js'),
    external: ['better-sqlite3', 'better-sqlite3-multiple-ciphers'],
    logLevel: 'info',
  });
  console.log('bundle.js written: ' + fs.existsSync(path.join(DIST, 'bundle.js')));
} catch (e) {
  stepFail('esbuild bundle', e);
}

// ---------------------------------------------------------------------------
// Step 2: SEA blob
// ---------------------------------------------------------------------------
step('Step 2: SEA blob (node --experimental-sea-config)');
try {
  execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], {
    cwd: SPIKE,          // paths in sea-config.json are relative to cwd
    stdio: 'inherit',
  });
  console.log('sea-prep.blob written: ' + fs.existsSync(path.join(DIST, 'sea-prep.blob')));
} catch (e) {
  stepFail('SEA blob', e);
}

// ---------------------------------------------------------------------------
// Step 3: copy node.exe -> vault-spike.exe
// ---------------------------------------------------------------------------
step('Step 3: copy node.exe -> vault-spike.exe');
const EXE = path.join(DIST, 'vault-spike.exe');
try {
  // If a previous exe exists it may be locked; try to remove first.
  if (fs.existsSync(EXE)) {
    try { fs.rmSync(EXE, { force: true }); } catch (e) { console.log('warn: could not remove old exe: ' + e.message); }
  }
  fs.copyFileSync(process.execPath, EXE);
  console.log('copied ' + process.execPath + ' -> ' + EXE);
} catch (e) {
  stepFail('copy node.exe', e);
}

// ---------------------------------------------------------------------------
// Step 4: postject inject
// ---------------------------------------------------------------------------
step('Step 4: postject inject NODE_SEA_BLOB');
try {
  const postjectBin = path.join(ROOT_NM, '.bin', process.platform === 'win32' ? 'postject.cmd' : 'postject');
  const args = [
    EXE,
    'NODE_SEA_BLOB',
    path.join(DIST, 'sea-prep.blob'),
    '--sentinel-fuse', SENTINEL,
    '--overwrite',
  ];
  console.log('running: ' + postjectBin + ' ' + args.join(' '));
  execFileSync(postjectBin, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  console.log('postject injection completed');
} catch (e) {
  stepFail('postject inject', e);
}

// ---------------------------------------------------------------------------
// Step 5: assemble sidecar runtime/node_modules
// ---------------------------------------------------------------------------
step('Step 5: assemble runtime/node_modules sidecar');
const RUNTIME_NM = path.join(DIST, 'runtime', 'node_modules');
// These 4 are the full dependency closure resolved flat from repo root:
//   better-sqlite3, better-sqlite3-multiple-ciphers  -> the native addons
//   bindings, file-uri-to-path                       -> runtime deps of both,
//                                                       hoisted to root (no nested nm)
const SIDECAR_PKGS = ['better-sqlite3', 'better-sqlite3-multiple-ciphers', 'bindings', 'file-uri-to-path'];
try {
  fs.mkdirSync(RUNTIME_NM, { recursive: true });
  for (const pkg of SIDECAR_PKGS) {
    const src = path.join(ROOT_NM, pkg);
    const dst = path.join(RUNTIME_NM, pkg);
    copyDir(src, dst);
    const nodeFile = path.join(dst, 'build', 'Release', 'better_sqlite3.node');
    console.log('copied ' + pkg + (fs.existsSync(nodeFile) ? ' (has .node)' : ''));
  }
} catch (e) {
  stepFail('assemble sidecar', e);
}

// ---------------------------------------------------------------------------
// Step 6: run the exe, capture output live, measure cold start
// ---------------------------------------------------------------------------
step('Step 6: run vault-spike.exe (live output)');
let capturedStdout = '';
let coldStartMs = null;
let exeExitCode = null;

function runExe() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let child;
    try {
      child = spawn(EXE, [], { cwd: DIST });
    } catch (e) {
      stepFail('run exe (spawn)', e);
      return resolve();
    }
    // Hard timeout: a hung exe must never wedge the build (60s is generous —
    // the whole test suite is sync and finishes in a few seconds).
    const killer = setTimeout(() => {
      stepFail('run exe', new Error('TIMEOUT after 60s — killed'));
      try { child.kill('SIGKILL'); } catch {}
    }, 60000);
    child.on('close', () => clearTimeout(killer));
    child.stdout.on('data', (d) => {
      if (coldStartMs === null) {
        coldStartMs = Number(process.hrtime.bigint() - t0) / 1e6;
      }
      const s = d.toString();
      capturedStdout += s;
      process.stdout.write(s);
    });
    child.stderr.on('data', (d) => process.stderr.write(d.toString()));
    child.on('error', (e) => { stepFail('run exe (error event)', e); resolve(); });
    child.on('close', (code) => { exeExitCode = code; resolve(); });
  });
}

// ---------------------------------------------------------------------------
// main async flow (7 + 8)
// ---------------------------------------------------------------------------
(async () => {
  if (fs.existsSync(EXE)) {
    await runExe();
  } else {
    stepFail('run exe', new Error('exe not found at ' + EXE));
  }

  step('Step 7: exe size');
  try {
    const bytes = fs.statSync(EXE).size;
    console.log('Exe size: ' + (bytes / (1024 * 1024)).toFixed(1) + ' MB (' + bytes + ' bytes)');
  } catch (e) {
    stepFail('exe size', e);
  }

  step('Cold start');
  console.log('Cold start: ' + (coldStartMs === null ? 'N/A (no stdout)' : coldStartMs.toFixed(0) + 'ms'));
  console.log('Exe exit code: ' + exeExitCode);

  // ---------------------------------------------------------------------------
  // Step 8: final PASS/FAIL summary parsed from exe stdout
  // ---------------------------------------------------------------------------
  step('Step 8: FINAL SUMMARY (parsed from exe output)');
  const cats = [
    { key: '1. SEA runtime facts', match: /SEA runtime facts/ },
    { key: '2. SEA asset read', match: /SEA asset read/ },
    { key: '3. better-sqlite3 CRUD', match: /better-sqlite3 CRUD/ },
    { key: '4. bs3-multiple-ciphers encrypted', match: /multiple-ciphers encrypted roundtrip/ },
    { key: '5a. spawn ffmpeg', match: /spawn ffmpeg/ },
    { key: '5b. spawn python --version/-c', match: /spawn python/ },
    { key: '5c. spawn temp .py file', match: /spawn temp \.py file/ },
  ];
  const lines = capturedStdout.split(/\r?\n/);
  for (const c of cats) {
    const line = lines.find((l) => (l.startsWith('PASS:') || l.startsWith('FAIL:') || l.startsWith('SOFT-FAIL:')) && c.match.test(l));
    let verdict = 'MISSING';
    if (line) verdict = line.split(':')[0];
    console.log(verdict.padEnd(9) + ' | ' + c.key);
  }
  console.log('\nOverall exe exit code: ' + exeExitCode + (exeExitCode === 0 ? ' (all HARD tests passed)' : ' (a HARD test failed)'));
})();
