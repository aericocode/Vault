/**
 * "Get your files into Cove": which folders hold Vault's media, which of them
 * Cove's library already covers, and how to add the rest to Cove's config.
 *
 * Folders come from Vault's own files: each media file's parent folder, kept
 * only when no ancestor folder also holds media directly (so a library spread
 * over many subfolders shows as a handful of top-most rows). The folder
 * mappings (Vault folder -> Cove folder) apply before comparing with Cove's
 * library roots (GET /api/system/config -> covePaths[].path).
 *
 * Adding roots: PUT /api/system/config takes Cove's WHOLE config. Like Cove's
 * own Settings page, it is read again right before (GET as a settings writer
 * returns everything except downloader passwords, which Cove keeps when a
 * save leaves them out: ConfigService.BuildDownloaderSiteCredentials merges
 * them back by id), the new roots are appended, and everything else goes back
 * exactly as read. Existing roots are never removed or reordered.
 *
 * Overlap: Cove does not refuse a root that contains another root, but its
 * scan then walks the inner one twice and the outer root's settings can win
 * over the inner one's exclusions (ScanDiscoveryService: the first target to
 * reach a file keeps it). So a folder that would contain an existing root is
 * never added. And because a scan path must lie inside a root
 * (ResolveScanTargets drops anything else), such a folder cannot be scanned
 * as a whole either; only the roots inside it are.
 */

const fs = require('fs');
const path = require('path');
const M = require('./mapping');

