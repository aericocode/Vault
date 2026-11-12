'use strict';
/**
 * "Copy diagnostics" (Settings > About): a short plain-text report a tester
 * pastes into Discord when something does not work on their machine. Read
 * only: it looks at the OS, the desktop session, the GPU (lib/pmv/gpu-detect)
 * and which external tools answer, and changes nothing.
 *
 * Privacy: the report names no library paths, files or settings. Anything
 * that could still carry a personal path (a tool's own output, the GPU
 * check's error text) goes through redact(): the home folder becomes `~` and
 * the account name becomes `<user>`.
 *
 * collect() gathers, format() turns what was gathered into text. format() is
 * pure so the tests can feed it any shape, missing fields included.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const VERSION_TIMEOUT_MS = 4000;

/** Tools worth knowing about. `local`: Vault may have downloaded it next to itself (lib/ffmpeg-locate.js). */
const TOOLS = [
  { name: 'ffmpeg', args: ['-version'], local: true },
  { name: 'ffprobe', args: ['-version'], local: true },
  { name: 'fpcalc', args: ['-version'], local: true },
  { name: 'mpv', args: ['--no-config', '--version'] },
  // The Linux desktop file pickers. Meaningless elsewhere, so not asked there.
  { name: 'zenity', args: ['--version'], linuxOnly: true },
  { name: 'kdialog', args: ['--version'], linuxOnly: true },
];

