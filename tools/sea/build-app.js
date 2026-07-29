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
 *   diarize_service.py, opus_translate.py     python sidecars (spawned by
 *                            path.join(__dirname,…) which inside a SEA exe
 *                            resolves to the exe's own directory)
 *   README.txt, SETUP.md, LICENSE
 *
 * All app data (video_metadata.db, thumbnails/, trash/, models/, …) is created
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

/* 1 ── clean output */
step('clean dist/');
try {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(BUILD, { recursive: true });
} catch (e) { die('clean (is a previous Vault.exe still running?)', e); }

/* 2 ── bundle the whole app into one script */
step('esbuild bundle (video-tagger.js → bundle.js)');
try {
  const esbuild = require(path.join(NM, 'esbuild'));
  const r = esbuild.buildSync({
    absWorkingDir: REPO,
    entryPoints: ['video-tagger.js'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: path.join(BUILD, 'bundle.js'),
    // Loaded at runtime via createRequire from runtime/node_modules (native)
    external: ['better-sqlite3', 'better-sqlite3-multiple-ciphers'],
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
default browser at http://127.0.0.1:8765.

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
