/* =========================================================================
   Platform words: the few things the viewer says differently per OS.

   They follow the SERVER's OS, the machine that holds the files, not the
   browser's: the viewer can be a browser on another computer. GET /api/about
   says which (`platform`, Node's process.platform). Until it has answered,
   the browser's own OS is the guess, which is right whenever Vault runs on
   the same computer (nearly always).

   - vaultPlatformWords()       → { recycleBin, recycleBinChoice, isRecovered,
                                    canBeRecovered, filePicker, examplePath,
                                    examplePathNew }
   - vaultInstallLine(tool)     → { cmd, alts: [{ on, cmd }] } or null
   - vaultInstallNote(tool)     → "On Fedora: … On Arch: …" or ''
   - vaultServerPlatform()      → 'win32' | 'linux' | 'darwin' | …
   - vaultSetServerPlatform(p)  → record what /api/about said

   Linux and macOS call the OS bin "Trash". Vault has a trash folder of its
   own too ("Move to trash"), so where both appear side by side, the OS one
   is "System Trash" (recycleBinChoice).
   ========================================================================= */

const VAULT_PLATFORM_WORDS = {
  win32: {
    recycleBin: 'Recycle Bin',
    recycleBinChoice: 'Recycle Bin',
    // The Delete mode text (Modern, Classic), word for word as before Linux.
    isRecovered: 'is recovered from Windows',
    canBeRecovered: 'can be recovered by Windows',
    filePicker: 'file picker',
    examplePath: 'C:\\Media',
    examplePathNew: 'D:\\Media',
  },
  linux: {
    recycleBin: 'Trash',
    recycleBinChoice: 'System Trash',
    isRecovered: 'is recovered from the Trash in your file manager',
    canBeRecovered: 'can be recovered from the Trash in your file manager',
    filePicker: 'file picker',
    examplePath: '/home/you/Videos',
    examplePathNew: '/media/you/Drive/Videos',
  },
  darwin: {
    recycleBin: 'Trash',
    recycleBinChoice: 'System Trash',
    isRecovered: 'is recovered from the Trash in the Dock',
    canBeRecovered: 'can be recovered from the Trash in the Dock',
    filePicker: 'file picker',
    examplePath: '/Users/you/Movies',
    examplePathNew: '/Volumes/Drive/Movies',
  },
};

/* One-line installs per OS. Linux leads with apt (Ubuntu, Debian, Mint) and
   lists the other big families after it. null: no single sane command. */
const VAULT_INSTALL_LINES = {
  ffmpeg: {
    win32: { cmd: 'winget install ffmpeg' },
    linux: { cmd: 'sudo apt install ffmpeg', alts: [{ on: 'Fedora', cmd: 'sudo dnf install ffmpeg-free' }, { on: 'Arch', cmd: 'sudo pacman -S ffmpeg' }] },
    darwin: { cmd: 'brew install ffmpeg' },
  },
  mpv: {
    win32: null,
    linux: { cmd: 'sudo apt install mpv', alts: [{ on: 'Fedora', cmd: 'sudo dnf install mpv' }, { on: 'Arch', cmd: 'sudo pacman -S mpv' }] },
    darwin: { cmd: 'brew install mpv' },
  },
  python: {
    win32: { cmd: 'winget install Python.Python.3.12' },
    linux: { cmd: 'sudo apt install python3 python3-venv', alts: [{ on: 'Fedora', cmd: 'sudo dnf install python3' }, { on: 'Arch', cmd: 'sudo pacman -S python' }] },
    darwin: { cmd: 'brew install python' },
  },
  fpcalc: {
    win32: null,
    linux: { cmd: 'sudo apt install libchromaprint-tools', alts: [{ on: 'Fedora', cmd: 'sudo dnf install chromaprint-tools' }, { on: 'Arch', cmd: 'sudo pacman -S chromaprint' }] },
    darwin: { cmd: 'brew install chromaprint' },
  },
};

let _vaultServerPlatform = null;      // what /api/about said; null until then
let _vaultPlatformAsked = 0;          // when it was last asked (ms)

/** The browser's own OS, from its user agent: the guess before the server answers. */
function vaultGuessPlatform(ua) {
  const s = String(ua == null ? (typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '') : ua);
  if (/Windows/i.test(s)) return 'win32';
  if (/Mac OS X|Macintosh/i.test(s) && !/iPhone|iPad/i.test(s)) return 'darwin';
  if (/Linux|X11|CrOS/i.test(s) && !/Android/i.test(s)) return 'linux';
  return 'win32';
}

function vaultSetServerPlatform(p) {
  if (typeof p === 'string' && p) _vaultServerPlatform = p;
}

/** Ask /api/about once (again at most every 30 s while it has not answered, e.g. locked). */
function _vaultAskPlatform() {
  if (_vaultServerPlatform || typeof fetch !== 'function') return;
  const now = Date.now();
  if (now - _vaultPlatformAsked < 30000) return;
  _vaultPlatformAsked = now;
  Promise.resolve()
    // Background: asking which OS this is says nothing about the user being here (autolock).
    .then(() => fetch('/api/about', { headers: { 'X-Vault-Background': '1' } }))
    .then(r => (r && r.ok ? r.json() : null))
    .then(info => { if (info) vaultSetServerPlatform(info.platform); })
    .catch(() => {});
}

function vaultServerPlatform() {
  if (_vaultServerPlatform) return _vaultServerPlatform;
  _vaultAskPlatform();
  return vaultGuessPlatform();
}

/** Words for one OS. Anything that is not Windows or macOS reads like Linux. */
function vaultPlatformWords(platform) {
  const p = platform || vaultServerPlatform();
  return VAULT_PLATFORM_WORDS[p] || VAULT_PLATFORM_WORDS.linux;
}

function _vaultInstallEntry(tool, platform) {
  const p = platform || vaultServerPlatform();
  const t = VAULT_INSTALL_LINES[tool];
  if (!t) return null;
  return Object.prototype.hasOwnProperty.call(t, p) ? t[p] : t.linux;
}

/** { cmd, alts } for a tool on this OS, or null when there is no one command. */
function vaultInstallLine(tool, platform) {
  const e = _vaultInstallEntry(tool, platform);
  return e ? { cmd: e.cmd, alts: e.alts || [] } : null;
}

/** The other distro families as one sentence: "On Fedora: sudo dnf install mpv. On Arch: sudo pacman -S mpv." */
function vaultInstallNote(tool, platform) {
  const e = vaultInstallLine(tool, platform);
  if (!e || !e.alts.length) return '';
  return e.alts.map(a => `On ${a.on}: ${a.cmd}.`).join(' ');
}

if (typeof window !== 'undefined') {
  _vaultAskPlatform();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VAULT_PLATFORM_WORDS, VAULT_INSTALL_LINES,
    vaultGuessPlatform, vaultSetServerPlatform, vaultServerPlatform,
    vaultPlatformWords, vaultInstallLine, vaultInstallNote,
  };
}
