/* =========================================================================
   STAGE BAR - the remote while Stage is open: a slim bar docked along the
   bottom of the Vault window, full width, in both looks. The mini player is
   hidden while it shows (it still runs underneath: its element is Basic
   Stage's picture-in-picture video, and for the full Stage its clock is
   Stage's, player-lib/stage-control.js StageMediaProxy), and comes back
   where it was when Stage closes.

   Three parts, left to right:
     - what is on Stage: a small still (a click brings Stage to the front),
       the name, the status pill (On Stage / Holding / Finished / Locked),
       the status line (skipped, getting ready, end of the list ...) and the
       Flow text spot (setFlowText, filled by the Flow order work)
     - Previous file, back 10 s, Play / Pause, forward 10 s, Next file, and
       the seek bar with its times under them
     - Up next (its list opens above the bar, player-lib/up-next.js), Repeat,
       Hold, the volume, the Stage menu and Close Stage

   The page keeps the bar's height free: body.stage-bar-on and --stagebar-h
   on <html> (css/stage-remote.css) move the page, the dock, the rail, the
   Wall and the selection bar up; the toasts step over it (utils.js).

   stage-control.js owns what the bar says: it builds a state, view() below
   turns it into what to draw, paint() draws it. The pure parts
   (StageBarRules) are what test/stage-bar.test.js runs.
   ========================================================================= */

