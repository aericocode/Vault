/* =========================================================================
   STAGE - the page the Stage window shows (PLAYLISTS_SPEC 5).

   A dumb renderer: it plays what Control (the Vault window's remote) tells
   it, and nothing but the media is ever on screen. It talks to Control
   through the server (lib/stage/hub.js): one event stream in
   (/api/stage/events?role=stage), reports out (/api/stage/report).

   What it owns, so a Vault tab in the background (the streamer is in
   Discord, the browser slows that tab's timers) never holds Stage up:
   - moving on by itself when a file ends, to the upcoming files Control
     handed it with the current one (Up next first, then the list), then
     telling Control which one started
   - the picture timer (8 s by default; a GIF at least one full loop)
   - saving the resume spot, the view count and the watch heatmap, as the
     player does (player-lib/viewtracker.js)

   Never a black gap between files: each file gets its own layer, laid in
   under the one playing and shown only once it can play (a converted file
   can take a few seconds; the last picture stays up meanwhile). A file that
   cannot play is skipped here and reported. The end of the list, Hold and a
   lock are black. A lock (or any request refused with 423) is black at once,
   with everything stopped: Stage never shows anything of the library.
   ========================================================================= */

(() => {
  const params = new URLSearchParams(location.search);
  const HOST = params.get('host') === 'webview2' ? 'webview2' : 'popup';
  const webview = HOST === 'webview2' && window.chrome && window.chrome.webview ? window.chrome.webview : null;
  const $ = (id) => document.getElementById(id);
  const mediaBox = $('stageMedia');
  const blackEl = $('stageBlack');
  const nameEl = $('stageName');
  const fillBtn = $('stageFill');

  const STATUS_MS = 250;              // reports to Control, about 4 a second
  const LOAD_TIMEOUT_MS = 20000;      // a file that never starts is skipped
  const REMUX_TIMEOUT_MS = 60000;     // a converted file gets longer
  const WAIT_UPCOMING_MS = 3000;      // end of a file with nothing next: wait this long for Control
  const PREPARE_AHEAD_S = 12;         // get the next file ready this long before the end
  const SAVE_EVERY_S = 5;

  let settings = { showName: true, nameSeconds: 3, imageSeconds: 8, cursorSeconds: 1, windowName: 'Vault Stage', forceMute: false };
  let volume = 1;
  let muted = false;
  let repeat = 'off';
  let hold = false;
  let holdWasPlaying = false;
  let locked = false;
  let finished = false;
  let hideNames = false;              // Vault's privacy mode hides file names: Stage shows none
  let needNext = false;               // moved on and found nothing: the next upcoming list plays at once
  let upcoming = [];
  let cur = null;                     // the layer on screen
  let loading = null;                 // a layer being made ready to replace it
  let ahead = null;                   // the next file, made ready before the current one ends
  let gen = 0;                        // bumps on every load: late answers for an old one are dropped
  let es = null;
  let waitTimer = null;
  let lastSent = '';
  let caps = '';
  try { caps = typeof codecCaps === 'function' ? codecCaps() : ''; } catch {}

  /* ── Talking to the server ────────────────────────────────────────── */

  function report(body, { beacon = false } = {}) {
    if (locked) return Promise.resolve();
    const json = JSON.stringify(body);
    if (beacon && navigator.sendBeacon) {
      try { navigator.sendBeacon('/api/stage/report', new Blob([json], { type: 'application/json' })); } catch {}
      return Promise.resolve();
    }
    // Auto-lock: a Stage that is playing counts as someone being there (its
    // status reports, like a player's stream requests), so the library never
    // auto-locks and blacks out a live stream. Everything else Stage sends is
    // marked as background (server/index.js lock gate), so Hold, a pause or
    // the black end of the list let the auto-lock clock run as usual.
    const presence = body.type === 'status' && !body.hold && !body.paused && (body.state === 'playing' || body.state === 'picture');
    return fetch('/api/stage/report', {
      method: 'POST',
      headers: presence ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json', 'X-Vault-Background': '1' },
      body: json,
    }).then((r) => { if (r.status === 423) lockdown(); }).catch(() => {});
  }

  /** Any request of Stage's: a 423 means the library just locked. */
  async function get(url, opts) {
    const r = await fetch(url, opts);
    if (r.status === 423) { lockdown(); throw new Error('locked'); }
    return r;
  }

  function post(url, body, { keepalive = false } = {}) {
    if (locked) return;
    fetch(url, {
      method: 'POST', keepalive,
      // Saving the spot and the view count is not someone being there (see report()).
      headers: { 'Content-Type': 'application/json', 'X-Vault-Background': '1' },
      body: JSON.stringify(body),
    }).then((r) => { if (r.status === 423) lockdown(); }).catch(() => {});
  }

  /* ── Layers ───────────────────────────────────────────────────────── */

  function streamToken() {
    const c = window.crypto;
    if (c && typeof c.randomUUID === 'function') return `stage-${c.randomUUID().toLowerCase()}`;
    const b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `stage-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  const isPicture = (item) => item.media_type === 'image' || item.media_type === 'gif';

  function applySound(v) {
    if (!v) return;
    v.volume = Math.max(0, Math.min(1, volume));
    v.muted = muted || hold || locked || settings.forceMute === true;
  }

  /**
   * Make a layer for `item` and get it ready: a video playing (or, with
   * paused, showing its frame at the start spot), a picture decoded. It sits
   * under the one on screen, invisible. Resolves the layer, or null when the
   * file cannot play here.
   */
  function prepare(item, { paused = false } = {}) {
    const layer = {
      item, el: document.createElement('div'), v: null, img: null, hls: null, token: null, url: null,
      gone: false, picMs: 0, picLeft: 0, picStart: 0, picTimer: null, ended: false,
      watch: { acc: 0, lastT: null, counted: false, lastSaved: 0, heat: {} }, reason: '',
    };
    layer.el.className = 'stage-layer';
    mediaBox.appendChild(layer.el);
    const ready = isPicture(item) ? preparePicture(layer) : prepareVideo(layer, paused);
    const p = ready.then((ok) => (ok && !layer.gone ? layer : (dropLayer(layer), null)));
    p.layer = layer;
    return p;
  }

  async function preparePicture(layer) {
    const { item } = layer;
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    layer.img = img;
    let loop = 0;
    try {
      if (item.media_type === 'gif') {
        // The bytes once: their loop length, and the picture from the same copy.
        const r = await get(`/media/${item.id}`);
        if (!r.ok) { layer.reason = 'it could not be read'; return false; }
        const buf = await r.arrayBuffer();
        loop = StageRules.gifLoopSeconds(new Uint8Array(buf));
        layer.url = URL.createObjectURL(new Blob([buf], { type: 'image/gif' }));
        img.src = layer.url;
      } else {
        img.src = `/media/${item.id}`;
      }
      layer.el.appendChild(img);
      await (img.decode ? img.decode() : new Promise((res, rej) => { img.onload = res; img.onerror = rej; }));
    } catch {
      if (!locked) layer.reason = 'it cannot be shown';
      return false;
    }
    layer.picMs = StageRules.pictureMs(item, settings.imageSeconds, loop);
    layer.picLeft = layer.picMs;
    return true;
  }

  function prepareVideo(layer, paused) {
    const { item } = layer;
    const v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    v.disablePictureInPicture = true;
    v.setAttribute('disableremoteplayback', '');
    v.loop = repeat === 'one';
    layer.v = v;
    applySound(v);
    layer.el.appendChild(v);

    return new Promise((resolve) => {
      let done = false;
      let retried = false;
      let timer = null;
      const finish = (ok, why) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!ok && why) layer.reason = why;
        resolve(ok);
      };
      const armTimeout = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(false, 'it took too long to start'), ms);
      };
      const at = item.startAt > 0.5 ? item.startAt : 0;
      // Ready: a frame on screen at the right spot.
      const painted = () => {
        if (typeof v.requestVideoFrameCallback === 'function' && item.media_type === 'video') {
          let fired = false;
          v.requestVideoFrameCallback(() => { fired = true; finish(true); });
          setTimeout(() => { if (!fired) finish(true); }, 400);
        } else finish(true);
      };
      if (paused) {
        const check = () => { if (v.readyState >= 2 && !v.seeking) finish(true); };
        v.addEventListener('loadeddata', check);
        v.addEventListener('seeked', check);
      } else {
        v.addEventListener('playing', painted, { once: true });
      }
      v.addEventListener('loadedmetadata', () => {
        if (at > 0 && Math.abs(v.currentTime - at) > 1) { try { v.currentTime = at; } catch {} }
      });
      v.addEventListener('error', () => {
        if (done || layer.gone) return;
        // A native try the server also offered to convert: take that once.
        if (!retried && v.dataset.fallback === 'remux') { retried = true; v.dataset.fallback = ''; attachRemux(layer, { url: `/stream/${item.id}/index.m3u8` }, at, paused, () => finish(false, 'it cannot be played')); armTimeout(REMUX_TIMEOUT_MS); return; }
        finish(false, 'it cannot be played');
      });
      armTimeout(LOAD_TIMEOUT_MS);

      (async () => {
        let info = null;
        try {
          const r = await get(`/api/playback/${item.id}?caps=${encodeURIComponent(caps)}`);
          if (r.ok) info = await r.json();
        } catch { if (locked) return finish(false); }
        if (layer.gone) return finish(false);
        if (info && info.mode === 'unsupported') return finish(false, 'it can’t be played');
        if (info && info.mode === 'remux') {
          armTimeout(REMUX_TIMEOUT_MS);
          attachRemux(layer, info, at, paused, () => finish(false, 'it cannot be played'));
          return;
        }
        v.dataset.fallback = (info && info.fallback) || '';
        v.src = `${(info && info.url) || `/media/${item.id}`}${at > 0 ? `#t=${at.toFixed(1)}` : ''}`;
        if (!paused) v.play().catch(() => {});
      })();
    });
  }

  function attachRemux(layer, info, at, paused, fail) {
    const v = layer.v;
    layer.token = streamToken();
    const url = `${info.url}?c=${encodeURIComponent(layer.token)}`;
    if (!(typeof Hls !== 'undefined' && Hls.isSupported())) {
      v.src = url;
      if (at > 0) v.addEventListener('loadedmetadata', () => { try { v.currentTime = at; } catch {} }, { once: true });
      if (!paused) v.play().catch(() => {});
      return;
    }
    const hls = new Hls({ maxBufferLength: 60, enableWorker: true, startPosition: at > 0 ? at : -1 });
    layer.hls = hls;
    hls.on(Hls.Events.ERROR, (evt, data) => {
      if (!data || !data.fatal || layer.gone) return;
      if (data.response && data.response.code === 423) lockdown();
      fail();
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => { if (!layer.gone && !paused) v.play().catch(() => {}); });
    hls.loadSource(url);
    hls.attachMedia(v);
  }

  /** Stop a layer for good: decoder, connection, stream session, timers. */
  function dropLayer(layer) {
    if (!layer || layer.gone) return;
    layer.gone = true;
    clearTimeout(layer.picTimer);
    const v = layer.v;
    if (v) {
      try { v.muted = true; v.pause(); } catch {}
      if (!locked) saveWatch(layer, { keepalive: true });
      if (layer.hls) { try { layer.hls.destroy(); } catch {} layer.hls = null; }
      try { v.removeAttribute('src'); v.load(); } catch {}
    }
    if (layer.token && !locked) {
      const close = `/stream/${layer.item.id}/close?c=${encodeURIComponent(layer.token)}`;
      try { navigator.sendBeacon ? navigator.sendBeacon(close, new Blob([], { type: 'text/plain' })) : fetch(close, { method: 'POST', keepalive: true }); } catch {}
    }
    if (layer.url) { try { URL.revokeObjectURL(layer.url); } catch {} }
    // Removed a frame later, so the layer on top has painted first.
    requestAnimationFrame(() => requestAnimationFrame(() => layer.el.remove()));
  }

  /* ── On screen ────────────────────────────────────────────────────── */

  let nameTimer = null;
  function showName(item) {
    clearTimeout(nameTimer);
    nameEl.classList.remove('on');
    // No name when there is none to show: Vault's privacy mode with file
    // names hidden sends files without one (stage-control.js).
    if (!settings.showName || hideNames || !item || !String(item.filename || '').trim()) return;
    nameEl.textContent = StageRules.nameText(item.filename);
    nameEl.classList.add('on');
    nameTimer = setTimeout(() => nameEl.classList.remove('on'), Math.max(1, settings.nameSeconds || 3) * 1000);
  }

  function setBlack(on) {
    blackEl.classList.toggle('on', !!on);
    if (on) { clearTimeout(nameTimer); nameEl.classList.remove('on'); }
  }

  /** Put a ready layer on screen in place of the one there. */
  function swapIn(layer, { auto = false } = {}) {
    const old = cur;
    cur = layer;
    finished = false;
    needNext = false;
    clearTimeout(waitTimer);
    layer.el.classList.add('on');
    if (old && old !== layer) dropLayer(old);
    if (!hold && !locked) { setBlack(false); showName(layer.item); }
    applySound(layer.v);
    wireLayer(layer);
    if (isPicture(layer.item)) startPicture(layer);
    report({ type: 'started', key: layer.item.key, auto });
    sendStatus(true);
  }

  function wireLayer(layer) {
    const v = layer.v;
    if (!v) {
      // A picture counts as seen after a short look, as in the player.
      layer.dwell = setTimeout(() => { if (cur === layer && !hold) post(`/api/media/${layer.item.id}/viewed`, { watch_s: 0 }); }, StageRules.DWELL_MS);
      return;
    }
    v.loop = repeat === 'one';
    v.addEventListener('ended', () => { if (cur === layer && !v.loop) fileEnded(); });
    v.addEventListener('timeupdate', () => { if (cur === layer) trackWatch(layer); });
    v.addEventListener('pause', () => { if (cur === layer && !layer.gone) saveWatch(layer); });
    // A file that dies while it plays: on to the next.
    v.addEventListener('error', () => {
      if (cur !== layer || layer.gone) return;
      report({ type: 'skipped', key: layer.item.key, reason: 'it stopped playing' });
      fileEnded();
    });
  }

  /* ── Pictures: their own timer (Control's tab may be asleep) ───────── */

  function startPicture(layer) {
    clearTimeout(layer.picTimer);
    if (repeat === 'one') return;          // the picture stays
    if (hold) return;                       // starts when Hold ends
    layer.picStart = Date.now();
    layer.picTimer = setTimeout(() => { if (cur === layer) fileEnded(); }, layer.picLeft);
  }

  function pausePicture(layer) {
    if (!layer || !layer.picStart) return;
    clearTimeout(layer.picTimer);
    layer.picLeft = Math.max(0, layer.picLeft - (Date.now() - layer.picStart));
    layer.picStart = 0;
  }

  /* ── Moving on ────────────────────────────────────────────────────── */

  /** The file on screen is done (ended, its picture time is up, or it died). */
  function fileEnded() {
    if (locked) return;
    if (cur) cur.ended = true;
    if (repeat === 'one' && cur) {
      if (cur.v) { try { cur.v.currentTime = 0; cur.v.play().catch(() => {}); } catch {} }
      else { cur.picLeft = cur.picMs; startPicture(cur); }
      return;
    }
    advance();
  }

  /** Play the first upcoming file that can play; black when there is none. */
  async function advance() {
    const my = ++gen;
    clearTimeout(waitTimer);
    while (upcoming.length) {
      const next = upcoming.shift();
      let layer = null;
      if (ahead && ahead.key === next.key) {
        const a = ahead;
        ahead = null;
        layer = await a.ready;
        if (layer && !layer.gone && layer.v) {
          if (!(await playReady(layer))) { dropLayer(layer); layer = null; }
        }
      } else {
        dropAhead();
        layer = await prepare(next);
      }
      if (my !== gen) { if (layer) dropLayer(layer); return; }
      if (layer) { swapIn(layer, { auto: true }); return; }
      report({ type: 'skipped', key: next.key, reason: 'it can’t be played' });
    }
    // Nothing given (yet): Control may be a moment behind. Keep the last
    // picture up for a little, then black.
    needNext = true;
    sendStatus(true, { state: 'waiting' });
    waitTimer = setTimeout(() => {
      if (my !== gen || upcoming.length) return;
      finished = true;
      setBlack(true);
      if (cur) { dropLayer(cur); cur = null; }
      report({ type: 'finished' });
      sendStatus(true);
    }, WAIT_UPCOMING_MS);
  }

  /** A layer made ready paused (ahead of time): play it and wait for the picture to move. */
  function playReady(layer) {
    const v = layer.v;
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), LOAD_TIMEOUT_MS);
      v.addEventListener('playing', () => { clearTimeout(t); resolve(true); }, { once: true });
      applySound(v);
      v.play().catch(() => { clearTimeout(t); resolve(false); });
    });
  }

  function dropAhead() {
    const a = ahead;
    ahead = null;
    if (a) a.ready.then((l) => { if (l) dropLayer(l); });
  }

  /** Near the end of a video: get the next file ready underneath (a converted file takes a moment). */
  function maybePrepareAhead() {
    if (ahead || !cur || !cur.v || hold || locked || repeat === 'one' || !upcoming.length) return;
    const v = cur.v;
    if (!(v.duration > 0) || v.duration - v.currentTime > PREPARE_AHEAD_S) return;
    const next = upcoming[0];
    if (isPicture(next)) return;            // pictures are quick
    ahead = { key: next.key, ready: prepare(next, { paused: true }) };
  }

  /* ── Commands from Control ────────────────────────────────────────── */

  async function load(cmd) {
    const my = ++gen;
    finished = false;
    clearTimeout(waitTimer);
    upcoming = (cmd.upcoming || []).slice();
    repeat = cmd.repeat || 'off';
    dropAhead();
    if (loading) { dropLayer(loading); loading = null; }
    needNext = false;
    const paused = cmd.paused === true || hold;
    sendStatus(true, { state: 'loading', key: cmd.item.key, t: cmd.item.startAt || 0, d: cmd.item.duration || 0, paused: cmd.paused === true });
    const pending = prepare(cmd.item, { paused });
    loading = pending.layer;
    const layer = await pending;
    if (loading === pending.layer) loading = null;
    if (my !== gen) { if (layer) dropLayer(layer); return; }
    if (layer) {
      if (paused && layer.v) { try { layer.v.pause(); } catch {} }
      if (hold) holdWasPlaying = cmd.paused !== true;
      swapIn(layer);
      return;
    }
    report({ type: 'skipped', key: cmd.item.key, reason: 'it can’t be played' });
    advance();
  }

  function setUpcoming(cmd) {
    upcoming = (cmd.upcoming || []).slice();
    repeat = cmd.repeat || repeat;
    if (cur && cur.v) cur.v.loop = repeat === 'one';
    if (ahead && (!upcoming.length || upcoming[0].key !== ahead.key)) dropAhead();
    // It moved on and found nothing (a file ended, or the one sent could
    // not play), and now there is something: carry on.
    if ((needNext || finished) && upcoming.length && !locked) {
      if (finished) setBlack(hold);
      advance();
    }
  }

  function setHold(on) {
    if (on === hold) return;
    hold = on;
    const v = cur && cur.v;
    if (on) {
      holdWasPlaying = !!(v ? !v.paused : (cur && cur.picStart));
      if (v) { try { v.pause(); } catch {} }
      pausePicture(cur);
      setBlack(true);
    } else {
      setBlack(finished);
      if (cur && !finished) {
        if (v && holdWasPlaying) v.play().catch(() => {});
        if (!v && isPicture(cur.item)) startPicture(cur);
      }
    }
    if (v) applySound(v);
    sendStatus(true);
  }

  function play() {
    if (!cur || hold) { holdWasPlaying = true; return; }
    if (cur.v) { if (cur.v.ended) cur.v.currentTime = 0; cur.v.play().catch(() => {}); }
    else if (!cur.picStart) startPicture(cur);
    sendStatus(true);
  }

  function pause() {
    if (!cur) return;
    if (hold) { holdWasPlaying = false; return; }
    if (cur.v) { try { cur.v.pause(); } catch {} } else pausePicture(cur);
    sendStatus(true);
  }

  function seek(t) {
    if (!cur || !cur.v) return;
    const d = cur.v.duration;
    try { cur.v.currentTime = Math.max(0, Math.min(Number.isFinite(d) ? d - 0.05 : t, t)); } catch {}
    if (ahead) dropAhead();
    sendStatus(true);
  }

  function setVolume(cmd) {
    volume = cmd.volume;
    muted = cmd.muted === true;
    if (cur) applySound(cur.v);
  }

  function applySettings(s) {
    if (!s || typeof s !== 'object') return;
    settings = { ...settings, ...s };
    document.title = settings.windowName || 'Vault Stage';
    if (cur) applySound(cur.v);
    armCursor();
  }

  /**
   * Vault's privacy mode with file names hidden, on or off. On: a name on
   * screen goes at once, and every name Stage holds (the file playing, the
   * ones lined up, one made ready ahead) is dropped. Off: Control sends the
   * files again with their names.
   */
  function setPrivacy(on) {
    hideNames = !!on;
    if (!hideNames) return;
    clearTimeout(nameTimer);
    nameEl.classList.remove('on');
    nameEl.textContent = '';
    const blank = (it) => { if (it) it.filename = ''; };
    if (cur) blank(cur.item);
    if (loading) blank(loading.item);
    upcoming.forEach(blank);
    if (ahead) ahead.ready.then((l) => { if (l) blank(l.item); });
  }

  /* ── Lock: black at once, everything stopped ──────────────────────── */

  function lockdown() {
    if (locked) return;
    locked = true;
    ++gen;
    setBlack(true);
    clearTimeout(waitTimer);
    dropAhead();
    if (loading) { dropLayer(loading); loading = null; }
    if (cur) { dropLayer(cur); cur = null; }
    upcoming = [];
    document.querySelectorAll('video').forEach((v) => { try { v.muted = true; v.pause(); } catch {} });
    if (es) { try { es.close(); } catch {} es = null; }
    waitForUnlock();
  }

  function waitForUnlock() {
    const poll = async () => {
      try {
        const r = await fetch('/api/vault/status', { headers: { 'X-Vault-Background': '1' } });
        const s = r.ok ? await r.json() : null;
        if (s && s.locked === false) { locked = false; connect(); return; }
      } catch {}
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 2000);
  }

  /* ── The event stream ─────────────────────────────────────────────── */

  function connect() {
    if (es) { try { es.close(); } catch {} }
    es = new EventSource('/api/stage/events?role=stage');
    const on = (name, fn) => es.addEventListener(name, (e) => {
      let data = {};
      try { data = JSON.parse(e.data || '{}'); } catch {}
      try { fn(data); } catch (err) { console.warn('[Stage]', name, err); }
    });
    on('sync', (s) => {
      applySettings(s.settings);
      volume = Number.isFinite(s.volume) ? s.volume : volume;
      muted = s.muted === true;
      setPrivacy(s.hideNames === true);
      repeat = s.repeat || 'off';
      if (s.hold !== hold) setHold(!!s.hold);
      // Opened, reloaded, or back after a lock: pick up what Control last sent.
      if (s.current && (!cur || cur.item.key !== s.current.key)) {
        const at = s.status && s.status.key === s.current.key ? s.status.t : s.current.startAt;
        // Under Hold (a lock, or Hold pressed) it waits paused, and Hold off
        // plays it again if it was playing before.
        load({ item: { ...s.current, startAt: at || 0 }, upcoming: s.upcoming, repeat: s.repeat, paused: s.hold ? !s.resume : s.paused });
      } else if (s.current && cur) {
        upcoming = (s.upcoming || []).slice();
      }
      report({ type: 'ready' });
    });
    on('load', load);
    on('upcoming', setUpcoming);
    on('play', play);
    on('pause', pause);
    on('seek', (c) => seek(c.t));
    on('volume', setVolume);
    on('hold', (c) => setHold(!!c.on));
    on('settings', applySettings);
    on('privacy', (c) => setPrivacy(c.hideNames === true));
    on('locked', lockdown);
    on('front', () => { try { window.focus(); } catch {} });
    on('size', (c) => {
      if (HOST !== 'popup' || !(c.w > 0) || !(c.h > 0)) return;
      try { window.resizeTo(c.w + (window.outerWidth - window.innerWidth), c.h + (window.outerHeight - window.innerHeight)); } catch {}
    });
    on('close', () => {
      sayClosing();
      if (HOST === 'popup') { try { window.close(); } catch {} }
    });
    es.onerror = () => {
      if (!es || es.readyState !== EventSource.CLOSED) return;   // the browser retries by itself
      // Refused (a lock answers 423): ask why before trying again.
      fetch('/api/vault/status').then(r => r.json()).then((s) => {
        if (s && s.locked) lockdown();
        else setTimeout(() => { if (!locked) connect(); }, 2000);
      }).catch(() => setTimeout(() => { if (!locked) connect(); }, 2000));
    };
  }

  /* ── Reports: where Stage is, about 4 times a second ──────────────── */

  function stateNow() {
    if (finished) return 'black';
    if (!cur) return 'black';
    if (cur.v) return cur.v.ended ? 'ended' : cur.v.paused ? 'paused' : 'playing';
    return 'picture';
  }

  /** override: { state, key, t, d, paused } for a moment the layers do not show (a file loading). */
  function sendStatus(now, override) {
    if (locked) return;
    const c = cur;
    let t = 0, d = 0, paused = true;
    if (c && c.v) { t = c.v.currentTime || 0; d = Number.isFinite(c.v.duration) ? c.v.duration : 0; paused = c.v.paused; }
    else if (c) {
      d = c.picMs / 1000;
      t = (c.picMs - (c.picStart ? Math.max(0, c.picLeft - (Date.now() - c.picStart)) : c.picLeft)) / 1000;
      paused = !c.picStart;
    }
    const o = override || {};
    if (o.t !== undefined) t = o.t;
    if (o.d !== undefined) d = o.d;
    if (o.paused !== undefined) paused = o.paused;
    const body = { type: 'status', key: o.key || (c ? c.item.key : null), state: o.state || stateNow(), t: Math.round(t * 10) / 10, d: Math.round(d * 10) / 10, paused, hold };
    const sig = JSON.stringify(body);
    if (!now && sig === lastSent) return;
    lastSent = sig;
    report(body);
  }

  setInterval(() => { sendStatus(false); maybePrepareAhead(); }, STATUS_MS);

  /* ── Resume spot, views, heatmap (the player's rules) ─────────────── */

  function trackWatch(layer) {
    const v = layer.v;
    const w = layer.watch;
    const id = layer.item.id;
    if (w.lastT === null) { w.lastT = v.currentTime; w.lastSaved = v.currentTime; return; }
    const delta = v.currentTime - w.lastT;
    w.lastT = v.currentTime;
    if (delta > 0 && delta < 2) {
      w.acc += delta;
      if (v.duration > 0) {
        const b = Math.max(0, Math.min(99, Math.floor((v.currentTime / v.duration) * 100)));
        w.heat[b] = (w.heat[b] || 0) + delta;
      }
    }
    if (!w.counted && StageRules.viewCounts(w.acc, v.duration)) {
      w.counted = true;
      post(`/api/media/${id}/viewed`, { watch_s: Math.round(w.acc) });
    }
    if (v.duration > 0 && Math.abs(v.currentTime - w.lastSaved) >= SAVE_EVERY_S) {
      w.lastSaved = v.currentTime;
      const pos = StageRules.positionToSave(v.currentTime, v.duration);
      if (pos !== null) post(`/api/media/${id}/flags`, { last_position: pos });
    }
  }

  function saveWatch(layer, { keepalive = false } = {}) {
    const v = layer.v;
    if (!v) return;
    const w = layer.watch;
    const total = Object.values(w.heat).reduce((s, x) => s + x, 0);
    if (total >= 1) {
      const buckets = {};
      for (const [k, x] of Object.entries(w.heat)) buckets[k] = Math.round(x * 10) / 10;
      post(`/api/media/${layer.item.id}/heatmap`, { buckets }, { keepalive });
    }
    w.heat = {};
    const pos = StageRules.positionToSave(v.currentTime, v.duration);
    if (pos !== null) post(`/api/media/${layer.item.id}/flags`, { last_position: pos }, { keepalive });
  }

  /* ── The window: cursor, moving it, pop-up extras ─────────────────── */

  let cursorTimer = null;
  function armCursor() {
    document.body.classList.remove('cursor-hidden');
    document.body.classList.add('stage-hover');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => {
      document.body.classList.add('cursor-hidden');
      document.body.classList.remove('stage-hover');
    }, Math.max(1, settings.cursorSeconds || 1) * 1000);
  }
  document.addEventListener('mousemove', armCursor);
  document.addEventListener('mouseleave', () => document.body.classList.remove('stage-hover'));

  if (webview) {
    // The whole picture moves the window (app-region in css/stage.css does it
    // where WebView2 supports it; a press that still reaches the page asks
    // the host). A double-click maximises or restores.
    document.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.detail === 1) { try { webview.postMessage('drag'); } catch {} }
    });
    document.addEventListener('dblclick', () => { try { webview.postMessage('max'); } catch {} });
  } else {
    fillBtn.hidden = false;
    fillBtn.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else document.documentElement.requestFullscreen().catch(() => {});
    });
    document.addEventListener('fullscreenchange', () => { fillBtn.textContent = document.fullscreenElement ? 'Back to the window' : 'Fill this screen'; });
    let boundsTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        if (document.fullscreenElement) return;
        report({ type: 'bounds', x: Math.round(window.screenX), y: Math.round(window.screenY), w: Math.round(window.outerWidth), h: Math.round(window.outerHeight) });
      }, 600);
    });
  }

  function sayClosing() {
    const c = cur;
    report({ type: 'closing', key: c ? c.item.key : null, t: c && c.v ? c.v.currentTime || 0 : 0, paused: c && c.v ? c.v.paused : true }, { beacon: true });
  }
  window.addEventListener('pagehide', () => {
    sayClosing();
    if (cur) saveWatch(cur, { keepalive: true });
  });

  document.title = settings.windowName;
  armCursor();
  connect();

  // For checks in a test browser: what is on screen, read-only.
  window.__stage = () => ({
    host: HOST, locked, hold, holdWasPlaying, hideNames, finished, repeat, upcoming: upcoming.map(u => u.key), upcomingNames: upcoming.map(u => u.filename),
    current: cur ? { key: cur.item.key, id: cur.item.id, kind: cur.v ? 'video' : 'picture', muted: cur.v ? cur.v.muted : null, t: cur.v ? cur.v.currentTime : null } : null,
    layers: mediaBox.children.length, black: blackEl.classList.contains('on'), name: nameEl.classList.contains('on') ? nameEl.textContent : null,
  });
})();
