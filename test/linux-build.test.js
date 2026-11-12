'use strict';
/**
 * Linux build, CI and copy (LINUX_SPEC WP7 + WP8):
 *
 *  - player-lib/platform-words.js: Recycle Bin vs Trash, example paths and
 *    install lines follow the server's OS
 *  - the Settings pages say Trash and show Linux paths when the server is Linux
 *  - lib/diagnostics.js: the "Copy diagnostics" report (redaction, missing
 *    fields, what it gathers on Linux)
 *  - lib/trash.js: the ESM-only `trash` package is called as a function
 *    (require() hands back its namespace), and on Linux a file really lands
 *    in the freedesktop Trash with its .trashinfo
 *  - lib/platform.js cipherMissingHelp: plain words, the right packages
 *  - start.sh / scan.sh keep LF endings
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'player-lib');
const noop = () => {};
const plain = (x) => JSON.parse(JSON.stringify(x));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-linux-build-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_TRASH = path.join(tmp, 'vault-trash');
delete process.env.VAULT_DB_PASSWORD;

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

/* ── player-lib/platform-words.js ───────────────────────────────────────── */

const PW = require('../player-lib/platform-words.js');

test('platform words: Recycle Bin on Windows, Trash on Linux and macOS', () => {
  assert.strictEqual(PW.vaultPlatformWords('win32').recycleBin, 'Recycle Bin');
  assert.strictEqual(PW.vaultPlatformWords('win32').recycleBinChoice, 'Recycle Bin');
  for (const p of ['linux', 'darwin']) {
    const w = PW.vaultPlatformWords(p);
    assert.strictEqual(w.recycleBin, 'Trash');
    assert.match(w.recycleBinChoice, /Trash/);
    assert.doesNotMatch(JSON.stringify(w), /Recycle|Windows|C:\\|\.exe/);
  }
  // Anything else (freebsd, …) reads like Linux, never like Windows
  assert.strictEqual(PW.vaultPlatformWords('freebsd').recycleBin, 'Trash');
  assert.strictEqual(PW.vaultPlatformWords('win32').filePicker, 'file picker');
  assert.strictEqual(PW.vaultPlatformWords('linux').filePicker, 'file picker');
});

test('platform words: example paths per OS', () => {
  assert.strictEqual(PW.vaultPlatformWords('win32').examplePath, 'C:\\Media');
  assert.strictEqual(PW.vaultPlatformWords('linux').examplePath, '/home/you/Videos');
  assert.strictEqual(PW.vaultPlatformWords('darwin').examplePath, '/Users/you/Movies');
  for (const p of ['linux', 'darwin']) assert.ok(PW.vaultPlatformWords(p).examplePathNew.startsWith('/'));
});

test('install lines: winget on Windows, apt then dnf and pacman on Linux, brew on macOS', () => {
  assert.strictEqual(PW.vaultInstallLine('ffmpeg', 'win32').cmd, 'winget install ffmpeg');
  assert.deepStrictEqual(PW.vaultInstallLine('ffmpeg', 'win32').alts, []);
  const lin = PW.vaultInstallLine('mpv', 'linux');
  assert.strictEqual(lin.cmd, 'sudo apt install mpv');
  assert.deepStrictEqual(lin.alts.map(a => a.on), ['Fedora', 'Arch']);
  assert.strictEqual(PW.vaultInstallNote('mpv', 'linux'), 'On Fedora: sudo dnf install mpv. On Arch: sudo pacman -S mpv.');
  assert.strictEqual(PW.vaultInstallLine('python', 'darwin').cmd, 'brew install python');
  assert.strictEqual(PW.vaultInstallNote('python', 'darwin'), '');
  assert.strictEqual(PW.vaultInstallLine('mpv', 'win32'), null, 'no single command: null, not a guess');
  assert.strictEqual(PW.vaultInstallLine('nope', 'linux'), null);
  for (const tool of Object.keys(PW.VAULT_INSTALL_LINES)) {
    const l = PW.vaultInstallLine(tool, 'linux');
    assert.ok(l && !/winget|brew/.test(l.cmd + JSON.stringify(l.alts)), `${tool}: no winget or brew on Linux`);
  }
});

test('the guess before the server answers comes from the browser, and the server wins', () => {
  assert.strictEqual(PW.vaultGuessPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'win32');
  assert.strictEqual(PW.vaultGuessPlatform('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'), 'linux');
  assert.strictEqual(PW.vaultGuessPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)'), 'darwin');
  assert.strictEqual(PW.vaultGuessPlatform('Mozilla/5.0 (Linux; Android 14)'), 'win32', 'a phone says nothing about the server');

  // In a page: /api/about answers linux, the words follow it.
  const ctx = {
    console, Promise, JSON, Object, Date,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    fetch: async (url, opts) => {
      assert.strictEqual(url, '/api/about');
      assert.strictEqual(opts.headers['X-Vault-Background'], '1', 'not counted as the user being there');
      return { ok: true, json: async () => ({ name: 'Vault', version: '1', platform: 'linux' }) };
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(LIB, 'platform-words.js'), 'utf8') + '\n;globalThis.__pw = { vaultPlatformWords, vaultServerPlatform };', ctx);
  return new Promise(r => setTimeout(r, 20)).then(() => {
    assert.strictEqual(ctx.__pw.vaultServerPlatform(), 'linux');
    assert.strictEqual(ctx.__pw.vaultPlatformWords().recycleBin, 'Trash');
  });
});

