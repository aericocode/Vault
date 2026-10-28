/* =========================================================================
   SET LOG - what Stage played, for the streamer: when chat asks "what video
   was that?" an hour later, the answer is here. The server records it
   (lib/stage/setlog.js); this is the popover that shows it.

   Opened by Log on the Stage bar (above the bar, by its button) or by Set
   log in Settings › Stage (in the middle of the window, Stage open or not).
   Newest first: the clock time, the time into the set, the name, and how
   long it played ("Playing now", or "skipped after 0:28", dimmed, for a file
   played under 30 seconds). A click on a row previews the file, the way a
   click on a tile does while Stage is open. Earlier sets picks one of the
   last 20. Copy as chapters and Copy list put the set on the clipboard,
   skipped files left out. Updates while open.

   Nothing here is ever shown on Stage. SetLogRules (pure) is what
   test/stage-setlog.test.js runs.
   ========================================================================= */

const SetLogRules = (() => {
  const pad = (n) => String(n).padStart(2, '0');
  const whole = (s) => Math.max(0, Math.floor(Number(s) || 0));

  /** h:mm:ss, always with the hour ("0:12:03"): the time into the set. */
  function hms(s) {
    const t = whole(s);
    return `${Math.floor(t / 3600)}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`;
  }

  /** m:ss, or h:mm:ss from an hour ("3:58", "1:02:10"): how long a file played. */
  function dur(s) {
    const t = whole(s);
    if (t >= 3600) return hms(t);
    return `${Math.floor(t / 60)}:${pad(t % 60)}`;
  }

  /** A chapter's time: mm:ss ("00:00", "12:03"), h:mm:ss once past an hour. */
  function chapterTime(s) {
    const t = whole(s);
    if (t >= 3600) return hms(t);
    return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  }

  /** The clock time ("8:14 PM"). */
  function clock(ms) {
    const d = new Date(ms);
    const h = d.getHours();
    return `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
  }

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

  /**
   * Which day a set is: "Tonight" (today, from 5 PM, or a set still going
   * that started yesterday evening), "Today", else a plain date ("Tue Oct 27",
   * with the year when it is not this year's).
   */
  function day(startMs, nowMs, open = false) {
    const d = new Date(startMs);
    const n = new Date(nowMs);
    if (dayKey(d) === dayKey(n)) return d.getHours() >= 17 || d.getHours() < 5 ? 'Tonight' : 'Today';
    const y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
    if (open && dayKey(d) === dayKey(y)) return 'Tonight';
    const base = `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
    return d.getFullYear() === n.getFullYear() ? base : `${base} ${d.getFullYear()}`;
  }

  /** "2h 41m", "45m", "under a minute". */
  function length(s) {
    const t = whole(s);
    const h = Math.floor(t / 3600);
    const m = Math.floor(t / 60) % 60;
    if (!h && !m) return 'under a minute';
    return h ? `${h}h ${pad(m)}m` : `${m}m`;
  }

  /** "Tonight · started 8:02 PM · 14 played". */
  function header(set, nowMs) {
    if (!set) return 'Nothing played on Stage yet';
    return `${day(set.startedAt, nowMs, set.open)} · started ${clock(set.startedAt)} · ${set.played} played`;
  }

  /** One set in the Earlier sets picker: "Tue Oct 27 · 2h 41m". */
  function setLabel(set, nowMs) {
    const d = day(set.startedAt, nowMs, set.open);
    return `${d}${d === 'Tonight' || d === 'Today' ? ` ${clock(set.startedAt)}` : ''} · ${set.open ? 'now playing' : length(set.duration)}`;
  }

  /** The right side of a row. */
  function right(e) {
    if (e.now) return 'Playing now';
    if (e.skipped) return `skipped after ${dur(e.played)}`;
    return dur(e.played);
  }

  const name = (e) => (e && e.title) || 'Untitled file';

  /** Entries whose name has every word of q in it (any case). */
  function filter(entries, q) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return entries;
    return entries.filter((e) => { const n = name(e).toLowerCase(); return words.every(w => n.includes(w)); });
  }

  /** Oldest first, skipped files left out: what the copies list. */
  const kept = (entries) => entries.filter(e => !e.skipped).slice().sort((a, b) => a.offset - b.offset || a.startedAt - b.startedAt);

  /** "00:00 Opening Glow\n12:03 Night Drive" (the first line always 00:00, for VOD chapters). */
  function chapters(entries) {
    return kept(entries).map((e, i) => `${i === 0 ? '00:00' : chapterTime(e.offset)} ${name(e)}`).join('\n');
  }

  /** "8:02 PM  Opening Glow\n8:14 PM  Night Drive" (clock times, for a Discord post). */
  function list(entries) {
    return kept(entries).map(e => `${clock(e.startedAt)}  ${name(e)}`).join('\n');
  }

  return { hms, dur, chapterTime, clock, day, length, header, setLabel, right, name, filter, chapters, list };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SetLogRules;

const SetLog = (typeof document === 'undefined') ? null : (() => {
  const R = SetLogRules;
  const POLL_MS = 2000;
  let el = null;
  let open = false;
  let fromBar = false;
  let sets = [];
  let setId = null;           // the set shown; null: the newest
  let data = null;            // { set, entries }
  let timer = null;
  let query = '';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function get(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function build() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'setLogPop';
    el.className = 'slog-pop';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Set log');
    el.hidden = true;
    el.innerHTML = `
      <div class="slog-head">
        <b class="slog-title">Set log</b>
        <span class="slog-pill" data-sl="head"></span>
        <span class="slog-sp"></span>
        <button type="button" class="slog-x" data-sl-act="close" title="Close" aria-label="Close the set log">✕</button>
      </div>
      <div class="slog-tools">
        <input class="slog-search" type="search" placeholder="Search this set" aria-label="Search this set" spellcheck="false" autocomplete="off">
        <button type="button" class="slog-btn" data-sl-act="chapters" title="Times from the start of the set, for VOD chapters">Copy as chapters</button>
        <button type="button" class="slog-btn" data-sl-act="list" title="Clock times, for a post in Discord">Copy list</button>
      </div>
      <div class="slog-list" data-sl="list" role="list"></div>
      <div class="slog-foot">
        <label class="slog-earlier"><span>Earlier sets</span>
          <select class="slog-sel" data-sl="sets" aria-label="Earlier sets"></select></label>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', onClick);
    el.querySelector('.slog-search').addEventListener('input', (e) => { query = e.target.value; paintList(); });
    el.querySelector('[data-sl="sets"]').addEventListener('change', (e) => {
      const v = Number(e.target.value);
      setId = sets.length && v === sets[0].id ? null : v;
      data = null;
      refresh();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      const row = e.key === 'Enter' && e.target.closest && e.target.closest('[data-sl-media]');
      if (row) { e.preventDefault(); preview(Number(row.dataset.slMedia)); }
    });
    return el;
  }

  function onClick(e) {
    const b = e.target.closest('[data-sl-act]');
    if (b) {
      const act = b.dataset.slAct;
      if (act === 'close') close();
      else if (act === 'chapters') copy(R.chapters(data ? data.entries : []));
      else if (act === 'list') copy(R.list(data ? data.entries : []));
      return;
    }
    const row = e.target.closest('[data-sl-media]');
    if (row) preview(Number(row.dataset.slMedia));
  }

  /** The same as a single click on its tile while Stage is open: the preview pane. */
  function preview(id) {
    if (!id) return;
    if (typeof StagePreview !== 'undefined' && StagePreview.stageOn && StagePreview.stageOn()) { StagePreview.click(id); return; }
    if (typeof dockIsShown === 'function' && dockIsShown() && typeof dockSelect === 'function') { dockSelect(id); return; }
    if (typeof showDetailsById === 'function') showDetailsById(id);
  }

  async function copy(text) {
    if (!text) { toast('Nothing to copy: no file in this set played for 30 seconds.'); return; }
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; }
    } catch {}
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
    }
    toast(ok ? 'Copied' : 'Could not copy. The clipboard is not available here.', ok ? null : 'error');
  }

  function toast(text, type) { if (typeof showToast === 'function') showToast(text, type ? { type } : undefined); }

  function paintHead() {
    const now = Date.now();
    const set = data && data.set ? { ...data.set, played: data.set.played } : null;
    el.querySelector('[data-sl="head"]').textContent = set ? R.header(set, now) : (sets.length ? '' : R.header(null, now));
    const sel = el.querySelector('[data-sl="sets"]');
    const want = sets.map(s => `${s.id}|${R.setLabel(s, now)}`).join('\n');
    if (sel._want !== want) {
      sel._want = want;
      sel.innerHTML = sets.map(s => `<option value="${s.id}">${esc(R.setLabel(s, now))}</option>`).join('');
    }
    const shown = data && data.set ? data.set.id : (sets[0] && sets[0].id);
    if (shown != null) sel.value = String(shown);
    el.querySelector('.slog-foot').hidden = sets.length < 2;
    const none = !data || !data.entries.some(e => !e.skipped);
    el.querySelectorAll('[data-sl-act="chapters"], [data-sl-act="list"]').forEach((b) => { b.disabled = none; });
  }

  function paintList() {
    if (!el) return;
    const box = el.querySelector('[data-sl="list"]');
    if (!data) { box.innerHTML = `<div class="slog-empty">${sets.length ? 'Loading…' : 'Nothing played on Stage yet. Files Stage plays show here, with the time they played.'}</div>`; return; }
    const rows = R.filter(data.entries, query);
    if (!rows.length) { box.innerHTML = `<div class="slog-empty">${data.entries.length ? 'No file in this set has that name.' : 'Nothing played in this set.'}</div>`; return; }
    box.innerHTML = rows.map((e) => {
      const can = e.inLibrary !== false;
      const cls = `slog-row${e.skipped ? ' slog-skip' : ''}${e.now ? ' slog-now' : ''}${can ? '' : ' slog-gone'}`;
      const attrs = can ? ` data-sl-media="${e.mediaId}" tabindex="0" title="Preview ${esc(R.name(e))}"` : ' title="No longer in the library"';
      return `<div class="${cls}" role="listitem"${attrs}><span class="slog-t">${esc(R.clock(e.startedAt))}</span><span class="slog-o">${esc(R.hms(e.offset))}</span><span class="slog-nm">${esc(R.name(e))}</span><span class="slog-r">${esc(R.right(e))}</span></div>`;
    }).join('');
  }

  async function refresh() {
    if (!open) return;
    try {
      const out = await get('/api/stage/setlog');
      sets = Array.isArray(out.sets) ? out.sets : [];
      if (setId != null && !sets.some(s => s.id === setId)) setId = null;
      const id = setId != null ? setId : (sets[0] && sets[0].id);
      data = id != null ? await get(`/api/stage/setlog/${id}`) : null;
    } catch {
      if (!data) { el.querySelector('[data-sl="list"]').innerHTML = '<div class="slog-empty">Could not load the set log.</div>'; return; }
    }
    if (!open) return;
    paintHead();
    paintList();
    position();
  }

  function position() {
    if (!open || !el) return;
    const de = document.documentElement;
    const vw = de.clientWidth || window.innerWidth;
    const vh = de.clientHeight || window.innerHeight;
    const gap = 8;
    const w = Math.min(560, vw - 2 * gap);
    el.style.width = `${w}px`;
    const r = fromBar && typeof StageBar !== 'undefined' && StageBar.anchorRect ? StageBar.anchorRect('log') : null;
    if (r) {
      el.style.left = `${Math.max(gap, Math.min(vw - w - gap, r.right - w))}px`;
      el.style.top = 'auto';
      el.style.bottom = `${Math.max(gap, vh - r.top + gap)}px`;
      el.style.maxHeight = `${Math.max(200, r.top - 2 * gap)}px`;
    } else {
      el.style.left = `${Math.max(gap, (vw - w) / 2)}px`;
      el.style.bottom = 'auto';
      el.style.top = `${Math.max(gap, Math.round(vh * 0.12))}px`;
      el.style.maxHeight = `${Math.max(200, vh - Math.round(vh * 0.12) - 2 * gap)}px`;
    }
  }

  function onOutside(e) {
    if (!el || el.contains(e.target)) return;
    const btn = document.getElementById('stageBarLog');
    if (btn && btn.contains(e.target)) return;
    if (e.target.closest && e.target.closest('#toast, #undoToast, #dock, .dock')) return;
    close();
  }

  /** Open it: by the Stage bar's Log button (bar: true) or in the middle of the window. */
  function show({ bar = false } = {}) {
    build();
    fromBar = !!bar && typeof StageBar !== 'undefined' && StageBar.shown && StageBar.shown();
    open = true;
    el.hidden = false;
    setId = null;
    data = null;
    query = '';
    el.querySelector('.slog-search').value = '';
    paintList();
    position();
    setBtn(true);
    refresh();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  }

  function close() {
    if (!open) return;
    open = false;
    clearInterval(timer);
    timer = null;
    if (el) el.hidden = true;
    setBtn(false);
    document.removeEventListener('pointerdown', onOutside, true);
  }

  function setBtn(on) {
    const b = document.getElementById('stageBarLog');
    if (b) b.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  function toggle(o) { if (open) close(); else show(o); }

  window.addEventListener('resize', position);
  // The bar went: the popover stays, in the middle of the window.
  window.addEventListener('vault:stage-bar', (e) => {
    if (!open) return;
    if (!(e.detail && e.detail.on)) fromBar = false;
    position();
  });

  return { show, close, toggle, isOpen: () => open, position };
})();

if (typeof window !== 'undefined') { window.SetLogRules = SetLogRules; window.SetLog = SetLog; }
