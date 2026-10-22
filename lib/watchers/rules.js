/**
 * Folder watchers: which files a watched folder takes in, and path helpers.
 *
 * Pure functions only (no disk, no database), so the rules are tested on
 * their own (test/watchers.test.js).
 *
 *   - File types: the folder's type chips (video, image, audio). An image
 *     chip covers pictures and GIFs, as the Add folder dialog does. A
 *     Documents type is listed but not offered yet (WATCHERS_SPEC: documents
 *     are a later feature); when imports learn documents, flipping
 *     `offered` is the only change here.
 *   - Skip patterns: one per line, * matches anything, case does not matter.
 *     "name\" or "name/" skips a folder of that name anywhere below the
 *     watched folder; a pattern with a separator inside matches the path
 *     relative to the watched folder; anything else matches the file name.
 *     Names starting with a dot (hidden on Linux and macOS, and how NAS boxes
 *     hide their own files) are always skipped.
 *   - Smaller than: videos and pictures only, never audio or documents, and
 *     off (0) unless the folder sets it.
 */

const path = require('path');

/** Patterns a new folder starts with (the user can edit them). */
const DEFAULT_SKIP_PATTERNS = [
  '*.part', '*.crdownload', '*.tmp', '~$*', 'Thumbs.db', 'desktop.ini', '@eaDir\\', '.DS_Store',
];

/**
 * Types a folder can take in. Extensions mirror the Add folder dialog
 * (player-lib/importer.js BUCKET_EXTS) and config.extensions.
 */
const TYPES = {
  video: {
    label: 'Videos', offered: true, sized: true,
    exts: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpeg', '.mpg',
      '.3gp', '.mts', '.m2ts', '.vob', '.ogv', '.rm', '.rmvb', '.asf', '.divx'],
  },
  image: {
    label: 'Pictures', offered: true, sized: true,
    exts: ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif', '.gif'],
  },
  audio: {
    label: 'Audio', offered: true, sized: false,
    exts: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a'],
  },
  // Not offered until imports take documents again (TODO.md). Never sized:
  // a small text file is still a whole document.
  document: {
    label: 'Documents', offered: false, sized: false,
    exts: ['.txt', '.md', '.pdf', '.docx', '.rtf'],
  },
};

const DEFAULT_TYPES = ['video', 'image'];

const EXT_TYPE = new Map();
for (const [type, t] of Object.entries(TYPES)) for (const e of t.exts) EXT_TYPE.set(e, type);

/** Which type chip an extension belongs to ('.MP4' -> 'video'), or null. */
function typeOfExt(ext) {
  return EXT_TYPE.get(String(ext || '').toLowerCase()) || null;
}

/** Only offered types, deduped, in TYPES order. Bad input gives the defaults. */
function normalizeTypes(list) {
  if (!Array.isArray(list)) return DEFAULT_TYPES.slice();
  const want = new Set(list.map(String));
  return Object.keys(TYPES).filter(t => TYPES[t].offered && want.has(t));
}

/** One pattern per entry, trimmed, empties dropped, capped. */
function normalizePatterns(list) {
  if (typeof list === 'string') list = list.split(/\r?\n/);
  if (!Array.isArray(list)) return DEFAULT_SKIP_PATTERNS.slice();
  const out = [];
  for (const raw of list) {
    const p = String(raw == null ? '' : raw).replace(/\u0000/g, '').trim();
    if (p && p.length <= 200 && !out.includes(p)) out.push(p);
    if (out.length >= 100) break;
  }
  return out;
}

