/**
 * Opens and runs the Stage window (PLAYLISTS_SPEC 5).
 *
 * Two ways to show Stage:
 *   webview2  Windows: a frameless WebView2 window run by a small PowerShell
 *             helper (lib/stage/host-script.js). What viewers see in Discord
 *             is the page and nothing else.
 *   popup     anywhere else, or when the helper cannot run: the viewer opens
 *             /stage itself with window.open, and the page offers "Fill this
 *             screen" (Fullscreen API).
 *
 * VAULT_STAGE_HOST=popup|webview2 picks one outright. Without it: webview2 on
 * Windows when the WebView2 Runtime and the SDK files (lib/stage/sdk.js) are
 * there, unless VAULT_DISABLE_NATIVE_PICKER=1 (test and scratch servers, so
 * nothing they do puts a window on the desktop). A test server that needs the
 * real window sets VAULT_STAGE_HOST=webview2 as well.
 *
 * One window at a time. Its user data (WebView2's profile and cache) goes in
 * <data>/stage-webview, never next to the helper. The helper closes when
 * Vault's process ends (it watches it, and its stdin closes), and Vault kills
 * it on the way out too, so no window outlives Vault.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { ROOT } = require('../approot');
const sdk = require('./sdk');
const { SCRIPT } = require('./host-script');

/** Chromium switches: never slow down or pause a covered or unfocused Stage. */
const BROWSER_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-features=CalculateNativeWinOcclusion,BackgroundVideoTrackOptimization,IntensiveWakeUpThrottling',
];

const MAX_LINE = 64 * 1024;   // a helper line longer than this is not the helper

/** Is a process with this id running? */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Leftovers of a helper (or a Vault) that was killed hard: its temp script
 * (vault-stage-<pid>-<time>.ps1) and its launch folder, when that Vault
 * process is not running any more.
 */
function sweepStale(udd, tmp = os.tmpdir()) {
  const swept = [];
  try {
    for (const f of fs.readdirSync(tmp)) {
      const m = /^vault-stage-(\d+)-\d+\.ps1$/.exec(f);
      if (m && Number(m[1]) !== process.pid && !pidAlive(Number(m[1]))) {
        try { fs.unlinkSync(path.join(tmp, f)); swept.push(f); } catch {}
      }
    }
  } catch {}
  const launches = path.join(udd, 'sdk-launch');
  try {
    for (const f of fs.readdirSync(launches)) {
      const m = /^(\d+)-\d+$/.exec(f);
      if (m && Number(m[1]) !== process.pid && !pidAlive(Number(m[1]))) {
        try { fs.rmSync(path.join(launches, f), { recursive: true, force: true }); swept.push(f); } catch {}
      }
    }
  } catch {}
  return swept;
}

function dataDir(env = process.env) {
  return env.VAULT_STAGE_DATA ? path.resolve(env.VAULT_STAGE_DATA) : path.join(ROOT, 'stage-webview');
}

/* ── Is the WebView2 Runtime there? (Windows' own copy, registry) ──────── */

const RUNTIME_KEYS = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
];
let _runtime = null;   // { at, version }

function queryRuntime(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', 'pv'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      const m = /pv\s+REG_SZ\s+(\S+)/.exec(String(out));
      resolve(m && m[1] !== '0.0.0.0' ? m[1] : null);
    });
  });
}

async function runtimeVersion() {
  if (process.platform !== 'win32') return null;
  if (_runtime && Date.now() - _runtime.at < 5 * 60000) return _runtime.version;
  let version = null;
  for (const k of RUNTIME_KEYS) {
    version = await queryRuntime(k);
    if (version) break;
  }
  _runtime = { at: Date.now(), version };
  return version;
}

/**
 * Which way Stage opens on this machine, and why.
 * Pure apart from what it is handed, for the tests.
 */
