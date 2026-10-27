/**
 * Stage hub (PLAYLISTS_SPEC 5): the link between Control (the Vault window,
 * its mini player acting as the remote) and Stage (mpv's window, shared in
 * Discord).
 *
 * Control holds one server-sent event stream (GET /api/stage/events) and
 * sends commands (POST /api/stage/cmd). Stage is mpv, driven on the server by
 * the engine (lib/stage/engine.js): the hub hands it every command and takes
 * its reports (status, started, skipped, finished) to pass on to Control.
 *
 * The hub keeps the session as well as relaying it: what is on Stage, what
 * comes next, the volume, Hold. A Control tab that (re)connects gets all of
 * it at once ("sync"), so it can reload, or sit throttled in a background
 * tab, while Stage carries on by itself.
 *
 * Nothing here touches the library, the disk or mpv. createHub() takes the
 * Stage runner (stage-routes.js: the engine and the mpv process) and the
 * settings store as plain objects, so the tests drive it with fakes.
 */

const MEDIA_TYPES = new Set(['video', 'image', 'gif', 'audio']);
const VIA = new Set(['user', 'upnext', 'list']);
const REPEAT = new Set(['off', 'all', 'one']);
const ROLES = new Set(['control']);
const STAGE_STATES = new Set(['loading', 'playing', 'paused', 'picture', 'black', 'ended', 'waiting']);
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
// What Stage may be handed to play after the file on it: Up next and the
// rest of the list. Long on purpose: the Vault tab that sends it is often in
// the background, where the browser slows its timers to once a minute or
// freezes the page outright, and Stage must keep playing on its own for
// hours (500 videos is days; even 8 s pictures last over an hour). Each item
// is about 200 bytes, well inside the server's 2 MB body limit.
const MAX_UPCOMING = 500;
const HEARTBEAT_MS = 15000;

/* ── Validation (pure) ─────────────────────────────────────────────────── */

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const nonNeg = (v) => fin(v) && v >= 0;

/**
 * One item as Stage needs it, or null. File paths never travel: the server
 * looks the path up from the id, in the library, when Stage plays it.
 */
function cleanItem(it) {
  if (!it || typeof it !== 'object') return null;
  if (typeof it.key !== 'string' || !KEY_RE.test(it.key)) return null;
  if (!Number.isInteger(it.id) || it.id <= 0) return null;
  if (!MEDIA_TYPES.has(it.media_type)) return null;
  if (typeof it.filename !== 'string' || it.filename.length > 1024) return null;
  return {
    key: it.key, id: it.id, media_type: it.media_type, filename: it.filename,
    duration: nonNeg(it.duration) ? it.duration : null,
    width: Number.isInteger(it.width) && it.width > 0 ? it.width : null,
    height: Number.isInteger(it.height) && it.height > 0 ? it.height : null,
    startAt: nonNeg(it.startAt) ? it.startAt : 0,
    via: VIA.has(it.via) ? it.via : 'user',
    index: Number.isInteger(it.index) && it.index >= -1 ? it.index : -1,
  };
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

/**
 * A command from Control, checked: { ok, cmd } or { ok: false, error }.
 * Commands: load, upcoming, play, pause, seek, volume, hold, privacy, close,
 * front, size.
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
    case 'close':
      // stop: the Stage bar's X, playback stops everywhere (no page hands the file back)
      if (body.stop !== undefined && typeof body.stop !== 'boolean') return { ok: false, error: 'stop must be true or false.' };
      return { ok: true, cmd: { type, stop: body.stop === true } };
    case 'play': case 'pause': case 'front':
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
    default:
      return { ok: false, error: 'Unknown Stage command.' };
  }
}

/**
 * A report from the engine, checked: { ok, rep } or { ok: false, error }.
 * Reports: status, started, skipped, finished. (They come from Vault's own
 * engine, never from a page; the check keeps their shape fixed all the same.)
 */
function validateReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send a report object.' };
  const keyOk = (k) => typeof k === 'string' && KEY_RE.test(k);
  const { type } = body;
  switch (type) {
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
    default:
      return { ok: false, error: 'Unknown Stage report.' };
  }
}

/* ── The hub ───────────────────────────────────────────────────────────── */

/**
 * @param {object} deps
 * @param {object} deps.stage     { alive(), command(c), front(), size(preset), close(), position(),
 *                                  lock(), unlock(session), settingsChanged(settings) }
 * @param {object} deps.settings  { get(): settings, sizes: [...] }
 * @param {boolean} [deps.forceMute]  test servers: Stage never makes a sound
 */
