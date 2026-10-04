/**
 * Move to Cove routes (/api/cove/*): the Settings tab's front end for the
 * export engine in lib/cove/export.js, run as one background job at a time
 * (lib/cove/job.js).
 *
 * The job reads the library through the live handle (database.get()) and
 * never writes to it. The vault-lock gate in server/index.js answers 423 for
 * all of these while the vault is locked; a lock during a run stops the job
 * between items (like the seed pack import, a running move does not keep the
 * vault awake).
 *
 * THE COVE TOKEN lives in this module's memory only: never written to disk,
 * never logged, never in a response or a report. A restart forgets it.
 * Changing the address to another origin (scheme, host or port) without
 * sending a token clears it, so it never goes to a server it was not made for.
 * The Cove address and folder mappings are saved in Vault's app settings.
 */

const express = require('express');
const database = require('../lib/database');
const vault = require('../lib/vault');
const appSettings = require('../lib/app-settings');
const job = require('../lib/cove/job');

const DEFAULT_URL = 'http://127.0.0.1:5073';
const MAX_URL = 500;
const MAX_PATH = 1000;
const MAX_MAPS = 20;

function readSettings() {
  const all = appSettings.all();
  const url = typeof all.coveUrl === 'string' && all.coveUrl.trim() ? all.coveUrl.trim().slice(0, MAX_URL) : DEFAULT_URL;
  const maps = Array.isArray(all.coveMaps)
    ? all.coveMaps.filter(m => m && typeof m.from === 'string' && typeof m.to === 'string')
      .slice(0, MAX_MAPS).map(m => ({ from: m.from.slice(0, MAX_PATH), to: m.to.slice(0, MAX_PATH) }))
    : [];
  return { url, maps };
}

/** Folder mappings as the engine takes them ("VaultFolder=CoveFolder"). */
const mapArgs = (maps) => maps.map(m => `${m.from}=${m.to}`);

/** scheme://host[:port] of a Cove address, or null when it does not parse. */
function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function badRequest(res, message) {
  return res.status(400).json({ error: message, code: 'BAD_INPUT' });
}

