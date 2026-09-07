/**
 * Media Tagger Viewer Server
 *
 * Local-only Express server that serves the viewer UI, the media library
 * API, media files (with HTTP Range support for seeking), and thumbnails.
 *
 * This replaces the old client-side model where db-viewer.html loaded the
 * .db via sql.js/WASM and saved edits back through the File System Access
 * API (Chrome-only). The viewer now works in any browser and media plays
 * over HTTP instead of fragile file:/// URLs.
 *
 * SECURITY: binds to 127.0.0.1 only. This process reads arbitrary paths
 * recorded in the DB and (in a later phase) moves files — never expose it
 * beyond localhost.
 */

// Load .env over config defaults — MUST precede the config require below (and
// runs when the viewer is started directly via `node server/index.js`).
require('../lib/load-env')();

const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('../config');
const db = require('../lib/database');
const thumbnails = require('../lib/thumbnails');
const trash = require('../lib/trash');
const embeddings = require('../lib/embeddings');
const vault = require('../lib/vault');
const secureAssets = require('../lib/secure-assets');
const importQueue = require('../lib/import-queue');
const appSettings = require('../lib/app-settings');
const ownedDir = require('../lib/owned-dir');
const { netFetch } = require('../lib/net');
const pkg = require('../package.json');

const { ROOT } = require('../lib/approot');

const app = express();