/* ── Settings pages follow the words ───────────────────────────────────── */

function stubEl() {
  return {
    addEventListener: noop, appendChild: noop, prepend: noop, insertAdjacentHTML: noop, insertAdjacentElement: noop,
    setAttribute: noop, removeAttribute: noop, querySelector: () => null, querySelectorAll: () => [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {}, dataset: {},
  };
}

/** settings.js (with platform-words.js when `platform` is given), as settings-search.test.js loads it. */
function loadSettings(look, platform) {
  const store = { vault_settings: JSON.stringify({ layoutStyle: look }) };
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, Date, Promise, Error, Symbol,
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: noop,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { port: '8765', hostname: '127.0.0.1' },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    document: {
      readyState: 'loading', addEventListener: noop, body: stubEl(), documentElement: stubEl(),
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: stubEl,
    },
    escapeHtml: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    showToast: noop,
  };
  ctx.window = ctx;
  ctx.addEventListener = noop;
  ctx.dispatchEvent = noop;
  vm.createContext(ctx);
  const files = ['shortcuts.js', 'settings-kit.js', 'thumb-settings-ui.js', 'watchers-ui.js', 'scan-settings-ui.js', 'stage-settings-ui.js', 'stream-tags-settings.js', 'settings.js'];
  if (platform) files.unshift('platform-words.js');
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(LIB, f), 'utf8'), ctx);
  if (platform) vm.runInContext(`vaultSetServerPlatform(${JSON.stringify(platform)})`, ctx);
  return ctx;
}

for (const look of ['classic', 'modern']) {
  test(`Settings (${look}): delete mode and Move paths follow the server's OS`, () => {
    const lin = loadSettings(look, 'linux').vaultSettingsPageHtml('library');
    assert.match(lin, /System Trash/);
    assert.match(lin, /the Trash in your file manager/);
    assert.match(lin, /placeholder="\/home\/you\/Videos"/);
    assert.match(lin, /placeholder="\/media\/you\/Drive\/Videos"/);
    assert.doesNotMatch(lin, /Recycle Bin|recovered (?:by|from) Windows|C:\\Media|D:\\Media/);

    const win = loadSettings(look, 'win32').vaultSettingsPageHtml('library');
    assert.match(win, /Recycle Bin/);
    assert.match(win, /placeholder="C:\\Media"/);
    assert.doesNotMatch(win, /System Trash/);
    // The Windows text word for word as it was before Linux.
    const winDelete = look === 'modern'
      ? 'Trash folder can be undone. Recycle Bin is recovered from Windows. Permanent cannot be undone.'
      : 'What the 🗑 button does. Soft can be undone from the trash. Recycle Bin can be recovered by Windows. Permanent erases the file from disk straight away.';
    assert.ok(win.includes(winDelete), 'Windows delete mode text unchanged');

    // Without platform-words.js (older tests load settings.js alone): the Windows words, unchanged
    const bare = loadSettings(look, null).vaultSettingsPageHtml('library');
    assert.ok(bare.includes(winDelete));
    assert.match(bare, /Recycle Bin/);
    assert.match(bare, /placeholder="C:\\Media"/);
  });

  test(`Settings (${look}): About has Copy diagnostics`, () => {
    const html = loadSettings(look, 'linux').vaultSettingsPageHtml('about');
    assert.match(html, /id="settingsDiagBtn"/);
    assert.match(html, /data-sfind="diagnostics"/);
    assert.match(html, /No file names or folders from your library/);
    assert.doesNotMatch(html, /—/, 'no em dashes');
  });
}

test('Settings search: the delete mode and mpv lines read as before on Windows', () => {
  const descs = (platform) => {
    const ctx = { console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, Date, Promise,
      navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, fetch: async () => ({ ok: false }),
      window: { addEventListener: noop }, document: { addEventListener: noop, getElementById: () => null, querySelector: () => null } };
    vm.createContext(ctx);
    const files = ['shortcuts.js', 'settings-kit.js', 'settings-search.js'];
    if (platform) files.unshift('platform-words.js');
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(LIB, f), 'utf8'), ctx);
    if (platform) vm.runInContext(`vaultSetServerPlatform(${JSON.stringify(platform)})`, ctx);
    vm.runInContext('globalThis.__i = SETTINGS_INDEX', ctx);
    const by = (id) => ctx.__i.find(e => e.id === id).desc;
    return { del: by('deleteMode'), mpv: by('stagePlayer') };
  };
  for (const w of [descs('win32'), descs(null)]) {
    assert.strictEqual(w.del, 'What the trash button does: soft to the trash folder, the Recycle Bin, or permanent.');
    assert.match(w.mpv, /Choose mpv\.exe if Vault does not find it\.$/);
  }
  const lin = descs('linux');
  assert.match(lin.del, /the System Trash/);
  assert.doesNotMatch(lin.del, /Recycle Bin/);
  assert.match(lin.mpv, /Choose the mpv program if Vault does not find it\.$/);
});