/** /etc/os-release → { NAME, VERSION_ID, PRETTY_NAME, … } (quotes removed). */
function parseOsRelease(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2').replace(/\\(["'$`\\])/g, '$1');
  }
  return out;
}

/** The version in a tool's first line of output ("ffmpeg version 6.1.1-3ubuntu5 Copyright…" → "6.1.1-3ubuntu5"). */
function parseToolVersion(stdout) {
  const first = String(stdout || '').split(/\r?\n/).find(l => l.trim()) || '';
  const m = /\bversion\s+v?([0-9][\w.+~:-]*|n[0-9][\w.+~-]*|N-[\w.+~-]+)/i.exec(first)
    || /\b(?:mpv|kdialog)\s+v?([0-9][\w.+~-]*)/i.exec(first)
    || /^v?([0-9]+\.[0-9]+[\w.+~-]*)\s*$/.exec(first.trim());
  return m ? m[1] : null;
}

/** Is `name` an executable file in one of PATH's folders? */
function onPath(name, { env = process.env, platform = process.platform, fsx = fs } = {}) {
  // PATH is this machine's, so its own separator (C:\… holds a colon).
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      try {
        const p = path.join(d, name + ext);
        const st = fsx.statSync(p);
        if (st.isFile()) return true;
      } catch { /* not here */ }
    }
  }
  return false;
}

function askVersion(cmd, args, { run = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      run(cmd, args, { windowsHide: true, timeout: VERSION_TIMEOUT_MS, maxBuffer: 512 * 1024, shell: false }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return resolve({ ran: false });
        resolve({ ran: true, version: parseToolVersion(stdout) || parseToolVersion(stderr) });
      });
    } catch { resolve({ ran: false }); }
  });
}

/**
 * One tool: { found, version, where } where `where` is 'next to Vault' or
 * 'on PATH'. Never a path.
 */
async function checkTool(t, { platform = process.platform, env = process.env, run, resolveLocal, findMpv } = {}) {
  if (t.linuxOnly && platform !== 'linux') return { skipped: true };
  if (t.name === 'mpv' && findMpv) {
    // Where Stage itself looks: the path chosen in Settings, the usual install
    // folders, then PATH (lib/stage/mpv-find.js).
    const f = await findMpv();
    if (!f || !f.found) return { found: false };
    const where = { chosen: 'chosen in Settings', default: 'standard folder', path: 'on PATH' }[f.source] || null;
    return { found: true, version: f.version || null, ...(where ? { where } : {}) };
  }
  let cmd = t.name;
  let where = 'on PATH';
  if (t.local && resolveLocal) {
    const r = resolveLocal(t.name);
    if (r && r !== t.name && path.isAbsolute(r)) { cmd = r; where = 'next to Vault'; }
  }
  if (where === 'on PATH' && !onPath(t.name, { env, platform })) return { found: false };
  const v = await askVersion(cmd, t.args, { run });
  if (!v.ran) return { found: false };
  return { found: true, version: v.version, where };
}

/** mpv as Stage finds it, with the path chosen in Settings › Stage (stageMpv). */
function defaultFindMpv() {
  let chosen = null;
  try {
    const m = require('./app-settings').all().stageMpv;
    if (m && typeof m.path === 'string') chosen = m.path;
  } catch { /* no settings yet */ }
  return require('./stage/mpv-find').findMpv({ chosen });
}

/** Everything the report needs, gathered from this machine. Never throws. */
async function collect({
  env = process.env,
  platform = process.platform,
  run = execFile,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  gpu = () => require('./pmv/gpu-detect').detectGPU(),
  findMpv = defaultFindMpv,
} = {}) {
  const info = {
    vaultVersion: null,
    node: process.version,
    sea: false,
    platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: null,
    distro: null,
    wsl: false,
    desktop: env.XDG_CURRENT_DESKTOP || null,
    sessionType: env.XDG_SESSION_TYPE || null,
    waylandDisplay: !!env.WAYLAND_DISPLAY,
    x11Display: !!env.DISPLAY,
    gpu: null,
    tools: {},
  };
  try { info.vaultVersion = require('../package.json').version; } catch {}
  try { info.sea = !!require('./approot').isSea; } catch {}
  try { info.osVersion = typeof os.version === 'function' ? os.version() : null; } catch {}
  if (platform === 'linux') {
    try { info.distro = parseOsRelease(readFile('/etc/os-release')).PRETTY_NAME || null; } catch {}
    try { info.wsl = /microsoft/i.test(readFile('/proc/version')); } catch {}
  }

  let resolveLocal = null;
  try { resolveLocal = require('./ffmpeg-locate').resolve; } catch {}
  const [gpuInfo, ...tools] = await Promise.all([
    Promise.resolve().then(gpu).catch((err) => ({ error: err && err.message })),
    ...TOOLS.map(t => checkTool(t, { platform, env, run, resolveLocal, findMpv }).catch(() => ({ found: false }))),
  ]);
  info.gpu = gpuInfo || null;
  TOOLS.forEach((t, i) => { info.tools[t.name] = tools[i]; });
  return info;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Take the home folder and the account name out of one value read from this
 * machine. The home folder goes first (it becomes `~`) and is matched with
 * either slash and, on Windows, any letter case. Then the account name, in
 * any letter case, wherever it stands as a whole word: a path segment
 * (/home/<name>/, C:\Users\<name>\, /Users/<name>/), a token in a version or
 * host string, but never inside a longer word ("ala" leaves "palace" alone,
 * also next to accented letters). A one-letter name is too common to hide.
 *
 * Only for values: format() runs it on each value it took from the system,
 * never on the finished report, so Vault's own words ("Vault diagnostics",
 * "next to Vault") stay as written whatever the account is called.
 */
function redact(text, { home = os.homedir(), user = safeUser(), platform = process.platform } = {}) {
  let out = String(text == null ? '' : text);
  if (home && home.length > 1) {
    const forms = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')]);
    for (const f of forms) {
      out = out.replace(new RegExp(escapeRe(f) + '(?![\\w.-])', platform === 'win32' ? 'gi' : 'g'), '~');
    }
  }
  if (user && user.length > 1) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escapeRe(user)}(?![\\p{L}\\p{M}\\p{N}_])`, 'giu'), () => '<user>');
  }
  return out;
}