// ── CSRF guard (audit finding D) ────────────────────────────────────────────
// The server binds 127.0.0.1 with no CORS config. JSON-body routes are already
// CSRF-resistant (a cross-origin JSON POST forces a preflight the server never
// answers), but a body-less POST like /api/trash/empty is a CORS "simple
// request" a malicious page can auto-submit via a <form>. Reject any non-safe
// method whose Origin header names a DIFFERENT origin than our own. Requests
// with NO Origin header (curl, native tools, same-origin GET-triggered nav)
// pass through — every modern browser attaches Origin to cross-origin writes
// (including form submissions), so this blocks the browser-initiated attack
// without needing any frontend change. `Origin: null` (file:// pages, sandboxed
// iframes, some redirects) is treated as cross-origin and REJECTED.
const _SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
function _allowedOrigins() {
  const port = config.server.port;
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}
app.use((req, res, next) => {
  if (_SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (origin === undefined) return next();            // no Origin → not a browser cross-site write
  if (_allowedOrigins().has(origin)) return next();   // same-origin
  console.warn(`[csrf] rejected ${req.method} ${req.path} — cross-origin Origin: ${origin}`);
  return res.status(403).json({ error: 'cross-origin request forbidden', code: 'CSRF_ORIGIN' });
});

app.use(express.json({ limit: '2mb' }));

// ── Vault lock (routes stay reachable while locked; everything below gates) ──

app.get('/api/vault/status', (req, res) => res.json(vault.status()));

// Create (or change) the vault password — encrypts the DB in place
app.post('/api/vault/setpass', async (req, res) => {
  try {
    res.json(await vault.setPassword(String(req.body?.pass ?? '')));
  } catch (err) {
    res.status(err.code === 'VAULT_SCAN_ACTIVE' ? 409 : 400).json({ error: err.message, code: err.code });
  }
});

// Change an existing passphrase (re-confirm current, then rekey). A wrong
// current password 401s; enough wrong tries force-lock the vault (the client
// then flips to the lock screen off the 423 / locked flag). The lockout
// threshold is deliberately not surfaced to the client.
app.post('/api/vault/changepass', async (req, res) => {
  try {
    res.json(await vault.changePassword(String(req.body?.current ?? ''), String(req.body?.next ?? '')));
  } catch (err) {
    if (err.code === 'VAULT_LOCKED_OUT') {
      return res.status(423).json({ error: err.message, code: err.code, locked: true });
    }
    const status = err.code === 'VAULT_WRONG_CURRENT' ? 401
      : err.code === 'VAULT_SCAN_ACTIVE' ? 409
      : err.code === 'VAULT_LOCKED' ? 423
      : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// Lock: 409 + {code:'VAULT_SCAN_ACTIVE'} when a scan runs and force isn't set,
// so the client can show the "click again to interrupt" warning state
app.post('/api/vault/lock', async (req, res) => {
  try {
    res.json(await vault.lock({ force: !!req.body?.force }));
  } catch (err) {
    res.status(err.code === 'VAULT_SCAN_ACTIVE' ? 409 : 400).json({ error: err.message, code: err.code });
  }
});

app.post('/api/vault/unlock', (req, res) => {
  try {
    res.json(vault.unlock(String(req.body?.pass ?? '')));
  } catch (err) {
    res.status(err.code === 'VAULT_WRONG_PASS' ? 401 : 500).json({ error: err.message, code: err.code });
  }
});

// Client-side user activity (throttled) — feeds the autolock idle clock
app.post('/api/vault/touch', (req, res) => { vault.touch(); res.json({ ok: true }); });

// Gate: while locked, every data endpoint answers 423 (the client swaps to the
// lock screen). Static assets and the vault routes above stay reachable so the
// lock screen itself can render.
app.use((req, res, next) => {
  const dataPath = req.path.startsWith('/api/') || req.path.startsWith('/media/')
    || req.path.startsWith('/thumb/') || req.path.startsWith('/frame/')
    || req.path.startsWith('/stream/');
  if (!dataPath) return next();
  if (vault.isLocked()) return res.status(423).json({ error: 'vault is locked', code: 'VAULT_LOCKED' });
  vault.touch();
  next();
});

/* ── Gate: no scanning or importing while a migrate job is running ─────────
   The other half of the mutual exclusion. /api/migrate/* already refuses to
   start while a scan is in flight; this refuses the reverse.

   It was not needed while the planners were synchronous — they seized the
   event loop, so no request could be served mid-migrate. Making them yield
   (so the UI stays alive) opened a real window, and the consequence is nasty:
   the scan pipeline writes rows via saveMedia, which UPSERTs on the filepath
   captured when the file was ENQUEUED. Repoint that row mid-scan and the
   UPSERT no longer matches it — it INSERTS a ghost row at the dead path
   carrying the fresh AI metadata, while the real row keeps the stale copy.

   So every route that queues scan work or creates rows by path is closed for
   the duration. Read-only routes stay open: the point is to keep the viewer
   usable during a long migrate, not to take it offline. */
const MIGRATE_BLOCKED_ROUTES = [
  /^\/api\/media\/batch-rescan$/,
  /^\/api\/media\/retry-errors$/,
  /^\/api\/media\/\d+\/rescan$/,
  /^\/api\/import\/add-paths$/,
  /^\/api\/import\/scan-folder$/,
  // PMV render → importToLibrary → insertStubs (lib/pmv/service.js)
  /^\/api\/pmv\/jobs\/[^/]+\/import$/,
  // A PAUSED queue with banked work reads as idle to _scanBusy — deliberately,
  // so pausing a scan is exactly how you make room to run a migrate. That only
  // holds if un-pausing is refused until the migrate is done.
  /^\/api\/import\/queue\/resume$/,
];

app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  if (!_migrateJob.isRunning()) return next();
  if (!MIGRATE_BLOCKED_ROUTES.some(re => re.test(req.path))) return next();
  res.status(409).json({
    error: 'a library migration is running. Wait for it to finish.',
    code: 'MIGRATE_RUNNING',
    jobId: _migrateJob.currentId(),
  });
});

/* ── Gamification: ON by default, with a hard CLI kill switch ──────────────
   It used to be opt-in on privacy grounds, but that reasoning didn't survive
   contact with the rest of the app: without a database password EVERYTHING is
   already readable — AI descriptions, notes, view counts, finishes. Singling
   out the score changed nothing except making a zero-setup feature invisible
   to everyone. The real fix was to ask for a password on first launch (see
   /api/settings/app passwordPromptSeen), which protects the whole library
   rather than one table of it.

   So the Settings toggle now HIDES the UI while tracking continues, and this
   flag is only for someone who wants the subsystem genuinely inert:
   `--no-gamify` persists {enabled:false}; `--gamify` clears the file, back to
   the default. An absent file means ON, which also makes the stray
   {enabled:true} that used to ship in the repo a harmless no-op. */
const GAMIFY_CONFIG_PATH = path.join(ROOT, 'gamify-config.json');

function resolveGamifyEnabled(args) {
  if (args.includes('--no-gamify')) {
    fs.writeFileSync(GAMIFY_CONFIG_PATH, JSON.stringify({ enabled: false }, null, 2));
    return false;
  }
  if (args.includes('--gamify')) {
    try { fs.unlinkSync(GAMIFY_CONFIG_PATH); } catch {}   // absent == default on
    return true;
  }
  try {
    return JSON.parse(fs.readFileSync(GAMIFY_CONFIG_PATH, 'utf8')).enabled !== false;
  } catch {
    return true;                                          // no file → on
  }
}

let gamifyEnabled = false;
let _gamifyRouter = null;

/**
 * Turn the tracker on/off at runtime and remember the choice.
 *
 * It used to be reachable only as a launch flag, which meant anyone who
 * double-clicks Vault.exe had no way to find it at all. The router is mounted
 * once, unconditionally, and gated on this flag (see below) — so flipping it
 * takes effect without a restart, while `require`ing the gamify modules still
 * only happens if the feature is actually used.
 */
function setGamifyEnabled(on) {
  gamifyEnabled = !!on;
  try {
    // Mirror resolveGamifyEnabled: the file only ever records an explicit OFF.
    if (gamifyEnabled) fs.unlinkSync(GAMIFY_CONFIG_PATH);
    else fs.writeFileSync(GAMIFY_CONFIG_PATH, JSON.stringify({ enabled: false }, null, 2));
  } catch { /* an absent file when enabling is exactly the desired state */ }
  if (gamifyEnabled) {
    // Same settle-on-boot the launch flag does, so the first UI read is current.
    try {
      require('../lib/gamify').settleDay();
      require('../lib/quests').ensureQuests();
    } catch (err) {
      console.warn(`[Gamify] enable failed: ${err.message}`);
    }
  }
  console.log(`[Gamify] ${gamifyEnabled ? 'enabled' : 'disabled'} from Settings`);
  return gamifyEnabled;
}

// Always answer status (the viewer probes this on load to decide whether to
// show any gamify UI at all); the real routes mount only when enabled.
app.get('/api/gamify/status', (req, res) => {
  if (!gamifyEnabled) return res.json({ enabled: false });
  const gamify = require('../lib/gamify');
  res.json({ enabled: true, stats: gamify.getPublicStats() });
});

// The tracker's real routes. Mounted ALWAYS but gated on the flag, so the
// Settings toggle works without a restart; the router (and everything it pulls
// in) is still only required the first time a request actually gets through.
app.use('/api/gamify', (req, res, next) => {
  if (!gamifyEnabled) return res.status(403).json({ error: 'gamification is off', code: 'GAMIFY_OFF' });
  if (!_gamifyRouter) _gamifyRouter = require('./gamify-routes').buildRouter();
  return _gamifyRouter(req, res, next);
});

/* ── Settings the SERVER owns ─────────────────────────────────────────────
   Everything else the Settings modal offers is browser-side (localStorage).
   These two aren't: the tracker decides which routes answer, and the autolock
   clock has to be correct from process start — before anyone opens the viewer.
   Both persist to disk so they survive a restart with no env vars set, which is
   the only situation a Vault.exe user is ever in. */

/* ── Per-model download consent ───────────────────────────────────────────
   allowModelDownload defaulted to TRUE, so the first Generate press started a
   ~1.5 GB HuggingFace pull and only announced it afterwards, in a console line
   an exe user never sees. That isn't consent.

   Nor is one blanket yes: approving Whisper today must not silently approve a
   Japanese translation pack next month. lib/model-consent.js keys the answer
   per artifact and the env var stays the hard ceiling over all of it. */

const modelConsent = require('../lib/model-consent');

/** Everything the UI needs: the env ceiling, what's approved, what's waiting. */
app.get('/api/settings/model-downloads', (req, res) => res.json(modelConsent.state()));

/** Approve or refuse ONE artifact — see lib/model-consent.js for why per-key. */
app.post('/api/settings/model-downloads', (req, res) => {
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  if (!key) return res.status(400).json({ error: 'key required' });
  if (typeof req.body?.allow !== 'boolean') {
    return res.status(400).json({ error: 'allow must be true or false' });
  }
  const r = modelConsent.grant(key, req.body.allow);
  if (!r.ok) {
    return res.status(409).json({
      error: 'Model downloads are disabled by SUB_ALLOW_DOWNLOADS=0 or VAULT_OFFLINE=1',
      code: r.code,
    });
  }
  console.log(`[Models] ${key} download ${r.allowed ? 'ALLOWED' : 'declined'} by the user`);
  res.json({ ...modelConsent.state(), ...r });
});

app.get('/api/settings/app', (req, res) => {
  res.json({
    gamify: gamifyEnabled,
    autolockMinutes: vault.getAutolockMinutes(),
    encrypted: vault.isEncrypted(),
    // Whether the first-launch "set a password" explainer has been answered.
    // Server-side, not localStorage: it's setup state, and a new browser
    // profile shouldn't re-nag someone who already decided.
    passwordPromptSeen: appSettings.all().passwordPromptSeen === true,
  });
});

app.post('/api/settings/app', (req, res) => {
  const body = req.body || {};
  const out = {};

  if ('gamify' in body) {
    if (typeof body.gamify !== 'boolean') {
      return res.status(400).json({ error: 'gamify must be true or false' });
    }
    out.gamify = setGamifyEnabled(body.gamify);
  }

  if ('autolockMinutes' in body) {
    const raw = body.autolockMinutes;
    const n = typeof raw === 'number' ? raw
      : (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN);
    if (!Number.isInteger(n) || n < 0 || n > 1440) {
      return res.status(400).json({ error: 'autolockMinutes must be an integer 0-1440 (0 = never)' });
    }
    out.autolockMinutes = vault.setAutolockMinutes(n);
    appSettings.set({ autolockMinutes: out.autolockMinutes });
  }

  if ('passwordPromptSeen' in body) {
    if (typeof body.passwordPromptSeen !== 'boolean') {
      return res.status(400).json({ error: 'passwordPromptSeen must be true or false' });
    }
    appSettings.set({ passwordPromptSeen: body.passwordPromptSeen });
    out.passwordPromptSeen = body.passwordPromptSeen;
  }

  if (Object.keys(out).length === 0) {
    return res.status(400).json({ error: 'nothing to change' });
  }
  res.json({ ...out, encrypted: vault.isEncrypted() });
});

/* ── Required external tools ──────────────────────────────────────────────
   ffmpeg/ffprobe are spawned by name from PATH and are deliberately NOT
   bundled in the portable build. The CLI scan has always refused to start
   without them (commands/scan.js), but the double-click path — which is how
   everyone running Vault.exe starts — never checked. A missing ffmpeg then
   surfaced as a per-file "Could not read media info", on every file, with
   nothing anywhere naming the actual cause.

   Probing costs child processes (isAvailable forks ffprobe; the fpcalc fallback
   forks too), so the answer is cached — but it must not be cached FOREVER. This
   cache predates lib/ffmpeg-locate.js and was justified by "the answer can't
   change while the process runs", which stopped being true the moment tools
   could also be resolved from ROOT: a binary dropped next to Vault is picked up
   by the very next spawn, PATH untouched. A permanent cache turned that into a
   lie the user could only escape by restarting — install ffmpeg out of band,
   reload the page, and the banner still insists it is missing, because the
   first probe of the process said so and nothing ever asked again.

   So: serve the cache only while everything in it is ok. If anything is still
   reported missing, re-probe. That is exactly the state in which the user is
   off installing something, and the only state in which the banner is on
   screen to be wrong; once every tool is ok the cache is served untouched and
   the healthy path costs nothing. (A PATH install is still invisible until a
   restart — a running process can never see a new PATH entry — which is why
   the winget row keeps its "then restart Vault".) */

const FFMPEG_INSTALL = {
  winget: 'winget install ffmpeg',
  url: 'https://www.gyan.dev/ffmpeg/builds/',
};

/* Everything the one-click downloader knows how to fetch. `entry` matches the
   binary inside the zip by suffix, so a version bump in the archive's top-level
   folder name doesn't break extraction; `files` are the fixed basenames WE
   write into ROOT — zip entry names are untrusted input, never joined into a
   path. `verify` must prove the extracted binary actually runs. */
const DOWNLOADABLE_TOOLS = {
  ffmpeg: {
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    sizeMB: 90,
    files: ['ffmpeg.exe', 'ffprobe.exe'],
    entry: (name) => (e) => e.entryName.toLowerCase().endsWith(`/bin/${name}`),
    verify: () => require('../lib/media-info').isAvailable(),
  },
  fpcalc: {
    url: 'https://github.com/acoustid/chromaprint/releases/download/v1.5.1/chromaprint-fpcalc-1.5.1-windows-x86_64.zip',
    sizeMB: 1,
    files: ['fpcalc.exe'],
    entry: (name) => (e) => e.entryName.toLowerCase().endsWith(`/${name}`),
    verify: async () => (await require('../lib/musicid/fingerprint').checkTools()).fpcalcVersion !== null,
  },
};

let _toolsCache = null;

function checkTools({ refresh = false } = {}) {
  // A cache with a missing tool in it is a cache that has to be re-earned.
  const allOk = !!_toolsCache && Object.values(_toolsCache).every((t) => t.ok);
  if (_toolsCache && !refresh && allOk) return _toolsCache;
  _toolsCache = {
    ffmpeg: {
      ok: require('../lib/media-info').isAvailable(),
      required: true,
      label: 'ffmpeg / ffprobe',
      needed: 'scanning, thumbnails and duration — imports can\'t be processed without it',
      install: FFMPEG_INSTALL,
      downloadable: true,
      sizeMB: DOWNLOADABLE_TOOLS.ffmpeg.sizeMB,
    },
    fpcalc: {
      // existsSync, not a spawn: this runs on every /api/setup-check and the
      // full probe forks two processes. The download path re-verifies properly.
      ok: fs.existsSync(path.join(ROOT, 'fpcalc.exe'))
        || (() => { try { require('child_process').execSync('fpcalc -version', { windowsHide: true, stdio: 'ignore' }); return true; } catch { return false; } })(),
      required: false,
      label: 'fpcalc (Chromaprint)',
      needed: 'Music ID — fingerprinting and song matching. Everything else works without it',
      install: { winget: null, url: 'https://acoustid.org/chromaprint' },
      downloadable: true,
      sizeMB: DOWNLOADABLE_TOOLS.fpcalc.sizeMB,
    },
  };
  return _toolsCache;
}

app.get('/api/setup-check', (req, res) => {
  res.json(checkTools({ refresh: req.query.refresh === '1' }));
});

/* ── One-click tool downloads (the Stash onboarding model) ────────────────
   Stash checks PATH, then beside its config, and offers to fetch missing
   tools there — so Windows users never open a terminal. Same here: the
   banner's button calls this, the zip lands in a temp file, the binaries are
   extracted next to Vault.exe (ROOT — where ffmpeg-locate looks), and every
   later spawn picks them up with NO restart, because file resolution —
   unlike PATH — is re-checked per spawn.

   User-initiated only, which matters twice over: it keeps the no-silent-egress
   posture (purpose 'tool' in lib/net.js, same consent shape as the manual
   update check), and it keeps GPL ffmpeg out of the release zip — the USER
   fetches it from gyan.dev; Vault never distributes it.

   One job per tool: two clicks share one download rather than racing to write
   the same exe. State survives until the next click, so the client can poll
   after the fact. */

const _toolJobs = new Map();  // tool -> { state: 'downloading'|'extracting'|'done'|'error', pct, error }

app.post('/api/setup/download/:tool', (req, res) => {
  const tool = DOWNLOADABLE_TOOLS[req.params.tool];    // registry lookup — no path from input
  if (!tool) return res.status(404).json({ error: 'unknown tool' });
  if (process.platform !== 'win32') {
    return res.status(400).json({ error: 'Automatic download is Windows-only — install it with your package manager.' });
  }
  const live = _toolJobs.get(req.params.tool);
  if (live && ['downloading', 'extracting'].includes(live.state)) {
    return res.json({ started: false, ...live });       // already in flight — attach
  }

  const job = { state: 'downloading', pct: 0, error: null };
  _toolJobs.set(req.params.tool, job);
  res.json({ started: true, ...job });

  (async () => {
    const os = require('os');
    const tmp = path.join(os.tmpdir(), `vault-${req.params.tool}-${process.pid}.zip`);
    try {
      const resp = await netFetch(tool.url, { purpose: 'tool' });
      if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`);

      // Stream to disk with progress — ffmpeg's zip is ~90 MB and adm-zip
      // needs a file anyway; buffering it whole in memory helps nobody.
      const total = Number(resp.headers.get('content-length')) || 0;
      let got = 0;
      const out = fs.createWriteStream(tmp);
      for await (const chunk of resp.body) {
        out.write(chunk);
        got += chunk.length;
        if (total) job.pct = Math.round((got / total) * 100);
      }
      await new Promise((ok, bad) => out.end(err => err ? bad(err) : ok()));

      job.state = 'extracting';
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(tmp);
      for (const name of tool.files) {
        const entry = zip.getEntries().find(e => !e.isDirectory && tool.entry(name)(e));
        if (!entry) throw new Error(`archive layout unexpected — ${name} not found`);
        fs.writeFileSync(path.join(ROOT, name), entry.getData());
      }

      // Prove the binary actually runs before declaring victory.
      require('../lib/ffmpeg-locate').invalidate();
      if (!(await tool.verify())) {
        throw new Error('extracted binary did not run — antivirus quarantine?');
      }
      checkTools({ refresh: true });
      // Files that failed only because this tool was missing are now fixable —
      // and the user is standing right here, having just clicked the button
      // that fixed them. Don't make them find the per-file rescan.
      require('../lib/self-heal').run({ reason: `${req.params.tool} download` })
        .catch(err => console.warn(`[Self-heal] skipped: ${err.message}`));
      Object.assign(job, { state: 'done', pct: 100, files: tool.files });
      console.log(`[Setup] ${req.params.tool} downloaded → ${tool.files.map(f => path.join(ROOT, f)).join(', ')}`);
    } catch (err) {
      Object.assign(job, { state: 'error', pct: 0, error: String(err.message).slice(0, 300) });
      console.warn(`[Setup] ${req.params.tool} download failed: ${job.error}`);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  })();
});

app.get('/api/setup/download/:tool', (req, res) => {
  res.json(_toolJobs.get(req.params.tool) || { state: 'idle' });
});

// App identity for the Settings → About section. The name is the PRODUCT name,
// deliberately not pkg.name — that is the npm package id (lowercase `vault`) and
// rendering it would put "vault" in the panel instead of "Vault". Version still
// tracks package.json so a release bump shows up here for free.
app.get('/api/about', (req, res) => {
  res.json({ name: 'Vault', version: pkg.version });
});

// Manual update check — MANUAL ONLY. This makes exactly ONE request to
// api.github.com, and only when the user clicks "Check for updates" in the
// About panel. Nothing here runs automatically or on a timer; there is no
// background update ping anywhere in the app. Always answers HTTP 200 JSON
// (errors go in the body) so the client never has to handle a thrown route.
function _parseRepoSlug(repo) {
  // package.json `repository` can be a string ('github:owner/repo', a full
  // https URL, optionally .git-suffixed) or an object { url }.
  let s = typeof repo === 'string' ? repo : (repo && repo.url) || '';
  s = s.replace(/^git\+/, '').replace(/\.git$/, '');
  let m = s.match(/^github:([^/]+)\/(.+)$/);
  if (m) return `${m[1]}/${m[2]}`;
  m = s.match(/github\.com[/:]([^/]+)\/(.+)$/);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

// Segment-wise numeric semver compare: is `latest` newer than `current`?
// Non-numeric segments never count as newer (avoids a garbage tag masquerading
// as an upgrade).
function _isNewer(latest, current) {
  const a = String(latest).split('.');
  const b = String(current).split('.');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = parseInt(a[i], 10), y = parseInt(b[i], 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

app.get('/api/update-check', async (req, res) => {
  const current = pkg.version;
  const slug = _parseRepoSlug(pkg.repository);
  if (!slug) return res.json({ current, error: 'repository not configured' });

  try {
    const resp = await netFetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      purpose: 'update',
      headers: { 'User-Agent': `${pkg.name}/${pkg.version}`, 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.status === 404) {
      return res.json({ current, error: 'No releases found - repository may not be published yet' });
    }
    if (!resp.ok) {
      return res.json({ current, error: `GitHub returned HTTP ${resp.status}` });
    }
    const data = await resp.json();
    const latest = String(data.tag_name || '').replace(/^v/, '');
    res.json({ current, latest, updateAvailable: _isNewer(latest, current), url: data.html_url });
  } catch (err) {
    // NET_OFF (VAULT_OFFLINE) or any network/timeout failure — surface the
    // reason to the client; never crash the route.
    res.json({ current, error: err.message, code: err.code });
  }
});

// ── Static viewer assets ───────────────────────────────────────────────────
// Packaged (SEA) builds embed the minified client assets INSIDE the exe
// (tools/sea/build-app.js) and serve them from memory here — no readable
// css/player-lib ships on disk. Dev serves the repo files below, same URLs;
// the disk mounts also act as the fallback for anything not embedded.
const seaAssets = (() => {
  try {
    const sea = require('node:sea');
    return sea.isSea() ? sea : null;
  } catch { return null; }   // plain node — no SEA module
})();

const ASSET_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

if (seaAssets) {
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    let p;
    try { p = decodeURIComponent(req.path); } catch { return next(); }
    // Exact-key lookup into the embedded map — no filesystem involved, so
    // traversal is inert; the guard just keeps junk requests off getAsset.
    const key = p === '/' ? 'db-viewer.html'
      : /^\/(css|player-lib|images)\//.test(p) && !p.includes('..') ? p.slice(1)
      : null;
    if (!key) return next();
    let data;
    try { data = seaAssets.getAsset(key); } catch { return next(); }
    res.set('Content-Type', ASSET_TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream');
    res.set('Cache-Control', 'no-cache');
    res.end(Buffer.from(data));
  });
}

// Serve only the UI directories, not the whole project root (avoids exposing
// the .db, logs, node_modules, etc. — even on localhost, keep it tidy).
app.use('/css', express.static(path.join(ROOT, 'css')));
app.use('/player-lib', express.static(path.join(ROOT, 'player-lib')));
app.use('/images', express.static(path.join(ROOT, 'images')));

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'db-viewer.html'));
});

// ── Library API ────────────────────────────────────────────────────────────

// Full library dump. The viewer keeps its rich client-side filter/search
// pipeline (fuse fuzzy, tri-filters, dupes, saved searches) and just sources
// the rows from here instead of parsing the .db in the browser.
app.get('/api/media', (req, res) => {
  res.json(db.getAll());
});

// Express 5 dropped regex params (:id(\d+)) — validate ids in-handler
function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

app.get('/api/media/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const row = db.getById(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// Batch row refetch — fresh values for a set of ids in one request. The
// importer polls this after add-paths until the background-probed durations
// land (hover-scrub gates on duration_seconds), instead of N per-id fetches.
app.post('/api/media/rows', (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.slice(0, 2000).map(parseId).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  res.json({ rows: ids.map((id) => db.getById(id)).filter(Boolean) });
});

// Update user-editable fields (star, rating, notes, delete-flag,
// playback-failed). Whitelisted in lib/database.js setUserFields.
app.post('/api/media/:id/flags', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });

  // Gamify quest hooks compare against the values BEFORE this write
  // (rate: previously-unrated only; fave: fresh 0→1; notes: list must GROW)
  const prevRow = gamifyEnabled ? db.getById(id) : null;

  const ok = db.setUserFields(id, req.body || {});
  if (!ok) return res.status(400).json({ error: 'no valid fields or row not found' });

  const row = db.getById(id);

  if (prevRow) {
    const quests = require('../lib/quests');
    if (typeof req.body?.user_rating === 'number' && row.user_rating > 0) {
      const prevRating = prevRow.user_rating || 0;
      quests.onRate(row, prevRating);
      // Telemetry for the ratings-trend line (only when the value changed)
      if (row.user_rating !== prevRating) {
        require('../lib/gamify').logEvent('rate', id, { rating: row.user_rating });
      }
    }
    if (req.body?.user_starred !== undefined && row.user_starred && !prevRow.user_starred) {
      quests.onFave();
    }
    if (typeof req.body?.user_notes === 'string') {
      const noteCount = (v) => {
        try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.length : 0; }
        catch { return 0; }
      };
      if (noteCount(row.user_notes) > noteCount(prevRow.user_notes)) quests.onNote();
    }
  }

  // Notes are SHARED across confirmed dupes — writing notes on any member
  // propagates to the whole group, so deleting a copy never loses them.
  if (typeof req.body?.user_notes === 'string' && row.dupe_group) {
    db.setGroupNotes(row.dupe_group, row.user_notes);
  }

  res.json(row);
});

// Record a view (client fires this once per qualifying view — ≥75% watched
// for video/audio, short dwell for images/docs). When gamify is on, this
// also scores the view and returns the result under row.gamify so the
// client needs no second request.
app.post('/api/media/:id/viewed', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const row = db.incrementViewCount(id);
  if (!row) return res.status(404).json({ error: 'not found' });

  if (gamifyEnabled) {
    const gamify = require('../lib/gamify');
    const watchS = Number(req.body?.watch_s) || 0;
    row.gamify = gamify.recordView(id, watchS);
  }

  res.json(row);
});

// "Done" — the user ended their viewing session on this item. Tracks a
// per-item counter + last position (for A/V resume-of-interest) and gives
// the activity heatmap a bonus at that spot.
app.post('/api/media/:id/done', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const row = db.markDone(id, Number(req.body?.position) || 0);
  if (!row) return res.status(404).json({ error: 'not found' });
  // Record this finish in the local play-history log for the Full-Stats
  // "finishers over time" chart (stays in the local DB — nothing is sent anywhere)
  if (gamifyEnabled) require('../lib/gamify').logEvent('finisher', id);
  res.json(row);
});

// "Hot" — the user flagged an intense moment on this item. Same shape as
// Done: a per-item counter + last position, plus a heatmap bonus at the spot.
app.post('/api/media/:id/hot', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const row = db.markHot(id, Number(req.body?.position) || 0);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// Watch-activity heatmap flush (sparse {bucket: seconds} accumulated
// client-side during playback; merged additively server-side)
app.post('/api/media/:id/heatmap', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const heat = db.mergeHeatmap(id, req.body?.buckets || {});
  if (!heat) return res.status(404).json({ error: 'not found' });
  res.json({ watch_heatmap: heat });
});

app.get('/api/stats', (req, res) => {
  res.json(db.getStats());
});

// Which DB file is this server actually serving? Shown in the viewer header
// so "wrong library loaded" is diagnosable at a glance.
app.get('/api/dbinfo', (req, res) => {
  const p = path.resolve(config.paths.database);
  res.json({ path: p, filename: path.basename(p) });
});

// ── Correct AI metadata by hand (✏️ edit in the info sidebar) ─────────────
// Whitelisted in lib/database.js setAiFields; arrays arrive as arrays.
app.post('/api/media/:id/metadata', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const ok = db.setAiFields(id, req.body || {});
  if (!ok) return res.status(400).json({ error: 'no valid fields or row not found' });
  embeddings.invalidateCache(); // edited text should re-rank in semantic search
  res.json(db.getById(id));
});

// ── No byte-upload import path ──────────────────────────────────────────────
// Vault NEVER copies source media onto local disk. The former POST /api/import
// (which streamed dropped bytes into an imports/ folder) was removed: copying
// content from removable/encrypted source drives into a plaintext local folder
// defeats the whole in-place, vault-gated model. Everything is now referenced
// where it lives via the native pickers below (pick-folder / pick-files →
// add-paths → insertStubs). Dropped items carry no filesystem path browser-side
// (hard security boundary), but resolve-drop below can usually recover the real
// paths from the drag SOURCE window's selection; when it can't, the client
// falls back to the native pickers.

app.get('/api/import/queue', (req, res) => res.json(importQueue.status()));

// How many import scans run in parallel (IMPORT_WORKERS sets the boot default).
// Applied live — raising it starts more workers immediately, lowering it lets
// the surplus workers retire once their current file finishes.
app.post('/api/import/queue/concurrency', (req, res) => {
  // Number() would happily read true as 1 and [4] as 4 — take a real number or
  // a plainly-written integer string (form posts), nothing else.
  const raw = req.body?.n;
  const n = typeof raw === 'number' ? raw
    : (typeof raw === 'string' && /^\s*[+-]?\d+\s*$/.test(raw) ? Number(raw) : NaN);
  if (!Number.isInteger(n) || n < 1 || n > 8) {
    return res.status(400).json({ error: 'n must be an integer 1-8' });
  }
  importQueue.setConcurrency(n);
  res.json({ concurrency: importQueue.getConcurrency() });
});

// ⏸ Stop dispatching. Files already in flight run to completion — there is no
// clean way to abort a vision call, and killing one mid-write is how you get a
// half-scanned row.
app.post('/api/import/queue/pause', (req, res) => res.json(importQueue.pause()));

// ▶ Resume, clearing a user pause or a model halt alike. When the halt WAS the
// model, probe the endpoints first: resuming into a still-dead backend just
// halts again on the next file, and saying so up front is kinder than watching
// the panel bounce. Advisory only — the resume still happens, because a probe
// that's wrong must never be able to trap the user in a paused queue.
app.post('/api/import/queue/resume', async (req, res) => {
  const wasModelHalt = importQueue.pausedBy() === 'model';
  let warning = null;
  if (wasModelHalt) {
    try {
      const up = await require('../lib/llm-client').isAvailable();
      if (!up) warning = 'No LLM endpoint answered — load a model, or the scan will pause again on the next file.';
    } catch {}
  }
  res.json({ ...importQueue.resume(), warning });
});

// ── "Which model?" — answering LM Studio's multiple-models 400 ──────────────
// LM Studio only ignores the `model` field while exactly one model is loaded.
// Load a second (Vault's own setup guide causes this — semantic search wants an
// embedding model too) and every scan request is rejected 400 until one is
// named. lib/model-health.js classifies that, the import queue halts on it with
// pausedBy() === 'model-choice', and these two routes let the panel resolve it.
//
// The choice lives in llm-client process memory only — deliberately NOT in
// vault-settings.json. It describes what happens to be loaded right now, and a
// stale saved value would silently pin scans to a model that has since gone.
app.get('/api/ai/models', async (req, res) => {
  const llm = require('../lib/llm-client');
  try {
    const { models, error } = await llm.listModels();
    res.json({
      models,
      // What a request would carry today: the session pick, unless AI_MODEL
      // (which outranks it) is set.
      current: config.lmStudio.model || llm.getSessionModel() || null,
      error: error || null,
    });
  } catch (err) {
    // A backend that is down must not turn into a broken picker.
    res.json({ models: [], current: null, error: err.message });
  }
});

app.post('/api/ai/model-choice', (req, res) => {
  const raw = req.body?.model;
  if (typeof raw !== 'string' || !raw.trim()) {
    return res.status(400).json({ error: 'model must be a non-empty string' });
  }
  const llm = require('../lib/llm-client');
  const model = llm.setSessionModel(raw);
  // The halt this answers should clear itself — making the user press ▶ Resume
  // straight after picking would be asking the same question twice.
  let resumed = false;
  if (importQueue.pausedBy() === 'model-choice') {
    importQueue.resume();
    resumed = true;
  }
  res.json({ ok: true, model, resumed });
});

/**
 * Shared body of the two bulk-scan routes below.
 *
 * Both hand work to the import queue rather than scanning inline: the blocking
 * per-item /rescan route holds a request open for the whole AI call, which is
 * fine for one file and hopeless for a thousand. The queue reports in the scan
 * panel and inherits its pause / halt-on-dead-model behaviour for free.
 *
 * @param {boolean} force  include rows that already scanned successfully.
 *   Off, only rows carrying a processing_error (a real failure or the
 *   'unscanned' stub marker) move — so sending an entire selection is safe.
 * @returns {object|{status:number, error:string}} the response body
 */
function _queueBulkScan(rawIds, { force = false } = {}) {
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return { status: 400, error: 'ids must be a non-empty array' };
  }
  // Select all can hand this the entire library, so ids arrive by the thousand.
  const ids = [...new Set(rawIds.map(v => (typeof v === 'number' && Number.isInteger(v) ? v
    : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : null))).filter(v => v !== null))];
  if (ids.length === 0) return { status: 400, error: 'no valid ids' };

  // One statement per 500 ids, not one per id: getById in a loop cost ~100µs
  // each, so a 20k retry blocked the event loop (no streaming, no thumbnails)
  // for seconds. The WHERE clause does the "needs scanning" filter too.
  const needsScan = force ? '' :
    'AND processing_error IS NOT NULL AND processing_error != \'\'';
  const handle = db.get();
  const rows = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    rows.push(...handle.prepare(
      `SELECT id, filepath, filename, media_type, processing_error FROM media
        WHERE id IN (${chunk.map(() => '?').join(',')})
          AND user_trashed = 0 ${needsScan}`
    ).all(...chunk));
  }

  let queued = 0, alreadyQueued = 0, missing = 0, reprocessed = 0;
  for (const row of rows) {
    if (!fs.existsSync(row.filepath)) { missing++; continue; }
    // enqueue dedupes on filepath; counting its verdict rather than the loop
    // keeps the toast honest when some of the selection is already in flight.
    const { added } = importQueue.enqueue({
      id: row.id, filepath: row.filepath, filename: row.filename, mediaType: row.media_type,
    });
    if (added) {
      queued++;
      if (!row.processing_error) reprocessed++;
    } else {
      alreadyQueued++;
    }
  }
  return { queued, alreadyQueued, missing, reprocessed, skipped: ids.length - rows.length };
}

// Re-queue files whose AI scan never landed — the bulk bar's ↻ Retry errors.
// Not a "rescan": rows that scanned fine are skipped, so sending the whole
// selection is safe and only the failures move.
app.post('/api/media/retry-errors', (req, res) => {
  const out = _queueBulkScan(req.body?.ids, { force: false });
  if (out.status) return res.status(out.status).json({ error: out.error });
  res.json(out);
});

// Bulk rescan — the scan-status filter's "Rescan these (N)" button.
//
// Same queue, one extra switch: force also re-runs files that scanned FINE.
// That is a real cost (full AI analysis per file) but not a destructive one —
// the queue drives the same processFile({reprocess, retryErrors}) the per-file
// rescan uses, and db.saveMedia UPSERTs only the AI-derived columns, so notes,
// stars, ratings, flags, view counts and thumbnails all survive. The client
// still confirms before sending force, because the GPU time is the user's.
app.post('/api/media/batch-rescan', (req, res) => {
  const out = _queueBulkScan(req.body?.ids, { force: req.body?.force === true });
  if (out.status) return res.status(out.status).json({ error: out.error });
  res.json(out);
});

/* ── Library migration (Settings › Library) ────────────────────────────────
   The viewer's front end for `node vault.js migrate`. Both routes run the
   SAME planner the CLI does (commands/migrate.js) — it prints nothing and
   throws instead of exiting, precisely so it can be shared.

   /preview plans and returns the report. /apply RE-PLANS from the same inputs
   and writes that: the client never submits a plan. A plan is a list of row
   ids and destination paths, and honouring one from the browser would let a
   crafted request repoint arbitrary records at arbitrary paths — and even an
   honest one goes stale the moment a scan finishes or a file moves between
   the two clicks. Re-planning costs one pass over the library and removes the
   whole class of problem.

   Neither runs while files are being scanned: processFile writes rows by
   filepath, so repointing underneath a live scan is how you get a row pointing
   at one file with another file's metadata. */

/** Shared input parsing — the two routes must agree on what a request means. */
function _migrateParams(body) {
  const raw = body?.mode;
  const mode = raw === 'relink' ? 'relink' : (raw === 'auto' ? 'auto' : 'prefix');
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  if (mode === 'relink' || mode === 'auto') {
    const newRoot = str(body?.newRoot);
    if (!newRoot) return { error: 'newRoot is required' };
    return { mode, newRoot };
  }
  const oldPrefix = str(body?.oldPrefix);
  const newPrefix = str(body?.newPrefix);
  if (!oldPrefix || !newPrefix) return { error: 'oldPrefix and newPrefix are required' };
  if (oldPrefix === newPrefix) return { error: 'the two prefixes are identical' };
  return { mode, oldPrefix, newPrefix };
}

/** True while anything is mid-scan — migration has to wait for it. */
function _scanBusy() {
  return importQueue.isActive() || _rescanning.size > 0;
}

/* ── The migrate job runner ────────────────────────────────────────────────
   A migrate over a real library is minutes of work, so it cannot be "whatever
   the request happens to be doing". It is a JOB: one slot, owned by the
   server, outliving the request that started it.

   That buys three things the user actually asked for. Progress (the planners
   tick as they go). Survival — closing the modal, switching sections or
   reloading the page cannot cancel anything, because nothing is tied to the
   request lifecycle. And a result that waits: the summary stays parked until
   the next job starts or the TTL expires, so a client that wandered off gets
   the full report when it comes back rather than being told to run it again.

   One slot, not a queue: two concurrent migrates would race for the same rows
   and the same destination paths. A second start gets 409 and the jobId, so
   the other tab can attach to the run already going instead. */
const _migrateJob = (() => {
  const RESULT_TTL_MS = 60 * 60 * 1000;   // how long a finished report waits
  // Don't call a rate meaningful until the sample is worth something.
  const ETA_MIN_MS = 2000;
  const ETA_MIN_FRACTION = 0.05;

  let job = null;
  let seq = 0;

  /** Rebaseline whenever the phase or the size of the work changes — a rate
   *  measured while walking a folder says nothing about matching rows. */
  function tick(j, processed, total, phase) {
    if (!j.base || j.base.phase !== phase || j.base.total !== total) {
      j.base = { phase, total, processed, at: Date.now() };
    }
    j.phase = phase;
    j.processed = processed;
    j.total = total;
  }

  function etaMs(j) {
    if (j.done || !j.base || !j.total) return null;
    const dp = j.processed - j.base.processed;
    const dt = Date.now() - j.base.at;
    if (dp <= 0) return null;
    if (dt < ETA_MIN_MS && (dp / j.total) < ETA_MIN_FRACTION) return null;
    return Math.round((j.total - j.processed) * dt / dp);
  }

  async function execute(j) {
    const migrate = require('../commands/migrate');
    const onTick = (p, t, phase) => tick(j, p, t, phase);
    try {
      const report = j.mode === 'auto'
        ? await migrate.planAuto(j.inputs.newRoot, { onTick })
        : j.mode === 'relink'
          ? await migrate.planRelink(j.inputs.newRoot, { onTick })
          : await migrate.planPrefix(j.inputs.oldPrefix, j.inputs.newPrefix, { onTick });

      if (j.kind === 'apply') {
        // Announce 'writing', then HOLD before the transaction starts.
        // apply() is one synchronous block, so without a pause here the phase
        // is set and the loop is seized in the same tick: no poll could
        // observe it, and the UI would jump from "matching" straight to
        // "done" with an unexplained freeze in between. A single setImmediate
        // is too narrow to be reliable — it only helps if a request happens to
        // be queued at that exact instant — so wait long enough that the
        // 1s-interval poller is certain to see it. Negligible next to the
        // write it precedes, and it buys an honest progress line.
        const planned = report.rewrite.length + report.absorb.length;
        tick(j, 0, planned, 'writing');
        await new Promise(r => setTimeout(r, 120));
        j.applied = migrate.apply(report, { onTick });
        // Paths moved, so the cached "missing from disk" tally is meaningless.
        _missingCount.invalidate();
        embeddings.invalidateCache();
      }
      j.summary = migrate.summarize(report);
    } catch (err) {
      j.error = err && err.message ? err.message : String(err);
      j.errorCode = err && err.code ? err.code : null;
    } finally {
      j.done = true;
      j.finishedAt = Date.now();
      j.phase = 'done';
    }
  }

  function expired(j) {
    return j && j.done && (Date.now() - j.finishedAt) > RESULT_TTL_MS;
  }

  return {
    isRunning() { return !!(job && !job.done); },
    currentId() { return job ? job.id : null; },

    /** @returns {{job}|{status,error}} */
    start(kind, params) {
      if (job && !job.done) {
        return { status: 409, error: 'a migrate is already running', jobId: job.id };
      }
      job = {
        id: `mig-${++seq}-${Date.now()}`,
        kind, mode: params.mode, inputs: params,
        startedAt: Date.now(), finishedAt: null,
        phase: 'starting', processed: 0, total: 0, base: null,
        done: false, error: null, errorCode: null, summary: null, applied: null,
      };
      // Deliberately NOT awaited and NOT attached to the request: the run has
      // to outlive whatever HTTP call kicked it off.
      job.promise = execute(job);
      return { job };
    },

    /** Resolve early if the job finishes inside `ms` — the small-library path. */
    async settleWithin(ms) {
      if (!job || job.done) return true;
      const mine = job;
      await Promise.race([mine.promise, new Promise(r => setTimeout(r, ms))]);
      return mine.done;
    },

    /** Serializable snapshot. null once a finished result has aged out. */
    status() {
      if (!job || expired(job)) return null;
      return {
        jobId: job.id,
        running: !job.done,
        kind: job.kind,
        mode: job.mode,
        inputs: job.inputs,
        phase: job.phase,
        processed: job.processed,
        total: job.total,
        elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
        etaMs: etaMs(job),
        done: job.done,
        error: job.error,
        errorCode: job.errorCode,
        applied: job.applied,
        report: job.summary,
      };
    },
  };
})();

/** Shared start path for both routes — they differ only in `kind`. */
async function _migrateStart(kind, req, res) {
  const p = _migrateParams(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  if (_scanBusy()) {
    return res.status(409).json({ error: 'a scan is running. Pause it or let it finish first.' });
  }

  const started = _migrateJob.start(kind, p);
  if (started.error) {
    // Hand back the jobId so the caller can attach to the run in progress
    // rather than just being refused.
    return res.status(409).json({ error: started.error, jobId: started.jobId, running: true });
  }

  // Hybrid: a small library finishes before anyone can blink, and making that
  // case round-trip through a poll would be a downgrade. Give it a second.
  const finished = await _migrateJob.settleWithin(1000);
  const s = _migrateJob.status();
  if (finished && s) {
    if (s.error) {
      return res.status(s.errorCode === 'EMIGRATEROOT' ? 400 : 500).json({ error: s.error });
    }
    return res.json({
      ok: true, done: true, jobId: s.jobId, elapsedMs: s.elapsedMs,
      dryRun: kind === 'preview', applied: s.applied, report: s.report,
    });
  }
  res.status(202).json({ ok: true, done: false, jobId: started.job.id });
}

app.post('/api/migrate/preview', (req, res) => { _migrateStart('preview', req, res); });
app.post('/api/migrate/apply', (req, res) => { _migrateStart('apply', req, res); });

// Current or last migrate — progress while it runs, the report once it lands.
// No per-client state: any tab, any reload, same answer.
app.get('/api/migrate/job', (req, res) => {
  res.json(_migrateJob.status() || { running: false, idle: true });
});

/* ── "N files missing from disk" — the banner's source ─────────────────────
   One existsSync per live row. On a 100k library that is 100k syscalls, which
   is milliseconds of real work but seconds of a BLOCKED event loop — no
   streaming, no thumbnails, a frozen viewer on every page load. So the walk
   runs in 500-row slices with a setImmediate between them (other requests
   interleave), the result is cached, and the route answers from cache
   immediately rather than waiting.

   First call returns {computing:true, count:null} and the client polls. The
   TTL is generous because the answer only changes when files move, and the
   two things that move them — a migrate apply and a library reload — invalidate
   it explicitly. */
const _missingCount = (() => {
  const TTL_MS = 5 * 60 * 1000;
  const SLICE = 500;
  let value = null;         // { count, total, at }
  let running = null;       // in-flight promise
  let gen = 0;              // bumped by invalidate(); a walk started under an
                            // older gen must not publish its snapshot — it was
                            // taken before whatever just moved the files.

  async function compute() {
    const myGen = gen;
    const rows = db.get().prepare(
      'SELECT filepath FROM media WHERE user_trashed = 0'
    ).all();
    let count = 0;
    for (let i = 0; i < rows.length; i += SLICE) {
      for (const r of rows.slice(i, i + SLICE)) {
        try { if (!fs.existsSync(r.filepath)) count++; } catch { count++; }
      }
      // Yield: the whole point of this dance.
      await new Promise(resolve => setImmediate(resolve));
    }
    if (myGen !== gen) return null; // invalidated mid-walk; discard
    value = { count, total: rows.length, at: Date.now() };
    return value;
  }

  return {
    invalidate() { value = null; gen++; },
    /** Cached answer, kicking off a recompute when there isn't a fresh one. */
    get() {
      const fresh = value && (Date.now() - value.at) < TTL_MS;
      if (!fresh && !running) {
        running = compute().catch(() => null).finally(() => { running = null; });
      }
      if (fresh) return { ...value, computing: false };
      return { count: value ? value.count : null, total: value ? value.total : null,
               at: value ? value.at : null, computing: true, stale: !!value };
    },
  };
})();

app.get('/api/library/missing-count', (req, res) => {
  if (req.query.refresh === '1') _missingCount.invalidate();
  res.json(_missingCount.get());
});

// Cancel: drop everything still queued. Destructive (the panel makes it a
// two-click confirm), so it never touches rows already scanned.
app.post('/api/import/queue/cancel', (req, res) => {
  const { dropped, active } = importQueue.cancel();
  res.json({ dropped, active, status: importQueue.status() });
});

// ── Path-based import — Vault's ONLY import model: RECORD locations, never
// copy. The browser can't see dropped files' paths (security boundary), but
// this local server can pop a native folder OR file picker and hand the real
// on-disk paths straight to add-paths → insertStubs (no bytes ever copied).

// ── Native pickers (folder + multi-file) — ONE shared C# shim skeleton ─────
// Both pickers use the MODERN IFileOpenDialog (quick links, address bar), not
// the ancient FolderBrowserDialog tree. PowerShell 5.1 can only reach it
// through COM interop, so a C# shim is compiled via Add-Type; the shared
// skeleton lives in PICKER_CS_TOP/_BOTTOM so interop fixes land in BOTH
// pickers at once. Four Windows realities are handled explicitly:
//   • DPI: powershell.exe isn't per-monitor DPI-aware, so on a scaled display
//     (125/150/200%) the dialog rendered at 96 DPI and was bitmap-stretched
//     into a blur. EnsureDpiAware() upgrades the dialog thread to
//     per-monitor-v2 BEFORE any window exists — thread-level first (works even
//     where the process default is locked by a manifest), then process-level
//     fallbacks for older Windows.
//   • COM identity: the interface is declared with IFileOpenDialog's OWN IID
//     (d57c7288-…). It used to carry IFileDialog's (42f85136-…), which the
//     shell answers with a DIFFERENT vtable — every IFileDialog-level method
//     still worked (so the folder picker never failed), but slot 27, where
//     this declaration puts GetResults, held an unrelated function and
//     multi-select silently returned nothing. Confirmed by QI pointer
//     comparison: the two IIDs yield different vtables with different slot-27
//     entries.
//   • on top: the dialog is given a hidden TOPMOST owner window, so it renders
//     above the browser WITHOUT injecting synthetic keystrokes (an earlier
//     Alt-key focus hack dismissed the dialog after ~1s and wedged the
//     process — owner-window z-order is the documented, non-destructive way).
//   • dark mode: best-effort via uxtheme SetPreferredAppMode (undocumented
//     ordinal 135); on systems where it's unavailable the dialog is light.
// A healthy shim ALWAYS prints something: path(s) on OK, or PICK_CANCEL when
// the dialog is dismissed. Empty stdout therefore means the shim itself broke
// (compile/COM error) and the endpoints report THAT loudly instead of faking
// a user cancel.

const PICK_CANCEL = '::CANCEL::';    // stdout sentinel — never a legal path

const PICKER_CS_TOP = `
$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace VaultPick {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  internal class FileOpenDialogRCW {}

  // IFileOpenDialog's OWN IID. With IFileDialog's (42f85136-...) here, the
  // shell hands back a vtable whose GetResults slot is an unrelated function.
  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IFileOpenDialog {
    [PreserveSig] uint Show(IntPtr hwndParent);
    void SetFileTypes(uint c, IntPtr rg);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint o);
    void Advise(IntPtr p, out uint c);
    void Unadvise(uint c);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IntPtr si);
    void SetFolder(IntPtr si);
    void GetFolder(out IntPtr si);
    void GetCurrentSelection(out IntPtr si);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n);
    void GetFileName(out IntPtr n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShellItem si);
    void AddPlace(IntPtr si, int f);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string e);
    void Close(uint hr);
    void SetClientGuid(ref Guid g);
    void ClearClientData();
    void SetFilter(IntPtr f);
    void GetResults(out IShellItemArray e);
    void GetSelectedItems(out IntPtr e);
  }

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdn, out IntPtr ppszName);
    void GetAttributes(uint mask, out uint attrs);
    void Compare(IShellItem psi, uint hint, out int order);
  }

  [ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IShellItemArray {
    void BindToHandler(IntPtr pbc, ref Guid rbhid, ref Guid riid, out IntPtr ppvOut);
    void GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
    void GetPropertyDescriptionList(IntPtr keyType, ref Guid riid, out IntPtr ppv);
    void GetAttributes(int dwAttribFlags, uint sfgaoMask, out uint psfgaoAttribs);
    void GetCount(out uint pdwNumItems);
    void GetItemAt(uint dwIndex, out IShellItem ppsi);
    void EnumItems(out IntPtr ppenumShellItems);
  }

  public static class Picker {
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr CreateWindowEx(
      uint exStyle, string cls, string name, uint style,
      int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string m);
    [DllImport("uxtheme.dll", EntryPoint = "#135")] static extern int SetPreferredAppMode(int mode);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int mode);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    const uint WS_POPUP = 0x80000000;
    const uint WS_EX_TOPMOST = 0x00000008;
    const uint WS_EX_TOOLWINDOW = 0x00000080;   // keep the owner out of the taskbar

    // Per-monitor-v2 (-4) BEFORE any window exists, or a scaled display gets
    // a 96-DPI bitmap-stretched (blurry) dialog. Thread-level first: it still
    // works when the process default is locked by a manifest; the rest are
    // best-effort fallbacks for older Windows.
    static void EnsureDpiAware() {
      try { if (SetThreadDpiAwarenessContext((IntPtr)(-4)) != IntPtr.Zero) return; } catch {}
      try { if (SetProcessDpiAwarenessContext((IntPtr)(-4))) return; } catch {}
      try { if (SetProcessDpiAwareness(2) == 0) return; } catch {}
      try { SetProcessDPIAware(); } catch {}
    }

    static string GetPath(IShellItem item) {
      IntPtr p; item.GetDisplayName(0x80058000, out p);   // SIGDN_FILESYSPATH
      string s = Marshal.PtrToStringUni(p);
      Marshal.FreeCoTaskMem(p);
      return s == null ? "" : s;
    }

    public static string Pick() {
      EnsureDpiAware();
      try { SetPreferredAppMode(2); } catch {}   // dark mode, best-effort (undocumented)

      // Hidden TOPMOST owner: the dialog renders above it (and thus above the
      // browser) purely by z-order -- no keystroke injection, no window hunt.
      // The dialog's own modal loop pumps this owner, so it never hangs.
      IntPtr owner = CreateWindowEx(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, "STATIC", "",
        WS_POPUP, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, GetModuleHandle(null), IntPtr.Zero);
      try { SetForegroundWindow(owner); } catch {}   // best-effort activation

      try {
        var dlg = (IFileOpenDialog)(object)(new FileOpenDialogRCW());
`;

// Folder mode: single pick via GetResult (an IFileDialog-level method).
const PICKER_BODY_FOLDER = `        dlg.SetOptions(0x20 | 0x40);               // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
        dlg.SetTitle("Add a folder to Vault (files are referenced in place, never copied)");
        dlg.SetOkButtonLabel("Add folder");
        uint hr = dlg.Show(owner);
        if (hr != 0) return "${PICK_CANCEL}";      // dismissed / closed
        IShellItem item; dlg.GetResult(out item);
        return GetPath(item);
`;

// Files mode: multi-select via GetResults -> IShellItemArray (only reachable
// through the true IFileOpenDialog IID above), one filesystem path per line.
const PICKER_BODY_FILES = `        // FOS_FORCEFILESYSTEM | FOS_ALLOWMULTISELECT | FOS_FILEMUSTEXIST
        dlg.SetOptions(0x40 | 0x200 | 0x1000);
        dlg.SetTitle("Add files to Vault (files are referenced in place, never copied)");
        dlg.SetOkButtonLabel("Add files");
        uint hr = dlg.Show(owner);
        if (hr != 0) return "${PICK_CANCEL}";      // dismissed / closed
        IShellItemArray items; dlg.GetResults(out items);
        uint count; items.GetCount(out count);
        StringBuilder sb = new StringBuilder();
        for (uint i = 0; i < count; i++) {
          IShellItem item; items.GetItemAt(i, out item);
          string fp = GetPath(item);
          if (fp.Length != 0) { sb.Append(fp); sb.Append((char)10); }
        }
        return sb.ToString();
`;

const PICKER_CS_BOTTOM = `      } finally {
        if (owner != IntPtr.Zero) DestroyWindow(owner);
      }
    }
  }
}
'@
Add-Type -TypeDefinition $src
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.Write([VaultPick.Picker]::Pick())
`;

const PICKER_PS1 = PICKER_CS_TOP + PICKER_BODY_FOLDER + PICKER_CS_BOTTOM;
const PICKER_FILES_PS1 = PICKER_CS_TOP + PICKER_BODY_FILES + PICKER_CS_BOTTOM;

// One native dialog process at a time (folder OR files) — a second request
// while one is alive is a 409. Shared spawn/collect/cleanup for both pickers:
// Windows-only guard, single-instance guard, BOTH-pipe draining (an unread
// stderr fills its 4KB buffer and deadlocks the child — the "dialog never
// appears + stuck busy" failure), and the 10-min watchdog.
let _picker = null;          // live child process, or null
function spawnPicker(res, script, kind, onClose) {
  if (process.platform !== 'win32') {
    return res.status(501).json({ error: `native ${kind} picker is Windows-only for now — type the path instead` });
  }
  // Busy only when the child is genuinely alive — a crashed/killed picker can
  // never wedge the button again.
  if (_picker && _picker.exitCode === null) {
    return res.status(409).json({ error: 'a picker is already open — check for its window (it stays on top)' });
  }

  const { spawn } = require('child_process');
  const os = require('os');
  const scriptPath = path.join(os.tmpdir(), `vault-pick-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, script);

  const ps = spawn('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', scriptPath],
    { windowsHide: true });
  _picker = ps;

  let out = '', errOut = '', sent = false;
  const finish = (status, body) => {
    if (sent) return;
    sent = true;
    _picker = null;
    clearTimeout(watchdog);
    try { fs.unlinkSync(scriptPath); } catch {}
    res.status(status).json(body);
  };
  ps.stdout.on('data', (d) => { out += d.toString(); });
  ps.stderr.on('data', (d) => { errOut += d.toString(); });
  ps.on('error', (err) => finish(500, { error: err.message }));
  ps.on('close', (code) => onClose({ code, out, errOut, finish }));
  // Watchdog: if the dialog sits unanswered this long, kill it and free the
  // button rather than staying "busy" forever.
  const watchdog = setTimeout(() => {
    try { ps.kill('SIGKILL'); } catch {}
    finish(200, { canceled: true, timeout: true });
  }, 10 * 60 * 1000);
}

