/**
 * Folder watcher routes (WATCHERS_SPEC week 1), mounted at /api/watch.
 *
 * Everything is under /api/, so the vault-lock gate (423 while locked) and
 * the CSRF origin guard in server/index.js cover every route here. The ones
 * that can create library rows (watch a folder, check now, resume) are also
 * in its MIGRATE_BLOCKED_ROUTES. Paths are checked in lib/watchers/index.js
 * validatePath: absolute, an existing folder, drive roots only with confirm.
 *
 *   GET    /folders              every watched folder with status and file count
 *   POST   /folders              { path, confirm?, mode?, newFiles?, ... } watch one
 *   POST   /folders/:id          options patch
 *   DELETE /folders/:id          stop watching (files already added stay)
 *   POST   /folders/:id/check    catch-up walk of that folder now
 *   POST   /pause | /resume      Pause all / Resume
 *   POST   /settings             { checkOnStart }
 *   GET    /activity             the header pill and its popover
 *   POST   /seen                 { ids } or { all: true }: clear the New mark
 */

const express = require('express');
const watchers = require('../lib/watchers');
const store = require('../lib/watchers/store');

const MAX_SEEN = 5000;

function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 0xFFFFFFFF && /^\d+$/.test(String(v)) ? n : null;
}

function send(res, fn) {
  try {
    res.json(fn());
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.warn(`[Watch] request failed: ${err && err.message}`);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
}

function buildRouter() {
  const r = express.Router();

  r.get('/folders', (req, res) => send(res, () => watchers.listWithStatus()));

  r.post('/folders', (req, res) => send(res, () => watchers.addFolder(req.body || {})));

  r.post('/folders/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    send(res, () => watchers.updateFolder(id, req.body || {}));
  });

  r.delete('/folders/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    send(res, () => watchers.removeFolder(id));
  });

  r.post('/folders/:id/check', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    send(res, () => {
      if (watchers.settings.get().paused) {
        const e = new Error('Watching is paused. Resume it to check for changes.');
        e.status = 409; e.code = 'WATCH_PAUSED';
        throw e;
      }
      return watchers.checkNow(id);
    });
  });

  r.post('/pause', (req, res) => send(res, () => { watchers.manager().pauseAll(); return { ok: true, paused: true }; }));
  r.post('/resume', (req, res) => send(res, () => { watchers.manager().resumeAll(); return { ok: true, paused: false }; }));

  r.post('/settings', (req, res) => send(res, () => {
    const body = req.body || {};
    if (body.checkOnStart !== undefined && typeof body.checkOnStart !== 'boolean') {
      const e = new Error('checkOnStart must be true or false.'); e.status = 400; throw e;
    }
    return watchers.settings.set({ checkOnStart: body.checkOnStart });
  }));

  r.get('/activity', (req, res) => send(res, () => watchers.manager().activity()));

  r.post('/seen', (req, res) => send(res, () => {
    const body = req.body || {};
    if (body.all === true) return { cleared: store.markAllSeen() };
    const ids = Array.isArray(body.ids) ? body.ids : null;
    if (!ids || ids.length > MAX_SEEN || !ids.every(i => Number.isInteger(i) && i > 0)) {
      const e = new Error(`ids must be a list of up to ${MAX_SEEN} media ids.`); e.status = 400; throw e;
    }
    return { cleared: store.markSeen(ids) };
  }));

  return r;
}

module.exports = { buildRouter };
