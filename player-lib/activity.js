/* =========================================================================
   ACTIVITY: one button at the right end of the top bar for everything that
   runs in the background: the AI scan, face search, Share privately, adding
   files, and moving files to the trash.

   It replaces the floating panel that sat in the bottom right corner over
   the library, and the separate Share privately button. Nothing here opens
   by itself: a job that starts, waits or fails changes the button (a ring
   for progress, a count, a colour) and may pulse it once; the user opens the
   dropdown when they want to look.

   The button:
     ring    progress of the AI scan while it runs, else of the first running
             job that has a number to show (none while nothing runs)
     count   how many jobs run; with none running, how many need you
     colour  red when something failed and needs you, amber when something
             waits (playback, the scan model, the GPU, a paused job, a share
             ready to check), the accent while jobs only run, quiet when idle

   The dropdown: one section per job that runs or has a result worth showing
   (title, short status, a thin bar, one line, one or two buttons). Open
   swaps the list for that job's full view, which is the job's own panel,
   built and kept up to date by its own module (importer.js, faces.js,
   share-ui.js, selection.js), with an "Activity" link back.

   window.vaultActivity:
     set(id, job)   add or update a section. job: { title, icon: [emoji, name],
                    status, pct (0-100 or null), tone ('work' | 'wait' |
                    'need' | 'done'), running, detail (html, already escaped),
                    actions: [{ key, label, primary, run }], view (element for
                    Open), onOpen, dismiss (function: a small close button),
                    privateAttr (attribute put on the status and bar),
                    afterPaint (section element) }
     drop(id)       take a section away
     has(id) / running(id) / viewing() / isOpen()
     host()         where the full views live (inside the dropdown)
     openView(id) / back() / toggle(open) / pulse() / act(id, key)
     setLink(id, { label, run } | null)   a quiet link under the list
   ========================================================================= */