// A healthy shim always prints path(s) or the PICK_CANCEL sentinel, so an
// empty stdout can only mean the shim itself broke (compile/COM error) —
// report that loudly instead of pretending the user canceled.
app.post('/api/import/pick-folder', (req, res) => {
  spawnPicker(res, PICKER_PS1, 'folder', ({ code, out, errOut, finish }) => {
    const raw = out.trim();
    if (raw === PICK_CANCEL) return finish(200, { canceled: true });
    if (raw) return finish(200, { path: raw });
    console.warn('[Import] folder picker failed:', (errOut.trim() || `exit ${code}, no output`).split('\n')[0]);
    finish(500, { error: 'folder picker failed — see server log' });
  });
});

// Multi-select file picker → real on-disk paths, registered in place via
// add-paths (no copy). Mirrors pick-folder; returns { paths: [...] }, keeping
// { paths: [] } (dialog OK'd but nothing usable came back) distinct from a
// real { canceled } so the client can toast instead of failing silently.
app.post('/api/import/pick-files', (req, res) => {
  spawnPicker(res, PICKER_FILES_PS1, 'file', ({ code, out, errOut, finish }) => {
    const raw = out.trim();
    if (raw === PICK_CANCEL) return finish(200, { canceled: true });
    const paths = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (paths.length) return finish(200, { paths });
    if (code === 0 && !errOut.trim()) return finish(200, { paths: [] });
    console.warn('[Import] file picker failed:', (errOut.trim() || `exit ${code}, no output`).split('\n')[0]);
    finish(500, { error: 'file picker failed — see server log' });
  });
});