/* ── lib/diagnostics.js ─────────────────────────────────────────────────── */

const diag = require('../lib/diagnostics');

const FULL = {
  vaultVersion: '3.10.0', node: 'v24.18.1', sea: true, platform: 'linux', arch: 'x64',
  osRelease: '6.8.0-45-generic', osVersion: '#45-Ubuntu SMP', distro: 'Ubuntu 24.04.1 LTS', wsl: false,
  desktop: 'ubuntu:GNOME', sessionType: 'wayland', waylandDisplay: true, x11Display: true,
  gpu: { label: 'GPU (NVENC h264)', nvenc: true, nvdec: true },
  tools: {
    ffmpeg: { found: true, version: '6.1.1-3ubuntu5', where: 'on PATH' },
    ffprobe: { found: true, version: '6.1.1-3ubuntu5', where: 'next to Vault' },
    fpcalc: { found: false },
    mpv: { found: true, version: 'v0.37.0', where: 'on PATH' },
    zenity: { found: true, version: '4.0.1', where: 'on PATH' },
    kdialog: { found: false },
  },
};

test('diagnostics: every line a tester needs, in plain text', () => {
  const t = diag.format(FULL, { home: '/home/alice', user: 'alice' });
  assert.match(t, /^Vault diagnostics$/m);
  assert.match(t, /^Vault: 3\.10\.0 \(packaged app\)$/m);
  assert.match(t, /^Node: v24\.18\.1$/m);
  assert.match(t, /^OS: Linux x64, #45-Ubuntu SMP, release 6\.8\.0-45-generic$/m);
  assert.match(t, /^Distro: Ubuntu 24\.04\.1 LTS$/m);
  assert.match(t, /^Desktop: ubuntu:GNOME$/m);
  assert.match(t, /^Session: wayland \(WAYLAND_DISPLAY set, DISPLAY set\)$/m);
  assert.match(t, /^GPU: GPU \(NVENC h264\); NVENC yes, CUDA decode not tested \(ffmpeg has it\)$/m);
  assert.match(t, /^ {2}ffmpeg: 6\.1\.1-3ubuntu5 \(on PATH\)$/m);
  assert.match(t, /^ {2}ffprobe: 6\.1\.1-3ubuntu5 \(next to Vault\)$/m);
  assert.match(t, /^ {2}fpcalc: missing$/m);
  assert.match(t, /^ {2}mpv: v0\.37\.0 \(on PATH\)$/m);
  assert.match(t, /^ {2}zenity: 4\.0\.1 \(on PATH\)$/m);
  assert.match(t, /^ {2}kdialog: missing$/m);
  assert.doesNotMatch(t, /—/);
});

test('diagnostics: missing fields say unknown, Windows has no Linux-only lines', () => {
  const t = diag.format({ platform: 'win32' }, { home: 'C:\\Users\\bob', user: 'bob' });
  assert.match(t, /^Vault: unknown$/m);
  assert.match(t, /^Node: unknown$/m);
  assert.match(t, /^OS: Windows unknown, release unknown$/m);
  assert.match(t, /^GPU: unknown$/m);
  assert.match(t, /^ {2}ffmpeg: unknown$/m);
  assert.doesNotMatch(t, /Distro|Desktop|Session/);
  // Empty input does not throw either
  assert.match(diag.format(), /^Vault diagnostics/);
  // A GPU check that failed outright
  assert.match(diag.format({ platform: 'linux', gpu: { error: 'spawn ffmpeg ENOENT' } }), /^GPU: unknown \(spawn ffmpeg ENOENT\)$/m);
  // Skipped tools (zenity off Linux) leave no line
  assert.doesNotMatch(diag.format({ platform: 'win32', tools: { zenity: { skipped: true } } }), /zenity/);
});

test('diagnostics: the home folder becomes ~ and the account name <user>', () => {
  const info = {
    ...FULL,
    gpu: { label: 'CPU (libx264)', nvenc: false, nvdec: false, error: 'Command failed: /home/alice/bin/ffmpeg -encoders' },
    tools: { ffmpeg: { found: true, version: 'alice-build-7', where: 'on PATH' } },
  };
  const t = diag.format(info, { home: '/home/alice', user: 'alice' });
  assert.match(t, /~\/bin\/ffmpeg/);
  assert.match(t, /<user>-build-7/);
  assert.doesNotMatch(t, /alice/);

  // Windows: either slash, any case
  const w = diag.redact('C:\\Users\\Bob\\x and c:/users/bob/y and BOB', { home: 'C:\\Users\\Bob', user: 'Bob', platform: 'win32' });
  assert.strictEqual(w, '~\\x and ~/y and <user>');
  // A longer folder that only starts like home is not cut
  assert.strictEqual(diag.redact('/home/alice2/x', { home: '/home/alice', user: null, platform: 'linux' }), '/home/alice2/x');
  // A user name inside another word is left alone
  assert.strictEqual(diag.redact('palace', { home: '/x', user: 'ala', platform: 'linux' }), 'palace');
});

// The tester's machine: Ubuntu in a VM, no NVIDIA card, account "vault".
const VM = {
  vaultVersion: '3.10.0', node: 'v24.22.2', sea: true, platform: 'linux', arch: 'x64',
  osRelease: '7.0.0-43-generic', osVersion: '#43-Ubuntu SMP PREEMPT_DYNAMIC Fri Oct 23 13:25:25 UTC 2026',
  distro: 'Ubuntu 26.04.1 LTS', wsl: false,
  desktop: 'ubuntu:GNOME', sessionType: 'wayland', waylandDisplay: true, x11Display: true,
  gpu: { label: 'CPU (libx264), NVENC failed validation', nvenc: false, nvencFailed: true, nvdec: false, cudaListed: true },
  tools: {
    ffmpeg: { found: true, version: '8.0.1-3ubuntu2', where: 'on PATH' },
    ffprobe: { found: true, version: '8.0.1-3ubuntu2', where: 'on PATH' },
    fpcalc: { found: true, version: '1.5.1', where: 'next to Vault' },
    mpv: { found: true, version: 'v0.41.0', where: 'standard folder' },
    zenity: { found: true, version: '4.2.1', where: 'on PATH' },
    kdialog: { found: false },
  },
};

test('diagnostics: an account called "vault" (or like any other fixed word) leaves Vault\'s own text alone', () => {
  const t = diag.format(VM, { home: '/home/vault', user: 'vault' });
  assert.strictEqual(t, [
    'Vault diagnostics',
    'Vault: 3.10.0 (packaged app)',
    'Node: v24.22.2',
    'OS: Linux x64, #43-Ubuntu SMP PREEMPT_DYNAMIC Fri Oct 23 13:25:25 UTC 2026, release 7.0.0-43-generic',
    'Distro: Ubuntu 26.04.1 LTS',
    'Desktop: ubuntu:GNOME',
    'Session: wayland (WAYLAND_DISPLAY set, DISPLAY set)',
    'GPU: CPU (libx264), NVENC failed validation; NVENC no, CUDA decode no (ffmpeg has it, but the NVIDIA test failed)',
    'Tools:',
    '  ffmpeg: 8.0.1-3ubuntu2 (on PATH)',
    '  ffprobe: 8.0.1-3ubuntu2 (on PATH)',
    '  fpcalc: 1.5.1 (next to Vault)',
    '  mpv: v0.41.0 (standard folder)',
    '  zenity: 4.2.1 (on PATH)',
    '  kdialog: missing',
  ].join('\n'));

  // Other names that are also fixed words in the report: the fixed words stay
  const fixedLines = (s) => s.split('\n').filter(l => !/^(OS|Distro|Desktop|Session):/.test(l));
  const base = fixedLines(diag.format(VM, { home: '/home/zz', user: 'zz' }));
  for (const user of ['vault', 'VAULT', 'node', 'linux', 'x64', 'on', 'path', 'gpu', 'cpu', 'nvenc', 'cuda',
    'tools', 'missing', 'unknown', 'next', 'to', 'standard', 'folder', 'packaged', 'app', 'diagnostics', 'v']) {
    const lines = fixedLines(diag.format(VM, { home: `/home/${user}`, user }));
    assert.deepStrictEqual(lines, base, `account "${user}"`);
    assert.doesNotMatch(lines.join('\n'), /<user>/, `account "${user}"`);
  }
  // A missing value still reads "unknown" for an account called "unknown"
  assert.match(diag.format({ platform: 'linux' }, { home: '/home/unknown', user: 'unknown' }), /^Distro: unknown$/m);
});

test('diagnostics: the account name is still hidden in values from the system', () => {
  const opts = { home: '/home/vault', user: 'vault', platform: 'linux' };
  // Linux, Windows and mac style paths, home or not
  assert.strictEqual(diag.redact('/home/vault/bin/ffmpeg', opts), '~/bin/ffmpeg');
  assert.strictEqual(diag.redact('/srv/vault/ffmpeg and /home/Vault/x', opts), '/srv/<user>/ffmpeg and /home/<user>/x');
  assert.strictEqual(diag.redact('C:\\Users\\vault\\ffmpeg.exe', opts), 'C:\\Users\\<user>\\ffmpeg.exe');
  assert.strictEqual(diag.redact('/Users/vault/Applications/mpv', opts), '/Users/<user>/Applications/mpv');
  assert.strictEqual(diag.redact('C:\\Users\\Vault\\AppData\\x', { home: 'C:\\Users\\Vault', user: 'Vault', platform: 'win32' }), '~\\AppData\\x');
  assert.strictEqual(diag.redact('/Users/vault/x', { home: '/Users/vault', user: 'vault', platform: 'darwin' }), '~/x');
  // A whole token in a host or version string
  assert.strictEqual(diag.redact('#1 SMP vault-pc 6.8', opts), '#1 SMP <user>-pc 6.8');
  assert.strictEqual(diag.redact('build by VAULT', opts), 'build by <user>');

  // And in the report: each system value is hidden, the fixed text is not
  const t = diag.format({
    ...VM,
    osVersion: '#43-Ubuntu SMP vault@vault-vm', distro: 'Vault OS', desktop: 'vault', sessionType: 'x11',
    gpu: { label: 'CPU (libx264)', nvenc: false, error: 'spawn /home/vault/ffmpeg ENOENT' },
    tools: { ffmpeg: { found: true, version: '8.0-vault', where: 'next to Vault' } },
  }, { home: '/home/vault', user: 'vault' });
  assert.match(t, /^OS: Linux x64, #43-Ubuntu SMP <user>@<user>-vm, release/m);
  assert.match(t, /^Distro: <user> OS$/m);
  assert.match(t, /^Desktop: <user>$/m);
  assert.match(t, /ffmpeg check failed: spawn ~\/ffmpeg ENOENT$/m);
  assert.match(t, /^ {2}ffmpeg: 8\.0-<user> \(next to Vault\)$/m);
  assert.match(t, /^Vault diagnostics$/m);
  assert.doesNotMatch(t.replace(/Vault/g, ''), /vault/i, 'no other vault left anywhere');
  assert.match(diag.format({ platform: 'linux', gpu: { error: 'Command failed: /home/vault/ffmpeg' } }, { home: '/home/vault', user: 'vault' }),
    /^GPU: unknown \(Command failed: ~\/ffmpeg\)$/m);
});

test('diagnostics: names with regex characters, and short names inside other words', () => {
  // Regex characters are matched as plain text
  const meta = 'a.b+c(d)[e]$^|*?{1}\\';
  assert.strictEqual(diag.redact(`/srv/${meta}/y and axbbc`, { home: '/nohome', user: meta, platform: 'linux' }), '/srv/<user>/y and axbbc');
  assert.strictEqual(diag.redact('j.r and jxr', { home: '/x', user: 'j.r', platform: 'linux' }), '<user> and jxr');
  assert.strictEqual(diag.redact('/home/o\'brien/y', { home: '/x', user: 'o\'brien', platform: 'linux' }), '/home/<user>/y');
  // Not inside a longer word, accented letters and digits included
  const al = { home: '/x', user: 'al', platform: 'linux' };
  assert.strictEqual(diag.redact('alpha pal 2al al2 al_ alé éal /al/ al', al), 'alpha pal 2al al2 al_ alé éal /<user>/ <user>');
  assert.strictEqual(diag.redact('gnome-shell gnome', { home: '/x', user: 'gnome', platform: 'linux' }), '<user>-shell <user>');
  assert.strictEqual(diag.redact('3ubuntu2 #43-Ubuntu', { home: '/x', user: 'ubuntu', platform: 'linux' }), '3ubuntu2 #43-<user>');
  // A one-letter name is not hidden as a word; its home folder still is
  assert.strictEqual(diag.redact('/home/v/x v x64', { home: '/home/v', user: 'v', platform: 'linux' }), '~/x v x64');
  // Windows output for an ordinary account is what it always was
  const w = diag.format({ ...FULL, platform: 'win32', osVersion: 'Windows 11 Pro', osRelease: '10.0.26200', gpu: { label: 'GPU (NVENC h264)', nvenc: true, nvdec: true, cudaListed: true } },
    { home: 'C:\\Users\\bob', user: 'bob' });
  assert.match(w, /^Vault diagnostics\nVault: 3\.10\.0 \(packaged app\)\nNode: v24\.18\.1\nOS: Windows x64, Windows 11 Pro, release 10\.0\.26200\nGPU: GPU \(NVENC h264\); NVENC yes, CUDA decode not tested \(ffmpeg has it\)\nTools:\n/);
  assert.match(w, /^ {2}ffprobe: 6\.1\.1-3ubuntu5 \(next to Vault\)$/m);
});

test('diagnostics: CUDA decode is never claimed from the ffmpeg listing alone', async () => {
  const gpuDetect = require('../lib/pmv/gpu-detect');
  const fake = (nvencWorks) => async (cmd, args) => {
    if (args[0] === '-encoders') return { stdout: ' V....D h264_nvenc  NVIDIA NVENC H.264 encoder\n', stderr: '' };
    if (args[0] === '-hwaccels') return { stdout: 'Hardware acceleration methods:\nvdpau\ncuda\nvaapi\n', stderr: '' };
    if (nvencWorks) return { stdout: '', stderr: '' };
    throw Object.assign(new Error('Command failed'), { stderr: '[h264_nvenc @ 0x1] dl_fn->cuda_dl->cuInit(0) failed -> CUDA_ERROR_NO_DEVICE' });
  };
  // No NVIDIA card (the VM): NVENC fails its test encode, so no CUDA decode either
  const none = await gpuDetect.detectGPU({ run: fake(false) });
  assert.strictEqual(none.nvenc, false);
  assert.strictEqual(none.nvencFailed, true);
  assert.strictEqual(none.cudaListed, true);
  assert.strictEqual(none.nvdec, false);
  assert.deepStrictEqual(none.hwaccelArgs, []);
  assert.match(diag.format({ platform: 'linux', gpu: none }), /^GPU: CPU \(libx264\), NVENC failed validation; NVENC no, CUDA decode no \(ffmpeg has it, but the NVIDIA test failed\)$/m);
  // A working NVIDIA card: unchanged, NVENC yes; decode is listed but never tried
  const ok = await gpuDetect.detectGPU({ run: fake(true) });
  assert.strictEqual(ok.nvenc, true);
  assert.strictEqual(ok.nvdec, true);
  assert.deepStrictEqual(ok.hwaccelArgs, ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']);
  assert.match(diag.format({ platform: 'win32', gpu: ok }), /^GPU: GPU \(NVENC h264\); NVENC yes, CUDA decode not tested \(ffmpeg has it\)$/m);
  // An ffmpeg without cuda: plain no
  assert.match(diag.format({ platform: 'linux', gpu: { label: 'CPU (libx264)', nvenc: false, cudaListed: false } }), /CUDA decode no$/m);
  // An ffmpeg without NVENC that lists cuda: not tested, never yes
  assert.match(diag.format({ platform: 'linux', gpu: { label: 'CPU (libx264)', nvenc: false, cudaListed: true } }), /CUDA decode not tested \(ffmpeg has it\)$/m);
  assert.doesNotMatch(diag.format({ platform: 'linux', gpu: ok }), /CUDA decode yes/);
});

test('diagnostics: /etc/os-release and tool version lines', () => {
  const r = diag.parseOsRelease('NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n# comment\nID=ubuntu\n');
  assert.strictEqual(r.PRETTY_NAME, 'Ubuntu 24.04.1 LTS');
  assert.strictEqual(r.ID, 'ubuntu');
  assert.strictEqual(diag.parseToolVersion('ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023'), '6.1.1-3ubuntu5');
  assert.strictEqual(diag.parseToolVersion('ffmpeg version n7.1-1-g1234 Copyright'), 'n7.1-1-g1234');
  assert.strictEqual(diag.parseToolVersion('ffmpeg version N-117000-gabc Copyright'), 'N-117000-gabc');
  assert.strictEqual(diag.parseToolVersion('fpcalc version 1.5.1'), '1.5.1');
  assert.strictEqual(diag.parseToolVersion('mpv v0.37.0 Copyright © 2000-2023 mpv/MPlayer/mplayer2 projects'), '0.37.0');
  assert.strictEqual(diag.parseToolVersion('4.0.1\n'), '4.0.1');
  assert.strictEqual(diag.parseToolVersion('kdialog 23.08.5'), '23.08.5');
  assert.strictEqual(diag.parseToolVersion(''), null);
});

test('diagnostics: collect() on Linux reads os-release, the session, and asks each tool', async () => {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const n of ['ffmpeg', 'mpv', 'zenity']) fs.writeFileSync(path.join(bin, n), '');
  const asked = [];
  const run = (cmd, args, opts, cb) => {
    asked.push(path.basename(cmd));
    assert.strictEqual(opts.shell, false);
    const out = { ffmpeg: 'ffmpeg version 6.1.1 Copyright', mpv: 'mpv v0.37.0 Copyright', zenity: '4.0.1' }[path.basename(cmd)];
    setImmediate(() => cb(null, out || '', ''));
  };
  const info = await diag.collect({
    platform: 'linux',
    env: { PATH: bin, XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' },
    run,
    readFile: (p) => (p === '/etc/os-release' ? 'PRETTY_NAME="Fedora Linux 40 (Workstation Edition)"\n' : 'Linux version 6.8 (gcc)'),
    gpu: async () => ({ label: 'CPU (libx264)', nvenc: false, nvdec: false }),
    findMpv: null,    // ask mpv on PATH like the others (the Stage lookup is tested below)
  });
  assert.strictEqual(info.distro, 'Fedora Linux 40 (Workstation Edition)');
  assert.strictEqual(info.wsl, false);
  assert.strictEqual(info.desktop, 'KDE');
  assert.strictEqual(info.sessionType, 'x11');
  assert.strictEqual(info.waylandDisplay, false);
  assert.strictEqual(info.x11Display, true);
  assert.deepStrictEqual(plain(info.tools.ffmpeg), { found: true, version: '6.1.1', where: 'on PATH' });
  assert.deepStrictEqual(plain(info.tools.mpv), { found: true, version: '0.37.0', where: 'on PATH' });
  assert.deepStrictEqual(plain(info.tools.zenity), { found: true, version: '4.0.1', where: 'on PATH' });
  assert.deepStrictEqual(plain(info.tools.kdialog), { found: false }, 'not on PATH: not run at all');
  assert.ok(!asked.includes('kdialog'));
  assert.strictEqual(typeof info.vaultVersion, 'string');
  const text = diag.format(info);
  assert.match(text, /^Session: x11 \(WAYLAND_DISPLAY not set, DISPLAY set\)$/m);

  // Off Linux the desktop pickers are not asked about
  const win = await diag.collect({ platform: 'win32', env: { PATH: '' }, run, readFile: () => '', gpu: async () => null, findMpv: null });
  assert.deepStrictEqual(plain(win.tools.zenity), { skipped: true });
  assert.strictEqual(win.distro, null);
});

test('diagnostics: mpv is found where Stage finds it, and its path is never shown', async () => {
  const info = await diag.collect({
    platform: 'linux', env: { PATH: '' }, run: (c, a, o, cb) => cb(Object.assign(new Error('x'), { code: 'ENOENT' })),
    readFile: () => '', gpu: async () => null,
    findMpv: async () => ({ found: true, path: '/home/alice/apps/mpv', version: '0.38.0', source: 'chosen' }),
  });
  assert.deepStrictEqual(plain(info.tools.mpv), { found: true, version: '0.38.0', where: 'chosen in Settings' });
  assert.doesNotMatch(diag.format(info), /apps\/mpv/);
  const none = await diag.collect({ platform: 'linux', env: { PATH: '' }, readFile: () => '', gpu: async () => null, findMpv: async () => ({ found: false }) });
  assert.deepStrictEqual(plain(none.tools.mpv), { found: false });
});

/* ── lib/trash.js: the trash package ───────────────────────────────────── */

const trashLib = require('../lib/trash');

test('trash: an ES module namespace is unwrapped to its default function', () => {
  const fn = () => {};
  assert.strictEqual(trashLib.unwrapDefault(fn), fn);
  assert.strictEqual(trashLib.unwrapDefault({ __esModule: true, default: fn }), fn);
  assert.strictEqual(trashLib.unwrapDefault({ default: 'nope' }), null);
  assert.strictEqual(trashLib.unwrapDefault(null), null);
});

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const canRequireEsm = nodeMajor >= 23 || (nodeMajor === 22 && nodeMinor >= 12) || (nodeMajor === 20 && nodeMinor >= 19);

test('trash: the installed package loads as a callable function', { skip: !canRequireEsm && 'this Node cannot require() an ES module' }, () => {
  assert.strictEqual(typeof trashLib._trashPkg(), 'function');
});

/* ── lib/freedesktop-trash.js (the Linux Trash, own code) ─────────────── */

const fdt = require('../lib/freedesktop-trash');
const POSIX = process.platform !== 'win32';

test('freedesktop trash: Path= encoding, date format, home Trash folder', () => {
  assert.strictEqual(fdt.encodeTrashPath('/home/a/clip [1] *.mp4'), '/home/a/clip%20%5B1%5D%20%2A.mp4');
  assert.strictEqual(fdt.encodeTrashPath('/home/a/été (2).mkv'), '/home/a/%C3%A9t%C3%A9%20%282%29.mkv');
  assert.strictEqual(fdt.deletionDate(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02T03:04:05');
  assert.strictEqual(fdt.homeTrashDir({}, '/home/a').replace(/\\/g, '/'), '/home/a/.local/share/Trash');
  assert.strictEqual(fdt.homeTrashDir({ XDG_DATA_HOME: '/x/data' }, '/home/a').replace(/\\/g, '/'), '/x/data/Trash');
  assert.strictEqual(fdt.homeTrashDir({ XDG_DATA_HOME: 'relative' }, '/home/a').replace(/\\/g, '/'), '/home/a/.local/share/Trash', 'a relative XDG_DATA_HOME is ignored (spec)');
});

test('freedesktop trash: a file on the home disk goes to the home Trash, info first, names never clash', { skip: !POSIX && 'POSIX only' }, () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const env = { XDG_DATA_HOME: path.join(home, 'data') };
  const a = path.join(home, 'clip [1] *.mp4');
  fs.writeFileSync(a, 'one');
  const r1 = fdt.trashFile(a, { env, home, now: () => new Date(2026, 10, 1, 12, 0, 0) });
  assert.ok(!fs.existsSync(a));
  assert.strictEqual(r1.trashedAs, path.join(home, 'data', 'Trash', 'files', 'clip [1] *.mp4'));
  assert.strictEqual(fs.readFileSync(r1.info, 'utf8'),
    `[Trash Info]\nPath=${fdt.encodeTrashPath(a)}\nDeletionDate=2026-11-01T12:00:00\n`);
  // The same name again: a second entry, the first is untouched
  fs.writeFileSync(a, 'two');
  const r2 = fdt.trashFile(a, { env, home });
  assert.strictEqual(path.basename(r2.trashedAs), 'clip [1] *.2.mp4');
  assert.strictEqual(fs.readFileSync(r1.trashedAs, 'utf8'), 'one');
  assert.strictEqual(fs.readFileSync(r2.trashedAs, 'utf8'), 'two');
  assert.ok(fs.existsSync(path.join(home, 'data', 'Trash', 'info', 'clip [1] *.2.mp4.trashinfo')));
  // A missing file throws and leaves no .trashinfo behind
  assert.throws(() => fdt.trashFile(path.join(home, 'gone.mp4'), { env, home }), /ENOENT/);
  assert.strictEqual(fs.readdirSync(path.join(home, 'data', 'Trash', 'info')).length, 2);
});

/** A fake disk layout: every path's device is its first matching prefix's. */
function fakeFs(devs, real = fs) {
  const devOf = (p) => {
    const n = p.replace(/\\/g, '/');
    const hit = Object.keys(devs).sort((x, y) => y.length - x.length).find(k => n === k || n.startsWith(k.endsWith('/') ? k : k + '/'));
    return hit ? devs[hit] : 1;
  };
  const made = [];
  return {
    made,
    statSync: (p) => ({ dev: devOf(p) }),
    lstatSync: (p) => { if (/\.Trash$/.test(p)) { const e = new Error('no'); e.code = 'ENOENT'; throw e; } return { dev: devOf(p), isDirectory: () => true, isSymbolicLink: () => false, mode: 0 }; },
    mkdirSync: (p) => { made.push(p.replace(/\\/g, '/')); },
    real,
  };
}

test('freedesktop trash: a file on another disk goes to that disk\'s .Trash-<uid>, Path= relative to it', () => {
  const f = fakeFs({ '/': 1, '/media/usb': 2 });
  const r = fdt.trashDirFor('/media/usb/videos/a.mp4', { env: {}, home: '/home/a', uid: 1000, fsx: f });
  assert.strictEqual(r.dir.replace(/\\/g, '/'), '/media/usb/.Trash-1000');
  assert.strictEqual(r.topdir.replace(/\\/g, '/'), '/media/usb');
  assert.deepStrictEqual(f.made, ['/media/usb/.Trash-1000']);
  // Same disk as home: the home Trash, absolute Path=
  const h = fdt.trashDirFor('/srv/x.mp4', { env: {}, home: '/home/a', uid: 1000, fsx: fakeFs({ '/': 1 }) });
  assert.strictEqual(h.topdir, null);
  assert.strictEqual(h.dir.replace(/\\/g, '/'), '/home/a/.local/share/Trash');
  // A shared .Trash with the sticky bit: the user's folder inside it
  const s = fakeFs({ '/': 1, '/mnt/d': 3 });
  s.lstatSync = (p) => ({ dev: /^\/mnt\/d/.test(p.replace(/\\/g, '/')) ? 3 : 1, isDirectory: () => true, isSymbolicLink: () => false, mode: 0o41777 });
  assert.strictEqual(fdt.trashDirFor('/mnt/d/a.mp4', { env: {}, home: '/home/a', uid: 1000, fsx: s }).dir.replace(/\\/g, '/'), '/mnt/d/.Trash/1000');
  // A drive Vault cannot write to: a plain message, nothing copied to the home disk
  const ro = fakeFs({ '/': 1, '/media/cd': 4 });
  ro.mkdirSync = () => { const e = new Error('read-only'); e.code = 'EROFS'; throw e; };
  assert.throws(() => fdt.trashDirFor('/media/cd/a.mp4', { env: {}, home: '/home/a', uid: 1000, fsx: ro }), /this drive has no Trash Vault can use \(EROFS\)/);
});

test('trash: recycleFile on Linux uses the freedesktop Trash, never the trash package', { skip: !POSIX && 'POSIX only' }, async () => {
  const home = fs.mkdtempSync(path.join(os.homedir(), '.vault-test-trash-'));
  const prev = process.env.XDG_DATA_HOME;
  try {
    process.env.XDG_DATA_HOME = path.join(home, 'data');
    const file = path.join(home, 'a.mp4');
    fs.writeFileSync(file, 'x');
    await trashLib.recycleFile(file, { platform: 'linux' });
    assert.ok(!fs.existsSync(file));
    assert.deepStrictEqual(fs.readdirSync(path.join(home, 'data', 'Trash', 'files')), ['a.mp4']);
    await assert.rejects(trashLib.recycleFile(file, { platform: 'linux' }), /^Error: recycle failed: /);
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ── lib/platform.js cipherMissingHelp ─────────────────────────────────── */

test('cipherMissingHelp: the packages to install, per OS; a fresh download for the packaged app', () => {
  const { cipherMissingHelp } = require('../lib/platform');
  const lin = cipherMissingHelp({ platform: 'linux', isSea: false });
  assert.match(lin, /sudo apt install build-essential python3/);
  assert.match(lin, /sudo dnf install gcc-c\+\+ make python3/);
  assert.match(lin, /npm install/);
  assert.match(cipherMissingHelp({ platform: 'darwin', isSea: false }), /xcode-select --install/);
  assert.match(cipherMissingHelp({ platform: 'win32', isSea: false }), /npm install/);
  const sea = cipherMissingHelp({ platform: 'linux', isSea: true });
  assert.match(sea, /Download Vault again/);
  assert.doesNotMatch(sea, /npm|sudo/);
  for (const t of [lin, sea]) assert.doesNotMatch(t, /—|PLAINTEXT|VAULT_DB_PASSWORD/);
});

/* ── launchers ─────────────────────────────────────────────────────────── */

test('start.sh and scan.sh: LF line endings, a bash #! line, a Node version check', () => {
  for (const f of ['start.sh', 'scan.sh']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!src.includes('\r'), `${f} has no CR (a CRLF #! line does not run)`);
    assert.ok(src.startsWith('#!/usr/bin/env bash\n'), f);
    assert.match(src, /-lt 20/, `${f} checks for Node 20 or newer`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'start.sh'), 'utf8'), /require\('\.\/lib\/platform'\)\.openUrl/, 'opens the browser the way the app does');
  assert.match(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'), /^\*\.sh text eol=lf/m);
});
