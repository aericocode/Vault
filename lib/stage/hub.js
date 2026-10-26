/**
 * Stage hub (PLAYLISTS_SPEC 5): the link between Control (the Vault window,
 * its mini player acting as the remote) and Stage (the window shared in
 * Discord).
 *
 * The Stage window is a separate browser process (the WebView2 host has its
 * own profile), so nothing in the page can reach it directly. Both sides talk
 * to the server instead: each holds one server-sent event stream
 * (GET /api/stage/events?role=control|stage), Control sends commands
 * (POST /api/stage/cmd) and Stage sends reports (POST /api/stage/report).
 *
 * The hub keeps the session as well as relaying it: what is on Stage, what
 * comes next, the volume, Hold. A side that (re)connects gets all of it at
 * once ("sync"), so Control can reload, or sit throttled in a background tab,
 * while Stage carries on with what it has.
 *
 * The Wall on Stage (PLAYLISTS_SPEC, Stage decision 6) is a second thing
 * Stage can show instead of files: Control sends the Wall's settings and its
 * source as a query spec ("wall"), every change again, and Stage runs the
 * collage itself (player-lib/wall.js) and reports what it is doing ("wall"
 * reports). Files wait meanwhile (Up next is kept); "wallOff" ends it and a
 * "load" replaces it. Play and pause pause the Wall; seeking has nothing to
 * seek.
 *
 * Nothing here touches the library or the disk. createHub() takes the window
 * launcher (lib/stage/host.js) and the settings store as plain objects, so the
 * tests drive it with fakes.
 */

const WallRules = require('../../player-lib/wall-rules.js');

const MEDIA_TYPES = new Set(['video', 'image', 'gif', 'audio']);
const VIA = new Set(['user', 'upnext', 'list']);
const REPEAT = new Set(['off', 'all', 'one']);
const ROLES = new Set(['control', 'stage']);
const STAGE_STATES = new Set(['loading', 'playing', 'paused', 'picture', 'black', 'ended', 'waiting', 'wall']);
const WALL_STATES = new Set(['loading', 'running', 'empty', 'error']);
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_UPCOMING = 4;
const MAX_SPEC_BYTES = 16384;        // a query spec (search, filters, sort) is far smaller
const MAX_PEEK = 6;
const HEARTBEAT_MS = 15000;

/* ── Validation (pure) ─────────────────────────────────────────────────── */

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const nonNeg = (v) => fin(v) && v >= 0;

/** One item as Stage needs it, or null. Filepaths never travel: Stage asks for /media/:id. */
function cleanItem(it) {
  if (!it || typeof it !== 'object') return null;
  if (typeof it.key !== 'string' || !KEY_RE.test(it.key)) return null;
  if (!Number.isInteger(it.id) || it.id <= 0) return null;
  if (!MEDIA_TYPES.has(it.media_type)) return null;
  if (typeof it.filename !== 'string' || it.filename.length > 1024) return null;
  const out = {
    key: it.key, id: it.id, media_type: it.media_type, filename: it.filename,
    duration: nonNeg(it.duration) ? it.duration : null,
    width: Number.isInteger(it.width) && it.width > 0 ? it.width : null,
    height: Number.isInteger(it.height) && it.height > 0 ? it.height : null,
    startAt: nonNeg(it.startAt) ? it.startAt : 0,
    via: VIA.has(it.via) ? it.via : 'user',
    index: Number.isInteger(it.index) && it.index >= -1 ? it.index : -1,
  };
  return out;
}

function cleanUpcoming(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > MAX_UPCOMING) return null;
  const out = [];
  for (const it of list) {
    const c = cleanItem(it);
    if (!c) return null;
    out.push(c);
  }
  return out;
}

const plainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The Wall's source as a query spec: an object of modest size (the query route checks its fields). */
function cleanSpec(spec) {
  if (spec === undefined) return {};
  if (!plainObject(spec)) return null;
  let json;
  try { json = JSON.stringify(spec); } catch { return null; }
  if (Buffer.byteLength(json, 'utf8') > MAX_SPEC_BYTES) return null;
  return JSON.parse(json);
}

