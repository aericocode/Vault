/* Tells the server what this page's player is doing, for AI scan's Auto mode
   (Settings > General > AI scan; server: lib/playback-activity.js). Only sent
   while the mode is Auto: On and Off never hear of it.

   States: playing, paused (a file is open and paused; the server stops
   counting it after a minute and a half), idle. Sent at once on every change
   and every BEAT_MS while not idle, so a tab that closes or sleeps stops
   counting on its own. Background header: a beat is never the user being
   present, so it cannot keep the autolock away.

   What counts: the player's own <video id="mediaVideo"> / <audio
   id="mediaAudio"> (also in the mini player and picture-in-picture: the same
   element), and any other media element that is audible. Muted previews (the
   Wall's tiles, a mix's layers, the editor, face review) and hover previews
   (pictures) never count. Stage reports from the server side. */
(function () {
  'use strict';
  const BEAT_MS = 15000;
  const tab = 't' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
  let last = 'idle';
  let beat = null;
  let pending = null;

  function counts(el) {
    if (el.id === 'mediaVideo' || el.id === 'mediaAudio') return true;
    return !el.muted && el.volume > 0;
  }

  function stateNow() {
    let paused = false;
    for (const el of document.querySelectorAll('video, audio')) {
      if (!counts(el) || !el.currentSrc || el.ended) continue;
      if (!el.paused) return 'playing';
      if (el.currentTime > 0) paused = true;
    }
    return paused ? 'paused' : 'idle';
  }

  function send(state, { keepalive = false } = {}) {
    fetch('/api/playback/beat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vault-Background': '1' },
      body: JSON.stringify({ tab, state }),
      keepalive,
    }).catch(() => {});
  }

  function auto() {
    return !!(window.vaultAiScan && window.vaultAiScan.isAuto());
  }

  function check() {
    pending = null;
    const s = auto() ? stateNow() : 'idle';
    if (s !== last) {
      last = s;
      send(s);
    }
    if (s !== 'idle' && !beat) {
      beat = setInterval(() => {
        const now = auto() ? stateNow() : 'idle';
        if (now !== last) { last = now; }
        send(now);
        if (now === 'idle') { clearInterval(beat); beat = null; }
      }, BEAT_MS);
    } else if (s === 'idle' && beat) {
      clearInterval(beat); beat = null;
    }
  }

  function soon() {
    if (!pending) pending = setTimeout(check, 250);
  }

  const STOP_EVENTS = ['pause', 'ended', 'emptied'];
  const watched = new WeakSet();
  function onMedia(e) {
    soon();
    // A player that closes takes its element out of the page first; the pause
    // that follows never reaches document, so listen on the element itself.
    const el = e.target;
    if (e.type === 'play' && el && !watched.has(el)) {
      watched.add(el);
      for (const ev of STOP_EVENTS) el.addEventListener(ev, soon);
    }
  }
  for (const ev of ['play', 'playing', ...STOP_EVENTS, 'volumechange']) {
    document.addEventListener(ev, onMedia, true);   // media events do not bubble: capture
  }
  window.addEventListener('vault:ai-scan', soon);
  window.addEventListener('pagehide', () => { if (last !== 'idle') send('idle', { keepalive: true }); });
})();
