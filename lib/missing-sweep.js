/**
 * The missing-files sweep: which library files are not on disk right now.
 * Feeds the "N files are missing" banner (GET /api/library/missing-count) and
 * keeps media.missing_since (the Missing filter and tile tag) in agreement
 * with it.
 *
 * Built so it never holds the server:
 *   - rows are read a page at a time by id (PAGE rows, one short read each);
 *   - every existence check runs in a worker thread (lib/exists-check.js),
 *     with a timeout, so an unreachable network share cannot freeze anything;
 *   - rows are grouped by volume (C:, \\server\share). The first look at a
 *     volume decides: a volume that is not there, or does not answer in
 *     time, is skipped for this sweep, and nothing on it is marked;
 *   - the automatic sweeps (after start, every half hour) do not touch
 *     network or removable drives at all (week 3 brings their Offline state);
 *   - rows below a watched folder that is offline, or whose folder is not
 *     there, are left as they are (a missing folder marks nothing);
 *   - writes go a slice at a time, each naming the path it was decided for.
 *
 * The count it returns is the rows it judged missing plus the rows it left
 * alone that were already marked, so the banner and the filter agree.
 */

const path = require('path');
const { ExistsChecker } = require('./exists-check');

const PAGE = 2000;
const WRITE_SLICE = 500;
const PROBE_MS = 3000;          // first look at a volume
const BATCH_MS = 15000;         // a batch of checks on a volume that answered
const DRIVE_TYPES_TTL_MS = 10 * 60 * 1000;
const WIN = process.platform === 'win32';
const yieldNow = () => new Promise(resolve => setImmediate(resolve));

/** Forward slashes as backslashes on Windows (rows recorded either way). */
const norm = (p) => (WIN ? String(p).replace(/\//g, '\\') : String(p));

/** 'C:' or '\\server\share' (Windows), or '/' elsewhere. */
function volumeOf(p) {
  const s = norm(p);
  if (!WIN) return '/';
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(s);
  if (unc) return unc[0].toLowerCase();
  const d = /^[A-Za-z]:/.exec(s);
  return d ? d[0].toUpperCase() : null;
}
const isUnc = (vol) => !!vol && vol.startsWith('\\\\');
const volumeRoot = (vol) => (isUnc(vol) ? vol + '\\' : vol === '/' ? '/' : vol + '\\');

/* Windows drive types (Win32_LogicalDisk): 2 removable, 3 local, 4 network, 5 CD. */
let _driveTypes = { at: 0, map: new Map() };
async function driveTypes() {
  if (!WIN) return new Map();
  if (Date.now() - _driveTypes.at < DRIVE_TYPES_TTL_MS) return _driveTypes.map;
  const map = new Map();
  try {
    const { execFile } = require('child_process');
    const out = await new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 10000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
    });
    let list = out ? JSON.parse(out) : [];
    if (!Array.isArray(list)) list = [list];
    for (const d of list) if (d && d.DeviceID) map.set(String(d.DeviceID).toUpperCase(), Number(d.DriveType));
  } catch { /* unknown: every drive counts as local */ }
  _driveTypes = { at: Date.now(), map };
  return map;
}

/** Network or removable: not swept automatically (week 3). */
function isRemoteOrRemovable(vol, types) {
  if (isUnc(vol)) return true;
  const t = types.get(vol);
  return t === 2 || t === 4 || t === 5;
}

/**
 * One sweep.
 * @param {object} o
 * @param {Function} o.getDb          () -> better-sqlite3 connection (throws when locked)
 * @param {Function} o.stopped        () -> true to stop (lock, invalidation, migrate)
 * @param {object}   o.store          lib/watchers/store.js (markMissing / clearMissing)
 * @param {boolean} [o.auto]          the automatic sweep: skip network and removable drives
 * @param {string[]} [o.holdRoots]    watched folders to leave alone (offline)
 * @param {string[]} [o.watchedRoots] watched folders: any that is not there is left alone too
 * @param {ExistsChecker} [o.checker] tests may pass a fake ({ check(paths, ms) })
 * @param {Map} [o.types]             drive types (tests)
 * @returns {Promise<{count, total, skipped: string[]}|null>} null when stopped
 */
async function sweep(o) {
  const checker = o.checker || new ExistsChecker();
  const own = !o.checker;
  try {
    const types = o.types || (o.auto ? await driveTypes() : new Map());
    const vols = new Map();                       // volume -> 'ok' | 'skip'
    const hold = [...(o.holdRoots || [])];
    for (const root of o.watchedRoots || []) {
      const vol = volumeOf(root);
      if (o.auto && vol && isRemoteOrRemovable(vol, types)) { hold.push(root); continue; }
      const r = await checker.check([norm(root)], PROBE_MS);
      if (!(r && r[0])) hold.push(root);
    }
    const holdKeys = hold.map(r => norm(r).toLowerCase().replace(/\\+$/, '') + (WIN ? '\\' : '/'));
    const held = (p) => holdKeys.length && holdKeys.some(k => norm(p).toLowerCase().startsWith(k));
    let count = 0;
    let total = 0;
    let after = 0;
    const stamp = Date.now();
    for (;;) {
      if (o.stopped()) return null;
      const db = o.getDb();
      const rows = db.prepare(`SELECT id, filepath, missing_since FROM media
          WHERE id > ? AND COALESCE(user_trashed, 0) = 0 ORDER BY id LIMIT ?`).all(after, PAGE);
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      total += rows.length;

      // Group by volume; a volume's first look decides.
      const byVol = new Map();
      for (const r of rows) {
        if (held(r.filepath)) { if (r.missing_since != null) count++; continue; }
        const vol = volumeOf(r.filepath);
        if (!byVol.has(vol)) byVol.set(vol, []);
        byVol.get(vol).push(r);
      }
      const missing = [];
      const present = [];
      for (const [vol, list] of byVol) {
        let state = vols.get(vol);
        if (state === undefined) {
          if (!vol || (o.auto && isRemoteOrRemovable(vol, types))) state = 'skip';
          else {
            const r = await checker.check([volumeRoot(vol)], PROBE_MS);
            state = r && r[0] ? 'ok' : 'skip';
          }
          vols.set(vol, state);
        }
        if (state === 'skip') { for (const r of list) if (r.missing_since != null) count++; continue; }
        const res = await checker.check(list.map(r => norm(r.filepath)), BATCH_MS);
        if (!res) {                                // stopped answering: leave the volume alone
          vols.set(vol, 'skip');
          for (const r of list) if (r.missing_since != null) count++;
          continue;
        }
        list.forEach((r, i) => {
          if (!res[i]) { count++; if (r.missing_since == null) missing.push({ id: r.id, path: r.filepath }); }
          else if (r.missing_since != null) present.push({ id: r.id, path: r.filepath });
        });
      }
      for (let i = 0; i < missing.length; i += WRITE_SLICE) {
        if (o.stopped()) return null;
        o.store.markMissing(missing.slice(i, i + WRITE_SLICE), stamp);
        await yieldNow();
      }
      for (let i = 0; i < present.length; i += WRITE_SLICE) {
        if (o.stopped()) return null;
        o.store.clearMissing(present.slice(i, i + WRITE_SLICE));
        await yieldNow();
      }
      await yieldNow();
    }
    return { count, total, skipped: [...vols].filter(([, s]) => s === 'skip').map(([v]) => v) };
  } finally {
    if (own) checker.close();
  }
}

module.exports = { sweep, volumeOf, isRemoteOrRemovable, driveTypes, _setDriveTypes: (map) => { _driveTypes = { at: Date.now(), map }; } };