// ── Drop resolution: recover REAL paths for browser drag-drops ─────────────
// The browser never reveals a dropped item's on-disk path (hard security
// boundary), but the drag SOURCE still knows: dragging out of a file manager
// starts by selecting the items, and that selection is still live in the
// source window when the drop lands. This one-shot PowerShell reads every
// candidate selection — Directory Opus listers (dopusrt /info, covers
// Explorer-Replacement setups), File Explorer windows (Shell.Application COM)
// and the desktop (FindWindowSW SWC_DESKTOP) — and the endpoint below matches
// them against the drop's {name,size} payload, stat-verifying every path. On
// no/ambiguous match the client simply falls back to the native pickers, so a
// wrong path can never be added: a candidate only wins when its ENTIRE
// selected set equals the dropped set.
const RESOLVER_PS1 = `
$ErrorActionPreference = 'SilentlyContinue'
$sources = @()

# Directory Opus listers (also handles its Explorer Replacement mode).
foreach ($rt in @("$env:ProgramFiles\\GPSoftware\\Directory Opus\\dopusrt.exe",
                  "\${env:ProgramFiles(x86)}\\GPSoftware\\Directory Opus\\dopusrt.exe")) {
  if (-not (Test-Path $rt)) { continue }
  $tmp = Join-Path $env:TEMP ("vault-drop-" + [guid]::NewGuid().ToString('n') + ".xml")
  & $rt /info "$tmp,listers" | Out-Null
  $deadline = (Get-Date).AddSeconds(2)              # dopusrt writes the file async
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path $tmp) -and (Get-Item $tmp).Length -gt 0) { break }
    Start-Sleep -Milliseconds 50
  }
  try {
    [xml]$x = Get-Content $tmp -Raw
    foreach ($tabItems in @($x.results.items)) {
      $sel = @()
      foreach ($it in @($tabItems.item)) { if ($it.sel -eq '1' -and $it.path) { $sel += $it.path } }
      if ($sel.Count) { $sources += ,@($sel) }
    }
  } catch {}
  Remove-Item $tmp -Force
  break
}

# File Explorer windows + the desktop.
try {
  $sh = New-Object -ComObject Shell.Application
  foreach ($w in @($sh.Windows())) {
    try {
      if ($w.FullName -notlike '*explorer.exe') { continue }
      $doc = $w.Document
      if (-not $doc) { continue }
      $sel = @()
      foreach ($it in @($doc.SelectedItems())) { if ($it.Path) { $sel += $it.Path } }
      if ($sel.Count) { $sources += ,@($sel) }
    } catch {}
  }
  try {
    $hwnd = 0
    $desk = $sh.Windows().FindWindowSW(0, $null, 8, [ref]$hwnd, 1)   # SWC_DESKTOP
    if ($desk -and $desk.Document) {
      $sel = @()
      foreach ($it in @($desk.Document.SelectedItems())) { if ($it.Path) { $sel += $it.Path } }
      if ($sel.Count) { $sources += ,@($sel) }
    }
  } catch {}
} catch {}

# One JSON array-of-arrays on stdout (PS 5.1 may flatten singletons — the
# server normalizes).
if ($sources.Count) { ConvertTo-Json -Depth 3 @($sources) -Compress } else { '[]' }
`;

