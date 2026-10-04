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
 *
 * "Get your files into Cove" (/folders, /scan): Vault's top-most media
 * folders against Cove's library roots; a scan can add the missing folders to
 * Cove's config first (lib/cove/folders.js addRoots, the only write to Cove's
 * settings) and, once Cove's scan completed, a preview starts by itself.
 */

const express = require('express');
const database = require('../lib/database');
const vault = require('../lib/vault');
const appSettings = require('../lib/app-settings');
const job = require('../lib/cove/job');
const F = require('../lib/cove/folders');
const M = require('../lib/cove/mapping');

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
    if (job.isRunning()) return res.status(409).json({ error: 'Wait for the scan, preview or move to finish, or stop it first.', code: 'JOB_BUSY' });
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

  /**
   * The address, folders and token as they are right now, read once. Every
   * route that awaits Cove uses one snapshot from start to finish, never the
   * live token after an await (PUT /settings could have changed it meanwhile).
   */
  const snapshot = () => {
    const { url, maps } = readSettings();
    return { url, maps, token, version: settingsVersion };
  };
  const BUSY = { error: 'A scan, preview or move is already running.', code: 'JOB_BUSY' };

  router.post('/check', async (req, res) => {
    if (job.isRunning()) return res.status(409).json(BUSY);
    const snap = snapshot();
    try {
      res.json(await job.checkConnection({ coveUrl: snap.url, token: snap.token }));
    } catch (err) {
      const status = err.code === 'BAD_ARGS' || err.code === 'NET_OFF' ? 400 : 502;
      res.status(status).json({ ok: false, error: err.message, code: err.code || 'COVE_ERROR',
        ...(err.authEnabled != null ? { authEnabled: err.authEnabled } : {}) });
    }
  });

  /** Start a preview or move. Returns [httpStatus, body]; also used to chain a preview onto a scan. */
  const startJob = (mode) => {
    if (job.isRunning()) return [409, BUSY];
    if (mode === 'move' && previewOkVersion !== settingsVersion) {
      return [409, { error: 'Run a preview first. Move to Cove uses the same address and folders as the preview.', code: 'NEEDS_PREVIEW' }];
    }
    if (vault.isLocked()) return [423, { error: 'Vault is locked. Unlock it first.', code: 'VAULT_LOCKED' }];
    const { url, maps } = readSettings();
    const startedVersion = settingsVersion;
    // A new preview replaces the last one's verdict, even if it fails.
    if (mode === 'preview') previewOkVersion = null;
    let db;
    try {
      db = database.get();
    } catch (err) {
      return [500, { error: `Could not read the library: ${err.message}`, code: 'DB_ERROR' }];
    }
    try {
      const status = job.start({
        mode, db, encrypted: vault.isEncrypted(), coveUrl: url, token, maps: mapArgs(maps),
        onFinish: (j) => {
          if (j.mode === 'preview' && j.state === 'done' && settingsVersion === startedVersion) previewOkVersion = startedVersion;
        },
      });
      return [202, status];
    } catch (err) {
      return [err.code === 'JOB_BUSY' ? 409 : 500, { error: err.message, code: err.code }];
    }
  };
  const sendJob = (res, [status, body]) => res.status(status).json(body);

  router.post('/preview', (req, res) => sendJob(res, startJob('preview')));
  router.post('/move', (req, res) => sendJob(res, startJob('move')));

  // ── Get your files into Cove ──────────────────────────────────────────────

  /** A Cove request that failed, in plain words. */
  function coveProblem(err, snap) {
    const url = snap.url;
    if (err && err.status === 401) {
      return snap.token ? job.UI_MESSAGES.tokenRejected() : job.UI_MESSAGES.noToken();
    }
    if (err && err.code === 'NET_OFF') return err.message;
    if (err && !err.status) {
      let origin = url;
      try { origin = new URL(url).origin; } catch {}
      return `Could not reach Cove at ${origin}. Is Cove running? The address is in Cove's window title.`;
    }
    return (err && err.message) || String(err);
  }

  /**
   * Vault's folders against Cove's library, plus what this token may do.
   * Reads the Vault library (SELECT only) and Cove (GET only).
   */
  async function loadFolders(snap, signal) {
    const client = job.clientFor({ coveUrl: snap.url, token: snap.token, readOnly: true, signal });
    const me = await client.me();
    const perms = (me && me.permissions) || [];
    const cfg = await client.getConfig();
    const roots = ((cfg && cfg.covePaths) || []).map(p => p && p.path).filter(p => typeof p === 'string');
    const redacted = roots.includes('[redacted]');
    const rows = F.folderRows({ rows: F.readMediaRows(database.get()), maps: snap.maps, roots: redacted ? [] : roots });
    markEmptyRows(rows);
    return {
      rows,
      roots: redacted ? null : roots,
      canAddFolders: M.hasPermission(perms, 'system.settings.write') && !redacted,
      canScan: M.hasPermission(perms, 'library.scan'),
      canStopScan: M.hasPermission(perms, 'jobs.cancel'),
    };
  }

  /**
   * After a completed scan and the preview that followed it: a scanned row
   * none of whose items Cove found is marked 'empty' (usually a folder
   * mapping that points somewhere Cove has nothing).
   */
  function markEmptyRows(rows) {
    const s = job.status();
    const scan = s.lastScan;
    const last = job.lastReport();
    if (!scan || scan.coveStatus !== 'completed' || !scan.finishedAt || !last) return;
    if (last.report.mode !== 'dry run' && last.report.mode !== 'apply') return;
    if (new Date(last.report.generatedAt).getTime() < scan.finishedAt) return;
    const scanned = scan.paths.map(F.pathKey);
    const unmatched = (last.report.unmatched || []).map(u => F.pathKey(u.path));
    for (const row of rows) {
      if (row.state !== 'in' || !scanned.some(k => F.within(F.pathKey(row.covePath), k))) continue;
      const vk = F.pathKey(row.vaultPath);
      const missing = unmatched.filter(k => F.within(k, vk)).length;
      if (missing < row.items) continue;
      row.state = 'empty';
      row.note = row.mapped ? 'Cove found no files here. Check the folder mapping.' : 'Cove found none of these files. Check that Cove can open this folder.';
    }
  }

  router.get('/folders', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const snap = snapshot();
    try {
      res.json(await loadFolders(snap));
    } catch (err) {
      res.status(err && err.code === 'BAD_ARGS' ? 400 : 502).json({ error: coveProblem(err, snap), code: err.code || 'COVE_ERROR' });
    }
  });

  router.post('/scan', async (req, res) => {
    if (vault.isLocked()) return res.status(423).json({ error: 'Vault is locked. Unlock it first.', code: 'VAULT_LOCKED' });
    // Hold the job slot from the first moment: while Vault and Cove are read
    // below, settings changes, checks, previews and moves all answer 409.
    const slot = job.reserve();
    if (!slot) return res.status(409).json(BUSY);
    try {
      await scanRoute(req, res, slot);
    } finally {
      slot.release();                 // no-op once startScan took the slot
    }
  });

  function preparingEnded(slot) {
    const r = slot.signal.reason;
    return r && r.code === 'VAULT_LOCKED'
      ? { error: 'Vault locked before the scan started. Nothing was sent to Cove. Unlock Vault and try again.', code: 'VAULT_LOCKED' }
      : { error: 'Stopped before the scan started. Nothing was sent to Cove.', code: 'STOPPED' };
  }

  async function scanRoute(req, res, slot) {
    const addFolders = req.body?.addFolders === true;
    const generate = req.body?.generate === 'all' ? 'all' : 'covers';
    const snap = snapshot();
    let f;
    try {
      f = await loadFolders(snap, slot.signal);
    } catch (err) {
      if (slot.signal.aborted) return res.status(409).json(preparingEnded(slot));
      return res.status(502).json({ error: coveProblem(err, snap), code: err.code || 'COVE_ERROR' });
    }
    // Stopped, or the vault locked, while Cove was being read: start nothing.
    if (slot.signal.aborted) return res.status(409).json(preparingEnded(slot));
    if (vault.isLocked()) return res.status(423).json({ error: 'Vault is locked. Unlock it first.', code: 'VAULT_LOCKED' });
    if (!f.canScan) {
      return res.status(403).json({ error: 'Cove does not let Vault start a scan (the token needs the library.scan permission). Start a scan from Cove\'s Tasks page, then press Preview here.', code: 'NO_PERMISSION' });
    }
    const unique = (list) => [...new Map(list.map(p => [F.pathKey(p), p])).values()];
    let addPaths = [];
    let scanPaths;
    if (addFolders) {
      if (!f.canAddFolders) {
        return res.status(403).json({ error: 'Cove does not let Vault change its library folders (the token needs the system.settings.write permission). Add the folders in Cove\'s Settings yourself, then use "Only scan".', code: 'NO_PERMISSION' });
      }
      addPaths = unique(f.rows.filter(r => r.state === 'add').map(r => r.covePath));
      if (!addPaths.length) return res.status(400).json({ error: 'Cove already has every folder. Use "Only scan" instead.', code: 'NOTHING_TO_ADD' });
      scanPaths = addPaths;
    } else {
      scanPaths = unique([
        ...f.rows.filter(r => r.state === 'in' || r.state === 'empty').map(r => r.covePath),
        ...f.rows.filter(r => r.state === 'overlap').flatMap(r => r.innerRoots),
      ]);
      if (!scanPaths.length) return res.status(400).json({ error: 'None of your folders are in Cove\'s library yet, so there is nothing to scan. Add them first.', code: 'NOTHING_TO_SCAN' });
    }
    try {
      const status = job.startScan({
        coveUrl: snap.url, token: snap.token, addPaths, scanPaths, generate,
        reservation: slot, canStop: f.canStopScan,
        // Settings can't change while the slot is held; this is the belt to that brace.
        stillValid: () => settingsVersion === snap.version && token === snap.token,
        // The preview follows a completed scan by itself, Settings open or not.
        onFinish: (j) => { if (j.state === 'done') startJob('preview'); },
      });
      res.status(202).json(status);
    } catch (err) {
      res.status(err.code === 'JOB_BUSY' ? 409 : 500).json({ error: err.message, code: err.code });
    }
  }

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
    const s = job.status();
    if (s.state === 'running' && s.mode === 'scan' && s.scan && !s.scan.canStop) {
      return res.json({ stopping: false, error: job.SCAN_CANT_STOP_MSG });
    }
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