/** Cove's default extensions (Cove.Core/Interfaces/Configuration.cs), used when its config can't be read. */
const DEFAULT_EXTENSIONS = {
  video: ['.m4v', '.mp4', '.mov', '.wmv', '.avi', '.mpg', '.mpeg', '.rmvb', '.rm', '.flv', '.asf', '.mkv', '.webm', '.f4v'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'],
  audio: ['.mp3', '.m4a', '.m4b', '.flac', '.wav', '.ogg', '.oga', '.opus', '.aac', '.alac', '.aif', '.aiff', '.wma', '.mka', '.weba', '.amr'],
};

const NEW_ROOT = { excludeVideo: false, excludeImage: false, excludeAudio: false, excludeText: false };

/**
 * A path in one comparable form: forward slashes, single separators, no
 * trailing slash. A UNC path keeps its leading "//" (\\server\share is not
 * /server/share). Case is kept.
 */
function slashForm(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  const unc = /^\/\/[^/]/.test(s);
  s = s.replace(/\/{2,}/g, '/');
  if (unc) s = '/' + s;
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** Windows-style (drive letter or UNC)? Those compare case-insensitively, like Cove on Windows. */
function isWinForm(s) {
  return /^[a-z]:(\/|$)/i.test(s) || /^\/\/[^/]/.test(s);
}

/**
 * The one comparison key for every path on either side (Vault folders, Cove
 * paths, Cove roots): slashForm, lowercased for Windows-style paths.
 */
function pathKey(p) {
  const s = slashForm(p);
  return isWinForm(s) ? s.toLowerCase() : s;
}

/** A drive or filesystem root ("D:\", "/", "\\server\share"): never offered as a Cove folder. */
function isRootKey(k) {
  return k === '/' || k === '' || /^[a-z]:$/i.test(k) || /^\/\/[^/]+(\/[^/]+)?$/.test(k);
}

/** Is `p` the same as, or inside, `root`? (keys from pathKey) */
function within(pKey, rootKey) {
  if (!rootKey) return false;
  if (pKey === rootKey) return true;
  return pKey.startsWith(rootKey.endsWith('/') ? rootKey : rootKey + '/');
}

/** The parent folder of a file path, in the path's own style. */
function parentDir(p) {
  const s = String(p || '');
  const lib = s.includes('\\') || /^[a-z]:/i.test(s) ? path.win32 : path.posix;
  const d = lib.dirname(s);
  return d === s ? null : d;
}

/**
 * The Cove-side path of a Vault folder, and whether a mapping applied.
 * @param {string} vaultDir
 * @param {Array<{from:string, to:string}>} maps  the folder mappings as saved (Vault folder -> Cove folder)
 * The longest matching Vault folder wins; the rest of the path is joined in
 * the Cove folder's own style (backslashes for a drive letter or UNC path).
 */
function covePathFor(vaultDir, maps) {
  const vk = pathKey(vaultDir);
  let best = null;
  for (const m of maps || []) {
    const fk = pathKey(m && m.from);
    if (!fk || !within(vk, fk)) continue;
    if (!best || fk.length > best.fk.length) best = { m, fk };
  }
  if (!best) return { covePath: vaultDir, mapped: false };
  const rest = slashForm(vaultDir).slice(best.fk.length).replace(/^\//, '');
  const to = slashForm(best.m.to);
  const win = isWinForm(to);
  const sep = win ? '\\' : '/';
  const baseTo = win ? to.replace(/\//g, '\\') : to;
  const joined = !rest ? baseTo : (baseTo === '/' ? '/' + rest : baseTo + sep + rest.split('/').join(sep));
  return { covePath: joined, mapped: true };
}

/**
 * Top-most folders holding the given media rows, with item counts. A drive
 * or filesystem root is never a collecting folder: its subfolders get their
 * own rows, and files sitting directly on it get a row of their own (root).
 * @param {Array<{filepath:string}>} rows  non-trashed media of the kinds that migrate
 * @returns {Array<{ vaultPath, key, items, root }>} sorted by path
 */
function topFolders(rows) {
  const dirs = new Map();               // key -> { vaultPath, direct }
  for (const r of rows) {
    const d = parentDir(r.filepath);
    if (!d) continue;
    const k = pathKey(d);
    const e = dirs.get(k);
    if (e) e.direct++; else dirs.set(k, { vaultPath: d, direct: 1 });
  }
  const top = new Map();
  for (const [k, e] of dirs) {
    if (isRootKey(k)) {
      top.set(k, { vaultPath: e.vaultPath, key: k, items: e.direct, root: true });
      continue;
    }
    let anc = k;
    let owner = k;
    for (;;) {
      const i = anc.lastIndexOf('/');
      if (i <= 0) break;
      anc = anc.slice(0, i);
      if (!isRootKey(anc) && dirs.has(anc)) owner = anc;
    }
    if (!top.has(owner)) top.set(owner, { vaultPath: dirs.get(owner).vaultPath, key: owner, items: 0, root: false });
    top.get(owner).items += e.direct;
  }
  return [...top.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** The media rows the export would carry (non-trashed video, image/gif, audio). Reads only. */
function readMediaRows(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(media)').all().map(c => c.name));
  const trashed = cols.has('user_trashed') ? 'user_trashed' : '0 AS user_trashed';
  return db.prepare(`SELECT filepath, media_type, ${trashed} FROM media`).all()
    .filter(r => Number(r.user_trashed) !== 1 && M.vaultKind(r.media_type));
}

/**
 * Folder rows for the page.
 * @param {object} o
 * @param {Array} o.rows        readMediaRows output
 * @param {Array} o.maps        the folder mappings as saved ({from, to})
 * @param {string[]} o.roots    Cove's library roots
 * @param {Function} [o.exists] folder exists on disk (default fs.existsSync)
 * @returns {Array<{ vaultPath, covePath, items, state, note, mapped, innerRoots }>}
 *   state: 'in' (Cove covers it) | 'add' (would be added) | 'missing' (gone from disk) |
 *   'overlap' (holds an existing root, not added; only those roots get scanned) |
 *   'root' (files directly on a drive or filesystem root; never added)
 */
function folderRows({ rows, maps, roots, exists = fs.existsSync }) {
  const rootKeys = (roots || []).map(r => ({ path: r, key: pathKey(r) }));
  return topFolders(rows).map((f) => {
    const { covePath, mapped } = covePathFor(f.vaultPath, maps);
    const ck = pathKey(covePath);
    const row = { vaultPath: f.vaultPath, covePath, items: f.items, mapped, state: 'add', note: null, innerRoots: [] };
    if (rootKeys.some(r => within(ck, r.key))) { row.state = 'in'; return row; }
    if (f.root || isRootKey(ck)) {
      row.state = 'root';
      row.note = `These files sit directly on ${f.vaultPath}. Adding all of ${f.vaultPath} to Cove would scan the whole drive, ` +
        'so move them into a folder or add them in Cove yourself.';
      return row;
    }
    // With a mapping the folder is seen from Cove's side, which Vault can't check here.
    if (!mapped && !exists(f.vaultPath)) { row.state = 'missing'; row.note = 'This folder no longer exists.'; return row; }
    const inner = rootKeys.filter(r => within(r.key, ck));
    if (inner.length) {
      row.state = 'overlap';
      row.innerRoots = inner.map(r => r.path);
      row.note = `Cove's library already has ${inner.map(r => r.path).join(', ')} inside this folder. ` +
        'Adding the whole folder would make Cove scan that part twice, so Vault only scans what Cove already has. ' +
        'To add the rest, add this folder in Cove\'s Settings yourself.';
    }
    return row;
  });
}

/**
 * Append library roots to Cove's config the way Cove's Settings page does.
 * First confirms (GET /api/auth/me) that the principal may write settings:
 * only then does GET /api/system/config return everything, so only then may
 * it be sent back. Reads the config right before writing, never removes or
 * reorders a root, skips any path already covered (or that would contain a
 * root) by the config as it is now and any drive or filesystem root, and
 * checks the answer. Returns the paths actually added.
 * @param {import('./client').CoveClient} client  a writing client
 * @param {string[]} paths  Cove-side folder paths
 * @param {object} [o]
 * @param {Function} [o.beforeWrite]  called right before the write; throw to send nothing
 */
async function addRoots(client, paths, { beforeWrite } = {}) {
  const me = await client.me();
  if (!M.hasPermission((me && me.permissions) || [], 'system.settings.write')) {
    throw Object.assign(new Error('Cove does not let Vault change its library folders (the token needs the system.settings.write permission). ' +
      'Add the folders in Cove\'s Settings yourself, then use "Only scan".'), { code: 'NO_PERMISSION' });
  }
  const cfg = await client.getConfig();
  if (!cfg || !Array.isArray(cfg.covePaths)) throw new Error('Cove did not return its library settings.');
  const existing = cfg.covePaths;
  if (existing.some(p => !p || typeof p.path !== 'string' || p.path === '[redacted]')) {
    throw Object.assign(new Error('Cove only showed part of its library settings, so Vault did not change them.'), { code: 'NO_PERMISSION' });
  }
  const keys = existing.map(p => pathKey(p.path)).filter(Boolean);
  const add = [];
  for (const p of paths) {
    const k = pathKey(p);
    if (!k || isRootKey(k) || keys.some(r => within(k, r) || within(r, k))) continue;
    keys.push(k);
    add.push(p);
  }
  if (!add.length) return [];
  const next = { ...cfg, covePaths: [...existing, ...add.map(p => ({ path: p, ...NEW_ROOT }))] };
  // Last chance to call it off (Stop, a vault lock, changed settings): throws to send nothing.
  if (beforeWrite) beforeWrite();
  // Once sent, the write is not cut off halfway, so its outcome is always known.
  const saved = await client.putConfig(next, { signal: null });
  // Every root that was there is still there, in the same order, followed by ours.
  const got = (saved && saved.covePaths) || [];
  const ok = existing.every((p, i) => got[i] && got[i].path === p.path)
    && add.every(p => got.some(g => g.path === p));
  if (!ok) throw new Error('Cove saved its library settings differently than expected. Check the library folders in Cove\'s Settings.');
  return add;
}

/** Why a Vault item was not found in Cove (for the not-found lists). */
function notFoundReason(filepath, extSet, exists = fs.existsSync) {
  if (!exists(filepath)) return 'File no longer exists';
  const ext = path.extname(String(filepath)).toLowerCase();
  if (!extSet.has(ext)) return 'Cove doesn\'t support this file type';
  return 'Cove hasn\'t picked this file up yet';
}

/** The extensions Cove scans, from its config (or Cove's defaults). */
function extensionSet(cfg) {
  const list = (k, d) => (cfg && Array.isArray(cfg[k]) && cfg[k].length ? cfg[k] : d);
  return new Set([...list('videoExtensions', DEFAULT_EXTENSIONS.video), ...list('imageExtensions', DEFAULT_EXTENSIONS.image),
    ...list('audioExtensions', DEFAULT_EXTENSIONS.audio)].map(e => String(e).toLowerCase()));
}

module.exports = {
  pathKey, slashForm, isRootKey, within, parentDir, covePathFor, topFolders, readMediaRows, folderRows, addRoots,
  notFoundReason, extensionSet, NEW_ROOT, DEFAULT_EXTENSIONS,
};