// Resolver runs are short-lived (seconds, no dialog) — one at a time, killed
// hard at 8s. Same both-pipe draining rule as the pickers.
let _resolver = null;
function runResolver(cb) {
  if (_resolver && _resolver.exitCode === null) return cb(null);
  const { spawn } = require('child_process');
  const os = require('os');
  const scriptPath = path.join(os.tmpdir(), `vault-resolve-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, RESOLVER_PS1);
  const ps = spawn('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { windowsHide: true });
  _resolver = ps;
  let out = '', done = false;
  const finish = (v) => {
    if (done) return;
    done = true;
    _resolver = null;
    clearTimeout(watchdog);
    try { fs.unlinkSync(scriptPath); } catch {}
    cb(v);
  };
  ps.stdout.on('data', (d) => { out += d.toString(); });
  ps.stderr.on('data', () => {});
  ps.on('error', () => finish(null));
  ps.on('close', () => finish(out));
  const watchdog = setTimeout(() => { try { ps.kill('SIGKILL'); } catch {} finish(null); }, 8000);
}

// PS 5.1 ConvertTo-Json collapses single-element arrays — accept any of
// string / [string] / [[string]] and normalize to [[string]].
function normalizeSelections(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  if (typeof data === 'string') data = [data];
  if (!Array.isArray(data)) return [];
  if (data.length === 0) return [];                  // [] means "no selection", not one empty candidate
  if (data.every((x) => typeof x === 'string')) data = [data];
  return data.filter(Array.isArray).map((sel) => sel.filter((p) => typeof p === 'string'));
}

// A selection wins only if its stat-able items are EXACTLY the dropped set:
// every dropped file matches a distinct selected file (basename + byte size)
// and every dropped folder a distinct selected folder (basename), no extras.
function matchSelection(selPaths, wantFiles, wantDirs) {
  const cand = [];
  for (const p of selPaths) {
    try {
      const st = fs.statSync(p);
      cand.push({ path: p, name: path.basename(p).toLowerCase(), size: st.size, isDir: st.isDirectory() });
    } catch { /* virtual / vanished item — ignore it */ }
  }
  const files = cand.filter((c) => !c.isDir);
  const dirs = cand.filter((c) => c.isDir);
  if (files.length !== wantFiles.length || dirs.length !== wantDirs.length) return null;
  const fpool = [...files];
  for (const w of wantFiles) {
    const i = fpool.findIndex((c) => c.name === String(w.name || '').toLowerCase()
      && (w.size == null || c.size === Number(w.size)));
    if (i < 0) return null;
    fpool.splice(i, 1);
  }
  const dpool = [...dirs];
  for (const name of wantDirs) {
    const i = dpool.findIndex((c) => c.name === String(name || '').toLowerCase());
    if (i < 0) return null;
    dpool.splice(i, 1);
  }
  return {
    files: files.map((c) => ({ path: c.path, size: c.size })),
    dirs: dirs.map((c) => c.path),
  };
}

// Body: { files: [{name,size}...], dirs: [name...] } straight from the drop's
// DataTransfer. Reply: { files: [{path,size}...], dirs: [path...] } on a
// unique match, or { unresolved: <reason> } — the client then falls back to
// the pickers, so this endpoint never guesses.
app.post('/api/import/resolve-drop', (req, res) => {
  if (process.platform !== 'win32') return res.json({ unresolved: 'unsupported' });
  const wantFiles = Array.isArray(req.body?.files) ? req.body.files.slice(0, 2000) : [];
  const wantDirs = Array.isArray(req.body?.dirs)
    ? req.body.dirs.slice(0, 200).map((d) => String(d)) : [];
  if (!wantFiles.length && !wantDirs.length) {
    return res.status(400).json({ error: 'files or dirs required' });
  }
  runResolver((out) => {
    if (out == null) return res.json({ unresolved: 'resolver failed or busy' });
    const matches = new Map();       // sorted-path-set key → match
    for (const sel of normalizeSelections(out)) {
      const m = matchSelection(sel, wantFiles, wantDirs);
      if (m) matches.set([...m.files.map((f) => f.path), ...m.dirs].sort().join('\n'), m);
    }
    if (matches.size === 1) {
      const m = matches.values().next().value;
      console.log(`[Import] drop resolved in place: ${m.files.length} file(s), ${m.dirs.length} folder(s)`);
      return res.json(m);
    }
    res.json({ unresolved: matches.size ? 'ambiguous' : 'no matching selection' });
  });
});

// Walk a folder and report what's inside — the preview modal's data source.
// No DB writes; the client decides what to add.
app.post('/api/import/scan-folder', (req, res) => {
  const root = String(req.body?.path || '').trim();
  if (!root) return res.status(400).json({ error: 'path required' });
  let st;
  try { st = fs.statSync(root); } catch { return res.status(404).json({ error: 'folder not found' }); }
  if (!st.isDirectory()) return res.status(400).json({ error: 'not a folder' });

  const MAX_FILES = 50000;                       // sanity cap for a mis-pick like C:\
  const files = [];
  let subdirs = 0, truncated = false;
  const walk = (dir, depth) => {
    if (truncated) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= MAX_FILES) { truncated = true; return; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { subdirs++; walk(full, depth + 1); }
      else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch {}
        const ext = path.extname(e.name).slice(1).toLowerCase();
        files.push({ path: full, name: e.name, ext, size, depth });
      }
    }
  };
  walk(root, 0);
  res.json({ name: path.basename(root), path: root, subdirs, files, truncated });
});

// Record media rows for existing on-disk paths (the no-copy import). Rows are
// 'unscanned' stubs, playable immediately; AI scan queues per file.
// Duration/dimensions are probed in the BACKGROUND so adding a
// 500-file folder returns instantly.
app.post('/api/import/add-paths', (req, res) => {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths.map(String) : [];
  if (!paths.length) return res.status(400).json({ error: 'paths required' });

  const added = [];
  let unsupported = 0, existing = 0, missing = 0;
  const stubs = [];
  for (const p of paths) {
    const ext = path.extname(p).toLowerCase();
    // Default types first (video/image/gif): the video processor also claims
    // image/gif exts in the registry, so getProcessorMediaType would tag an
    // imported .png/.gif as 'video'. getMediaType returns the true type for
    // those; fall back to the registry for audio/document imports.
    const mediaType = config.getMediaType(ext) || config.getProcessorMediaType(ext);
    if (!mediaType) { unsupported++; continue; }
    if (!fs.existsSync(p)) { missing++; continue; }
    if (db.getByPath(p)) { existing++; continue; }
    stubs.push({ path: p, name: path.basename(p), mediaType });
  }
  if (stubs.length) db.insertStubs(stubs);

  for (const s of stubs) {
    const row = db.getByPath(s.path);
    if (!row) continue;
    added.push({ id: row.id, mediaType: s.mediaType, row });
    importQueue.enqueue({ id: row.id, filepath: s.path, filename: row.filename, mediaType: s.mediaType });
  }

  res.json({ added, skipped: { unsupported, existing, missing }, queued: true });

  // Background probe: duration/width/height for the new tiles, one at a time,
  // fully detached from the response. Errors are cosmetic-only.
  setImmediate(async () => {
    try {
      const mediaInfo = require('../lib/media-info');
      if (!mediaInfo.isAvailable()) return;
      for (const a of added) {
        if (!['video', 'audio', 'gif'].includes(a.mediaType)) continue;
        try {
          // One ffprobe now covers the tile (duration/size) AND the playback
          // decision (codecs), so a freshly imported file never has to be
          // probed again on its first play.
          const info = await mediaInfo.getStreamInfo(a.row.filepath);
          if (info) db.saveStreamInfo(a.id, info);
        } catch { /* per-file probe failure is fine */ }
      }
    } catch { /* probe loop is best-effort */ }
  });
});

// ── Single-file rescan (fix failed/bad scans without leaving the viewer) ──
// Reuses the CLI scan pipeline (commands/scan.js processFile). Blocks until
// the AI analysis finishes — the client shows a spinner. One rescan per
// file at a time; LM Studio must be running.
const _rescanning = new Set();

app.post('/api/media/:id/rescan', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const row = db.getById(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!fs.existsSync(row.filepath)) {
    return res.status(409).json({ error: 'source file missing on disk' });
  }
  if (_rescanning.has(id)) {
    return res.status(409).json({ error: 'rescan already running for this file' });
  }

  _rescanning.add(id);
  try {
    const { processFile } = require('../commands/scan');
    require('../lib/frame-extractor').ensureTempDir();

    const result = await processFile(
      { path: row.filepath, name: row.filename, mediaType: row.media_type },
      { reprocess: true, retryErrors: true }
    );

    embeddings.invalidateCache();
    if (result.error) {
      // A model-availability failure is reported up WITHOUT stamping the row
      // (commands/scan.js) so a queued retry isn't skipped later. That is right
      // for the queue, but this path has no queue and no picker of its own: the
      // row would be left with whatever stale error it had, and the user would
      // never learn that LM Studio simply wants a model named. So record the
      // real reason here — the scan panel's picker is where it gets fixed.
      if (result.needsModelChoice) {
        try {
          db.get().prepare('UPDATE media SET processing_error = ? WHERE id = ?')
            .run(String(result.error).slice(0, 300), id);
        } catch {}
        return res.json({ ok: false, error: result.error, needsModelChoice: true, row: db.getById(id) });
      }
      // Analysis failed again — row now carries the fresh error
      return res.json({ ok: false, error: result.error, row: db.getById(id) });
    }
    const updated = db.getById(id);
    res.json({ ok: true, elapsed: result.elapsed, frames: result.frames, row: updated });
  } catch (err) {
    res.status(500).json({ error: err.message, row: db.getById(id) });
  } finally {
    _rescanning.delete(id);
  }
});

// ── Beat bar: downsampled mono audio for in-browser beat detection ─────────
// Two formats from one endpoint:
//   • default (m4a): whole-file AAC-in-MP4 for decodeAudioData consumers (the
//     PMV editor, ensureBeats, and browsers without WebCodecs).
//   • ?fmt=adts: raw ADTS AAC for the streaming beat worker — self-framed, so
//     WebCodecs can decode it without a demuxer, and STREAMED straight from
//     ffmpeg's stdout while extraction runs (first bytes in ~a second even
//     when the full extraction takes a minute), teed into the cache. In vault
//     mode the ADTS path never touches disk in plaintext at all.
const _beatAudioInflight = new Map();
const _adtsInflight = new Map();      // id → Promise<{ok, buf?}> (buf in vault mode)

// One ffmpeg → many sinks: pipe stdout to the live response (if any) and
// collect for the cache. Resolves {ok:true, buf} on clean exit — never
// rejects, so concurrent waiters can't leak an unhandled rejection.
function spawnAdtsExtract(row, res) {
  const { spawn } = require('child_process');
  const ff = spawn(require('../lib/ffmpeg-locate').resolve('ffmpeg'), [
    '-v', 'error', '-i', row.filepath, '-vn',
    '-ac', '1', '-ar', '22050', '-c:a', 'aac', '-b:a', '48k',
    '-f', 'adts', 'pipe:1',
  ], { windowsHide: true });

  const chunks = [];
  let errLine = '';
  ff.stdout.on('data', (d) => chunks.push(d));
  ff.stderr.on('data', (d) => { if (!errLine) errLine = d.toString().split('\n')[0]; });

  if (res) {
    res.set('Content-Type', 'audio/aac');
    ff.stdout.pipe(res);                                   // progressive delivery
    res.on('close', () => { try { ff.stdout.unpipe(res); } catch {} });
  }

  return new Promise((resolve) => {
    const watchdog = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, 600000);
    ff.on('error', (err) => { clearTimeout(watchdog); resolve({ ok: false, err: err.message }); });
    ff.on('close', (code) => {
      clearTimeout(watchdog);
      if (code === 0 && chunks.length) return resolve({ ok: true, buf: Buffer.concat(chunks) });
      resolve({ ok: false, err: errLine || `ffmpeg exit ${code}` });
    });
  });
}

async function beatAudioAdts(req, res, id, row) {
  // Cache hit (complete by construction — only written after a clean exit)
  if (secureAssets.enabled()) {
    const buf = secureAssets.get(id, 'beataudio_adts', '');
    if (buf) { res.set('Content-Type', 'audio/aac'); return res.end(buf); }
  } else {
    const outPath = path.join(config.paths.thumbnailDir, `${id}_beataudio.aac`);
    if (fs.existsSync(outPath) && !_adtsInflight.has(id)) {
      res.set('Content-Type', 'audio/aac');
      return res.sendFile(outPath, (err) => {
        if (err && !res.headersSent) res.status(err.status || 500).end();
      });
    }
  }

  // Extraction already running (another request streams it live): wait for
  // the finished bytes rather than racing the extractor.
  if (_adtsInflight.has(id)) {
    const job = await _adtsInflight.get(id);
    if (!job.ok) return res.status(500).json({ error: 'audio extraction failed' });
    res.set('Content-Type', 'audio/aac');
    return res.end(job.buf);
  }

  // First requester: stream live while the cache fills.
  const jobPromise = spawnAdtsExtract(row, res);
  _adtsInflight.set(id, jobPromise);
  const job = await jobPromise.finally(() => _adtsInflight.delete(id));

  if (!job.ok) {
    console.warn(`[BeatBar] adts extraction failed for #${id}:`, job.err);
    if (!res.headersSent) return res.status(500).json({ error: 'audio extraction failed' });
    return res.destroy();                 // mid-stream failure → kill the socket
  }
  // pipe() already ended the response; persist the cache.
  try {
    if (secureAssets.enabled()) {
      secureAssets.put(id, 'beataudio_adts', job.buf, '');
    } else {
      ownedDir.ensureManaged(config.paths.thumbnailDir, 'thumbs');
      const outPath = path.join(config.paths.thumbnailDir, `${id}_beataudio.aac`);
      const tmp = `${outPath}.part-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, job.buf);
      fs.renameSync(tmp, outPath);
    }
  } catch (err) {
    console.warn(`[BeatBar] adts cache write failed for #${id}:`, err.message);
  }
}

// Beat detection audio feeds the beat bar, vibe sync AND the PMV studio
app.get('/api/media/:id/beat-audio', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).end();
  const row = db.getById(id);
  if (!row || !['video', 'audio'].includes(row.media_type)) return res.status(404).end();
  if (!fs.existsSync(row.filepath)) return res.status(404).end();

  // no-store in ALL modes — this feeds fetch()/arrayBuffer() (not a streamed
  // <audio> element), so no Range support is needed; a full buffer is fine.
  res.set('Cache-Control', 'no-store');

  if (req.query.fmt === 'adts') return beatAudioAdts(req, res, id, row);

  // Vault mode: bytes live encrypted in secure_assets.db. ffmpeg still needs a
  // real file, so extract into the (wiped) temp dir, read into the store, and
  // delete the plaintext temp copy — nothing derived persists under thumbnailDir.
  if (secureAssets.enabled()) {
    let buf = secureAssets.get(id, 'beataudio', '');
    if (!buf) {
      try {
        if (!_beatAudioInflight.has(id)) {
          const proc = require('../lib/proc');
          ownedDir.ensureManaged(config.paths.tempDir, 'temp');
          const tmp = path.join(config.paths.tempDir, `beat_${id}_${process.pid}_${Date.now()}.m4a`);
          _beatAudioInflight.set(id, proc.run('ffmpeg', [
            '-y', '-i', row.filepath, '-vn',
            '-ac', '1', '-ar', '22050', '-c:a', 'aac', '-b:a', '48k',
            tmp,
          ], { timeout: 600000 }).then(() => {
            const b = fs.readFileSync(tmp);
            secureAssets.put(id, 'beataudio', b, '');
            try { fs.unlinkSync(tmp); } catch {}
            return b;
          }).finally(() => _beatAudioInflight.delete(id)));
        }
        buf = await _beatAudioInflight.get(id);
      } catch (err) {
        return res.status(500).json({ error: 'audio extraction failed' });
      }
    }
    if (!buf) return res.status(404).end();
    res.set('Content-Type', 'audio/mp4');
    return res.end(buf);
  }

  // The cache file only counts once COMPLETE. ffmpeg writes outPath from its
  // first second, so a bare existsSync is true DURING extraction — a request
  // landing in that window (wide on 2h+ videos) used to stream the
  // half-written m4a and the client died with decodeAudioData "invalid
  // content" until the cache finished. Extract to a temp name, rename into
  // place on success (atomic), and make every request during an extraction
  // await it instead of racing it.
  const outPath = path.join(config.paths.thumbnailDir, `${id}_beataudio.m4a`);
  if (!fs.existsSync(outPath) || _beatAudioInflight.has(id)) {
    try {
      if (!_beatAudioInflight.has(id)) {
        const proc = require('../lib/proc');
        ownedDir.ensureManaged(config.paths.thumbnailDir, 'thumbs');
        const tmp = `${outPath}.part-${process.pid}-${Date.now()}`;
        _beatAudioInflight.set(id, proc.run('ffmpeg', [
          '-y', '-i', row.filepath, '-vn',
          '-ac', '1', '-ar', '22050', '-c:a', 'aac', '-b:a', '48k',
          '-f', 'mp4', tmp,
        ], { timeout: 600000 })
          .then(() => fs.renameSync(tmp, outPath))
          .finally(() => {
            _beatAudioInflight.delete(id);
            try { fs.unlinkSync(tmp); } catch {}   // failure/timeout leftovers
          }));
      }
      await _beatAudioInflight.get(id);
    } catch (err) {
      return res.status(500).json({ error: 'audio extraction failed' });
    }
  }
  res.sendFile(outPath, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).end();
  });
});