(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // The order sections are listed in, whatever order they start in.
  const ORDER = ['ai', 'faces', 'share', 'import', 'delete'];
  const TONES = ['need', 'wait', 'work'];
  const PULSE_MS = 1600;

  const jobs = new Map();       // id -> job
  const links = new Map();      // id -> { label, run }
  let isOpen = false;
  let viewing = null;
  let pulseTimer = null;
  let built = null;

  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s))
    : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  const ico = (emoji, name) => (typeof vaultIconSwap === 'function' ? vaultIconSwap(emoji, name) : esc(emoji));
  const $ = (id) => document.getElementById(id);

  /* ── The button and the dropdown, made once ─────────────────────────── */

  function ensure() {
    if (built && built.isConnected !== false) return built;
    const wrap = document.createElement('div');
    wrap.id = 'activityWrap';
    wrap.className = 'act-wrap';
    wrap.dataset.state = 'idle';
    wrap.innerHTML = `
      <button type="button" class="header-btn act-btn" id="activityBtn" aria-haspopup="dialog" aria-expanded="false"
              aria-controls="activityPop" aria-label="Activity: nothing running" title="Activity">
        <svg class="act-ring" id="activityRing" viewBox="0 0 44 44" aria-hidden="true" focusable="false" hidden>
          <circle class="act-ring-bg" cx="22" cy="22" r="20" pathLength="100"></circle>
          <circle class="act-ring-fg" id="activityRingFg" cx="22" cy="22" r="20" pathLength="100" stroke-dasharray="0 100"></circle>
        </svg>
        <span class="act-ic">${ico('📊', 'activity')}</span>
        <span class="act-badge" id="activityBadge" hidden></span>
      </button>
      <div class="act-pop" id="activityPop" role="dialog" aria-label="Activity" hidden>
        <div class="act-main" id="activityMain">
          <div class="act-title">Activity</div>
          <div class="act-idle" id="activityIdle">Nothing is running.</div>
          <div class="act-list" id="activityList"></div>
          <div class="act-links" id="activityLinks" hidden></div>
        </div>
        <div class="act-view" id="activityView" hidden>
          <button type="button" class="act-back" id="activityBack">${ico('‹ ', 'chev-left')}Activity</button>
          <div class="act-host" id="activityHost"></div>
        </div>
      </div>`;
    const btns = document.querySelector && document.querySelector('.header-buttons');
    if (btns) {
      const refresh = $('refreshBtn');
      btns.insertBefore(wrap, refresh && refresh.parentNode === btns ? refresh : null);
    } else if (document.body) {
      document.body.appendChild(wrap);
    }
    built = wrap;

    $('activityBtn').addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); toggle(); });
    $('activityBack').addEventListener('click', () => back());
    $('activityList').addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      const sec = b.closest('[data-job]');
      if (sec) act(sec.dataset.job, b.dataset.act);
    });
    $('activityLinks').addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-link]') : null;
      const l = b && links.get(b.dataset.link);
      if (l) { toggle(false); l.run(); }
    });
    // A click anywhere else closes it. The path is read when the event
    // happens, so a button the poll has just redrawn still counts as inside.
    document.addEventListener('mousedown', (e) => {
      if (!isOpen) return;
      const inside = typeof eventPathHasNode === 'function' ? eventPathHasNode(e, wrap)
        : (wrap.contains ? wrap.contains(e.target) : false);
      if (!inside) toggle(false);
    });
    document.addEventListener('keydown', (e) => {
      if (!isOpen || e.key !== 'Escape') return;
      // A field's own Escape (an open select) is the browser's; the dropdown
      // closes on the next one.
      if (e.defaultPrevented) return;
      const focusIn = typeof eventPathHasNode === 'function' && eventPathHasNode(e, wrap);
      toggle(false);
      if (focusIn) { $('activityBtn').focus?.(); if (e.stopPropagation) e.stopPropagation(); }
    });
    if (typeof window.addEventListener === 'function') window.addEventListener('resize', () => { if (isOpen) place(); });
    paint();
    return wrap;
  }

  /* ── Open and close ─────────────────────────────────────────────────── */

  function toggle(open) {
    ensure();
    const next = open === undefined ? !isOpen : !!open;
    if (next === isOpen) return;
    isOpen = next;
    $('activityPop').hidden = !next;
    $('activityBtn').setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) {
      // Every open starts on the list.
      showView(null);
      paint();
      place();
      try { window.dispatchEvent(new CustomEvent('vault:activity', { detail: { open: true } })); } catch { /* old browser */ }
    }
  }

  /** Under the button, inside the window: fixed, so a narrow window still fits it. */
  function place() {
    const pop = $('activityPop');
    const btn = $('activityBtn');
    if (!pop || !btn || typeof btn.getBoundingClientRect !== 'function') return;
    const r = btn.getBoundingClientRect();
    // The width without the page's scrollbar, which a fixed box cannot sit under.
    const vw = (document.documentElement && document.documentElement.clientWidth) || window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    if (!vw || !vh) return;
    pop.style.top = `${Math.round(r.bottom + 8)}px`;
    // Under the button's right edge, but never past the left edge of a narrow
    // window: as wide as the CSS asks, min(400px, 100vw - 16px), measured
    // without the scrollbar.
    const w = Math.min(400, vw - 16);
    pop.style.width = `${w}px`;
    pop.style.right = `${Math.max(8, Math.min(Math.round(vw - r.right), vw - w - 8))}px`;
    pop.style.maxHeight = `${Math.max(160, Math.round(vh - r.bottom - 20))}px`;
  }

  /** Swap the list for a job's full view (null: back to the list). */
  function showView(id) {
    const job = id ? jobs.get(id) : null;
    viewing = job && job.view ? id : null;
    $('activityMain').hidden = !!viewing;
    $('activityView').hidden = !viewing;
    for (const [jid, j] of jobs) if (j.view) j.view.hidden = jid !== viewing;
    if (viewing && typeof job.onOpen === 'function') {
      try { job.onOpen(); } catch { /* the view still shows */ }
    }
  }

  function openView(id) {
    if (!jobs.has(id)) return;
    if (!isOpen) toggle(true);
    showView(id);
    $('activityBack').focus?.();
  }

  function back() {
    const was = viewing;
    showView(null);
    paint();
    const open = was && $(`act-${was}-acts`) && $(`act-${was}-acts`).querySelector('[data-act="open"]');
    if (open && open.focus) open.focus(); else $('activityBtn').focus?.();
  }

  /** A short pulse on the button: something started or needs a look. */
  function pulse() {
    const wrap = ensure();
    clearTimeout(pulseTimer);
    wrap.classList.remove('act-pulse');
    void wrap.offsetWidth;   // restart the animation
    wrap.classList.add('act-pulse');
    pulseTimer = setTimeout(() => wrap.classList.remove('act-pulse'), PULSE_MS);
  }

  /* ── Jobs ───────────────────────────────────────────────────────────── */

  function set(id, job) {
    ensure();
    const prev = jobs.get(id);
    jobs.set(id, { ...job });
    if (job.view) job.view.hidden = id !== viewing;
    else if (viewing === id) showView(null);
    if (!prev) placeSection(id);
    paintSection(id);
    paint();
  }

  function drop(id) {
    if (!jobs.has(id)) return;
    const job = jobs.get(id);
    jobs.delete(id);
    if (job.view) job.view.hidden = true;
    const sec = $(`act-sec-${id}`);
    if (sec) sec.remove();
    if (viewing === id) {
      const focusWasIn = isOpen && document.activeElement && job.view && job.view.contains && job.view.contains(document.activeElement);
      showView(null);
      if (focusWasIn) $('activityBtn').focus?.();
    }
    paint();
  }

  function act(id, key) {
    const job = jobs.get(id);
    if (!job) return;
    if (key === 'open') { openView(id); return; }
    if (key === 'dismiss') { if (typeof job.dismiss === 'function') job.dismiss(); return; }
    const a = (job.actions || []).find(x => x.key === key);
    if (a && typeof a.run === 'function') a.run();
  }

  /** The section's element, put in its place in ORDER. */
  function placeSection(id) {
    const list = $('activityList');
    const sec = document.createElement('div');
    sec.id = `act-sec-${id}`;
    sec.className = 'act-sec';
    sec.dataset.job = id;
    sec.innerHTML = `
      <div class="act-head">
        <span class="act-sec-ic" id="act-${id}-ic"></span>
        <span class="act-sec-title" id="act-${id}-title"></span>
        <span class="act-sec-status" id="act-${id}-status"></span>
        <button type="button" class="act-x" id="act-${id}-x" data-act="dismiss" title="Dismiss" aria-label="Dismiss" hidden>${ico('✕', 'close')}</button>
      </div>
      <div class="act-bar" id="act-${id}-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="act-bar-fill" id="act-${id}-fill"></div></div>
      <div class="act-foot">
        <span class="act-detail" id="act-${id}-detail"></span>
        <span class="act-acts" id="act-${id}-acts"></span>
      </div>`;
    const rank = (x) => { const i = ORDER.indexOf(x); return i < 0 ? ORDER.length : i; };
    const after = [...jobs.keys()].filter(j => j !== id && rank(j) > rank(id) && $(`act-sec-${j}`))
      .sort((a, b) => rank(a) - rank(b))[0];
    const before = after ? $(`act-sec-${after}`) : null;
    if (before && typeof list.insertBefore === 'function') list.insertBefore(sec, before);
    else list.appendChild(sec);
  }

  /** Fill one section in place: nothing under the cursor or the focus is rebuilt. */
  function paintSection(id) {
    const job = jobs.get(id);
    const sec = $(`act-sec-${id}`);
    if (!job || !sec) return;
    sec.dataset.tone = job.tone || 'work';
    const ic = $(`act-${id}-ic`);
    const icKey = (job.icon || []).join('|');
    if (ic.dataset.k !== icKey) { ic.dataset.k = icKey; ic.innerHTML = job.icon ? ico(job.icon[0], job.icon[1]) : ''; }
    $(`act-${id}-title`).textContent = job.title || '';
    const status = $(`act-${id}-status`);
    status.textContent = job.status || '';
    const bar = $(`act-${id}-bar`);
    const hasPct = typeof job.pct === 'number' && Number.isFinite(job.pct);
    bar.hidden = !hasPct;
    if (hasPct) {
      const pct = Math.max(0, Math.min(100, job.pct));
      $(`act-${id}-fill`).style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
      bar.setAttribute('aria-label', `${job.title || ''} ${Math.round(pct)} percent`);
    }
    if (job.privateAttr) { status.setAttribute(job.privateAttr, ''); bar.setAttribute(job.privateAttr, ''); }
    const detail = $(`act-${id}-detail`);
    const dHtml = job.detail || '';
    if (detail.dataset.sig !== dHtml) { detail.dataset.sig = dHtml; detail.innerHTML = dHtml; }
    detail.hidden = !dHtml;
    $(`act-${id}-x`).hidden = typeof job.dismiss !== 'function';
    paintActions(id, job);
    if (typeof job.afterPaint === 'function') { try { job.afterPaint(sec); } catch { /* the section still shows */ } }
  }

  /** The buttons: labels change in place; the row is rebuilt only when the set of buttons changes. */
  function paintActions(id, job) {
    const box = $(`act-${id}-acts`);
    const list = (job.actions || []).filter(a => a && !a.hidden).slice();
    if (job.view) list.push({ key: 'open', label: 'Open' });
    const keys = list.map(a => a.key).join();
    if (box.dataset.keys !== keys) {
      box.dataset.keys = keys;
      box.innerHTML = list.map(a => `<button type="button" class="dq-btn act-act" data-act="${esc(a.key)}" id="act-${id}-b-${esc(a.key)}"></button>`).join('');
    }
    for (const a of list) {
      const b = $(`act-${id}-b-${a.key}`);
      if (!b) continue;
      if (b.dataset.label !== a.label) { b.dataset.label = a.label; b.textContent = a.label; }
      b.classList.toggle('dq-btn-primary', !!a.primary);
      b.disabled = !!a.disabled;
      if (a.title) b.title = a.title; else b.removeAttribute('title');
    }
  }

  /* ── The button's look, the idle line and the links ─────────────────── */

  /** What the button shows, from the jobs: { tone, running, needs, waits, pct }. */
  function summary() {
    const all = [...jobs.entries()].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
    const run = all.filter(([, j]) => j.running);
    const needs = all.filter(([, j]) => j.tone === 'need').length;
    const waits = all.filter(([, j]) => j.tone === 'wait').length;
    const tone = needs ? 'need' : waits ? 'wait' : run.length ? 'work' : 'idle';
    // The ring: the AI scan while it runs, else the first running job with a number.
    const ai = jobs.get('ai');
    const src = ai && ai.running && typeof ai.pct === 'number' ? ai
      : (run.map(([, j]) => j).find(j => typeof j.pct === 'number') || null);
    // Moving: running and not held. A held job (a scan waiting for playback,
    // anything paused) is still running for the polls and the badge, but the
    // words say waiting; a share packing beside ones ready to check is moving.
    const moving = run.filter(([, j]) => !j.held).length;
    return { tone, running: run.length, moving, needs, waits, pct: src && run.length ? (src.ringPct != null ? src.ringPct : src.pct) : null };
  }

  function paint() {
    if (!built) return;
    const s = summary();
    built.dataset.state = s.tone;
    const btn = $('activityBtn');
    // The ring
    const ring = $('activityRing');
    ring.hidden = s.pct == null;
    if (s.pct != null) {
      const p = Math.max(0, Math.min(100, s.pct));
      $('activityRingFg').setAttribute('stroke-dasharray', `${p.toFixed(1)} 100`);
    }
    // The count: running jobs; with none running, the ones that need you.
    const badge = $('activityBadge');
    const n = s.running || s.needs;
    badge.hidden = !n;
    badge.textContent = n ? String(n) : '';
    badge.dataset.tone = s.tone;
    // Words for a screen reader and the tooltip.
    const bits = [];
    if (s.moving) bits.push(`${s.moving} running`);
    if (s.waits) bits.push(`${s.waits} waiting`);
    if (s.needs) bits.push(`${s.needs} ${s.needs === 1 ? 'needs' : 'need'} you`);
    const label = `Activity: ${bits.length ? bits.join(', ') : 'nothing running'}`;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    // The list
    // "Nothing is running." only over quiet results, not over something held.
    $('activityIdle').hidden = s.running > 0 || s.waits > 0 || s.needs > 0;
    const lk = $('activityLinks');
    const linkHtml = [...links.entries()].map(([id, l]) => `<button type="button" class="act-link" data-link="${esc(id)}">${esc(l.label)}</button>`).join('');
    if (lk.dataset.sig !== linkHtml) { lk.dataset.sig = linkHtml; lk.innerHTML = linkHtml; }
    lk.hidden = !linkHtml;
  }

  function setLink(id, link) {
    ensure();
    if (link) links.set(id, link); else links.delete(id);
    paint();
  }

  window.vaultActivity = {
    set,
    drop,
    has: (id) => jobs.has(id),
    get: (id) => jobs.get(id) || null,
    running: (id) => !!(jobs.get(id) && jobs.get(id).running),
    viewing: () => viewing,
    isOpen: () => isOpen,
    host: () => { ensure(); return $('activityHost'); },
    openView,
    back,
    toggle,
    pulse,
    act,
    setLink,
    summary,
    ensure,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensure);
  else ensure();
})();