function createHub({ stage, settings, forceMute = false, heartbeatMs = HEARTBEAT_MS } = {}) {
  const clients = new Map();     // id -> { role, res }
  let nextId = 1;
  let heartbeat = null;
  const sizes = (settings && settings.sizes) || ['free'];
  const has = (name) => !!stage && typeof stage[name] === 'function';
  const alive = () => has('alive') && stage.alive();

  const blank = () => ({
    open: false, mode: null, current: null, upcoming: [], repeat: 'off',
    paused: false, hold: false, locked: false, volume: 1, muted: false,
    status: null, closing: false, closeStop: false, openedAt: 0, resume: false, hideNames: false,
  });
  let s = blank();
  // Every item handed to the engine lately, by key: mpv may already be
  // starting one that a newer upcoming list from Control has since replaced.
  const handed = new Map();
  const MAX_HANDED = 2 * MAX_UPCOMING + 16;
  function remember(items) {
    for (const it of items) {
      handed.delete(it.key);
      handed.set(it.key, it);
      if (handed.size > MAX_HANDED) handed.delete(handed.keys().next().value);
    }
  }

  function write(res, event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone; its close handler tidies up */ }
  }

  function send(event, data) {
    for (const c of clients.values()) write(c.res, event, data);
  }

  function stageSettings() {
    const st = settings && typeof settings.get === 'function' ? settings.get() : {};
    return { ...st, forceMute: !!forceMute, hostMode: s.mode };
  }

  /** What a Control tab that connects (or asks) needs to pick up where things are. */
  function snapshot() {
    return {
      open: s.open, mode: s.mode, current: s.current, upcoming: s.upcoming, repeat: s.repeat,
      paused: s.paused, hold: s.hold, locked: s.locked, volume: s.volume, muted: s.muted,
      status: s.status, resume: s.resume, hideNames: s.hideNames,
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

  /** Where Stage was, for the hand-back to the mini player. */
  function lastSpot() {
    let t = s.current ? s.current.startAt : 0;
    if (s.status && s.current && s.status.key === s.current.key) t = s.status.t;
    return { current: s.current, t, paused: s.paused || s.hold };
  }

  /** The Stage window went away: say how, and start over. */
  function ended(how) {
    if (!s.open) return;
    // A Close that stops says so: no Control page hands the file back then.
    const last = { ...lastSpot(), stop: how === 'closed' && s.closeStop === true };
    const keep = { volume: s.volume, muted: s.muted };
    s = { ...blank(), ...keep };
    handed.clear();
    send(how, last);
  }

  /** Hold a server-sent event stream open for one Control page. Returns the client id. */
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
    write(res, 'sync', { ...snapshot(), settings: stageSettings() });
    const drop = () => { clients.delete(id); };
    req.on('close', drop);
    res.on('close', drop);
    return id;
  }

  /** mpv started (or was brought to the front). */
  function opened(mode = 'mpv') {
    s.mode = mode;
    // A new Stage: a Close from the session before is not this one's.
    s.closing = false;
    if (!s.open) { s.open = true; s.openedAt = Date.now(); }
    send('opened', { mode });
  }

  /** mpv's process ended. byUser: Vault closed it (Control's Close, the window's own close button). */
  function stageExited({ byUser = false } = {}) {
    ended(byUser || s.closing ? 'closed' : 'gone');
  }

  /**
   * The window's own close button: Stage closes the way Control's Close does.
   * stop: Control's Close that stops playback (the Stage bar's X).
   */
  function closeRequested({ stop = false } = {}) {
    if (!s.open) return;
    if (stop) s.closeStop = true;
    if (has('position')) {
      const pos = stage.position();
      if (pos && s.current && pos.key === s.current.key) {
        s.status = { ...(s.status || {}), key: pos.key, t: pos.t, paused: pos.paused };
        if (!s.hold) s.paused = pos.paused === true;
      }
    }
    s.closing = true;
    if (alive() && has('close')) stage.close();
    else ended('closed');
  }

  /** A command from Control. Returns { status, body } for the route. */
  function command(body) {
    if (s.locked) return { status: 423, body: { error: 'Vault is locked. Unlock it first.', code: 'VAULT_LOCKED' } };
    const v = validateCommand(body, sizes);
    if (!v.ok) return { status: 400, body: { error: v.error } };
    const c = v.cmd;
    if (!s.open && c.type !== 'close') return { status: 409, body: { error: 'Stage is not open.', code: 'STAGE_CLOSED' } };
    switch (c.type) {
      case 'load':
        s.current = c.item;
        s.upcoming = c.upcoming;
        s.repeat = c.repeat;
        s.paused = c.paused;
        s.status = { key: c.item.key, state: 'loading', t: c.item.startAt, d: c.item.duration || 0, paused: c.paused, hold: s.hold };
        remember([c.item, ...c.upcoming]);
        break;
      case 'upcoming':
        // An answer for an item Stage has already moved past is stale.
        if (c.forKey && s.current && c.forKey !== s.current.key) return { status: 200, body: { ok: true, stale: true } };
        s.upcoming = c.upcoming;
        s.repeat = c.repeat;
        remember(c.upcoming);
        break;
      case 'play': s.paused = false; break;
      case 'pause': s.paused = true; break;
      case 'seek': break;
      case 'volume': s.volume = c.volume; s.muted = c.muted; break;
      case 'hold': s.hold = c.on; if (!c.on) s.resume = false; break;
      case 'privacy':
        // Vault's privacy mode hides file names: none kept here either (a
        // Control tab that reconnects gets none, mpv draws none). Turned off,
        // Control sends the files again with their names.
        s.hideNames = c.hideNames;
        if (c.hideNames) {
          if (s.current) s.current = { ...s.current, filename: '' };
          s.upcoming = s.upcoming.map(u => ({ ...u, filename: '' }));
          for (const [k, it] of handed) handed.set(k, { ...it, filename: '' });
        }
        break;
      case 'front':
        if (alive() && has('front')) stage.front();
        return { status: 200, body: { ok: true } };
      case 'size':
        if (alive() && has('size')) stage.size(c.preset);
        return { status: 200, body: { ok: true } };
      case 'close': {
        if (!s.open) return { status: 200, body: { ok: true, last: lastSpot() } };
        closeRequested({ stop: c.stop === true });
        return { status: 200, body: { ok: true, last: lastSpot() } };
      }
      default: break;
    }
    if (has('command')) stage.command(c);
    // Other Control tabs follow along.
    send('cmd', c);
    return { status: 200, body: { ok: true } };
  }

  /** A report from the engine. Returns { status, body }. */
  function report(body) {
    if (s.locked) return { status: 423, body: { error: 'Vault is locked. Unlock it first.', code: 'VAULT_LOCKED' } };
    const v = validateReport(body);
    if (!v.ok) return { status: 400, body: { error: v.error } };
    const r = v.rep;
    switch (r.type) {
      case 'status':
        s.status = r;
        // On Hold the engine reports paused; what Control asked for stays.
        if (s.current && r.key === s.current.key && !r.hold) s.paused = r.paused;
        break;
      case 'started': {
        // Stage moved on by itself to one of the files it was given.
        if (!s.current || r.key !== s.current.key) {
          const i = s.upcoming.findIndex(u => u.key === r.key);
          if (i !== -1) {
            s.current = s.upcoming[i];
            s.upcoming = s.upcoming.slice(i + 1);
          } else if (handed.has(r.key)) {
            // A file mpv had lined up and started just as Control replaced it
            // (Up next changed as a file ended): it is what Stage plays now.
            // Control's newer list stays next; Control counts this one as
            // played and sends what comes after it.
            s.current = handed.get(r.key);
            s.upcoming = s.upcoming.filter(u => u.key !== r.key);
          } else {
            return { status: 409, body: { error: 'Stage started a file it was not given.', code: 'UNKNOWN_KEY' } };
          }
          s.paused = false;
        }
        send('started', { item: s.current, auto: r.auto, upcoming: s.upcoming });
        return { status: 200, body: { ok: true } };
      }
      case 'skipped': {
        const item = (s.current && s.current.key === r.key) ? s.current : s.upcoming.find(u => u.key === r.key) || null;
        s.upcoming = s.upcoming.filter(u => u.key !== r.key);
        send('skipped', { key: r.key, item, reason: r.reason });
        return { status: 200, body: { ok: true } };
      }
      case 'finished':
        s.status = { ...(s.status || {}), state: 'black' };
        send('finished', { current: s.current });
        return { status: 200, body: { ok: true } };
      default: break;
    }
    send(r.type, r);
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
      if (has('lock')) stage.lock();
    }
    const all = [...clients.values()];
    clients.clear();
    for (const c of all) {
      write(c.res, 'locked', {});
      try { c.res.end(); } catch {}
    }
  }

  /** Unlocked: an mpv still open picks the file up again, paused under Hold. */
  function unlock() {
    s.locked = false;
    if (!s.open) return;
    if (!alive()) { ended('gone'); return; }
    if (has('unlock')) stage.unlock(snapshot());
  }

  /** Settings changed on the Settings page: mpv and the remote follow at once. */
  function settingsChanged() {
    const st = stageSettings();
    send('settings', st);
    if (alive() && has('settingsChanged')) stage.settingsChanged(st);
  }

  function state() { return snapshot(); }
  function count() { return clients.size; }

  function close() {
    clearInterval(heartbeat);
    heartbeat = null;
    for (const c of clients.values()) { try { c.res.end(); } catch {} }
    clients.clear();
  }

  return { attach, command, report, opened, stageExited, closeRequested, lock, unlock, settingsChanged, state, count, close, _session: () => s };
}

module.exports = { createHub, validateCommand, validateReport, cleanItem, ROLES, MEDIA_TYPES, MAX_UPCOMING, STAGE_STATES };