// ── Remove records from the library (DB rows only — files stay on disk) ───
app.post('/api/records/delete', (req, res) => {
  const ids = parseIdList(req.body);
  if (ids.length === 0) return res.status(400).json({ error: 'ids required' });

  // Clean up cached thumbnails/scrub frames before the rows vanish — only in a
  // dir the app owns (missing marker → skip, never unlink files under a
  // user-data directory the thumbs path was mis-pointed at).
  if (ownedDir.guardSweep(config.paths.thumbnailDir, 'record-delete thumbnail cleanup')) {
    for (const id of ids) {
      for (const name of [`${id}.jpg`, ...[0, 1, 2, 3, 4].map(i => `${id}_s${i}.jpg`)]) {
        try { fs.unlinkSync(path.join(config.paths.thumbnailDir, name)); } catch {}
      }
    }
  }

  const deleted = db.deleteRecords(ids);
  embeddings.invalidateCache();
  res.json({ deleted });
});

// ── Saved note snippets (quick notes) ──────────────────────────────────────

app.get('/api/note-snippets', (req, res) => {
  res.json(db.getSavedNotes());
});

app.post('/api/note-snippets', (req, res) => {
  const text = (req.body?.text || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const color = typeof req.body?.color === 'string' ? req.body.color : null;
  res.json(db.addSavedNote(text, color));
});

// Recolor a snippet (empty/absent color clears it back to the default chip)
app.patch('/api/note-snippets/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const color = typeof req.body?.color === 'string' ? req.body.color : null;
  res.json(db.setSavedNoteColor(id, color));
});