function buildRouter() {
  const router = express.Router();

  // In memory only (see the header).
  let token = null;
  // Bumped on every settings change. A preview counts toward Move only when
  // it started and finished with no change in between.
  let settingsVersion = 0;
  let previewOkVersion = null;

  const currentKey = () => {
    const { url, maps } = readSettings();
    return JSON.stringify({ url, maps, hasToken: !!token });
  };

  // A lock closes the live handle: stop the job between items with a plain message.
  vault.onChange((event) => { if (event === 'locked') job.stop('locked'); });

  router.get('/settings', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { url, maps } = readSettings();
    res.json({ url, maps, hasToken: !!token, encrypted: vault.isEncrypted() });
  });

  router.put('/settings', (req, res) => {
    if (job.isRunning()) return res.status(409).json({ error: 'Wait for the preview or move to finish, or stop it first.', code: 'JOB_BUSY' });
    const body = req.body || {};
    const cur = readSettings();
    const before = currentKey();
    const tokenBefore = token;
    let { url, maps } = cur;

    if ('url' in body) {
      if (typeof body.url !== 'string' || body.url.trim().length > MAX_URL) return badRequest(res, 'Cove\'s address is not valid.');
      url = body.url.trim() || DEFAULT_URL;
      let u;
      try { u = new URL(url); } catch { u = null; }
      if (!u || !/^https?:$/.test(u.protocol)) return badRequest(res, 'Enter Cove\'s address, for example http://127.0.0.1:5073');
    }
    if ('maps' in body) {
      if (!Array.isArray(body.maps) || body.maps.length > MAX_MAPS) return badRequest(res, `Up to ${MAX_MAPS} folders can be mapped.`);
      const next = [];
      for (const m of body.maps) {
        const from = typeof m?.from === 'string' ? m.from.trim() : '';
        const to = typeof m?.to === 'string' ? m.to.trim() : '';
        if (!from && !to) continue;                       // an empty row is just left out
        if (!from || !to) return badRequest(res, 'Fill in both folders in each row, or clear the row.');
        if (from.length > MAX_PATH || to.length > MAX_PATH) return badRequest(res, 'That folder path is too long.');
        if (from.includes('=')) return badRequest(res, `The Vault folder "${from}" contains "=", which is not supported here.`);
        next.push({ from, to });
      }
      maps = next;
    }
    if ('token' in body) {
      if (body.token != null && typeof body.token !== 'string') return badRequest(res, 'The token is not valid.');
      const t = (body.token || '').trim();
      if (t.length > 4096) return badRequest(res, 'The token is not valid.');
      token = t || null;                                  // "" clears it
    } else if (url !== cur.url && originOf(url) !== originOf(cur.url)) {
      // A token belongs to the Cove it was made for: never send it to a new host.
      token = null;
    }

    if (url !== cur.url || JSON.stringify(maps) !== JSON.stringify(cur.maps)) {
      appSettings.set({ coveUrl: url, coveMaps: maps });
    }
    if (currentKey() !== before || token !== tokenBefore) {
      settingsVersion++;
      previewOkVersion = null;
    }
    res.json({ url, maps, hasToken: !!token, encrypted: vault.isEncrypted() });
  });

  router.post('/check', async (req, res) => {
    const { url } = readSettings();
    try {
      res.json(await job.checkConnection({ coveUrl: url, token }));
    } catch (err) {
      const status = err.code === 'BAD_ARGS' || err.code === 'NET_OFF' ? 400 : 502;
      res.status(status).json({ ok: false, error: err.message, code: err.code || 'COVE_ERROR',
        ...(err.authEnabled != null ? { authEnabled: err.authEnabled } : {}) });
    }
  });

  const startJob = (mode, res) => {
    if (job.isRunning()) return res.status(409).json({ error: 'A preview or move is already running.', code: 'JOB_BUSY' });
    if (mode === 'move' && previewOkVersion !== settingsVersion) {
      return res.status(409).json({ error: 'Run a preview first. Move to Cove uses the same address and folders as the preview.', code: 'NEEDS_PREVIEW' });
    }
    if (vault.isLocked()) return res.status(423).json({ error: 'Vault is locked. Unlock it first.', code: 'VAULT_LOCKED' });
    const { url, maps } = readSettings();
    const startedVersion = settingsVersion;
    // A new preview replaces the last one's verdict, even if it fails.
    if (mode === 'preview') previewOkVersion = null;
    let db;
    try {
      db = database.get();
    } catch (err) {
      return res.status(500).json({ error: `Could not read the library: ${err.message}`, code: 'DB_ERROR' });
    }
    try {
      const status = job.start({
        mode, db, encrypted: vault.isEncrypted(), coveUrl: url, token, maps: mapArgs(maps),
        onFinish: (j) => {
          if (j.mode === 'preview' && j.state === 'done' && settingsVersion === startedVersion) previewOkVersion = startedVersion;
        },
      });
      res.status(202).json(status);
    } catch (err) {
      res.status(err.code === 'JOB_BUSY' ? 409 : 500).json({ error: err.message, code: err.code });
    }
  };

  router.post('/preview', (req, res) => startJob('preview', res));
  router.post('/move', (req, res) => startJob('move', res));

  router.get('/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ...job.status(), canMove: previewOkVersion === settingsVersion, inputsCurrent: currentKeyMatches() });
  });

  /** Does the last job's address/folders/token presence match the settings as they are now? */
  function currentKeyMatches() {
    const s = job.status();
    if (!s.inputs) return false;
    const { url, maps } = readSettings();
    return s.inputs.url === url && JSON.stringify(s.inputs.maps) === JSON.stringify(mapArgs(maps)) && s.inputs.hasToken === !!token;
  }

  router.post('/stop', (req, res) => {
    res.json({ stopping: job.stop('user') });
  });

  router.get('/report', (req, res) => {
    const last = job.lastReport();
    if (!last) return res.status(404).json({ error: 'No report yet. Run a preview first.', code: 'NO_REPORT' });
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="cove-report-${job.timestamp(last.at)}.json"`);
    res.send(JSON.stringify(last.report, null, 2));
  });

  return router;
}

module.exports = { buildRouter };