function chooseMode({ env = process.env, platform = process.platform, runtime = null, sdkOk = false } = {}) {
  const want = String(env.VAULT_STAGE_HOST || '').toLowerCase();
  if (want === 'popup') return { mode: 'popup', reason: 'VAULT_STAGE_HOST=popup' };
  if (platform !== 'win32') return { mode: 'popup', reason: 'not Windows' };
  if (want !== 'webview2' && env.VAULT_DISABLE_NATIVE_PICKER === '1') return { mode: 'popup', reason: 'native windows are off (VAULT_DISABLE_NATIVE_PICKER)' };
  if (!runtime) return { mode: 'popup', reason: 'the WebView2 Runtime is not installed' };
  if (!sdkOk) return { mode: 'popup', reason: 'the WebView2 files are missing or changed' };
  return { mode: 'webview2', reason: null };
}

/* ── The helper process ────────────────────────────────────────────────── */

/**
 * @param {object} opts
 * @param {(line: object) => void} opts.onEvent  parsed lines from the helper
 * @param {(info: {byUser: boolean, code: number|null, error: string|null}) => void} opts.onExit
 */
function createHost({ onEvent = () => {}, onExit = () => {}, env = process.env } = {}) {
  let child = null;
  let lastError = null;
  let reason = null;
  let scriptPath = null;
  let failedAt = 0;          // the helper could not start: popup for a while

  async function mode() {
    if (failedAt && Date.now() - failedAt < 10 * 60000 && String(env.VAULT_STAGE_HOST || '').toLowerCase() !== 'webview2') {
      return { mode: 'popup', reason: lastError || 'the Stage window could not start' };
    }
    const runtime = await runtimeVersion();
    // What the remote shows only; launch() checks the files again, uncached.
    const v = process.platform === 'win32' ? sdk.looksPresent(sdk.sdkDir(env)) : { ok: false };
    return chooseMode({ env, runtime, sdkOk: v.ok });
  }

  function alive() { return !!child && child.exitCode === null && !child.killed; }

  function sendLine(line) {
    if (!alive()) return false;
    try { child.stdin.write(`${line}\n`); return true; } catch { return false; }
  }

  function parse(line) {
    const [word, ...rest] = line.trim().split(' ');
    if (word === 'bounds') {
      const n = rest.map(Number);
      if (n.length < 17 || n.some(x => !Number.isFinite(x))) return null;
      const r = (i) => ({ x: n[i], y: n[i + 1], w: n[i + 2], h: n[i + 3] });
      return { type: 'bounds', win: r(0), client: r(4), work: r(8), max: n[12] === 1, normal: r(13) };
    }
    if (word === 'ready') return { type: 'ready', hwnd: rest[0] || null };
    if (word === 'runtime') return { type: 'runtime', version: rest[0] || null };
    if (word === 'closing') return { type: 'closing', why: rest[0] || 'user' };
    if (word === 'error') return { type: 'error', message: rest.join(' ') };
    return null;
  }

  /**
   * Start the window (or bring the one that is open to the front).
   * @returns {Promise<{ok: boolean, reused?: boolean, error?: string}>}
   */
  async function launch({ url, title, bounds = null, client = null, mute = false }) {
    if (alive()) { front(); return { ok: true, reused: true }; }
    const dir = sdk.sdkDir(env);
    const check = sdk.verify(dir);
    if (!check.ok) return { ok: false, error: 'The Stage window files are missing.' };
    const udd = dataDir(env);
    try { fs.mkdirSync(udd, { recursive: true }); } catch {}
    sweepStale(udd);
    // The helper writes the bytes it checked here and loads them from here only.
    const launchDir = path.join(udd, 'sdk-launch', `${process.pid}-${Date.now()}`);
    scriptPath = path.join(os.tmpdir(), `vault-stage-${process.pid}-${Date.now()}.ps1`);
    fs.writeFileSync(scriptPath, SCRIPT);
    // VAULT_STAGE_BROWSER_ARGS: more switches, for checks (a remote debugging port).
    const extra = String(env.VAULT_STAGE_BROWSER_ARGS || '').split(/\s+/).filter(a => /^--[a-z0-9-]+(=[\w.,:-]*)?$/i.test(a));
    const args = [...BROWSER_ARGS, ...(mute ? ['--mute-audio'] : []), ...extra].join(' ');
    const childEnv = {
      ...process.env,
      VAULT_STAGE_URL: url,
      VAULT_STAGE_UDD: udd,
      VAULT_STAGE_SDK: dir,
      VAULT_STAGE_PINS: sdk.pinsEnv(),
      VAULT_STAGE_LAUNCH: launchDir,
      VAULT_STAGE_TITLE: title || 'Vault Stage',
      VAULT_STAGE_BOUNDS: bounds ? [bounds.x, bounds.y, bounds.w, bounds.h, bounds.max ? 1 : 0].join(',') : '',
      VAULT_STAGE_CLIENT: client ? `${client.w},${client.h}` : '',
      VAULT_STAGE_PARENT: String(process.pid),
      VAULT_STAGE_ARGS: args,
      VAULT_STAGE_MUTE: mute ? '1' : '',
    };
    lastError = null;
    let byUser = false;
    let started = false;
    const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', scriptPath],
      { windowsHide: true, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    let buf = '';
    let errText = '';
    let resolveStart;
    const startedP = new Promise((resolve) => { resolveStart = resolve; });
    proc.stdout.on('data', (d) => {
      buf += d;
      // The helper only ever prints short lines: anything else is not it talking.
      if (buf.length > MAX_LINE && buf.indexOf('\n') === -1) {
        buf = '';
        lastError = 'the Stage window sent something unexpected';
        try { proc.kill(); } catch {}
        return;
      }
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        const ev = parse(line);
        if (!ev) continue;
        if (ev.type === 'ready') { started = true; resolveStart({ ok: true }); }
        if (ev.type === 'closing') byUser = ev.why === 'user' || ev.why === 'cmd';
        if (ev.type === 'error') lastError = ev.message;
        onEvent(ev);
      }
    });
    proc.stderr.on('data', (d) => { errText = (errText + d).slice(-4000); });
    proc.stdin.on('error', () => {});
    const done = (code) => {
      if (child === proc) child = null;
      try { fs.unlinkSync(scriptPath); } catch {}
      try { fs.rmSync(launchDir, { recursive: true, force: true }); } catch {}
      const error = lastError || (started ? null : (errText.trim().split('\n')[0] || `exit ${code}`));
      if (!started) {
        failedAt = Date.now();
        lastError = error;
        console.warn('[Stage] the Stage window could not start:', error);
        resolveStart({ ok: false, error: 'The Stage window could not start.' });
      }
      onExit({ byUser, code, error, started });
    };
    proc.on('error', (err) => { lastError = err.message; done(null); });
    proc.on('exit', (code) => done(code));
    // A helper that never gets a window up within 30 s counts as failed.
    const t = setTimeout(() => {
      if (!started && child === proc) { lastError = 'the Stage window took too long to open'; try { proc.kill(); } catch {} }
    }, 30000);
    if (t.unref) t.unref();
    return startedP;
  }

  function front() { sendLine('front'); }
  function close() { if (!sendLine('close')) return; const p = child; setTimeout(() => { if (p && p.exitCode === null) { try { p.kill(); } catch {} } }, 5000).unref?.(); }
  function setTitle(t) { sendLine(`title ${String(t || 'Vault Stage').replace(/[\r\n]+/g, ' ')}`); }
  function setClient(w, h) { sendLine(`client ${Math.round(w)} ${Math.round(h)}`); }
  function setRect(r) { sendLine(`rect ${Math.round(r.x)} ${Math.round(r.y)} ${Math.round(r.w)} ${Math.round(r.h)}`); }
  function kill() { if (child && child.exitCode === null) { try { child.kill(); } catch {} } }

  return { mode, alive, launch, front, close, setTitle, setClient, setRect, kill, parse, get reason() { return reason; } };
}

module.exports = { createHost, chooseMode, runtimeVersion, dataDir, sweepStale, pidAlive, BROWSER_ARGS, MAX_LINE };