// Persist a drag-reordered list ({ ids: [...] }, left-to-right)
app.post('/api/note-snippets/reorder', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  res.json(db.reorderSavedNotes(ids));
});

app.delete('/api/note-snippets/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  res.json(db.deleteSavedNote(id));
});

// Semantic search: embed the query (LM Studio) → cosine-rank all embedded
// items. Returns [{id, score}] best-first. 503 if no items are embedded yet
// or the embedding model is unreachable.
app.get('/api/search/semantic', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'q required' });

  try {
    const results = await embeddings.search(q, Number(req.query.limit) || 500);
    if (results.length === 0) {
      return res.status(503).json({
        error: 'no embeddings yet — run: node vault.js embed',
      });
    }
    res.json({ results });
  } catch (err) {
    res.status(503).json({ error: `embedding model unavailable: ${err.message}` });
  }
});

// ── Trash (hard move to config.paths.trashDir, with undo) ─────────────────

function parseIdList(body) {
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : [];
  return ids.filter(id => Number.isInteger(id) && id > 0);
}

app.post('/api/trash', async (req, res) => {
  const ids = parseIdList(req.body);
  if (ids.length === 0) return res.status(400).json({ error: 'ids required' });
  try {
    const results = await trash.trashItems(ids);
    embeddings.invalidateCache(); // trashed items leave semantic results
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/untrash', async (req, res) => {
  const ids = parseIdList(req.body);
  if (ids.length === 0) return res.status(400).json({ error: 'ids required' });
  try {
    const results = await trash.untrashItems(ids);
    embeddings.invalidateCache();
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Destructive delete of LIVE library files (the delete-mode alternatives to
// soft trash): mode 'recycle' → OS Recycle Bin, mode 'hard' → gone from disk.
// Both purge the record for whichever files were removed. Same result shape as
// /api/trash so the client's queue handles all three ops uniformly.
app.post('/api/delete', async (req, res) => {
  const ids = parseIdList(req.body);
  const mode = req.body?.mode === 'hard' ? 'hard' : 'recycle';
  if (ids.length === 0) return res.status(400).json({ error: 'ids required' });
  try {
    const results = await trash.deleteItems(ids, mode);
    const okIds = results.filter(r => r.ok).map(r => r.id);
    if (ownedDir.guardSweep(config.paths.thumbnailDir, 'delete thumbnail cleanup')) {
      for (const id of okIds) {
        for (const name of [`${id}.jpg`, `${id}_beataudio.m4a`,
                            ...[0, 1, 2, 3, 4].map(i => `${id}_s${i}.jpg`)]) {
          try { fs.unlinkSync(path.join(config.paths.thumbnailDir, name)); } catch {}
        }
      }
    }
    if (okIds.length) { db.deleteRecords(okIds); embeddings.invalidateCache(); }
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Permanently empty the trash: delete every trashed file from disk AND purge
// all their records/traces (metadata, notes, subtitles, thumbnails, …).
// Irreversible — the client double-confirms first.
app.post('/api/trash/empty', (req, res) => {
  try {
    const rows = db.get()
      .prepare('SELECT id, filepath, trashed_original_path FROM media WHERE user_trashed = 1')
      .all();
    if (!rows.length) return res.json({ deleted: 0, filesDeleted: 0 });

    const trashDir = path.resolve(config.paths.trashDir);
    // Thumbnail-cache cleanup is gated on the app-owned marker; the trash-file
    // deletion below is separately guarded by the underTrash path check.
    const thumbsOwned = ownedDir.guardSweep(config.paths.thumbnailDir, 'trash-empty thumbnail cleanup');
    let filesDeleted = 0;
    for (const row of rows) {
      // SAFETY: only ever unlink files that actually live under the trash dir.
      // A stale-trash row (file already gone) has filepath === original_path,
      // which is NOT under trashDir — so it's skipped, never touched.
      const fp = row.filepath ? path.resolve(row.filepath) : '';
      const underTrash = fp && (fp === trashDir || fp.startsWith(trashDir + path.sep));
      if (underTrash && row.filepath !== row.trashed_original_path) {
        try { fs.unlinkSync(fp); filesDeleted++; } catch {}
      }
      // Cached thumbnails / scrub frames / beat audio (deleteRecords doesn't)
      if (thumbsOwned) {
        for (const name of [`${row.id}.jpg`, `${row.id}_beataudio.m4a`,
                            ...[0, 1, 2, 3, 4].map(i => `${row.id}_s${i}.jpg`)]) {
          try { fs.unlinkSync(path.join(config.paths.thumbnailDir, name)); } catch {}
        }
      }
    }

    const deleted = db.deleteRecords(rows.map(r => r.id));   // cascades all sub-repos
    embeddings.invalidateCache();
    res.json({ deleted, filesDeleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Collections (custom playlists — see COLLECTIONS_SPEC.md) ──────────────

app.get('/api/collections', (req, res) => {
  res.json(db.getCollections());
});

// Map typed collection errors → HTTP status codes (shared by create/patch/items)
const COLL_ERR_STATUS = { NAME_TAKEN: 409, BAD_PARENT: 400, BAD_KIND: 400, CYCLE: 400, FOLDER_TARGET: 400 };

app.post('/api/collections', (req, res) => {
  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const kind = req.body?.kind === 'folder' ? 'folder' : 'collection';
  const parentId = req.body?.parent_id == null ? null : parseId(req.body.parent_id);
  if (req.body?.parent_id != null && !parentId) return res.status(400).json({ error: 'bad parent_id' });
  try {
    res.json(db.createCollection(name, {
      description: (req.body?.description || '').toString(),
      parentId,
      kind,
    }));
  } catch (err) {
    const status = COLL_ERR_STATUS[err.code];
    if (status) return res.status(status).json({ error: err.message, code: err.code });
    throw err;
  }
});

app.patch('/api/collections/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const fields = {};
  if (typeof req.body?.name === 'string') fields.name = req.body.name;
  if (typeof req.body?.description === 'string') fields.description = req.body.description;
  // parent_id: present-and-null moves to root; a number moves under that folder
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'parent_id')) {
    fields.parent_id = req.body.parent_id == null ? null : parseId(req.body.parent_id);
    if (req.body.parent_id != null && !fields.parent_id) return res.status(400).json({ error: 'bad parent_id' });
  }
  try {
    if (!db.updateCollection(id, fields)) return res.status(400).json({ error: 'nothing to update or not found' });
    res.json({ ok: true });
  } catch (err) {
    const status = COLL_ERR_STATUS[err.code];
    if (status) return res.status(status).json({ error: err.message, code: err.code });
    throw err;
  }
});

app.delete('/api/collections/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  db.deleteCollection(id);   // folder → re-parents children; collection → drops items
  res.json(db.getCollections());
});

app.get('/api/collections/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  res.json({ media_ids: db.getCollectionItems(id) });
});

// Per-collection membership counts for a set of media ids — the picker derives
// all/some/none from member_count vs ids.length in one request.
app.post('/api/collections/membership', (req, res) => {
  const ids = parseIdList(req.body);
  if (ids.length === 0) return res.status(400).json({ error: 'ids required' });
  res.json(db.getMembershipCounts(ids));
});

app.post('/api/collections/:id/items', (req, res) => {
  const id = parseId(req.params.id);
  const ids = parseIdList(req.body);
  if (!id || ids.length === 0) return res.status(400).json({ error: 'id + ids required' });
  let added;
  try {
    added = db.addToCollection(id, ids);
  } catch (err) {
    const status = COLL_ERR_STATUS[err.code];
    if (status) return res.status(status).json({ error: err.message, code: err.code });
    throw err;
  }
  // Curator quests count NEWLY added pairs only (re-adds are conflict-ignored)
  if (gamifyEnabled && added > 0) require('../lib/quests').onCollect(added);
  res.json({ added, item_count: db.collectionItemCount(id), first_ids: db.collectionFirstIds(id) });
});

app.delete('/api/collections/:id/items', (req, res) => {
  const id = parseId(req.params.id);
  const ids = parseIdList(req.body);
  if (!id || ids.length === 0) return res.status(400).json({ error: 'id + ids required' });
  const removed = db.removeFromCollection(id, ids);
  res.json({ removed, item_count: db.collectionItemCount(id), first_ids: db.collectionFirstIds(id) });
});

app.get('/api/media/:id/collections', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  res.json(db.collectionsForMedia(id));
});

// ── Music ID (fingerprinting, songs, stack mixes — see lib/musicid/) ──────
app.use('/api/music', require('./music-routes').buildRouter());

// ── Games (per-game save slots — see lib/games/) ──────────────────────────
app.use('/api/games', require('./games-routes').buildRouter());

// ── PMV Studio (beat-cut music videos — see lib/pmv/) ─────────────────────
app.use('/api/pmv', require('./pmv-routes').buildRouter());

// ── Subtitles (whisper transcription + OPUS-MT translation — lib/subtitles/)
app.use('/api', require('./subtitle-routes').buildRouter());

// ── Playback decision + HLS remux streaming (mounted at the root: it owns
//    both /api/playback|/api/stream and the /stream/:id/* media URLs) ────────
app.use(require('./stream-routes').buildRouter());

// ── Saved searches ─────────────────────────────────────────────────────────

app.get('/api/searches', (req, res) => {
  res.json(db.getSavedSearches());
});

app.post('/api/searches', (req, res) => {
  const { name, search_text, filters, sort_order } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  db.addSavedSearch(name, search_text || '', filters || {}, sort_order || 0);
  res.json(db.getSavedSearches());
});

app.delete('/api/searches/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  db.deleteSavedSearch(id);
  res.json(db.getSavedSearches());
});

// ── Media streaming ────────────────────────────────────────────────────────

function streamMediaRow(row, req, res) {
  if (!row) return res.status(404).end();
  if (!fs.existsSync(row.filepath)) {
    // Source file missing — let the client flag it as playback_failed
    return res.status(404).end();
  }
  // res.sendFile handles Content-Type, Range requests (seeking), and caching
  res.sendFile(row.filepath, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).end();
  });
}

// Path-based variant — lets the viewer keep passing filepaths around
// (single change in pathToFileUrl) instead of threading ids everywhere.
// Only paths that exist in the DB are served; this is NOT a general file
// server. Defined BEFORE /media/:id so "by-path" isn't captured as an id.
app.get('/media/by-path', (req, res) => {
  const p = req.query.p;
  if (!p) return res.status(400).end();
  streamMediaRow(db.getByPath(p), req, res);
});

app.get('/media/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).end();
  streamMediaRow(db.getById(id), req, res);
});

// ── Thumbnails ─────────────────────────────────────────────────────────────

// Hover-scrub preview frames (videos only): /scrub/:id/0 … /scrub/:id/4
app.get('/scrub/:id/:idx', async (req, res) => {
  const id = parseId(req.params.id);
  const idx = Number(req.params.idx);
  if (!id || !Number.isInteger(idx)) return res.status(400).end();
  const row = db.getById(id);
  if (!row) return res.status(404).end();

  // no-store in ALL modes: the browser's disk cache would otherwise persist a
  // decrypted copy, and localhost latency makes caching pointless anyway.
  res.set('Cache-Control', 'no-store');
  try {
    if (secureAssets.enabled()) {
      const buf = await thumbnails.getScrubFrameBuffer(row, idx);
      if (!buf) return res.status(404).end();
      res.set('Content-Type', 'image/jpeg');
      return res.end(buf);
    }
    const framePath = await thumbnails.getScrubFrame(row, idx);
    if (!framePath) return res.status(404).end();
    res.sendFile(framePath, (err) => {
      if (err && !res.headersSent) res.status(err.status || 500).end();
    });
  } catch (err) {
    res.status(500).end();
  }
});

app.get('/thumb/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).end();
  let row = db.getById(id);
  if (!row) return res.status(404).end();

  // Custom mixes are virtual files — borrow the first source video's thumb
  if (row.media_type === 'mix') {
    try {
      const mix = require('../lib/musicid/repo').getCustomMix(id);
      const srcId = mix?.media_ids?.[0];
      const src = srcId && db.getById(srcId);
      if (src) row = src;
      else return res.status(404).end();
    } catch { return res.status(404).end(); }
  }

  // no-store in ALL modes (see /scrub) — never leave a decrypted copy in cache.
  res.set('Cache-Control', 'no-store');
  try {
    if (secureAssets.enabled()) {
      const buf = await thumbnails.getThumbnailBuffer(row);
      if (!buf) return res.status(404).end();
      res.set('Content-Type', 'image/jpeg');
      return res.end(buf);
    }
    const thumbPath = await thumbnails.getThumbnail(row);
    if (!thumbPath) return res.status(404).end();
    res.sendFile(thumbPath, (err) => {
      if (err && !res.headersSent) res.status(err.status || 500).end();
    });
  } catch (err) {
    res.status(500).end();
  }
});

// ── Startup ────────────────────────────────────────────────────────────────

// Temp frames used to persist forever. Wipe the dir's CONTENTS (not the dir) on
// startup and graceful shutdown so nothing derived — including the plaintext
// temp copies the secure-assets path writes and deletes — is left lying around.
function wipeTempDir() {
  const dir = config.paths.tempDir;
  // Gate on the app-owned marker: never wipe a temp dir pointed at user data.
  if (!ownedDir.guardSweep(dir, 'startup/shutdown temp wipe')) return 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (name === ownedDir.MARKER_NAME) continue;   // keep the marker across wipes
    try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); n++; } catch {}
  }
  return n;
}