const StageBarRules = (() => {
  /* The transport sits in the middle of the WINDOW: the two side columns
     are always the same width, so they must each hold the right-hand
     cluster. The seek bar gets a width of its own that only ever grows as
     the window widens (seekWant: about 160 px at 900, 200 at 1100, 450 at
     1600, up to 560), and the middle is just wide enough for it and the
     transport. When the window is too narrow for that, the least needed
     pieces go first, one row always: the 10 s buttons, then the Up next word
     (icon and count stay), then the volume slider (the button stays), then
     the seek bar's times, then Repeat, then Hold (those two move into the
     Stage menu). Only with all of them gone does the seek bar get narrower
     than it wants (never under SEEK_MIN), and only when even the transport
     does not fit does the bar give up centring (the middle then sits beside
     the left part, nothing overflows).

     Sizes in px, measured from the bar by stage-bar.js (NOMINAL until then):
       right      the right cluster with everything in it
       unLabel, volSlider, repeat, hold   what each one adds to it
       ctrls      the transport row with everything in it; skip: what the
                  two 10 s buttons add
       times      what the two seek times (and their gaps) add to the seek row
       pad, gap   the bar's side padding (both sides) and column gap */
  const SEEK_MIN = 60;
  const SEEK_MAX = 560;
  const THUMB_MIN = 560;              // below this the still goes (the left side is the name's)
  const NOMINAL = { right: 380, unLabel: 58, volSlider: 76, repeat: 38, hold: 38, ctrls: 190, skip: 76, times: 84, pad: 28, gap: 14 };
  const DROP_ORDER = ['skip', 'unLabel', 'volSlider', 'times', 'repeat', 'hold'];

  /** The seek bar's width at a bar this wide, before anything has to give: never smaller for a wider bar. */
  function seekWant(width) {
    const w = Number(width) || 0;
    const v = w <= 1100 ? 0.2 * w - 20 : 200 + 0.5 * (w - 1100);
    return Math.round(Math.max(SEEK_MIN, Math.min(SEEK_MAX, v)));
  }

  /**
   * What shows at a bar this wide, how wide the middle and the seek bar are.
   * want (default: width): the width the seek bar's wish is read from: the
   * window's, so a page scrollbar coming and going (the bar is 15 px
   * narrower with it) does not nudge the seek bar.
   * { show: { skip, unLabel, volSlider, thumb, times, repeat, hold },
   *   mid: px, or null when the bar cannot be centred, seek: px, side: px }.
   */
  function layout(width, sizes, want) {
    const w = Number(width) || 0;
    const m = { ...NOMINAL, ...(sizes || {}) };
    const show = { skip: true, unLabel: true, volSlider: true, thumb: true, times: true, repeat: true, hold: true };
    if (!(w > 0)) return { show, mid: null, seek: null, side: null };
    show.thumb = w >= THUMB_MIN;
    let right = m.right, ctrls = m.ctrls, times = m.times;
    let seek = seekWant(Number(want) > 0 ? Number(want) : w);
    const space = () => w - m.pad - 2 * m.gap - 2 * right;
    const need = () => Math.max(ctrls, seek + times);
    for (const k of DROP_ORDER) {
      if (space() >= need()) break;
      show[k] = false;
      if (k === 'skip') ctrls -= m.skip;
      else if (k === 'times') times = 0;
      else right -= m[k];
    }
    if (space() < need()) {
      // Everything optional is gone: the seek bar gives way, down to its minimum.
      if (space() >= Math.max(ctrls, SEEK_MIN)) seek = Math.min(seek, Math.floor(space()));
      else return { show, mid: null, seek: SEEK_MIN, side: null };
    }
    const mid = Math.max(ctrls, seek + times);
    return { show, mid, seek, side: (w - m.pad - 2 * m.gap - mid) / 2 };
  }

  /**
   * Hovering the seek bar: the time under the pointer and which of the
   * file's hover frames (the five the player's own seek bar uses, server
   * /scrub/:id/:idx) is nearest. x and the bar's left / width in px.
   */
  function previewAt(x, left, width, duration, frameIndex) {
    const d = Number(duration) > 0 ? Number(duration) : 0;
    const wd = Number(width) > 0 ? Number(width) : 0;
    const frac = wd ? Math.max(0, Math.min(1, (Number(x) - Number(left)) / wd)) : 0;
    const t = frac * d;
    const idx = typeof frameIndex === 'function' ? frameIndex(t, d)
      : (d > 0 ? Math.max(0, Math.min(4, Math.round((t / d) * 6) - 1)) : 0);
    return { frac, t, x: frac * wd, idx };
  }

  /**
   * The bar's still: the same picture, at the same URL, as the file's tile in
   * the grid (thumbs.js thumbUrl: the library's own row, which carries the
   * thumbnail's version), a vault-mode copy kept in memory first; '' when
   * the file has no picture (thumbnails off, the server said none).
   *   row      the file on Stage (maybe a bare { id, media_type })
   *   o.libRow the library's row for it, if loaded
   *   o.canShow, o.url, o.blob   thumbs.js canShowThumb, thumbUrl, and the
   *            vault-mode object URL (getThumbBlob) or null
   */
  function thumbSrc(row, o = {}) {
    if (!row || !row.id) return '';
    const r = o.libRow && o.libRow.id === row.id ? { ...row, ...o.libRow } : row;
    if (typeof o.canShow === 'function' && !o.canShow(r)) return '';
    if (o.blob) return o.blob;
    return typeof o.url === 'function' ? (o.url(r) || '') : `/thumb/${r.id}`;
  }

  /** The height the page keeps free under it (0 while it is not shown). */
  function reserve(shown, height) {
    if (!shown) return 0;
    const h = Math.ceil(Number(height) || 0);
    return h > 0 ? h : 0;
  }

  function clock(s) {
    const v = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(v / 3600);
    const m = Math.floor((v % 3600) / 60);
    const sec = String(v % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function pill({ locked, hold, finished }) {
    if (locked) return { word: 'Locked', live: false };
    if (hold) return { word: 'Holding', live: false };
    if (finished) return { word: 'Finished', live: false };
    return { word: 'On Stage', live: true };
  }

  const REPEAT = {
    off: { title: 'Repeat: off. Click to repeat the list', label: 'Repeat: off' },
    all: { title: 'Repeat all. Click to repeat this file', label: 'Repeat all' },
    one: { title: 'Repeat this file. Click to turn repeat off', label: 'Repeat this file' },
  };

  /**
   * What the bar shows, from what Stage is doing.
   *   s.basic        Basic Stage (picture-in-picture) rather than mpv
   *   s.hasFile      a file is on Stage
   *   s.filename     its name; s.namesHidden: privacy mode hides names
   *   s.mediaType    video / audio / image / gif
   *   s.t, s.d       where it is and how long it is (seconds)
   *   s.paused, s.hold, s.finished, s.locked, s.loading
   *   s.note         a message to show for now (skipped, end of the list ...)
   *   s.pictureLive  Stage reports this picture (its countdown runs)
   *   s.volume, s.volumeMax, s.muted   Stage's sound (Basic: the page's)
   *   s.repeat       off / all / one
   *   s.upNext       files in Up next
   *   s.fmt          optional time formatter (formatDuration), else m:ss
   */
  function view(s) {
    const fmt = typeof s.fmt === 'function' ? (x) => s.fmt(x) || '0:00' : clock;
    const picture = s.mediaType === 'image' || s.mediaType === 'gif';
    const name = s.hasFile ? (s.namesHidden || !s.filename ? 'this file' : String(s.filename)) : 'Stage is open';
    const d = Number(s.d) > 0 ? Number(s.d) : 0;
    const t = Math.max(0, Math.min(d || Infinity, Number(s.t) || 0));

    let note = '';
    if (s.locked) note = 'Stage went black. Unlock to carry on.';
    else if (s.hold) {
      note = s.basic ? 'Holding: paused and muted. Press Hold again to come back.'
        : `Holding. ${s.hasFile && !picture ? `Paused at ${fmt(t)}. ` : ''}Press Hold again to come back.`;
    } else if (s.note) note = String(s.note);
    else if (s.hasFile && s.loading) note = 'Getting ready…';
    else if (!s.hasFile) note = s.basic ? 'Play a video to show it there.' : 'Play a file to show it there.';

    let now = '', end = '';
    if (s.hasFile && picture) {
      if (s.pictureLive && !s.hold && !s.finished) {
        const left = Math.max(0, Math.ceil(d - t));
        end = s.paused ? `paused · ${left} s left` : `next in ${left} s`;
      }
    } else if (s.hasFile) {
      now = fmt(t);
      end = fmt(d);
    }
    const seekable = !!s.hasFile && !picture && d > 0 && !s.locked;

    const max = Number(s.volumeMax) > 0 ? Number(s.volumeMax) : 1;
    const vol = Math.max(0, Math.min(max, Number(s.volume) || 0));
    const silent = !!s.muted || vol === 0;
    const where = s.basic ? '' : ' Stage';

    const paused = !s.hasFile || !!s.paused || !!s.hold || !!s.finished;
    const n = Math.max(0, Number(s.upNext) || 0);
    const mode = REPEAT[s.repeat] ? s.repeat : 'off';
    return {
      hasFile: !!s.hasFile,
      id: s.hasFile && s.id ? s.id : null,
      mediaType: s.hasFile ? (s.mediaType || null) : null,
      title: name,
      pill: pill(s),
      note,
      play: { paused, label: paused ? 'Play' : 'Pause' },
      seek: { enabled: seekable, fraction: seekable ? t / d : 0, now, end, t, d },
      hold: {
        on: !!s.hold,
        title: s.basic
          ? (s.hold ? 'Holding: paused and muted. Press to come back (H)' : 'Hold: pause and mute. Basic Stage can’t go black (H)')
          : (s.hold ? 'Holding: Stage is black and silent. Press to come back (H)' : 'Hold: Stage goes black and silent (H)'),
      },
      repeat: { mode, title: REPEAT[mode].title, label: REPEAT[mode].label },
      volume: {
        silent, value: silent ? 0 : vol, max,
        title: silent ? `Unmute${where}` : (s.basic ? 'Mute' : 'Mute Stage'),
      },
      upNext: { count: n, label: n ? `Up next, ${n === 1 ? '1 file' : `${n} files`}` : 'Up next' },
      front: s.basic ? 'Show the picture-in-picture window' : 'Bring Stage to the front',
    };
  }

  return { SEEK_MIN, SEEK_MAX, NOMINAL, DROP_ORDER, seekWant, layout, previewAt, thumbSrc, reserve, view, clock };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = StageBarRules;

const StageBar = (typeof document === 'undefined') ? null : (() => {
  const $ = (id) => document.getElementById(id);
  let on = false;
  let flowText = '';
  let watch = null;
  let seekBound = false;
  let last = null;                    // the last view drawn
  let lastPlan = null;                // the last layout, with the sizes it was measured from
  let fitNow = StageBarRules.layout(0).show;  // what shows at the bar's width now

  const media = () => (typeof miniMediaEl === 'function' ? miniMediaEl() : null);

  /** Show the bar (the mini player goes, the page makes room). */
  function show() {
    const bar = $('stageBar');
    if (!bar) return;
    if (!on) {
      on = true;
      bar.hidden = false;
      document.body.classList.add('stage-bar-on');
      // The mini player is hidden now: a control of it that had focus (its
      // Stage button, say) must not keep it, or Space would press it unseen.
      const mini = $('miniPlayer');
      const a = document.activeElement;
      if (mini && a && (a === mini || (mini.contains && mini.contains(a)))) {
        try { if (a.blur) a.blur(); bar.focus({ preventScroll: true }); } catch {}
      }
      bindOnce(bar);
      if (!watch && typeof ResizeObserver === 'function') {
        watch = new ResizeObserver(() => { if (on) relayout(); });
        watch.observe(bar);
      }
    }
    relayout();
  }

  /** Hide it: the mini player (if it plays) is back where it was. */
  function hide() {
    const bar = $('stageBar');
    if (!on) return;
    on = false;
    if (bar) bar.hidden = true;
    document.body.classList.remove('stage-bar-on');
    document.documentElement.style.removeProperty('--stagebar-h');
    if (typeof miniLayout === 'function') miniLayout();
    if (typeof vaultPlaceToasts === 'function') vaultPlaceToasts();
  }

  const NO_CLASSES = { skip: 'sb-no-skip', unLabel: 'sb-no-label', volSlider: 'sb-no-volslider', thumb: 'sb-no-thumb', times: 'sb-no-times', repeat: 'sb-no-repeat', hold: 'sb-no-hold' };

  /** The pieces' widths, with everything showing (StageBarRules.layout sizes). */
  function measure(bar) {
    const width = (el) => (el && el.getBoundingClientRect ? el.getBoundingClientRect().width : 0);
    const row = (el, gap) => {
      if (!el || !el.children) return 0;
      const kids = [...el.children].filter((k) => width(k) > 0);
      return kids.reduce((n, k) => n + width(k), 0) + gap * Math.max(0, kids.length - 1);
    };
    const right = bar.querySelector && bar.querySelector('.sb-right');
    const ctrls = bar.querySelector && bar.querySelector('.sb-ctrls');
    const r = row(right, 6);
    if (!(r > 0)) return null;        // not laid out (no page): the nominal sizes
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(bar) : null;
    const px = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
    const label = bar.querySelector('.sb-un-label');
    return {
      right: r,
      unLabel: width(label) + 6 + 4,  // the word, its gap, and the button's narrower padding without it
      volSlider: width($('stageBarVol')) + 6,
      repeat: width($('stageBarRepeat')) + 6,
      hold: width($('stageBarHold')) + 6,
      ctrls: row(ctrls, 6),
      skip: width($('stageBarBack')) + width($('stageBarFwd')) + 12,
      // Both times as wide as the length (it does not change while the file plays; the
      // time playing does, and must not move the layout every second).
      times: 2 * Math.max(width($('stageBarNow')), width($('stageBarEnd'))) + 16,
      pad: cs ? px(cs.paddingLeft, 14) + px(cs.paddingRight, 14) : 28,
      gap: cs ? px(cs.columnGap, 14) : 14,
    };
  }

  /**
   * The bar's width decides what fits and how wide the middle is (the
   * transport stays in the middle of the window); its height is kept free.
   */
  function relayout() {
    const bar = $('stageBar');
    if (!bar) return;
    // Everything back in to measure it, then out what does not fit (one
    // synchronous pass: nothing is drawn in between).
    for (const c of Object.values(NO_CLASSES)) bar.classList.remove(c);
    bar.classList.remove('sb-uncentered', 'sb-sized');
    const sizes = on ? measure(bar) : null;
    const plan = StageBarRules.layout(bar.clientWidth || window.innerWidth, sizes, window.innerWidth);
    fitNow = plan.show;
    lastPlan = { ...plan, width: bar.clientWidth, sizes };
    for (const [k, c] of Object.entries(NO_CLASSES)) bar.classList.toggle(c, !plan.show[k]);
    bar.classList.toggle('sb-uncentered', plan.mid == null);
    bar.classList.toggle('sb-sized', plan.seek != null);
    if (bar.style && bar.style.setProperty) {
      if (plan.mid == null) bar.style.removeProperty('--sb-mid');
      else bar.style.setProperty('--sb-mid', `${plan.mid}px`);
      bar.style.setProperty('--sb-seek', `${plan.seek}px`);
    }
    const h = StageBarRules.reserve(on, bar.offsetHeight);
    document.documentElement.style.setProperty('--stagebar-h', `${h}px`);
    if (typeof UpNext !== 'undefined' && UpNext.positionPopover) UpNext.positionPopover();
    if (typeof vaultPlaceToasts === 'function') vaultPlaceToasts();
  }

  function act(kind, e) {
    const SC = typeof StageControl !== 'undefined' ? StageControl : null;
    switch (kind) {
      case 'front': if (SC) SC.front(); break;
      case 'prev': if (last && last.hasFile && typeof playPreviousMedia === 'function') playPreviousMedia(); break;
      case 'next': if (last && last.hasFile && typeof playNextMedia === 'function') playNextMedia(); break;
      case 'back': if (typeof miniSkip === 'function') miniSkip(-10); break;
      case 'fwd': if (typeof miniSkip === 'function') miniSkip(10); break;
      case 'play': if (typeof miniTogglePlay === 'function') miniTogglePlay(); break;
      case 'upnext': if (typeof UpNext !== 'undefined') UpNext.togglePopover(); break;
      case 'repeat': if (typeof cycleRepeatMode === 'function') cycleRepeatMode(); break;
      case 'hold': if (SC) SC.toggleHold(); break;
      case 'mute':
        if (typeof miniToggleMute === 'function') miniToggleMute();
        if (SC) SC.paintVolume();       // Basic: a gain change fires no volumechange
        break;
      case 'menu': if (SC) SC.menu(e); break;
      case 'close': if (SC) SC.closeStage(); break;
      default: break;
    }
  }

  function bindOnce(bar) {
    if (bar._sbBound) return;
    bar._sbBound = true;
    bar.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-sb-act]');
      if (!b || b.disabled) return;
      act(b.dataset.sbAct, e);
      // A mouse press leaves no focus on the button, so Space, N and P
      // (app.js) go to Stage, not to the last button pressed.
      if (e.detail > 0 && b.dataset.sbAct !== 'menu' && b.dataset.sbAct !== 'upnext') b.blur();
    });
    $('stageBarMenu')?.addEventListener('contextmenu', (e) => act('menu', e));
    const slider = $('stageBarVol');
    if (slider) {
      slider.addEventListener('input', () => {
        if (typeof miniSetVolume === 'function') miniSetVolume(slider.value);
        // Basic between 100 % and 150 % is a gain change: no volumechange to repaint from.
        if (typeof StageControl !== 'undefined') StageControl.paintVolume();
      });
      slider.addEventListener('pointerup', () => slider.blur());
    }
    const seek = $('stageBarSeek');
    if (seek && !seekBound && typeof attachSeekScrubbing === 'function') {
      seekBound = true;
      attachSeekScrubbing(seek, $('stageBarTrack'), () => (last && last.seek.enabled ? media() : null), { hideLabelOnRelease: true });
    }
    // Hovering the seek bar: the nearest hover frame over the time, as on
    // the player's own seek bar.
    if (seek) {
      seek.addEventListener('pointermove', (e) => preview(e.clientX));
      seek.addEventListener('pointerleave', () => preview(null));
      seek.addEventListener('pointerdown', (e) => preview(e.clientX));
    }
    // The seek bar from the keyboard: arrows 5 s, Page Up / Down 10 s, Home / End.
    seek?.addEventListener('keydown', (e) => {
      const el = media();
      if (!el || !last || !last.seek.enabled) return;
      const d = el.duration;
      const steps = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -10, PageUp: 10 };
      let to = null;
      if (e.key in steps) to = el.currentTime + steps[e.key];
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = Math.max(0, d - 1);
      if (to === null) return;
      e.preventDefault();
      e.stopPropagation();
      el.currentTime = Math.max(0, Math.min(d, to));
    });
  }

  /**
   * The hover frame over the seek bar at client x (null: hide it). Videos
   * only, and only while hover frames are on (Settings › Library ›
   * Thumbnails); the frames are the player's (thumbs.js scrubUrl, server
   * /scrub/:id/:idx). No frame for the file: the time alone shows (the
   * shared scrub helper's label, player-video.js).
   */
  function preview(x) {
    const seek = $('stageBarSeek');
    const track = $('stageBarTrack');
    if (!seek || !track) return;
    let box = seek.querySelector('.sb-preview');
    const v = last;
    const hoverOn = typeof thumbHoverOn !== 'function' || thumbHoverOn();
    const want = x != null && v && v.seek.enabled && v.id && v.mediaType === 'video' && hoverOn
      && (typeof canShowThumb !== 'function' || canShowThumb({ id: v.id, media_type: 'video' }));
    if (!want) { if (box) box.classList.remove('on'); return; }
    if (!box) {
      box = document.createElement('div');
      box.className = 'sb-preview';
      box.setAttribute('aria-hidden', 'true');
      box.innerHTML = '<img alt="" draggable="false">';
      seek.appendChild(box);
    }
    const img = box.querySelector('img');
    const rect = track.getBoundingClientRect();
    const frameIndex = typeof DockGeom !== 'undefined' && DockGeom.scrubFrameIndex ? DockGeom.scrubFrameIndex : null;
    const p = StageBarRules.previewAt(x, rect.left, rect.width, v.seek.d, frameIndex);
    const key = `${v.id}/${p.idx}`;
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.classList.remove('sb-pv-none');
      img.onerror = () => { if (box.dataset.key === key) box.classList.add('sb-pv-none'); };
      img.src = typeof scrubUrl === 'function' ? scrubUrl(v.id, p.idx) : `/scrub/${v.id}/${p.idx}`;
    }
    const half = (box.offsetWidth || 160) / 2;
    box.style.left = `${Math.max(half, Math.min(rect.width - half, p.x))}px`;
    box.classList.add('on');
  }

  function setGlyph(btn, emoji, icon) {
    if (!btn) return;
    const key = `${emoji}|${icon}`;
    if (btn.dataset.glyph === key) return;
    btn.dataset.glyph = key;
    const span = btn.querySelector('.sb-g') || btn;
    span.innerHTML = typeof vaultIconSwap === 'function' ? vaultIconSwap(emoji, icon) : emoji;
  }

  /** Draw a view (StageBarRules.view) and the still (thumb: its URL or ''). */
  function paint(v, { thumb = '' } = {}) {
    if (!v) return;
    last = v;
    const bar = $('stageBar');
    if (!bar) return;
    const title = $('stageBarTitle');
    if (title) {
      title.textContent = v.title;
      // Privacy mode: no name in the tooltip, whatever the view says (the CSS blurs the text too).
      title.title = document.body.classList.contains('pm-names') ? '' : v.title;
    }
    const pill = $('stageBarPill');
    if (pill) {
      pill.classList.toggle('sb-pill-live', v.pill.live);
      const w = pill.querySelector('.sb-pill-word');
      if (w && w.textContent !== v.pill.word) w.textContent = v.pill.word;
    }
    const note = $('stageBarNote');
    if (note && note.textContent !== v.note) { note.textContent = v.note; note.title = v.note; }
    bar.classList.toggle('sb-has-note', !!v.note);

    const img = $('stageBarThumbImg');
    const front = $('stageBarFront');
    if (front) { front.title = v.front; front.setAttribute('aria-label', v.front); }
    if (img) {
      if (!thumb) { img.hidden = true; img.removeAttribute('src'); delete img.dataset.src; }
      else if (img.dataset.src !== thumb) {
        img.dataset.src = thumb;
        img.hidden = true;
        img.style.display = '';
        delete img.dataset.thumbTry;
        front?.classList.remove('thumb-fallback');
        img.onload = () => { img.hidden = false; img.style.display = ''; front?.classList.remove('thumb-fallback'); };
        img.onerror = () => { img.hidden = true; };
        img.src = thumb;
      }
    }

    for (const id of ['stageBarPrev', 'stageBarNext', 'stageBarPlay']) { const b = $(id); if (b) b.disabled = !v.hasFile; }
    for (const id of ['stageBarBack', 'stageBarFwd']) { const b = $(id); if (b) b.disabled = !v.seek.enabled; }
    const play = $('stageBarPlay');
    if (play) {
      setGlyph(play, v.play.paused ? '▶︎' : '⏸︎', v.play.paused ? 'play' : 'pause');
      play.setAttribute('aria-label', v.play.label);
      play.title = `${v.play.label} (Space)`;
      play.classList.toggle('is-paused', v.play.paused);
    }

    const seek = $('stageBarSeek');
    const fill = $('stageBarFill');
    if (fill && !(seek && seek.classList.contains('scrubbing'))) fill.style.width = `${(v.seek.fraction * 100).toFixed(3)}%`;
    if (seek) {
      seek.classList.toggle('sb-seek-off', !v.seek.enabled);
      seek.setAttribute('aria-disabled', v.seek.enabled ? 'false' : 'true');
      seek.tabIndex = v.seek.enabled ? 0 : -1;
      seek.setAttribute('aria-valuemax', String(Math.round(v.seek.d || 0)));
      seek.setAttribute('aria-valuenow', String(Math.round(v.seek.t || 0)));
      seek.setAttribute('aria-valuetext', v.seek.enabled ? `${v.seek.now} of ${v.seek.end}` : (v.seek.end || 'Nothing to seek'));
    }
    const nowEl = $('stageBarNow');
    if (nowEl) nowEl.textContent = v.seek.now;
    const endEl = $('stageBarEnd');
    if (endEl) endEl.textContent = v.seek.end;

    const un = $('stageBarUpNext');
    if (un) un.setAttribute('aria-label', v.upNext.label);
    const badge = $('stageBarUpNextCount');
    if (badge) {
      const was = badge.hidden ? '' : badge.textContent;
      badge.textContent = String(v.upNext.count);
      badge.hidden = !v.upNext.count;
      // The count coming, going or gaining a digit changes the right side's width: lay out again.
      const now = badge.hidden ? '' : badge.textContent;
      if (was.length !== now.length && on) relayout();
    }

    const rep = $('stageBarRepeat');
    if (rep) {
      setGlyph(rep, v.repeat.mode === 'one' ? '🔂' : '🔁', v.repeat.mode === 'one' ? 'repeat-one' : 'repeat');
      rep.title = v.repeat.title;
      rep.setAttribute('aria-label', v.repeat.label);
      rep.classList.toggle('on', v.repeat.mode !== 'off');
      rep.dataset.mode = v.repeat.mode;
    }
    const hold = $('stageBarHold');
    if (hold) {
      hold.title = v.hold.title;
      hold.setAttribute('aria-pressed', v.hold.on ? 'true' : 'false');
      hold.classList.toggle('on', v.hold.on);
    }
    const mute = $('stageBarMute');
    if (mute) {
      setGlyph(mute, v.volume.silent ? '🔇' : '🔊', v.volume.silent ? 'mute' : 'volume');
      mute.title = v.volume.title;
      mute.setAttribute('aria-label', v.volume.title);
      mute.setAttribute('aria-pressed', v.volume.silent ? 'true' : 'false');
    }
    const slider = $('stageBarVol');
    if (slider && !slider.matches(':active')) {
      slider.max = String(v.volume.max);
      slider.value = String(v.volume.value);
    }
  }

  /**
   * The Flow order hook: a short "tempo · energy" line beside the status
   * pill, for the file on Stage. '' (or nothing) empties it. Kept across
   * paints and across Stage closing and opening again: the caller sets it
   * whenever the file on Stage changes.
   */
  function setFlowText(text) {
    flowText = String(text == null ? '' : text);
    const el = $('stageBarFlow');
    if (!el) return;
    el.textContent = flowText;
    el.hidden = !flowText;
  }

  /**
   * Where things that open from the bar sit, as a rect: 'upnext' and 'menu'
   * line up with their button, 'tips' with the bar's right end; the top is
   * the bar's top (they open above it). Null while the bar is not shown.
   */
  function anchorRect(kind) {
    const bar = $('stageBar');
    if (!on || !bar) return null;
    const b = bar.getBoundingClientRect();
    const btn = kind === 'upnext' ? $('stageBarUpNext') : kind === 'menu' ? $('stageBarMenu') : null;
    const r = btn ? btn.getBoundingClientRect() : { left: b.right - 380, right: b.right - 12 };
    return { left: r.left, right: r.right, top: b.top, bottom: b.bottom, width: r.right - r.left, height: b.height };
  }

  /** Pieces the bar is too narrow for now (Repeat and Hold go into the Stage menu). */
  function dropped() {
    const out = {};
    for (const k of Object.keys(fitNow)) if (!fitNow[k]) out[k] = true;
    return on ? out : {};
  }

  return { show, hide, paint, relayout, dropped, plan: () => lastPlan, setFlowText, flowText: () => flowText, anchorRect, shown: () => on, contains: (el) => !!el && !!$('stageBar')?.contains(el) };
})();

if (typeof window !== 'undefined') { window.StageBarRules = StageBarRules; window.StageBar = StageBar; }
