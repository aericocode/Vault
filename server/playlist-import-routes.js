/**
 * Import playlist routes (PLAYLISTS_SPEC, build step 3). The work is in
 * lib/playlist/import.js; this file is the HTTP side.
 *
 *   POST /api/playlists/import/pick              native file picker (one playlist)
 *                                                → the review | { canceled }
 *   POST /api/playlists/import/drop  {name,size} a playlist file dropped on the
 *                                                window: its real path is found
 *                                                the way dropped media is (the
 *                                                drop resolver) → the review |
 *                                                { unresolved } (the page then
 *                                                opens the picker)
 *   GET  /api/playlists/import/:sid              the review again
 *   POST /api/playlists/import/:sid/find-in-folder  native folder picker, then
 *                                                look for the missing entries
 *                                                there by name → the review
 *   POST /api/playlists/import/:sid/choose {index, pick}  settle an entry found
 *                                                more than once (pick: number | null)
 *   POST /api/playlists/import/:sid/commit {target:'new', name} |
 *                                          {target:'existing', collectionId},
 *                                          addAndScan?: boolean
 *   POST /api/playlists/import/:sid/close        forget the open playlist
 *   POST /api/playlists/imports/:iid/undo        take the import back
 *
 * Where paths come from: only from the native pickers' output, from the drop
 * resolver (a file the user selected and dragged, matched by name and size
 * and checked on disk), and from parsing the playlist file found that way.
 * No route takes a path from the page: the page names a playlist only by the
 * session id these routes handed out, and an entry only by its number. So a
 * page cannot get Vault to read or stat a file of its choosing. (The Add
 * window the review opens posts its files to /api/import/add-paths like any
 * other Add, which records rows and reads nothing but what it adds.)
 *
 * Every route here sits behind the server's global guards: the Host
 * allowlist, Fetch Metadata, the cross-origin write check (CSRF) and the
 * lock gate (423 while locked) all run before any /api route.
 */

'use strict';

const express = require('express');
const path = require('path');
const playlistImport = require('../lib/playlist/import');

const STATUS = {
  NOT_FOUND: 404, BAD_TARGET: 400, NAME_TAKEN: 409, BAD_FILE: 400, TOO_BIG: 413,
  BUSY: 409, BAD_CHOICE: 400, FOLDER_TARGET: 400, BAD_PARENT: 400, BAD_PATH: 400,
  LOCKED: 423,
};

const LOCKED_BODY = { error: 'Vault is locked. Unlock it first.', code: 'VAULT_LOCKED' };

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A path a picker printed, if it is one Vault will use: one line, an absolute
 * Windows path (drive or UNC). Anything else is refused, never repaired.
 */
function checkPickedPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 32767) return null;
  if (/[\u0000-\u001f]/.test(raw)) return null;
  if (!/^(?:[A-Za-z]:\\|\\\\[^\\])/.test(raw) || !path.win32.isAbsolute(raw)) return null;
  return raw;
}

function sendErr(res, err, what) {
  const status = STATUS[err && err.code];
  if (status) return res.status(status).json({ error: err.message, code: err.code });
  console.warn(`[Playlist import] ${what}:`, err && err.message);
  if (res.headersSent) return undefined;
  return res.status(500).json({ error: `Something went wrong while ${what}. See the server log.` });
}

/**
 * @param {object} deps from server/index.js
 * @param {Function} deps.spawnPicker   (res, script, kind, onClose) the shared picker runner
 * @param {string} deps.pickCancel      what a picker prints when dismissed
 * @param {string} deps.playlistScript  the one-playlist file picker
 * @param {string} deps.folderScript    the Find in folder picker
 * @param {Function} deps.runResolver   (cb) the drop resolver
 * @param {Function} deps.normalizeSelections
 * @param {Function} deps.matchSelection
 * @param {Function} deps.isLocked
 */