/**
 * A command from Control, checked: { ok, cmd } or { ok: false, error }.
 * Commands: load, upcoming, play, pause, seek, volume, hold, close, front, size,
 * and for the Wall on Stage: wall, wallShuffle, wallOff.
 */
function validateCommand(body, sizes = ['free']) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send a command object.' };
  const { type } = body;
  const repeatOk = (r) => r === undefined || REPEAT.has(r);
  switch (type) {
    case 'load': {
      const item = cleanItem(body.item);
      if (!item) return { ok: false, error: 'load needs an item: key, id, media_type, filename.' };
      const upcoming = cleanUpcoming(body.upcoming);
      if (!upcoming) return { ok: false, error: `upcoming must be a list of up to ${MAX_UPCOMING} items.` };
      if (!repeatOk(body.repeat)) return { ok: false, error: 'repeat must be off, all or one.' };
      return { ok: true, cmd: { type, item, upcoming, paused: body.paused === true, repeat: body.repeat || 'off' } };
    }
    case 'upcoming': {
      const upcoming = cleanUpcoming(body.upcoming);
      if (!upcoming) return { ok: false, error: `upcoming must be a list of up to ${MAX_UPCOMING} items.` };
      if (!repeatOk(body.repeat)) return { ok: false, error: 'repeat must be off, all or one.' };
      if (body.forKey !== undefined && (typeof body.forKey !== 'string' || !KEY_RE.test(body.forKey))) return { ok: false, error: 'forKey must be an item key.' };
      return { ok: true, cmd: { type, upcoming, repeat: body.repeat || 'off', forKey: body.forKey || null } };
    }
    case 'play': case 'pause': case 'close': case 'front':
      return { ok: true, cmd: { type } };
    case 'seek':
      if (!nonNeg(body.t)) return { ok: false, error: 'seek needs t, a time in seconds.' };
      return { ok: true, cmd: { type, t: body.t } };
    case 'volume':
      if (!fin(body.volume) || body.volume < 0 || body.volume > 1) return { ok: false, error: 'volume must be 0 to 1.' };
      if (body.muted !== undefined && typeof body.muted !== 'boolean') return { ok: false, error: 'muted must be true or false.' };
      return { ok: true, cmd: { type, volume: body.volume, muted: body.muted === true } };
    case 'hold':
      if (typeof body.on !== 'boolean') return { ok: false, error: 'hold needs on: true or false.' };
      return { ok: true, cmd: { type, on: body.on } };
    case 'privacy':
      if (typeof body.hideNames !== 'boolean') return { ok: false, error: 'privacy needs hideNames: true or false.' };
      return { ok: true, cmd: { type, hideNames: body.hideNames } };
    case 'size':
      if (!sizes.includes(body.preset)) return { ok: false, error: `size must be one of ${sizes.join(', ')}.` };
      return { ok: true, cmd: { type, preset: body.preset } };
    case 'wall': {
      // Every value is clamped the way the Wall reads its own settings.
      if (!plainObject(body.cfg)) return { ok: false, error: 'wall needs cfg, the Wall settings.' };
      const spec = cleanSpec(body.spec);
      if (!spec) return { ok: false, error: `wall spec must be a query object under ${MAX_SPEC_BYTES} bytes.` };
      if (body.label !== undefined && typeof body.label !== 'string') return { ok: false, error: 'label must be text.' };
      if (body.paused !== undefined && typeof body.paused !== 'boolean') return { ok: false, error: 'paused must be true or false.' };
      if (body.from !== undefined && body.from !== null && (typeof body.from !== 'string' || !KEY_RE.test(body.from))) return { ok: false, error: 'from must be a page key.' };
      return {
        ok: true,
        cmd: {
          type, cfg: WallRules.cfgFrom(body.cfg), spec,
          label: String(body.label || '').trim().slice(0, 120) || 'The Wall',
          paused: body.paused === true, from: body.from || null,
        },
      };
    }
    case 'wallShuffle': case 'wallOff':
      return { ok: true, cmd: { type } };
    default:
      return { ok: false, error: 'Unknown Stage command.' };
  }
}

/**
 * A report from Stage, checked: { ok, rep } or { ok: false, error }.
 * Reports: ready, status, started, skipped, finished, closing, bounds.
 */
function validateReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send a report object.' };
  const keyOk = (k) => typeof k === 'string' && KEY_RE.test(k);
  const { type } = body;
  switch (type) {
    case 'ready':
    case 'finished':
      return { ok: true, rep: { type } };
    case 'status': {
      if (body.key !== null && body.key !== undefined && !keyOk(body.key)) return { ok: false, error: 'status key must be an item key.' };
      if (!STAGE_STATES.has(body.state)) return { ok: false, error: 'status needs a state.' };
      return {
        ok: true,
        rep: {
          type, key: body.key || null, state: body.state,
          t: nonNeg(body.t) ? body.t : 0, d: nonNeg(body.d) ? body.d : 0,
          paused: body.paused === true, hold: body.hold === true,
        },
      };
    }
    case 'started':
      if (!keyOk(body.key)) return { ok: false, error: 'started needs the item key.' };
      return { ok: true, rep: { type, key: body.key, auto: body.auto === true } };
    case 'skipped':
      if (!keyOk(body.key)) return { ok: false, error: 'skipped needs the item key.' };
      return { ok: true, rep: { type, key: body.key, reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : '' } };
    case 'closing':
      return { ok: true, rep: { type, key: keyOk(body.key) ? body.key : null, t: nonNeg(body.t) ? body.t : 0, paused: body.paused === true } };
    case 'bounds': {
      const r = ['x', 'y', 'w', 'h'].every(k => Number.isInteger(body[k])) && body.w > 0 && body.h > 0;
      if (!r) return { ok: false, error: 'bounds needs x, y, w and h.' };
      return { ok: true, rep: { type, x: body.x, y: body.y, w: body.w, h: body.h } };
    }
    case 'wall': {
      // What the Wall on Stage is doing, for the remote's line and Control's peek.
      if (!WALL_STATES.has(body.state)) return { ok: false, error: 'wall needs a state.' };
      const count = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 100000) : 0);
      const ids = Array.isArray(body.ids) ? body.ids.filter(id => Number.isInteger(id) && id > 0).slice(0, MAX_PEEK) : [];
      return {
        ok: true,
        rep: {
          type, state: body.state, clips: count(body.clips), blocks: count(body.blocks),
          running: body.running === true, paused: body.paused === true,
          message: typeof body.message === 'string' ? body.message.slice(0, 300) : '', ids,
        },
      };
    }
    default:
      return { ok: false, error: 'Unknown Stage report.' };
  }
}

/* ── The hub ───────────────────────────────────────────────────────────── */

/**
 * @param {object} deps
 * @param {object} deps.host       { mode(), alive(), close(), front(), size(preset), setTitle(t) }
 * @param {object} deps.settings   { get(): settings, sizes: [...] }
 * @param {number} [deps.graceMs]  how long Stage may be gone (a reload) before it counts as closed
 * @param {boolean} [deps.forceMute]  test servers: Stage never makes a sound
 */