let _shutdownHooked = false;
function _installShutdownHooks() {
  if (_shutdownHooked) return;
  _shutdownHooked = true;
  const onExit = async (signal) => {
    // Producers first, and WAITED FOR: each owns an FFmpeg child and a temp dir
    // under tempDir, and the children have to be gone before the wipe, or one
    // still writes into the directory being cleared (or outlives the server).
    try { await require('../lib/stream/session').stopAll(); } catch {}
    try { wipeTempDir(); } catch {}
    try { secureAssets.close(); } catch {}
    process.exit(signal === 'SIGTERM' ? 143 : 130);
  };
  process.on('SIGINT', () => onExit('SIGINT'));
  process.on('SIGTERM', () => onExit('SIGTERM'));
}

// One-time idempotent boot repair: images/gifs imported through the viewer's
// add-paths flow before the classification fix were stored as media_type
// 'video' (that endpoint used the processor registry, where the video
// processor deliberately claims image/gif extensions). Correct any such rows
// in place, keyed off the filepath extension. Touches media_type ONLY —
// duration/dimensions/thumbnails are left as-is (harmless/NULL on images).
// Idempotent: after repair no row matches. Silent when nothing changed.
function repairMisclassifiedMediaTypes() {
  try {
    const conn = db.get();
    const fixes = [
      { type: 'image', exts: config.extensions.image },
      { type: 'gif', exts: config.extensions.gif },
    ];
    let total = 0;
    for (const { type, exts } of fixes) {
      if (!exts || !exts.length) continue;
      const likes = exts.map(() => 'lower(filepath) LIKE ?').join(' OR ');
      const params = exts.map(e => '%' + e.toLowerCase());
      const info = conn.prepare(
        `UPDATE media SET media_type = ? WHERE media_type = 'video' AND (${likes})`
      ).run(type, ...params);
      total += info.changes;
    }
    if (total > 0) {
      console.log(`[Import] repaired ${total} media rows misclassified as video (image/gif)`);
    }
  } catch (err) {
    console.warn(`[Import] media-type repair skipped: ${err.message}`);
  }
}

function start(args = process.argv.slice(2)) {
  // Boot-phase timing. Off by default (keeps the exe user's console clean);
  // set VAULT_BOOT_TIMING=1 to print a one-line breakdown of where startup
  // spends its wall-clock — the fast way to tell a slow readdir from a slow
  // tool-probe when someone reports a laggy launch.
  const _bootT0 = process.hrtime.bigint();
  const _bootMarks = [];
  let _bootReported = false;
  const _bootMark = (name) => {
    if (!process.env.VAULT_BOOT_TIMING) return;
    const ms = Number(process.hrtime.bigint() - _bootT0) / 1e6;
    // Marks landing after the report (async passes finishing post-listen)
    // print standalone with their absolute offset from process start.
    if (_bootReported) console.log(`[boot-timing] ${name} done @ ${ms.toFixed(0)}ms`);
    else _bootMarks.push([name, ms]);
  };
  const _bootReport = () => {
    _bootReported = true;
    if (!process.env.VAULT_BOOT_TIMING || !_bootMarks.length) return;
    let prev = 0;
    const parts = _bootMarks.map(([n, ms]) => {
      const d = ms - prev; prev = ms; return `${n} ${d.toFixed(0)}ms`;
    });
    console.log(`[boot-timing] ${parts.join('  ·  ')}  ·  total ${prev.toFixed(0)}ms`);
  };

  // Encrypted DB + no/wrong VAULT_DB_PASSWORD → boot LOCKED (the
  // viewer shows the lock screen and unlocks with the passphrase) instead
  // of crashing. Any other init failure is still fatal.
  let bootedLocked = false;
  try {
    db.init(config.paths.database, config.getDbPassword());
  } catch (err) {
    if (err.code === 'DB_ENCRYPTED') {
      vault.bootLocked();
      bootedLocked = true;
    } else if (err.code === 'VAULT_NO_CIPHER') {
      // Password set but no cipher module — the main DB would be plaintext.
      // Same hard refusal as the secure-assets handler below.
      console.error('');
      console.error('  ✖ Vault misconfiguration — REFUSING TO START');
      console.error('  ' + err.message);
      console.error('');
      process.exit(1);
    } else {
      throw err;
    }
  }

  _bootMark('db.init');

  // App-owned-directory adoption (audit findings A/B/C): before ANY sweep, mark
  // the managed roots the app created. A pre-existing markerless dir is adopted
  // only when empty / all-app-pattern; a dir holding unrecognized user files is
  // left unmarked and every sweep on it is skipped + warned. Runs before
  // wipeTempDir and migrateFromDisk so a legit older-version cache is adopted
  // and its sweeps proceed as before.
  ownedDir.adoptOnStartup(config.paths.tempDir, 'temp', 'temp-frames');
  try {
    ownedDir.adoptOnStartup(require('../lib/video-transcriber').TEMP_AUDIO_DIR, 'tempaudio', 'temp-audio');
  } catch { /* transcriber optional at boot */ }
  // thumbnailDir — and a REDIRECTED subtitles root (VAULT_SUBS outside
  // thumbnailDir, which the parent marker doesn't cover) — can hold the whole
  // library's artifacts on a slow/cold disk, and adoption reads EVERY directory
  // entry. Async, off the boot path: a 100k-file cold readdir never stands
  // between double-click and a reachable UI, and requests are served while it
  // runs. migrateFromDisk (both boot modes) awaits this promise so its sweep
  // still sees the marker adoption just wrote; a per-request sweep (delete
  // cleanup) that raced it would skip-and-warn, never delete.
  const slowDirsAdopted = (async () => {
    await ownedDir.adoptOnStartupAsync(config.paths.thumbnailDir, 'thumbs', 'thumbnails');
    if (secureAssets.subtitlesRedirected()) {
      await ownedDir.adoptOnStartupAsync(secureAssets.subtitlesDir(), 'subs', 'subtitles');
    }
    _bootMark('adopt-slow-dirs');
  })().catch((err) => {
    // Nothing in the pass should reject (every callee self-catches), but the
    // two .then() chains below must never become unhandled rejections.
    console.warn(`[owned-dir] startup adoption pass failed: ${err.message}`);
  });

  // Temp hygiene: clear stale/plaintext temp artifacts on every startup.
  _bootMark('adopt-temp-dirs');
  wipeTempDir();
  _installShutdownHooks();
  _bootMark('wipe-temp');

  if (bootedLocked) {
    // Route mounts skipped their boot-time DB cleanup — run it on first unlock
    let staleJobsDone = false;
    vault.onChange((e) => {
      if (e !== 'unlocked' || staleJobsDone) return;
      staleJobsDone = true;
      try { require('../lib/pmv/repo').failStaleJobs(); } catch {}
      try { require('../lib/subtitles/repo').failStaleJobs(); } catch {}
      try { require('../lib/musicid/exporter').failStaleExports(); } catch {}
      repairMisclassifiedMediaTypes();
    });
    // The secure-assets store opens on first unlock (vault.unlock); sweep any
    // pre-existing plaintext artifacts into it once the key is available.
    let migrated = false;
    vault.onChange((e) => {
      if (e !== 'unlocked' || migrated) return;
      migrated = true;
      slowDirsAdopted.then(() => {
        try { secureAssets.migrateFromDisk(); } catch (err) { console.warn(`[SecureAssets] migration skipped: ${err.message}`); }
      });
    });
    // Vault-status line (booted locked → encrypted, key not yet available).
    console.log('Vault: LOCKED — encrypted; unlock in the viewer to open the encrypted secure_assets store');
  } else {
    // Main DB opened cleanly. Open the derived-artifact store with the same
    // password (no-op when vault mode is off). A password set WITHOUT the cipher
    // module is a HARD failure — never silently run plaintext (B2). Migration
    // failures, by contrast, are non-fatal.
    try {
      secureAssets.init(config.getDbPassword());
    } catch (err) {
      if (err.code === 'VAULT_NO_CIPHER') {
        console.error('');
        console.error('  ✖ Vault misconfiguration — REFUSING TO START');
        console.error('  ' + err.message);
        console.error('');
        process.exit(1);
      }
      throw err;
    }
    // Exactly one vault-status line stating the mode (B1).
    if (secureAssets.enabled()) {
      console.log(`Vault: ON — derived artifacts encrypted in secure_assets.db at ${path.resolve(secureAssets.storePath())}`);
      // After the async adoption pass — the migration sweep is gated on the
      // marker that pass may have just written (and is itself a full-directory
      // walk that has no business on the boot path).
      slowDirsAdopted.then(() => {
        try { secureAssets.migrateFromDisk(); } catch (err) { console.warn(`[SecureAssets] migration skipped: ${err.message}`); }
      });
    } else {
      console.log('Vault: OFF — no password set; derived artifacts stored as plain files');
    }
  }

  // Booted with the DB already open → repair now. (Locked boots defer this to
  // first unlock, wired into the stale-job cleanup above.)
  if (!bootedLocked) repairMisclassifiedMediaTypes();

  gamifyEnabled = resolveGamifyEnabled(args);
  if (gamifyEnabled) {
    // Settle decay/streak once at startup so the first UI read is current —
    // deferred to first unlock when the vault booted locked (needs the DB)
    let gamifyBooted = false;
    const bootGamify = () => {
      if (gamifyBooted) return;
      gamifyBooted = true;
      require('../lib/gamify').settleDay();
      require('../lib/quests').ensureQuests();
    };
    if (bootedLocked) vault.onChange((e) => { if (e === 'unlocked') bootGamify(); });
    else bootGamify();
  }

  // A running scan blocks non-forced locks and keeps the autolock clock alive
  vault.registerScanProbe(() => importQueue.isActive() || _rescanning.size > 0);
  // A saved autolock value overrides the config default. Env still wins the very
  // first run (see lib/app-settings.js) — after that this file is the truth, so
  // the exe user who has no env vars still gets the timeout they chose.
  const savedAutolock = appSettings.all().autolockMinutes;
  if (typeof savedAutolock === 'number' && Number.isFinite(savedAutolock)) {
    config.security.autolockMinutes = Math.max(0, Math.min(1440, Math.trunc(savedAutolock)));
  }
  vault.startAutolock();
  _bootMark('db-open-housekeeping');

  const { host, port } = config.server;
  app.listen(port, host, () => {
    _bootMark('listen-ready');
    _bootReport();
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │  Vault                                       │');
    console.log(`  │  http://${host}:${port}                      │`);
    console.log('  └──────────────────────────────────────────────┘');
    console.log('');
    console.log(`  Database:   ${path.resolve(config.paths.database)}`);
    console.log(`  Vault:      ${vault.isLocked() ? 'LOCKED — unlock from the viewer (click the logo)' : vault.isEncrypted() ? `unlocked (autolock ${config.security.autolockMinutes || 'off'} min)` : 'no password set (click the logo to create one)'}`);
    console.log(`  Thumbnails: ${path.resolve(config.paths.thumbnailDir)}`);
    console.log(`  Gamify:     ${gamifyEnabled ? 'ON (all data stays local — --no-gamify to disable)' : 'off (start with --gamify to enable)'}`);
    console.log('  Local-only (127.0.0.1). Ctrl+C to stop.');
    console.log('');

    // "Install ffmpeg, then restart Vault" is what those rows' error messages
    // told the user to do — so this is the restart, and nothing was healing.
    // Off the listen path entirely (it re-probes files and may fork pip) and
    // deferred to first unlock when the vault booted locked, since it reads the
    // main DB. Failure here is never fatal.
    let selfHealed = false;
    const selfHeal = () => {
      if (selfHealed) return;
      selfHealed = true;
      setImmediate(() => require('../lib/self-heal')
        .run({ reason: 'startup' })
        .catch(err => console.warn(`[Self-heal] skipped: ${err.message}`)));
    };
    if (bootedLocked) vault.onChange((e) => { if (e === 'unlocked') selfHeal(); });
    else selfHeal();

    // Say it here, once, in the window the user is already looking at — rather
    // than letting them find out one failed file at a time. Deferred off the
    // listen callback: checkTools() spawns ffprobe/fpcalc synchronously, and on
    // a fresh unsigned exe Defender can hold that first child-process spawn for
    // seconds — the UI should be reachable while that probe runs.
    setImmediate(() => {
      const tools = checkTools();
      if (!tools.ffmpeg.ok) {
        console.log('  ┌──────────────────────────────────────────────────────┐');
        console.log('  │  ⚠  ffmpeg / ffprobe not found on PATH               │');
        console.log('  └──────────────────────────────────────────────────────┘');
        console.log('  Scanning, thumbnails and duration all need it. Install with:');
        console.log('');
        console.log(`      ${FFMPEG_INSTALL.winget}`);
        console.log('');
        console.log(`  …or grab a build from ${FFMPEG_INSTALL.url}`);
        console.log('  Easiest: the viewer that just opened has a ⬇ Download button in the');
        console.log('  banner at the top — it fetches ffmpeg next to Vault, no restart needed.');
        console.log('');
      }
    });
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start, run: start };