function globToRegex(glob) {
  const body = glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * Compile skip patterns into one test: skip(relPath) -> true when the file
 * (path relative to the watched folder, either separator) is to be ignored.
 */
function compileSkip(patterns) {
  const names = [];
  const dirs = [];
  const rels = [];
  for (const p of normalizePatterns(patterns)) {
    const norm = p.replace(/\//g, '\\');
    if (/\\$/.test(norm)) {
      const name = norm.replace(/\\+$/, '');
      if (name) dirs.push(globToRegex(name));
    } else if (norm.includes('\\')) {
      rels.push(globToRegex(norm.replace(/^\\+/, '')));
    } else {
      names.push(globToRegex(norm));
    }
  }
  return function skip(relPath) {
    const rel = String(relPath || '').replace(/\//g, '\\').replace(/^\\+/, '');
    const parts = rel.split('\\').filter(Boolean);
    if (!parts.length) return true;
    const base = parts[parts.length - 1];
    // Hidden by convention: any dot-named file or folder on the way.
    if (parts.some(s => s.startsWith('.'))) return true;
    if (names.some(r => r.test(base))) return true;
    for (let i = 0; i < parts.length - 1; i++) {
      if (dirs.some(r => r.test(parts[i]))) return true;
    }
    if (rels.some(r => r.test(rel))) return true;
    return false;
  };
}

/**
 * Does this folder take in this file? `folder` is a normalized folder row
 * (see store.js rowToFolder): { types, skipPatterns, minSizeBytes,
 * includeSubfolders }. `skip` is compileSkip(folder.skipPatterns), passed in
 * so a batch compiles it once. `size` may be undefined when it is not known
 * yet (the size check then waits for the stat).
 * @returns {{ok: boolean, type?: string, reason?: string}}
 */
function accepts(folder, relPath, size, skip = compileSkip(folder.skipPatterns)) {
  const rel = String(relPath || '').replace(/\//g, '\\');
  if (!folder.includeSubfolders && rel.includes('\\')) return { ok: false, reason: 'subfolder' };
  const type = typeOfExt(path.extname(rel));
  if (!type || !folder.types.includes(type) || !TYPES[type].offered) return { ok: false, reason: 'type' };
  if (skip(rel)) return { ok: false, reason: 'skip' };
  if (TYPES[type].sized && folder.minSizeBytes > 0 && Number.isFinite(size) && size < folder.minSizeBytes) {
    return { ok: false, reason: 'small' };
  }
  return { ok: true, type };
}

/* ── Paths ─────────────────────────────────────────────────────────────── */

const WIN = process.platform === 'win32';

/**
 * Case folding for in-memory keys (the Settler, the Add files batch dedupe,
 * catch-up pairing over rows already read), close to how NTFS compares names
 * and never looser: a character is folded only when its upper case is one
 * character AND that upper case lowers back to the original's lower case
 * (round-trip safe). So é/É and ç/Ç meet, while every pair NTFS keeps apart
 * stays apart: i/ı, s/ſ, µ/μ, ς/σ, ẛ/ṡ, U+0345/ι, ß/ẞ (ı, ſ, µ, ς, ẛ and
 * U+0345 do not round-trip, and ß uppers to two letters). Where this differs
 * from NTFS it errs toward "different" (Kelvin K/k, Ångström Å/å, Ohm Ω/ω
 * stay apart), which can only cost a duplicate row, never a wrong merge.
 * Titlecase letters (ǅ, ǈ, ǋ, ǲ) are never folded: NTFS keeps ǅ apart from
 * ǆ (checked on this machine), while ǆ and Ǆ meet.
 *
 * And only inside a whitelist of blocks where JavaScript's case mapping and
 * NTFS's upcase table were checked to agree (scratchpad vfy-fold.js, every
 * code point U+0020..U+10FFFF on this machine): ASCII, Latin-1 Supplement,
 * Latin Extended-A, Greek (U+0370-03FF) and basic Cyrillic (U+0400-04FF).
 * Both the character and its upper case must be inside. Everything else
 * (Georgian, Cherokee, Latin Extended-B/D, IPA, supplementary planes such as
 * Deseret...) is never folded: NTFS keeps many of those pairs apart, and a
 * wrong merge would drop a file. Their case-only renames fall back to the
 * file system (realpath, manager.js) or the documented known limit.
 * Never used to scan the database.
 */
const FOLD_BLOCKS = [[0x0000, 0x007f], [0x0080, 0x00ff], [0x0100, 0x017f], [0x0370, 0x03ff], [0x0400, 0x04ff]];
// Inside those blocks, letters newer than NTFS's upcase table (found by the probe): Greek Yot.
const FOLD_EXCLUDE = new Set([0x037f, 0x03f3]);
const foldable = (cp) => !FOLD_EXCLUDE.has(cp) && FOLD_BLOCKS.some(([a, b]) => cp >= a && cp <= b);

function foldCase(s) {
  const str = String(s);
  if (!/[^\x00-\x7f]/.test(str)) return str.toUpperCase();
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (!foldable(cp) || /\p{Lt}/u.test(ch)) { out += ch; continue; }
    const u = ch.toUpperCase();
    out += ([...u].length === 1 && foldable(u.codePointAt(0)) && u.toLowerCase() === ch.toLowerCase()) ? u : ch;
  }
  return out;
}

/** True when the path has letters outside ASCII (which SQLite NOCASE does not fold). */
const hasNonAscii = (s) => /[^\x00-\x7f]/.test(String(s));

/** Compare form: case folded on Windows (case-insensitive file system), no trailing separator. */
function pathKey(p) {
  let s = path.resolve(String(p));
  if (s.length > 3 || !/^[A-Za-z]:\\$/.test(s)) s = s.replace(/[\\/]+$/, '');
  return WIN ? foldCase(s) : s;
}

/** True when `child` is `parent` itself or somewhere below it. */
function isInside(child, parent) {
  const c = pathKey(child);
  const p = pathKey(parent);
  if (c === p) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

/** Relative path of `file` under `root` ('' for the root itself), or null when outside. */
function relativeTo(root, file) {
  if (!isInside(file, root)) return null;
  const rel = path.relative(root, file);
  return rel;
}

/** A drive root like C:\ (or / elsewhere): watching one needs a confirm. */
function isDriveRoot(p) {
  const s = path.resolve(String(p));
  if (WIN) return /^[A-Za-z]:\\?$/.test(s) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(s);
  return s === '/';
}

/** A network share path (\\server\share\...): defaults to a timer, not live. */
function isNetworkPath(p) {
  return /^\\\\[^\\?.][^\\]*\\[^\\]+/.test(String(p));
}

/**
 * Where a new folder fits among the existing ones (WATCHERS_SPEC: a folder
 * inside another watched folder is folded into the parent).
 *   { coveredBy: folder }   new path is inside a folder that watches subfolders
 *   { duplicate: folder }   same folder already watched
 *   { absorbs: [folders] }  new path is a parent of these (they fold into it)
 * `includeSubfolders` is the new folder's own setting: a parent that does
 * not watch subfolders absorbs nothing.
 */
function nesting(newPath, existing, includeSubfolders = true) {
  const out = { coveredBy: null, duplicate: null, absorbs: [] };
  for (const f of existing) {
    if (pathKey(f.path) === pathKey(newPath)) { out.duplicate = f; continue; }
    if (f.includeSubfolders && isInside(newPath, f.path)) out.coveredBy = f;
    else if (includeSubfolders && isInside(f.path, newPath)) out.absorbs.push(f);
  }
  return out;
}

module.exports = {
  DEFAULT_SKIP_PATTERNS, DEFAULT_TYPES, TYPES,
  typeOfExt, normalizeTypes, normalizePatterns, compileSkip, accepts,
  pathKey, foldCase, hasNonAscii, isInside, relativeTo, isDriveRoot, isNetworkPath, nesting,
};
