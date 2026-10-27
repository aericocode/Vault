'use strict';
/**
 * Vault — production exe build (Node SEA). One command, repeatable:
 *
 *   npm run build:exe        (→ node tools/sea/build-app.js)
 *
 * Produces dist/Vault/ — a self-contained PORTABLE folder:
 *   Vault.exe                server + CLI, all JS bundled inside the binary,
 *                            PLUS the client assets (css/ player-lib/ images/
 *                            db-viewer.html) minified and embedded as SEA
 *                            assets — served from memory, nothing readable
 *                            ships on disk (server/index.js embedded layer)
 *   runtime/node_modules/    the native SQLite addons (can't live in the blob)
 *                            and onnxruntime-node (face search), trimmed to
 *                            this platform's CPU runtime (see ONNX_FILES)
 *   diarize_service.py, opus_translate.py     python sidecars (spawned by
 *                            path.join(__dirname,…) which inside a SEA exe
 *                            resolves to the exe's own directory)
 *   README.txt, SETUP.md, LICENSE
 *
 * All app data (vault.db, thumbnails/, trash/, models/, …) is created
 * NEXT TO THE EXE on first run (lib/approot.js anchors every path there when
 * sea.isSea()), so the folder can be cut-pasted anywhere.
 *
 * Prereqs: repo node_modules installed (esbuild, postject are devDeps).
 * The exe is UNSIGNED (Phase 5 skipped) — postject's "signature seems
 * corrupted" warning is expected: injecting invalidates node.exe's original
 * Microsoft signature. SmartScreen may warn on other machines.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'dist', 'Vault');
const BUILD = path.join(REPO, 'dist', '.build');
const NM = path.join(REPO, 'node_modules');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// Native addons + their runtime deps (flat closure, verified by the Phase 0
// spike incl. an isolation test with repo node_modules hidden).
const RUNTIME_PKGS = ['better-sqlite3', 'better-sqlite3-multiple-ciphers', 'bindings', 'file-uri-to-path'];

// onnxruntime-node (face search, lib/faces/engine.js) ships 288 MB of binaries
// for every platform plus DirectML/DXC DLLs we never load (CPU provider only).
// Copy just what this platform's CPU runtime needs; the worker thread loads it
// from runtime/node_modules via createRequire like the SQLite addons.
const ORT_BIN = `bin/napi-v6/${process.platform}/${process.arch}`;
const ONNX_FILES = {
  'onnxruntime-node': ['package.json', 'dist', `${ORT_BIN}/onnxruntime_binding.node`,
    `${ORT_BIN}/${process.platform === 'win32' ? 'onnxruntime.dll' : process.platform === 'darwin' ? 'libonnxruntime.1.dylib' : 'libonnxruntime.so.1'}`],
  'onnxruntime-common': ['package.json', 'dist/cjs'],
};

// Client assets served to the browser — minified and EMBEDDED in the exe as
// SEA assets (served from memory by server/index.js); nothing ships loose.
const CLIENT_ASSETS = ['db-viewer.html', 'css', 'player-lib', 'images'];

// Python sidecars spawned from disk (see lib/subtitles/{diarizer,translator}.js).
const PY_SIDECARS = ['lib/subtitles/diarize_service.py', 'lib/subtitles/opus_translate.py'];

// Docs shipped loose in the folder so a zip user can read them without GitHub.
const DOCS = ['SETUP.md', 'LICENSE'];

const step = (m) => console.log('\n### ' + m);
const die = (m, e) => { console.error('BUILD FAILED: ' + m + (e ? ' — ' + (e.message || e) : '')); process.exit(1); };

const t0 = Date.now();

/* 0 ── native addon check (nodejs/node#65446) */
// Node 24.19.0+ HEADERS compile a RemoveEnvironmentCleanupHook call into every
// node::ObjectWrap destructor, but no 24.x runtime can serve it outside a JS
// context: the addon aborts with "Assertion failed: (env) != nullptr" whenever
// GC frees a better-sqlite3 Statement/Database. It follows the headers the addon
// was compiled against, not the runtime. v3.7.2 shipped like that (CI built with
// 24.20.0). A good build imports only AddEnvironmentCleanupHook. CI pins the
// headers via npm_config_target in release.yml; drop this check once a 24.x
// release carries the fix. Runs first so a bad addon never touches dist/.
step('native addon check (nodejs/node#65446)');
for (const pkg of ['better-sqlite3', 'better-sqlite3-multiple-ciphers']) {
  let bin;
  try { bin = fs.readFileSync(path.join(NM, pkg, 'build', 'Release', 'better_sqlite3.node')); }
  catch (e) { die(pkg + ' native addon missing (npm ci first)', e); }
  let headers = 'unknown';   // prebuilt downloads carry no config.gypi
  try {
    const gypi = fs.readFileSync(path.join(NM, pkg, 'build', 'config.gypi'), 'utf8');
    headers = (gypi.match(/"nodedir":\s*"[^"]*?(\d+\.\d+\.\d+)"/) || [])[1] || headers;
  } catch { /* keep 'unknown' */ }
  if (bin.includes('RemoveEnvironmentCleanupHook')) {
    die(pkg + ' was compiled against Node ' + headers + ' headers and would crash on garbage ' +
      'collection (nodejs/node#65446). Rebuild it against 24.18.1 headers: ' +
      'set npm_config_target=24.18.1 and npm_config_disturl=https://nodejs.org/dist, ' +
      'then npm rebuild better-sqlite3 better-sqlite3-multiple-ciphers');
  }
  console.log('  ' + pkg + ': ok (Node ' + headers + ' headers)');
}
{
  // onnxruntime-node is N-API (no ObjectWrap from node.h), so it should never
  // import the hook; checked anyway because the crash would be the same.
  const ort = path.join(NM, 'onnxruntime-node', 'bin', 'napi-v6', process.platform, process.arch, 'onnxruntime_binding.node');
  let bin;
  try { bin = fs.readFileSync(ort); } catch (e) { die('onnxruntime-node native addon missing (npm ci first)', e); }
  if (bin.includes('RemoveEnvironmentCleanupHook')) {
    die('onnxruntime_binding.node imports RemoveEnvironmentCleanupHook (nodejs/node#65446): pick an onnxruntime-node build made against <= 24.18.1 headers');
  }
  console.log('  onnxruntime-node: ok (N-API, no RemoveEnvironmentCleanupHook)');
}

/* 1 ── clean output */
step('clean dist/');
try {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(BUILD, { recursive: true });
} catch (e) { die('clean (is a previous Vault.exe still running?)', e); }

/* 2 ── bundle the whole app into one script */
step('esbuild bundle (vault.js → bundle.js)');
try {
  const esbuild = require(path.join(NM, 'esbuild'));
  const r = esbuild.buildSync({
    absWorkingDir: REPO,
    entryPoints: ['vault.js'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: path.join(BUILD, 'bundle.js'),
    // Loaded at runtime via createRequire from runtime/node_modules (native)
    external: ['better-sqlite3', 'better-sqlite3-multiple-ciphers', 'onnxruntime-node', 'onnxruntime-common'],
    // minify obscures the embedded server code further + shrinks the blob.
    // Trade-off: customer stack traces are unreadable — acceptable for now.
    minify: true,
    sourcemap: false,
    logLevel: 'warning',
  });
  if (r.errors && r.errors.length) die('esbuild reported errors');
  const kb = (fs.statSync(path.join(BUILD, 'bundle.js')).size / 1024).toFixed(0);
  console.log(`bundle.js: ${kb} KB`);
} catch (e) { die('esbuild', e); }

/* 3 ── minify client assets → SEA asset map */
// JS: whitespace+syntax only — player-lib is load-order globals across files
// (state.js declares, cards.js reads, …), so identifier renaming would sever
// the cross-file references. CSS minifies fully. HTML just loses comments.
step('minify client assets (embedded, served from memory)');
const seaAssets = {};   // key ('css/tiles.css') → path relative to BUILD
try {
  const esbuild = require(path.join(NM, 'esbuild'));
  let files = 0, before = 0, after = 0;

  const addAsset = (rel, buf) => {
    const dst = path.join(BUILD, 'assets', rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
    seaAssets[rel.replace(/\\/g, '/')] = path.join('assets', rel);
    files++; after += buf.length;
  };

  const minifyOne = (rel, abs) => {
    const ext = path.extname(abs).toLowerCase();
    const raw = fs.readFileSync(abs);
    before += raw.length;
    if (ext === '.js') {
      const r = esbuild.transformSync(raw.toString('utf8'), {
        loader: 'js', target: 'es2022',
        minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false,
      });
      addAsset(rel, Buffer.from(r.code));
    } else if (ext === '.css') {
      const r = esbuild.transformSync(raw.toString('utf8'), { loader: 'css', minify: true });
      addAsset(rel, Buffer.from(r.code));
    } else if (ext === '.html') {
      addAsset(rel, Buffer.from(raw.toString('utf8').replace(/<!--[\s\S]*?-->/g, '')));
    } else {
      addAsset(rel, raw);   // svg/png/… verbatim
    }
  };

  const walk = (rel) => {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) { console.log('  (skip, missing: ' + rel + ')'); return; }
    if (fs.statSync(abs).isDirectory()) {
      for (const f of fs.readdirSync(abs)) walk(path.join(rel, f));
    } else {
      minifyOne(rel, abs);
    }
  };
  for (const a of CLIENT_ASSETS) walk(a);
  console.log(`${files} assets: ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB`);
} catch (e) { die('minify client assets', e); }

/* 3b ── worker threads that load their own file, bundled on their own */
// new Worker(path) needs a file on disk, and the exe has none: each worker is
// bundled by itself and embedded as an asset; its pool starts it from that
// source with eval: true (lib/flow/pool.js). Keys are not under css/,
// player-lib/ or images/, so the asset route never serves them.
step('bundle worker threads (embedded)');
try {
  const esbuild = require(path.join(NM, 'esbuild'));
  for (const [key, entry] of [['flow-worker.js', 'lib/flow/worker.js']]) {
    const out = path.join(BUILD, 'workers', key);
    const r = esbuild.buildSync({
      absWorkingDir: REPO,
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      outfile: out,
      external: ['better-sqlite3', 'better-sqlite3-multiple-ciphers', 'onnxruntime-node', 'onnxruntime-common'],
      minify: true,
      sourcemap: false,
      logLevel: 'warning',
    });
    if (r.errors && r.errors.length) die('esbuild reported errors for ' + entry);
    seaAssets[key] = path.join('workers', key);
    console.log(`${key}: ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  }
} catch (e) { die('bundle worker threads', e); }

/* 4 ── SEA blob (bundle + embedded assets) */
step('SEA blob');
try {
  fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify({
    main: 'bundle.js',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    assets: seaAssets,
  }, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: BUILD, stdio: 'inherit' });
} catch (e) { die('sea blob', e); }

/* 5 ── copy node.exe + inject */
step('assemble Vault.exe (copy node + postject inject)');
const EXE = path.join(OUT, 'Vault.exe');
try {
  fs.copyFileSync(process.execPath, EXE);
  const postject = path.join(NM, '.bin', process.platform === 'win32' ? 'postject.cmd' : 'postject');
  execFileSync(postject, [EXE, 'NODE_SEA_BLOB', path.join(BUILD, 'sea-prep.blob'),
    '--sentinel-fuse', SENTINEL, '--overwrite'],
    { stdio: 'inherit', shell: process.platform === 'win32' });
} catch (e) { die('inject', e); }

/* 6 ── runtime native sidecar */
step('runtime/node_modules (native SQLite)');
try {
  for (const pkg of RUNTIME_PKGS) {
    fs.cpSync(path.join(NM, pkg), path.join(OUT, 'runtime', 'node_modules', pkg), { recursive: true });
  }
  console.log('copied: ' + RUNTIME_PKGS.join(', '));
  let bytes = 0;
  for (const [pkg, files] of Object.entries(ONNX_FILES)) {
    for (const rel of files) {
      const src = path.join(NM, pkg, rel);
      const dst = path.join(OUT, 'runtime', 'node_modules', pkg, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true, filter: (f) => !/\.(map|d\.ts)$/.test(f) });
    }
  }
  const du = (d) => fs.readdirSync(d, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? du(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
  for (const pkg of Object.keys(ONNX_FILES)) bytes += du(path.join(OUT, 'runtime', 'node_modules', pkg));
  console.log('copied (trimmed): ' + Object.keys(ONNX_FILES).join(', ') + ' = ' + (bytes / 1048576).toFixed(1) + ' MB');
} catch (e) { die('runtime sidecar', e); }

/* 7 ── python sidecars (client assets are embedded — nothing loose to copy) */
step('python sidecars');
try {
  for (const p of PY_SIDECARS) {
    fs.copyFileSync(path.join(REPO, p), path.join(OUT, path.basename(p)));
    console.log('  ' + p + ' → ' + path.basename(p));
  }
} catch (e) { die('sidecars', e); }

/* 8 ── docs + license (readable next to the exe) */
step('docs (SETUP.md, LICENSE)');
try {
  for (const d of DOCS) {
    fs.copyFileSync(path.join(REPO, d), path.join(OUT, d));
    console.log('  ' + d);
  }
} catch (e) { die('docs', e); }

/* 9 ── README */
step('README.txt');
const version = require(path.join(REPO, 'package.json')).version;
fs.writeFileSync(path.join(OUT, 'README.txt'), `Vault v${version} — portable build
================================${'='.repeat(String(version).length)}

Double-click Vault.exe to start. A console window opens (that's the server —
closing it stops Vault and locks the library), and the viewer opens in your
default browser at http://127.0.0.1:8765, or whatever port you set in Settings.

Everything Vault creates (library database, thumbnails, trash, models, …)
lives HERE, next to Vault.exe. Move or copy this whole folder anywhere —
nothing is installed elsewhere on the system.

On first launch Vault offers to set a password. It's optional and it
encrypts the library database — there is NO recovery if you lose it.

Optional flags:  Vault.exe --no-gamify  turn the Obsession tracker off
                                        entirely (it is on by default)
                 Vault.exe --no-browser start the server without opening a tab
                 Vault.exe wizard       interactive scan setup
                 Vault.exe status       library stats in the console

External tools:
  - ffmpeg / ffprobe        — thumbnails, duration, beat bar, subtitles,
                              Music ID. When missing, the viewer shows a
                              ⬇ Download banner: one click puts them next to
                              Vault.exe, no restart. A PATH install works too
  - fpcalc (Chromaprint)    — Music ID fingerprinting. Same ⬇ banner
  - LM Studio (or Ollama)   — AI scanning & semantic search. Separate install
  - python + faster-whisper — transcription & subtitles. Separate install

Full guide, model recommendations and every setting: SETUP.md (in this folder).

This build is unsigned; Windows SmartScreen may warn on first run
("More info" → "Run anyway").
`);

/* 10 ── summary */
step('done');
const size = (fs.statSync(EXE).size / (1024 * 1024)).toFixed(1);
console.log(`dist/Vault/Vault.exe — ${size} MB, built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('Run it:  dist\\Vault\\Vault.exe   (test OUTSIDE the repo tree for true isolation)');