function createHub({ host, settings, graceMs = 5000, openGraceMs = 30000, unlockGraceMs = 10000, forceMute = false, heartbeatMs = HEARTBEAT_MS } = {}) {
  const clients = new Map();     // id -> { role, res }
  let nextId = 1;
  let goneTimer = null;
  let heartbeat = null;
  const sizes = (settings && settings.sizes) || ['free'];

  const blank = () => ({
    open: false, mode: null, current: null, upcoming: [], repeat: 'off',
    paused: false, hold: false, locked: false, volume: 1, muted: false,
    status: null, closing: false, openedAt: 0, resume: false, hideNames: false,
    wall: null, wallStatus: null,   // the Wall on Stage: { cfg, spec, label, paused, from }, Stage's last report
  });
  let s = blank();

  function count(role) {
    let n = 0;
    for (const c of clients.values()) if (c.role === role) n++;
    return n;
  }

  function write(res, event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone; its close handler tidies up */ }
  }

  function send(role, event, data) {
    for (const c of clients.values()) if (!role || c.role === role) write(c.res, event, data);
  }

  function stageSettings() {
    const st = settings && typeof settings.get === 'function' ? settings.get() : {};
    return { ...st, forceMute: !!forceMute, hostMode: s.mode };
  }

  /** What a side that connects (or asks) needs to pick up where things are. */
  function snapshot() {
    return {
      open: s.open, mode: s.mode, current: s.current, upcoming: s.upcoming, repeat: s.repeat,
      paused: s.paused, hold: s.hold, locked: s.locked, volume: s.volume, muted: s.muted,
      status: s.status, stages: count('stage'), resume: s.resume, hideNames: s.hideNames,
      wall: s.wall, wallStatus: s.wallStatus,
    };
  }

  function ensureHeartbeat() {
    if (heartbeat || !heartbeatMs) return;
    heartbeat = setInterval(() => {
      if (!clients.size) { clearInterval(heartbeat); heartbeat = null; return; }
      for (const c of clients.values()) { try { c.res.write(': ping\n\n'); } catch {} }
    }, heartbeatMs);
    if (heartbeat.unref) heartbeat.unref();
  }

  /** The Stage window went away: say how, and start over. */
  function ended(how) {
    clearTimeout(goneTimer);
    goneTimer = null;
    if (!s.open) return;
    const last = { current: s.current, t: s.status && s.status.key === (s.current && s.current.key) ? s.status.t : (s.current ? s.current.startAt : 0), paused: s.paused || s.hold, wall: !!s.wall };
    const keep = { volume: s.volume, muted: s.muted };
    s = { ...blank(), ...keep };
    send('control', how, last);
    // A Stage page still connected (a popup the browser kept) is told to go.
    send('stage', 'close', {});
  }

  /** Stage lost its stream (a reload, a crash). With no host process to ask, wait a moment first. */
  function stageLeft() {
    if (count('stage') > 0 || !s.open) return;
    if (host && typeof host.alive === 'function' && host.alive()) return;   // the host's exit decides
    clearTimeout(goneTimer);
    goneTimer = setTimeout(() => {
      if (count('stage') > 0) return;
      ended(s.closing ? 'closed' : 'gone');
    }, graceMs);
    if (goneTimer.unref) goneTimer.unref();
  }

  /**
   * Hold a server-sent event stream open for one page.
   * @returns {number} the client id
   */
  function attach(role, req, res) {
    const id = nextId++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    clients.set(id, { role, res });
    ensureHeartbeat();
    if (role === 'stage') {
      clearTimeout(goneTimer);
      goneTimer = null;
      if (!s.open) { s.open = true; s.openedAt = Date.now(); if (!s.mode) s.mode = 'popup'; }
      write(res, 'sync', { ...snapshot(), settings: stageSettings() });
      send('control', 'opened', { mode: s.mode });
    } else {
      write(res, 'sync', { ...snapshot(), settings: stageSettings() });
    }
    const drop = () => {
      if (!clients.delete(id)) return;
      if (role === 'stage') stageLeft();
    };
    req.on('close', drop);
    res.on('close', drop);
    return id;
  }

  /** The window launcher started (or reused) a Stage window. */
  function opened(mode) {
    clearTimeout(goneTimer);
    goneTimer = null;
    s.mode = mode;
    // A new Stage: a Close from the session before (still in its grace period) is not this one's.
    s.closing = false;
    if (!s.open) { s.open = true; s.openedAt = Date.now(); }
    send('control', 'opened', { mode });
    // A pop-up the browser blocked never connects: give it a while, then it is gone.
    if (!count('stage')) {
      goneTimer = setTimeout(() => {
        if (count('stage') > 0) return;
        if (host && typeof host.alive === 'function' && host.alive()) return;
        ended('gone');
      }, Math.max(graceMs, openGraceMs));
      if (goneTimer.unref) goneTimer.unref();
    }
  }

  /** The host process exited. byUser: its own close button (or Control's Close). */
  function hostExited({ byUser = false } = {}) {
    ended(byUser || s.closing ? 'closed' : 'gone');
  }

  /**
   * A command from Control. Returns { status, body } for the route.
   */
  function command(body) {
    if (s.locked) return { status: 423, body: { error: 'Vault is locked. Unlock it first.', code: 'VAULT_LOCKED' } };
    const v = validateCommand(body, sizes);
    if (!v.ok) return { status: 400, body: { error: v.error } };
    let c = v.cmd;
    if (!s.open && c.type !== 'close') return { status: 409, body: { error: 'Stage is not open.', code: 'STAGE_CLOSED' } };
    if (s.wall && (c.type === 'play' || c.type === 'pause')) {
      // The Wall on Stage: play and pause are the Wall's (the same as its Pause button).
      s.wall = { ...s.wall, paused: c.type === 'pause', from: null };
      c = { type: 'wall', ...s.wall };
    }
    switch (c.type) {
      case 'load':
        // A file on Stage ends the Wall there.
        s.wall = null;
        s.wallStatus = null;
        s.current = c.item;
        s.upcoming = c.upcoming;
        s.repeat = c.repeat;
        s.paused = c.paused;
        s.status = { key: c.item.key, state: 'loading', t: c.item.startAt, d: c.item.duration || 0, paused: c.paused, hold: s.hold };
        break;
      case 'upcoming':
        // An answer for an item Stage has already moved past is stale.
        if (c.forKey && s.current && c.forKey !== s.current.key) return { status: 200, body: { ok: true, stale: true } };
        s.upcoming = c.upcoming;
        s.repeat = c.repeat;
        break;
      case 'play': s.paused = false; break;
      case 'pause': s.paused = true; break;
      case 'seek':
        if (s.wall) return { status: 409, body: { error: 'The Wall is on Stage: there is nothing to seek.', code: 'WALL_ON_STAGE' } };
        break;
      case 'wall':
        // Shown (or changed): the file that was on Stage gives way; Up next waits.
        if (!s.wall) s.wallStatus = null;
        s.wall = { cfg: c.cfg, spec: c.spec, label: c.label, paused: c.paused, from: c.from };
        s.current = null;
        s.upcoming = [];
        s.paused = c.paused;
        s.status = { key: null, state: 'wall', t: 0, d: 0, paused: c.paused, hold: s.hold };
        break;
      case 'wallShuffle':
        if (!s.wall) return { status: 409, body: { error: 'The Wall is not on Stage.', code: 'WALL_OFF' } };
        break;
      case 'wallOff':
        if (!s.wall) return { status: 200, body: { ok: true, already: true } };
        s.wall = null;
        s.wallStatus = null;
        s.status = { key: null, state: 'black', t: 0, d: 0, paused: true, hold: s.hold };
        break;
      case 'volume': s.volume = c.volume; s.muted = c.muted; break;
      case 'hold': s.hold = c.on; if (!c.on) s.resume = false; break;
      case 'privacy':
        // Vault's privacy mode hides file names: none kept here either (a
        // Stage that reconnects gets none). Turned off, Control sends the
        // files again with their names.
        s.hideNames = c.hideNames;
        if (c.hideNames) {
          if (s.current) s.current = { ...s.current, filename: '' };
          s.upcoming = s.upcoming.map(u => ({ ...u, filename: '' }));
        }
        break;
      case 'front':
        if (host && host.alive && host.alive()) host.front();
        else send('stage', 'front', {});
        return { status: 200, body: { ok: true } };
      case 'size':
        if (host && host.alive && host.alive()) host.size(c.preset);
        else send('stage', 'size', { preset: c.preset, ...(settings.presets && settings.presets[c.preset] ? settings.presets[c.preset] : {}) });
        return { status: 200, body: { ok: true } };
      case 'close': {
        const last = { current: s.current, t: s.status ? s.status.t : 0, paused: s.paused || s.hold };
        if (!s.open) return { status: 200, body: { ok: true, last } };
        s.closing = true;
        if (host && host.alive && host.alive()) host.close();
        send('stage', 'close', {});
        stageLeft();
        return { status: 200, body: { ok: true, last } };
      }
      default: break;
    }
    send('stage', c.type, c);
    // Other Control tabs follow along.
    send('control', 'cmd', c);
    return { status: 200, body: { ok: true } };
  }

  /** A report from Stage. Returns { status, body }. */
  function report(body) {
    if (s.locked) return { status: 423, body: { error: 'Vault is locked. Unlock it first.', code: 'VAULT_LOCKED' } };
    const v = validateReport(body);
    if (!v.ok) return { status: 400, body: { error: v.error } };
    const r = v.rep;
    switch (r.type) {
      case 'status':
        s.status = r;
        if (s.current && r.key === s.current.key) s.paused = r.paused;
        break;
      case 'started': {
        // Stage moved on by itself to one of the files it was given.
        if (!s.current || r.key !== s.current.key) {
          const i = s.upcoming.findIndex(u => u.key === r.key);
          if (i === -1) return { status: 409, body: { error: 'Stage started a file it was not given.', code: 'UNKNOWN_KEY' } };
          s.current = s.upcoming[i];
          s.upcoming = s.upcoming.slice(i + 1);
          s.paused = false;
        }
        send('control', 'started', { item: s.current, auto: r.auto, upcoming: s.upcoming });
        return { status: 200, body: { ok: true } };
      }
      case 'skipped': {
        const item = (s.current && s.current.key === r.key) ? s.current : s.upcoming.find(u => u.key === r.key) || null;
        s.upcoming = s.upcoming.filter(u => u.key !== r.key);
        send('control', 'skipped', { key: r.key, item, reason: r.reason });
        return { status: 200, body: { ok: true } };
      }
      case 'finished':
        s.status = { ...(s.status || {}), state: 'black' };
        send('control', 'finished', { current: s.current });
        return { status: 200, body: { ok: true } };
      case 'closing':
        s.closing = true;
        if (r.key && s.current && r.key === s.current.key) s.status = { ...(s.status || {}), t: r.t, paused: r.paused };
        return { status: 200, body: { ok: true } };
      case 'bounds':
        if (settings && typeof settings.saveBounds === 'function') settings.saveBounds(r);
        return { status: 200, body: { ok: true } };
      case 'wall':
        // A late report from a Wall that has since left Stage.
        if (!s.wall) return { status: 200, body: { ok: true, stale: true } };
        s.wallStatus = r;
        send('control', 'wallStatus', r);
        return { status: 200, body: { ok: true } };
      default: break;
    }
    send('control', r.type, r);
    return { status: 200, body: { ok: true } };
  }

  /** Vault locked: black at once, every stream told and closed. The session waits for the unlock. */
  function lock() {
    s.locked = true;
    if (s.open) {
      // Black and paused; whether it was playing decides what Hold off does after the unlock.
      if (!s.hold) s.resume = !s.paused;
      s.hold = true;
      s.paused = true;
    }
    // Forgotten first, so ending the streams decides nothing while locked:
    // whether a Stage is still there is settled after the unlock (unlock()).
    const all = [...clients.values()];
    clients.clear();
    clearTimeout(goneTimer);
    goneTimer = null;
    for (const c of all) {
      write(c.res, 'locked', {});
      try { c.res.end(); } catch {}
    }
  }

  /**
   * Unlocked. A Stage window still open reconnects within a few seconds (it
   * polls for the unlock); one that went away while locked (a pop-up closed
   * then: its stream had already been ended, and it sends nothing while
   * locked) never will, so the same wait as for a reload decides. A host
   * process's exit decides for itself (stageLeft leaves those alone).
   */
  function unlock() {
    s.locked = false;
    if (!s.open || count('stage') > 0) return;
    if (host && typeof host.alive === 'function' && host.alive()) return;
    clearTimeout(goneTimer);
    goneTimer = setTimeout(() => {
      if (count('stage') > 0 || !s.open) return;
      ended(s.closing ? 'closed' : 'gone');
    }, Math.max(graceMs, unlockGraceMs));
    if (goneTimer.unref) goneTimer.unref();
  }

  /** Settings changed on the Settings page: Stage and the remote follow at once. */
  function settingsChanged() {
    const st = stageSettings();
    send(null, 'settings', st);
    if (host && host.alive && host.alive() && typeof host.setTitle === 'function') host.setTitle(st.windowName);
  }

  function state() { return snapshot(); }

  function close() {
    clearTimeout(goneTimer);
    clearInterval(heartbeat);
    heartbeat = null;
    for (const c of clients.values()) { try { c.res.end(); } catch {} }
    clients.clear();
  }

  return { attach, command, report, opened, hostExited, lock, unlock, settingsChanged, state, count, close, _session: () => s };
}

module.exports = { createHub, validateCommand, validateReport, cleanItem, cleanSpec, ROLES, MEDIA_TYPES, MAX_UPCOMING, MAX_SPEC_BYTES };
