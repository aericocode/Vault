/**
 * The in-app folder browser's one route (Linux and macOS; Windows uses its
 * own dialogs and answers 404 here).
 *
 *   GET /api/fs/list?path=&mode=&ext=&hidden=
 *     path    an absolute folder; empty opens the mode's usual place
 *     mode    folder | file | files | save | exe
 *     ext     file modes: a comma list of extensions to show (m3u,m3u8)
 *     hidden  1 lists names starting with a dot
 *   → { path, parent, entries: [{ name, dir, count?, counted?, inLibrary? }],
 *       truncated, places: [{ group, items: [{ path, label, icon, tag? }] }] }
 *
 * Read-only: it lists names, stats entries and counts media by extension. It
 * never opens a file, never writes, and refuses /proc, /sys and /dev (also
 * through a symlink) with a 403. It sits under /api, so the server's global
 * guards run first: the Host allowlist (localhost only), Fetch Metadata, and
 * the lock gate (423 while the vault is locked).
 */

'use strict';

const express = require('express');
const fsBrowse = require('../lib/fs-browse');

const MODES = new Set(['folder', 'file', 'files', 'save', 'exe']);

/**
 * @param {object} [o]
 * @param {() => string[]} [o.libraryRoots]  the library's own folders, for Places
 * @param {string} [o.platform]
 * @param {object} [o.env]
 */
function buildRouter({ libraryRoots = () => [], platform = process.platform, env = process.env } = {}) {
  const router = express.Router();

  router.get('/api/fs/list', (req, res) => {
    if (platform === 'win32') return res.status(404).json({ error: 'Not used on Windows.' });
    const q = req.query || {};
    const mode = typeof q.mode === 'string' && MODES.has(q.mode) ? q.mode : 'folder';
    const exts = typeof q.ext === 'string' && q.ext ? q.ext.split(',').slice(0, 20) : [];
    const hidden = q.hidden === '1';
    let roots = [];
    try { roots = libraryRoots() || []; } catch { roots = []; }
    const start = typeof q.path === 'string' && q.path ? q.path : fsBrowse.defaultStart(mode, { env });
    const r = fsBrowse.listDir(start, { mode, exts, hidden, inLibrary: new Set(roots) });
    const places = fsBrowse.placesHere({ libraryRoots: roots, env, programs: mode === 'exe' });
    if (!r.ok) return res.status(r.status).json({ error: r.error, places });
    res.set('Cache-Control', 'no-store');
    res.json({ path: r.path, parent: r.parent, entries: r.entries, truncated: r.truncated, places });
  });

  return router;
}

module.exports = { buildRouter };