function safeUser() {
  try { return os.userInfo().username; } catch { return process.env.USER || process.env.USERNAME || null; }
}

const OS_NAMES = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };

function toolLine(name, t, r) {
  if (!t) return `  ${name}: unknown`;
  if (t.skipped) return null;
  if (!t.found) return `  ${name}: missing`;
  return `  ${name}: ${t.version ? r(t.version) : 'found, version unknown'}${t.where ? ` (${t.where})` : ''}`;
}

/**
 * The CUDA decode part of the GPU line. ffmpeg listing the cuda hwaccel
 * (cudaListed) only says what the ffmpeg build can do, and no CUDA decode is
 * ever tried, so this never says yes: "not tested" when it might work, "no"
 * when NVENC's real test encode failed.
 */
function cudaDecodeText(g) {
  const listed = g.cudaListed !== undefined ? !!g.cudaListed : !!g.nvdec;
  if (!listed) return 'no';
  if (g.nvencFailed) return 'no (ffmpeg has it, but the NVIDIA test failed)';
  return 'not tested (ffmpeg has it)';
}

/**
 * The report text. Every field may be missing; the line then says "unknown".
 *
 * Privacy: values read from this machine (OS strings, desktop, session, a
 * tool's version, an error) each go through redact() on their own. Vault's
 * own words, and values Vault or Node fix (Vault's version, Node's version,
 * the processor type, the GPU labels, where a tool was found), are written as
 * they are and never redacted, so an account called "vault" or "x64" cannot
 * rewrite them.
 */
function format(info = {}, redactOpts = {}) {
  const plat = info.platform;
  const ropts = { platform: plat, ...redactOpts };
  const missing = (v) => v === null || v === undefined || v === '';
  const u = (v) => (missing(v) ? 'unknown' : String(v));
  const r = (v) => (missing(v) ? 'unknown' : redact(v, ropts));
  const yes = (v) => (v ? 'set' : 'not set');
  const osName = OS_NAMES[plat] || u(plat);
  const lines = [];
  lines.push('Vault diagnostics');
  lines.push(`Vault: ${u(info.vaultVersion)}${info.sea ? ' (packaged app)' : info.sea === false ? ' (from source)' : ''}`);
  lines.push(`Node: ${u(info.node)}`);
  lines.push(`OS: ${osName} ${u(info.arch)}${info.osVersion ? `, ${r(info.osVersion)}` : ''}, release ${r(info.osRelease)}`);
  if (plat === 'linux') {
    lines.push(`Distro: ${r(info.distro)}${info.wsl ? ' (WSL)' : ''}`);
    lines.push(`Desktop: ${r(info.desktop)}`);
    lines.push(`Session: ${r(info.sessionType)} (WAYLAND_DISPLAY ${yes(info.waylandDisplay)}, DISPLAY ${yes(info.x11Display)})`);
  }
  const g = info.gpu;
  if (!g) lines.push('GPU: unknown');
  else if (g.error && !g.label) lines.push(`GPU: unknown (${r(g.error)})`);
  else {
    lines.push(`GPU: ${u(g.label)}; NVENC ${g.nvenc ? 'yes' : 'no'}, CUDA decode ${cudaDecodeText(g)}`
      + (g.hint ? `; ${g.hint}` : '') + (g.error ? `; ffmpeg check failed: ${r(String(g.error).split('\n')[0])}` : ''));
  }
  lines.push('Tools:');
  const tools = info.tools || {};
  const names = [...new Set([...TOOLS.map(t => t.name), ...Object.keys(tools)])];
  for (const n of names) {
    const l = toolLine(n, tools[n], r);
    if (l) lines.push(l);
  }
  return lines.join('\n');
}

/** Gather and format, for the route. */
async function report(opts = {}) {
  return format(await collect(opts));
}

module.exports = { collect, format, redact, report, parseOsRelease, parseToolVersion, onPath, TOOLS };