function buildRouter(deps) {
  const router = express.Router();
  const defaults = {
    pickPlaylist: (res, onClose) => deps.spawnPicker(res, deps.playlistScript, 'file', onClose),
    pickFolder: (res, onClose) => deps.spawnPicker(res, deps.folderScript, 'folder', onClose),
    resolve: (cb) => deps.runResolver(cb),
  };
  dialogs = { ...defaults };
  resetDialogs = () => { dialogs = { ...defaults }; };

  /** Run a picker; `use(path, finish)` gets a checked path. */
  function withPicked(res, open, use) {
    try {
      open(res, ({ code, out, errOut, finish }) => {
        try {
          const raw = String(out || '').trim();
          if (raw === deps.pickCancel) return finish(200, { canceled: true });
          if (!raw) {
            console.warn('[Playlist import] picker failed:', (String(errOut || '').trim() || `exit ${code}, no output`).split('\n')[0]);
            return finish(500, { error: 'The picker could not open. Try again.' });
          }
          const p = checkPickedPath(raw);
          if (!p) return finish(400, { error: 'The picker returned a path Vault cannot use.', code: 'BAD_PATH' });
          // A picker can stay open for minutes: look again.
          if (deps.isLocked()) return finish(423, { error: 'Vault is locked. Unlock it first.', code: 'VAULT_LOCKED' });
          return use(p, finish);
        } catch (err) {
          console.warn('[Playlist import] after the picker:', err && err.message);
          return finish(500, { error: 'Something went wrong. See the server log.' });
        }
      });
    } catch (err) {
      console.warn('[Playlist import] picker did not open:', err && err.message);
      if (!res.headersSent) res.status(500).json({ error: 'The picker did not open. See the server log.' });
    }
  }

  const finishErr = (finish, err, what) => {
    const status = STATUS[err && err.code];
    if (status) return finish(status, { error: err.message, code: err.code });
    console.warn(`[Playlist import] ${what}:`, err && err.message);
    return finish(500, { error: `Something went wrong while ${what}. See the server log.` });
  };

  const openAndReview = (p, finish) => playlistImport.openPlaylist(p)
    // Locked while it was read: the lock gate let the request in, but the
    // review (paths) must not go out now.
    .then((review) => (deps.isLocked() ? finish(423, LOCKED_BODY) : finish(200, review)))
    .catch((err) => finishErr(finish, err, 'reading the playlist'));

  router.post('/api/playlists/import/pick', (req, res) => {
    withPicked(res, dialogs.pickPlaylist, (p, finish) => {
      if (!playlistImport.playlistExt(p)) {
        return finish(400, { error: 'That is not a playlist file Vault can read (.m3u, .m3u8, .xspf, .pls, .dpl).', code: 'BAD_FILE' });
      }
      return openAndReview(p, finish);
    });
  });

  router.post('/api/playlists/import/drop', (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const name = typeof b.name === 'string' ? b.name : '';
    const size = b.size == null ? null : Number(b.size);
    if (!name || name.length > 260 || /[\\/\u0000-\u001f]/.test(name) || !playlistImport.playlistExt(name)) {
      return res.status(400).json({ error: 'name must be the name of a playlist file', code: 'BAD_FILE' });
    }
    if (size !== null && !(Number.isSafeInteger(size) && size >= 0)) {
      return res.status(400).json({ error: 'size must be a number of bytes', code: 'BAD_FILE' });
    }
    if (process.platform !== 'win32' && dialogs.resolve === defaults.resolve) return res.json({ unresolved: 'unsupported' });
    let answered = false;
    const reply = (status, body) => { if (!answered) { answered = true; res.status(status).json(body); } };
    try {
      dialogs.resolve((out) => {
        try {
          if (out == null) return reply(200, { unresolved: 'resolver failed or busy' });
          const found = new Map();
          for (const sel of deps.normalizeSelections(out)) {
            const m = deps.matchSelection(sel, [{ name, size }], []);
            if (m && m.files.length === 1) found.set(m.files[0].path, m.files[0].path);
          }
          if (found.size !== 1) return reply(200, { unresolved: found.size ? 'ambiguous' : 'no matching selection' });
          const p = checkPickedPath(found.values().next().value);
          if (!p || !playlistImport.playlistExt(p)) return reply(200, { unresolved: 'no matching selection' });
          if (deps.isLocked()) return reply(423, { error: 'Vault is locked. Unlock it first.', code: 'VAULT_LOCKED' });
          return openAndReview(p, reply);
        } catch (err) {
          console.warn('[Playlist import] drop:', err && err.message);
          return reply(500, { error: 'Something went wrong. See the server log.' });
        }
      });
    } catch (err) {
      console.warn('[Playlist import] drop resolver did not run:', err && err.message);
      reply(200, { unresolved: 'resolver failed' });
    }
  });

  /** The session id in the URL, checked; answers 404 itself when it is no good. */
  const sid = (req, res) => {
    const id = String(req.params.sid || '');
    if (!SESSION_ID.test(id)) { res.status(404).json({ error: 'This playlist is no longer open. Open it again.', code: 'NOT_FOUND' }); return null; }
    return id;
  };

  router.get('/api/playlists/import/:sid', (req, res) => {
    const id = sid(req, res);
    if (!id) return;
    try { res.json(playlistImport.review(id)); } catch (err) { sendErr(res, err, 'reading the playlist'); }
  });

  router.post('/api/playlists/import/:sid/find-in-folder', (req, res) => {
    const id = sid(req, res);
    if (!id) return;
    try { playlistImport.review(id); } catch (err) { return sendErr(res, err, 'finding the files'); }
    withPicked(res, dialogs.pickFolder, (folder, finish) => playlistImport.findInFolder(id, folder)
      .then((found) => (deps.isLocked() ? finish(423, LOCKED_BODY) : finish(200, { ...playlistImport.review(id), found })))
      .catch((err) => finishErr(finish, err, 'looking in the folder')));
  });

  router.post('/api/playlists/import/:sid/choose', (req, res) => {
    const id = sid(req, res);
    if (!id) return;
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const index = Number(b.index);
    const pick = b.pick === null ? null : Number(b.pick);
    if (!Number.isSafeInteger(index) || index < 0) return res.status(400).json({ error: 'index must be an entry number', code: 'BAD_CHOICE' });
    try {
      playlistImport.choose(id, index, pick);
      res.json(playlistImport.review(id));
    } catch (err) { sendErr(res, err, 'choosing the file'); }
  });

  router.post('/api/playlists/import/:sid/commit', async (req, res) => {
    const id = sid(req, res);
    if (!id) return;
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    if (b.target !== 'new' && b.target !== 'existing') {
      return res.status(400).json({ error: "target must be 'new' or 'existing'", code: 'BAD_TARGET' });
    }
    if (b.target === 'new' && typeof b.name !== 'string') {
      return res.status(400).json({ error: 'name must be text', code: 'BAD_TARGET' });
    }
    try {
      const out = await playlistImport.commit(id, {
        target: b.target,
        name: b.name,
        collectionId: b.collectionId,
        addAndScan: b.addAndScan === true,
      });
      res.json(out);
    } catch (err) { sendErr(res, err, 'making the collection'); }
  });

  router.post('/api/playlists/import/:sid/close', (req, res) => {
    const id = sid(req, res);
    if (!id) return;
    playlistImport.close(id);
    res.json({ ok: true });
  });

  router.post('/api/playlists/imports/:iid/undo', (req, res) => {
    const iid = String(req.params.iid || '');
    if (!SESSION_ID.test(iid)) return res.status(404).json({ error: 'This import can no longer be undone.', code: 'NOT_FOUND' });
    try { res.json(playlistImport.undo(iid)); } catch (err) { sendErr(res, err, 'undoing the import'); }
  });

  return router;
}

let dialogs = null;
let resetDialogs = () => {};

/**
 * Tests only: swap the pickers and the drop resolver for fakes.
 *   { pickPlaylist(res, onClose), pickFolder(res, onClose), resolve(cb) }
 * onClose({ code, out, errOut, finish }) as the real pickers call it. null
 * puts the real ones back.
 */
function _setDialogsForTest(fakes) {
  if (!fakes) return resetDialogs();
  dialogs = { ...dialogs, ...fakes };
  return undefined;
}

module.exports = { buildRouter, checkPickedPath, _setDialogsForTest };
