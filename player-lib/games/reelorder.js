/* =========================================================================
   REEL ORDER — video timeline puzzle, ported into the Games host.

   Original game by aericode (SAMPLES/Reel Order). Ported changes:
     • video comes from the library via /media/:id (HTTP Range → seeking),
       not a file-picker blob URL;
     • poster capture is throttled (a pool of 3) so many clips don't stampede
       the browser's ~6-connection-per-host limit;
     • the run-forever timer is the shared ElapsedTimer (pauses off-view);
     • full game state saves/restores (segments + order + placements + elapsed);
     • DragManager's document listeners are removed on destroy (tab lifecycle);
     • setup/file-picker screen dropped (host owns video selection); the
       difficulty chooser is the game's own pre-game panel.

   Everything lives under a module-private `TL` — no globals except the
   window.gamesRegister('reelorder', …) call at the end.
   ========================================================================= */
(function () {
  const TL = {};

  /* ── Config ──────────────────────────────────────────────────────────── */
  TL.Config = {
    difficulties: {
      practice: { label: 'Practice', coveragePercent: 0.75, minClips: 3, maxClipDuration: 60, multiplier: 0.3 },
      easy:     { label: 'Easy',     coveragePercent: 0.25, minClips: 3, maxClipDuration: 30, multiplier: 0.8 },
      normal:   { label: 'Normal',   coveragePercent: 0.18, minClips: 5, maxClipDuration: 25, multiplier: 1.0 },
      hard:     { label: 'Hard',     coveragePercent: 0.12, minClips: 8, maxClipDuration: 12, multiplier: 1.2 },
      evil:     { label: 'Evil',     coveragePercent: 0.05, minClips: 8, maxClipDuration: 5,  multiplier: 1.5 },
    },
    defaultDifficulty: 'normal',
    clips: { minCount: 3, maxCount: 30, maxDuration: 30, minDuration: 1, minGap: 10 },
    distribution: { jitter: 0.8, edgePadding: 1 },
    scoring: {
      baseScore: 10000, timeDecayPerSec: 4, orderPenalty: 500,
      timestampBonusMax: 200, timestampThreshold: 0.04,
    },
    playback: { defaultVolume: 0.7, skipSeconds: 5 },
    ui: {
      clipWindowWidth: 280, clipWindowHeight: 158, timelineHeight: 80, pointerHeight: 30,
      defaultTileWidth: 240, minTileWidth: 140, maxTileWidth: 360, tileStep: 10,
    },
  };

  /* ── High scores (localStorage, per difficulty) ──────────────────────── */
  TL.HighScores = {
    _prefix: 'reelorder_best_',
    get(d) { try { const v = localStorage.getItem(this._prefix + d); return v ? parseInt(v, 10) || 0 : 0; } catch { return 0; } },
    set(d, s) { try { localStorage.setItem(this._prefix + d, String(Math.floor(s))); } catch {} },
  };

  /* ── Segment generation (verbatim) ───────────────────────────────────── */
  TL.Segments = {
    generate(videoDuration, difficultyKey) {
      const diff = TL.Config.difficulties[difficultyKey];
      const clips = TL.Config.clips, dist = TL.Config.distribution;
      if (!diff) throw new Error(`Unknown difficulty: ${difficultyKey}`);
      const minClips = Math.max(clips.minCount, diff.minClips || clips.minCount);
      const maxClipDuration = Math.min(clips.maxDuration, diff.maxClipDuration || clips.maxDuration);
      const totalClipTime = videoDuration * diff.coveragePercent;
      let clipDuration = Math.min(totalClipTime / minClips, maxClipDuration);
      clipDuration = Math.max(clipDuration, clips.minDuration);
      let clipCount = Math.round(totalClipTime / clipDuration);
      clipCount = Math.max(minClips, Math.min(clips.maxCount, clipCount));
      clipDuration = totalClipTime / clipCount;
      clipDuration = Math.max(clips.minDuration, Math.min(maxClipDuration, clipDuration));
      if (clipDuration >= maxClipDuration) {
        clipCount = Math.max(minClips, Math.ceil(totalClipTime / maxClipDuration));
        clipCount = Math.min(clips.maxCount, clipCount);
        clipDuration = totalClipTime / clipCount;
      }
      const totalNeeded = (clipCount * clipDuration) + ((clipCount - 1) * clips.minGap) + (2 * dist.edgePadding);
      if (totalNeeded > videoDuration) {
        while (clipCount > minClips) {
          clipCount--;
          clipDuration = Math.min(totalClipTime / clipCount, maxClipDuration);
          const needed = (clipCount * clipDuration) + ((clipCount - 1) * clips.minGap) + (2 * dist.edgePadding);
          if (needed <= videoDuration) break;
        }
        if (clipCount <= minClips) {
          clipCount = minClips;
          const available = videoDuration - ((clipCount - 1) * clips.minGap) - (2 * dist.edgePadding);
          clipDuration = Math.max(clips.minDuration, available / clipCount);
        }
      }
      const segments = this._placeClips(videoDuration, clipCount, clipDuration, clips.minGap, dist);
      segments.sort((a, b) => a.startTime - b.startTime);
      segments.forEach((seg, i) => { seg.correctOrder = i; });
      return segments;
    },
    _placeClips(videoDuration, clipCount, clipDuration, minGap, dist) {
      const usable = videoDuration - (2 * dist.edgePadding);
      const zoneSize = usable / clipCount;
      const segments = [];
      for (let i = 0; i < clipCount; i++) {
        const zoneStart = dist.edgePadding + (i * zoneSize);
        const zoneEnd = zoneStart + zoneSize;
        let earliest = zoneStart;
        if (segments.length > 0) earliest = Math.max(earliest, segments[segments.length - 1].endTime + minGap);
        let latest = zoneEnd - clipDuration;
        const remainingAfter = clipCount - i - 1;
        const roomNeeded = remainingAfter * (clipDuration + minGap);
        latest = Math.min(latest, videoDuration - dist.edgePadding - roomNeeded - clipDuration);
        latest = Math.max(earliest, latest);
        const range = latest - earliest;
        const center = earliest + range * 0.5;
        const jittered = center + (Math.random() - 0.5) * range * dist.jitter;
        const startTime = Math.max(earliest, Math.min(latest, jittered));
        segments.push({
          index: i,
          startTime: Math.round(startTime * 100) / 100,
          endTime: Math.round((startTime + clipDuration) * 100) / 100,
        });
      }
      return segments;
    },
  };

  /* ── SegmentPlayer (deferred load + poster; single-focus audio) ───────── */
  TL.SegmentPlayer = class SegmentPlayer {
    constructor(url, startTime, endTime) {
      this.url = url;
      this.startTime = startTime;
      this.endTime = endTime;
      this.duration = endTime - startTime;
      this._playing = false; this._focused = false;
      this._posterReady = false; this._destroyed = false; this._loadStarted = false;
      this._readyResolve = null;
      this.ready = new Promise(r => { this._readyResolve = r; });

      this._vid = document.createElement('video');
      this._vid.playsInline = true; this._vid.loop = false; this._vid.muted = true;
      this._vid.preload = 'auto';
      this._vid.volume = TL.Config.playback.defaultVolume;
      this._vid.style.cssText = 'display:none;position:absolute;pointer-events:none;';

      this._poster = document.createElement('img');
      this._poster.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:6px;pointer-events:none;';
      this._capCanvas = document.createElement('canvas');
      this._capCtx = this._capCanvas.getContext('2d');

      this._onTimeUpdate = () => {
        if (this._vid && this._vid.currentTime >= this.endTime - 0.05) this._vid.currentTime = this.startTime;
      };
      this._vid.addEventListener('timeupdate', this._onTimeUpdate);
      this._vid.addEventListener('ended', () => {
        if (this._playing && this._focused) { this._vid.currentTime = this.startTime; this._vid.play().catch(() => {}); }
      });
      this._vid.addEventListener('seeked', () => {
        if (!this._posterReady && !this._destroyed) this._capturePoster();
      }, { once: true });
      this._vid.addEventListener('loadedmetadata', () => { this._vid.currentTime = this.startTime; }, { once: true });
    }

    /** Begin loading the media (deferred so the game can throttle). */
    startLoad() {
      if (this._loadStarted || this._destroyed) return this.ready;
      this._loadStarted = true;
      document.body.appendChild(this._vid);
      this._vid.src = this.url;
      return this.ready;
    }

    _capturePoster() {
      try {
        const w = this._vid.videoWidth, h = this._vid.videoHeight;
        if (!w || !h) return;
        this._capCanvas.width = Math.min(w, 480);
        this._capCanvas.height = Math.round(this._capCanvas.width * (h / w));
        this._capCtx.drawImage(this._vid, 0, 0, this._capCanvas.width, this._capCanvas.height);
        this._poster.src = this._capCanvas.toDataURL('image/jpeg', 0.7);
        this._posterReady = true;
        this._vid.pause();
        this._capCanvas.width = 0; this._capCanvas.height = 0;
        this._capCanvas = null; this._capCtx = null;
        this._readyResolve && this._readyResolve();
      } catch (e) {
        console.warn('Poster capture failed:', e);
        this._readyResolve && this._readyResolve();
      }
    }

    getVideoElement() { return this._vid; }
    getPosterElement() { return this._poster; }

    focus() {
      this._focused = true; this._vid.muted = false;
      this._vid.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:6px;pointer-events:none;';
      if (this._playing) {
        if (this._vid.currentTime < this.startTime || this._vid.currentTime >= this.endTime) this._vid.currentTime = this.startTime;
        this._vid.play().catch(() => {});
      }
    }
    blur() {
      this._focused = false; this._vid.muted = true; this._vid.pause();
      this._vid.style.cssText = 'display:none;position:absolute;pointer-events:none;';
      if (this._vid.parentElement !== document.body) document.body.appendChild(this._vid);
    }
    get isFocused() { return this._focused; }

    play() {
      this._playing = true;
      if (this._focused) {
        if (this._vid.currentTime < this.startTime || this._vid.currentTime >= this.endTime) this._vid.currentTime = this.startTime;
        this._vid.play().catch(() => {});
      }
    }
    pause() { this._playing = false; this._vid.pause(); }
    skip(seconds) {
      let t = this._vid.currentTime + seconds;
      t = Math.max(this.startTime, Math.min(t, this.endTime - 0.1));
      this._vid.currentTime = t;
    }
    setVolume(v) { this._vid.volume = Math.max(0, Math.min(1, v)); }
    get isPlaying() { return this._playing; }
    get progress() {
      if (!this._focused) return 0;
      return Math.max(0, Math.min(1, (this._vid.currentTime - this.startTime) / this.duration));
    }
    destroy() {
      this._destroyed = true;
      try {
        this._vid.pause();
        this._vid.removeEventListener('timeupdate', this._onTimeUpdate);
        this._vid.removeAttribute('src'); this._vid.load(); this._vid.remove();
      } catch {}
      if (this._poster.parentElement) this._poster.remove();
      this._capCanvas = null; this._capCtx = null; this._vid = null;
    }
  };

  TL.AudioManager = class AudioManager {
    constructor() { this._focused = null; this._volume = TL.Config.playback.defaultVolume; this._globalPlaying = false; }
    setFocus(clipWindow) {
      if (this._focused === clipWindow) return;
      if (this._focused) { this._focused.player.blur(); this._focused.showPoster(); this._focused.el.classList.remove('focused'); }
      this._focused = clipWindow;
      if (clipWindow) {
        clipWindow.player.setVolume(this._volume);
        clipWindow.player.focus(); clipWindow.showLive(); clipWindow.el.classList.add('focused');
        if (this._globalPlaying) clipWindow.player.play();
      }
    }
    get focused() { return this._focused; }
    setVolume(v) { this._volume = Math.max(0, Math.min(1, v)); if (this._focused) this._focused.player.setVolume(this._volume); }
    get volume() { return this._volume; }
    setGlobalPlaying(p) { this._globalPlaying = p; }
  };

  /* ── ClipWindow (verbatim) ───────────────────────────────────────────── */
  TL.ClipWindow = class ClipWindow {
    constructor(player, displayIndex, segment) {
      this.player = player; this.displayIndex = displayIndex; this.segment = segment;
      this.placed = false; this.timelineX = null;
      this._buildDOM();
    }
    _buildDOM() {
      const cfg = TL.Config.ui;
      this.el = document.createElement('div');
      this.el.className = 'clip-window';
      this.el.style.width = cfg.clipWindowWidth + 'px';
      this.el.style.height = cfg.clipWindowHeight + 'px';
      this._mediaWrap = document.createElement('div');
      this._mediaWrap.className = 'clip-media-wrap';
      this.el.appendChild(this._mediaWrap);
      this._mediaWrap.appendChild(this.player.getPosterElement());
      this._overlay = document.createElement('div');
      this._overlay.className = 'clip-overlay';
      this.el.appendChild(this._overlay);
      this.badge = document.createElement('div');
      this.badge.className = 'clip-badge';
      this.badge.textContent = this.displayIndex;
      this.el.appendChild(this.badge);
      this.progressBar = document.createElement('div');
      this.progressBar.className = 'clip-progress';
      this.progressFill = document.createElement('div');
      this.progressFill.className = 'clip-progress-fill';
      this.progressBar.appendChild(this.progressFill);
      this.el.appendChild(this.progressBar);
      this._updateProgress = () => {
        if (this.player && this.player.isFocused && this.player.isPlaying) {
          this.progressFill.style.width = (this.player.progress * 100) + '%';
        }
        this._progressRAF = requestAnimationFrame(this._updateProgress);
      };
      this._progressRAF = requestAnimationFrame(this._updateProgress);
    }
    showLive() {
      this._mediaWrap.innerHTML = '';
      const vid = this.player.getVideoElement();
      vid.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:6px;pointer-events:none;';
      this._mediaWrap.appendChild(vid);
    }
    showPoster() { this._mediaWrap.innerHTML = ''; this._mediaWrap.appendChild(this.player.getPosterElement()); }
    setPosition(x, y) { this.el.style.left = x + 'px'; this.el.style.top = y + 'px'; }
    setPlaced(fraction) { this.placed = true; this.timelineX = fraction; this.el.classList.add('placed'); this.player.pause(); }
    unplace() { this.placed = false; this.timelineX = null; this.el.classList.remove('placed'); }
    destroy() { if (this._progressRAF) cancelAnimationFrame(this._progressRAF); this.player.destroy(); this.el.remove(); }
  };

  /* ── TimelineBar (verbatim, minus unused destroy details) ─────────────── */
  TL.TimelineBar = class TimelineBar {
    constructor(el, videoDuration, gameArea) {
      this.el = el; this.videoDuration = videoDuration; this._gameArea = gameArea;
      this._placements = new Map();
      this._buildBar(); this._buildConnectorSVG();
    }
    _buildBar() {
      this.el.innerHTML = ''; this.el.classList.add('timeline-bar');
      this._arrowsAbove = document.createElement('div');
      this._arrowsAbove.className = 'timeline-arrows timeline-arrows-above';
      this.el.appendChild(this._arrowsAbove);
      this._markings = document.createElement('div');
      this._markings.className = 'timeline-markings';
      this.el.appendChild(this._markings);
      this._track = document.createElement('div');
      this._track.className = 'timeline-track';
      this.el.appendChild(this._track);
      this._arrowsBelow = document.createElement('div');
      this._arrowsBelow.className = 'timeline-arrows timeline-arrows-below';
      this.el.appendChild(this._arrowsBelow);
      this._preview = document.createElement('div');
      this._preview.className = 'timeline-preview';
      this._preview.innerHTML = '<span class="preview-time"></span>';
      this._preview.style.display = 'none';
      this.el.appendChild(this._preview);
      this._renderMarkings();
    }
    _buildConnectorSVG() {
      this._svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this._svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;';
      this._gameArea.appendChild(this._svg);
    }
    _renderMarkings() {
      this._markings.innerHTML = '';
      const interval = this._getMarkingInterval(this.videoDuration);
      for (let t = 0; t <= this.videoDuration; t += interval) {
        const label = document.createElement('span');
        label.className = 'timeline-mark';
        label.textContent = this._formatTime(t);
        label.style.left = ((t / this.videoDuration) * 100) + '%';
        this._markings.appendChild(label);
      }
    }
    _getMarkingInterval(d) { if (d <= 60) return 10; if (d <= 300) return 30; if (d <= 900) return 60; if (d <= 3600) return 300; return 600; }
    _formatTime(s) { return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
    placeClip(clipWindow, fraction) {
      this.removeClip(clipWindow);
      const pos = this._findPosition(fraction);
      const arrow = document.createElement('div');
      arrow.className = 'timeline-arrow' + (pos.side === 'below' ? ' arrow-below' : '');
      arrow.style.left = (fraction * 100) + '%';
      const badge = document.createElement('span');
      badge.className = 'arrow-badge';
      badge.textContent = clipWindow.displayIndex;
      const tooltip = document.createElement('span');
      tooltip.className = 'arrow-tooltip';
      tooltip.textContent = this._formatTime(fraction * this.videoDuration);
      if (pos.side === 'below') { arrow.appendChild(tooltip); arrow.appendChild(badge); this._arrowsBelow.appendChild(arrow); }
      else { arrow.appendChild(badge); arrow.appendChild(tooltip); this._arrowsAbove.appendChild(arrow); }
      clipWindow.setPosition(pos.x, pos.y); clipWindow.setPlaced(fraction);
      this._placements.set(clipWindow, { fraction, arrowEl: arrow, x: pos.x, y: pos.y, side: pos.side });
      this._drawConnectors();
    }
    _findPosition(fraction) {
      const cfg = TL.Config.ui;
      const tlRect = this.el.getBoundingClientRect();
      const areaRect = this._gameArea.getBoundingClientRect();
      const clipW = cfg.clipWindowWidth, clipH = cfg.clipWindowHeight, gap = 6, arrowPad = 8;
      const xCenter = (fraction * tlRect.width) + (tlRect.left - areaRect.left);
      const x = Math.max(5, Math.min(xCenter - clipW / 2, areaRect.width - clipW - 5));
      const blockers = [];
      for (const [, p] of this._placements) { if (x < p.x + clipW && x + clipW > p.x) blockers.push(p); }
      const barTop = this.el.offsetTop, arrowH = 50;
      blockers.sort((a, b) => b.y - a.y);
      const y = this._probeY(clipH, blockers, gap, barTop - arrowH - arrowPad - clipH, -1, 5);
      if (y != null) return { x, y, side: 'above' };
      return { x, y: barTop - arrowH - arrowPad - clipH, side: 'above' };
    }
    _probeY(h, blockers, gap, idealY, dir, boundaryY) {
      if (blockers.length === 0) {
        if (dir < 0 && idealY >= boundaryY) return idealY;
        if (dir > 0 && idealY <= boundaryY) return idealY;
        return null;
      }
      let y = idealY;
      for (let attempt = 0; attempt < 30; attempt++) {
        if (dir < 0 && y < boundaryY) return null;
        if (dir > 0 && y > boundaryY) return null;
        let blocked = false;
        for (const p of blockers) {
          if (y < p.y + h + gap && y + h + gap > p.y) { blocked = true; y = dir < 0 ? p.y - h - gap : p.y + h + gap; break; }
        }
        if (!blocked) return y;
      }
      return null;
    }
    removeClip(clipWindow) {
      const p = this._placements.get(clipWindow);
      if (p) { p.arrowEl.remove(); this._placements.delete(clipWindow); this._drawConnectors(); }
    }
    _drawConnectors() {
      this._svg.innerHTML = '';
      const areaRect = this._gameArea.getBoundingClientRect();
      for (const [clipWin, p] of this._placements) {
        const clipRect = clipWin.el.getBoundingClientRect();
        const arrowRect = p.arrowEl.getBoundingClientRect();
        if (!clipRect.width || !arrowRect.width) continue;
        const above = p.side === 'above';
        const sx = clipRect.left + clipRect.width / 2 - areaRect.left;
        const sy = (above ? clipRect.bottom : clipRect.top) - areaRect.top;
        const ex = arrowRect.left + arrowRect.width / 2 - areaRect.left;
        const ey = (above ? arrowRect.top : arrowRect.bottom) - areaRect.top;
        const dx = ex - sx, cpX = sx + dx * 0.5, cpY = sy + (ey - sy) * 0.5 + dx * 0.08 * (above ? 1 : -1);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${sx} ${sy} Q ${cpX} ${cpY} ${ex} ${ey}`);
        path.setAttribute('class', 'connector-line');
        path.dataset.clipIdx = clipWin.displayIndex;
        this._svg.appendChild(path);
      }
    }
    showPreview(fraction) {
      if (!this._preview) return;
      fraction = Math.max(0, Math.min(1, fraction));
      this._preview.style.display = ''; this._preview.style.left = (fraction * 100) + '%';
      this._preview.querySelector('.preview-time').textContent = this._formatTime(fraction * this.videoDuration);
    }
    hidePreview() { if (this._preview) this._preview.style.display = 'none'; }
    getPlacedOrder() {
      return [...this._placements.entries()].sort((a, b) => a[1].fraction - b[1].fraction)
        .map(([clipWindow, { fraction }]) => ({ clipWindow, fraction, timestamp: fraction * this.videoDuration }));
    }
    get placedCount() { return this._placements.size; }
    showResults(results) {
      for (const { clipWindow, orderCorrect, timeBonus } of results) {
        const p = this._placements.get(clipWindow);
        if (!p) continue;
        const cls = (orderCorrect && timeBonus > 0) ? 'result-perfect' : orderCorrect ? 'result-correct' : 'result-wrong';
        p.arrowEl.classList.add(cls);
        const line = this._svg.querySelector(`[data-clip-idx="${clipWindow.displayIndex}"]`);
        if (line) line.classList.add(cls.replace('result-', 'connector-'));
      }
    }
    clear() {
      for (const [, { arrowEl }] of this._placements) arrowEl.remove();
      this._placements.clear();
      if (this._svg) this._svg.innerHTML = '';
      if (this._arrowsAbove) this._arrowsAbove.innerHTML = '';
      if (this._arrowsBelow) this._arrowsBelow.innerHTML = '';
    }
    destroy() { this.clear(); this.el.innerHTML = ''; if (this._svg) this._svg.remove(); }
  };

  /* ── DragManager (adapted: removable document listeners) ─────────────── */
  TL.DragManager = class DragManager {
    constructor(container, timelineEl, timeline, onDrop, onRemove) {
      this._container = container; this._timelineEl = timelineEl; this._timeline = timeline;
      this._onDrop = onDrop; this._onRemove = onRemove;
      this._active = null; this._offset = { x: 0, y: 0 }; this._windows = []; this._locked = false;
      this._downH = (e) => this._onDown(e);
      this._moveH = (e) => this._onMove(e);
      this._upH = (e) => this._onUp(e);
      this._container.addEventListener('pointerdown', this._downH);
      document.addEventListener('pointermove', this._moveH);
      document.addEventListener('pointerup', this._upH);
    }
    register(clipWindow) {
      this._windows.push(clipWindow);
      clipWindow.el.style.cursor = 'grab';
      clipWindow.el.style.position = 'absolute';
      clipWindow.el.style.userSelect = 'none';
      clipWindow.el.style.touchAction = 'none';
    }
    _findWindow(target) {
      let el = target;
      while (el && el !== this._container) {
        if (el.classList && el.classList.contains('clip-window')) return this._windows.find(w => w.el === el) || null;
        el = el.parentElement;
      }
      return null;
    }
    _onDown(e) {
      if (this._locked) return;
      const win = this._findWindow(e.target);
      if (!win) return;
      e.preventDefault();
      this._active = win;
      const rect = win.el.getBoundingClientRect();
      this._offset.x = e.clientX - rect.left; this._offset.y = e.clientY - rect.top;
      win.el.style.cursor = 'grabbing'; win.el.style.zIndex = '100'; win.el.classList.add('dragging');
      if (win.placed) { win.unplace(); if (this._onRemove) this._onRemove(win); }
    }
    _onMove(e) {
      if (!this._active) return;
      e.preventDefault();
      const containerRect = this._container.getBoundingClientRect();
      this._active.setPosition(e.clientX - containerRect.left - this._offset.x, e.clientY - containerRect.top - this._offset.y);
      const tlRect = this._timelineEl.getBoundingClientRect();
      const overTimeline = (e.clientY >= tlRect.top - 80 && e.clientY <= tlRect.bottom + 80 && e.clientX >= tlRect.left && e.clientX <= tlRect.right);
      this._timelineEl.classList.toggle('drop-hover', overTimeline);
      if (overTimeline) this._timeline.showPreview(Math.max(0, Math.min(1, (e.clientX - tlRect.left) / tlRect.width)));
      else this._timeline.hidePreview();
    }
    _onUp(e) {
      if (!this._active) return;
      const win = this._active; this._active = null;
      win.el.style.cursor = 'grab'; win.el.style.zIndex = ''; win.el.classList.remove('dragging');
      this._timelineEl.classList.remove('drop-hover'); this._timeline.hidePreview();
      const tlRect = this._timelineEl.getBoundingClientRect();
      const overTimeline = (e.clientY >= tlRect.top - 80 && e.clientY <= tlRect.bottom + 80 && e.clientX >= tlRect.left && e.clientX <= tlRect.right);
      if (overTimeline) this._onDrop(win, Math.max(0, Math.min(1, (e.clientX - tlRect.left) / tlRect.width)));
    }
    clear() { this._windows = []; this._active = null; }
    lock() { this._locked = true; this._active = null; this._windows.forEach(w => { w.el.style.cursor = 'pointer'; }); }
    destroy() {
      document.removeEventListener('pointermove', this._moveH);
      document.removeEventListener('pointerup', this._upH);
      this._windows = []; this._active = null;
    }
  };

  /* ── ScoreKeeper (adapted: uses an injected ElapsedTimer) ────────────── */
  TL.ScoreKeeper = class ScoreKeeper {
    constructor(timer) { this._timer = timer; }
    start(onTick) { this._timer.start(onTick); }
    stop() { this._timer.stop(); }
    get elapsed() { return this._timer.elapsedMs() / 1000; }
    calculate(placedOrder, segments, videoDuration) {
      const cfg = TL.Config.scoring;
      const timeDecay = Math.floor(this.elapsed * cfg.timeDecayPerSec);
      let orderPenalties = 0, timestampBonus = 0;
      const clipResults = [];
      for (let i = 0; i < placedOrder.length; i++) {
        const { clipWindow, timestamp } = placedOrder[i];
        const seg = clipWindow.segment;
        const orderCorrect = (seg.correctOrder === i);
        if (!orderCorrect) orderPenalties += cfg.orderPenalty;
        const error = Math.abs(timestamp - seg.startTime);
        const threshold = videoDuration * cfg.timestampThreshold;
        let timeBonus = 0;
        if (error <= threshold) timeBonus = Math.round(cfg.timestampBonusMax * (1 - error / threshold));
        timestampBonus += timeBonus;
        clipResults.push({ clipWindow, segment: seg, placedAt: timestamp, actualStart: seg.startTime, error, orderCorrect, timeBonus });
      }
      const score = Math.max(0, cfg.baseScore - timeDecay - orderPenalties + timestampBonus);
      return {
        score,
        breakdown: {
          base: cfg.baseScore, timeDecay, timeTaken: this.elapsed, orderPenalties,
          orderWrong: clipResults.filter(c => !c.orderCorrect).length, timestampBonus, clipCount: placedOrder.length,
        },
        clipResults,
      };
    }
    static formatTime(seconds) { const m = Math.floor(seconds / 60), s = (seconds % 60).toFixed(1); return m + ':' + (s < 10 ? '0' : '') + s; }
    static formatMMSS(seconds) { const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60); return m + ':' + String(s).padStart(2, '0'); }
  };

  /* ── UI (top bar, transport bar, results — no file-picker setup) ─────── */
  TL.UI = {
    buildTopBar(container) {
      const bar = document.createElement('div');
      bar.id = 'top-bar';
      bar.innerHTML = `
        <div class="top-left">
          <h1 class="game-title">Reel Order</h1>
          <p class="game-hint">Drag clips onto the timeline in order. Accuracy = bonus points.</p>
        </div>
        <div class="top-right">
          <div class="ro-size" title="Tile size">
            <span class="ro-size-label">Size</span>
            <input type="range" id="ro-tile-size" class="ro-size-slider"
              min="${TL.Config.ui.minTileWidth}" max="${TL.Config.ui.maxTileWidth}" step="${TL.Config.ui.tileStep}">
          </div>
          <div class="top-stats">
            <div class="hud-stat"><span class="hud-label">Clip Length</span><span class="hud-value" id="hud-clip-dur">–</span></div>
            <div class="hud-stat"><span class="hud-label">Placed</span><span class="hud-value" id="hud-placed">0 / 0</span></div>
            <div class="hud-stat"><span class="hud-label">Time</span><span class="hud-value" id="hud-timer">0:00.0</span></div>
            <div class="hud-stat"><span class="hud-label">Best</span><span class="hud-value" id="hud-best">–</span></div>
          </div>
          <div class="top-buttons">
            <button class="new-game-btn" id="btn-new-game">New Game</button>
            <button class="submit-btn" id="btn-submit" disabled>Submit Order</button>
          </div>
        </div>`;
      container.appendChild(bar);
      return bar;
    },
    buildTransportBar(container) {
      const bar = document.createElement('div');
      bar.id = 'transport-bar';
      bar.innerHTML = `
        <div class="transport-controls">
          <button class="transport-btn" id="btn-back" title="Back 5s">◀◀</button>
          <button class="transport-btn transport-play" id="btn-play" title="Play/Pause">▶</button>
          <button class="transport-btn" id="btn-fwd" title="Forward 5s">▶▶</button>
          <div class="volume-wrap">
            <span class="vol-icon">🔊</span>
            <input type="range" id="volume-slider" min="0" max="1" step="0.05" value="0.7" class="volume-slider">
          </div>
        </div>`;
      container.appendChild(bar);
      return bar;
    },
    showResults(container, results, difficulty, onReview, onPlayAgain) {
      const { score, breakdown, clipResults } = results;
      const fmt = TL.ScoreKeeper.formatMMSS;
      const prevBest = TL.HighScores.get(difficulty);
      const isNewBest = score > prevBest;
      if (isNewBest) TL.HighScores.set(difficulty, score);
      const bestScore = Math.max(score, prevBest);
      const hudBest = document.getElementById('hud-best');
      if (hudBest) hudBest.textContent = bestScore.toLocaleString();
      const overlay = document.createElement('div');
      overlay.id = 'results-overlay';
      const orderCorrect = clipResults.filter(c => c.orderCorrect).length, total = clipResults.length;
      overlay.innerHTML = `
        <div class="results-card">
          <h2 class="results-title">Results</h2>
          <div class="results-score">${score.toLocaleString()}</div>
          ${isNewBest ? '<div class="new-best">New High Score!</div>' : ''}
          <div class="results-best">Best (${TL.Config.difficulties[difficulty].label}): ${bestScore.toLocaleString()}</div>
          <div class="results-breakdown">
            <div class="rb-row"><span>Base Score</span><span>${breakdown.base.toLocaleString()}</span></div>
            <div class="rb-row penalty"><span>Time Penalty (${TL.ScoreKeeper.formatTime(breakdown.timeTaken)})</span><span>−${breakdown.timeDecay.toLocaleString()}</span></div>
            <div class="rb-row ${breakdown.orderWrong > 0 ? 'penalty' : 'bonus'}"><span>Order (${orderCorrect}/${total} correct)</span><span>${breakdown.orderWrong > 0 ? '−' + breakdown.orderPenalties.toLocaleString() : '✓'}</span></div>
            <div class="rb-row bonus"><span>Timestamp Bonus</span><span>+${breakdown.timestampBonus.toLocaleString()}</span></div>
          </div>
          <div class="results-clips">
            <h3>Clip Details</h3>
            ${clipResults.map(c => `
              <div class="rc-row ${c.orderCorrect ? (c.timeBonus > 0 ? 'perfect' : 'correct') : 'wrong'}">
                <span class="rc-num">#${c.clipWindow.displayIndex}</span>
                <span class="rc-order">${c.orderCorrect ? '✓' : '✗'}</span>
                <span class="rc-time">Placed: ${fmt(c.placedAt)} → Actual: ${fmt(c.actualStart)}</span>
                <span class="rc-bonus">${c.timeBonus > 0 ? '+' + c.timeBonus : ''}</span>
              </div>`).join('')}
          </div>
          <div class="results-buttons">
            <button class="start-btn review-btn" id="btn-review">Review Timeline</button>
            <button class="start-btn" id="btn-play-again">Play Again</button>
          </div>
        </div>`;
      container.appendChild(overlay);
      overlay.querySelector('#btn-review').addEventListener('click', () => { overlay.remove(); onReview && onReview(); });
      overlay.querySelector('#btn-play-again').addEventListener('click', () => { overlay.remove(); onPlayAgain && onPlayAgain(); });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); onReview && onReview(); } });
    },
  };

  /* ── Small helpers ───────────────────────────────────────────────────── */
  function runPool(tasks, concurrency) {
    return new Promise(resolve => {
      let i = 0, done = 0;
      if (tasks.length === 0) return resolve();
      const next = () => {
        if (i >= tasks.length) return;
        const t = tasks[i++];
        Promise.resolve().then(t).catch(() => {}).finally(() => {
          if (++done >= tasks.length) resolve();
          else next();
        });
      };
      for (let k = 0; k < Math.min(concurrency, tasks.length); k++) next();
    });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* ═══════════════════════════════════════════════════════════════════════
     ReelOrderGame — the host interface (mount/pause/resume/getState/destroy)
     ═══════════════════════════════════════════════════════════════════════ */
  class ReelOrderGame {
    constructor() {
      this._timer = new ElapsedTimer();
      this._container = null;
      this._mediaId = null;
      this._media = null;
      this._onProgress = null;
      this._mediaUrl = null;
      this._sourceUrl = null;   // resolved clip source — a shared blob URL once fetched
      this._blobUrl = null;     // object URL for the one-shot download (revoked on destroy)
      this._difficulty = TL.Config.defaultDifficulty;
      this._segments = [];
      this._clipWindows = [];
      this._timeline = null;
      this._dragManager = null;
      this._audioManager = null;
      this._scorer = null;
      this._playing = false;
      this._reviewMode = false;
      this._videoDuration = 0;
      this._phase = 'setup'; // setup | playing | review
      this._lastResults = null;
      this._tileWidth = this._loadTileWidth();  // user's preferred tile width (target)
      this._loadingEl = null;
      this._tileRAF = 0;
      this._pendingTileW = null;
    }

    _loadTileWidth() {
      const cfg = TL.Config.ui;
      let w = cfg.defaultTileWidth;
      try { const v = parseInt(localStorage.getItem('reelorder_tile_w'), 10); if (v) w = v; } catch {}
      return Math.max(cfg.minTileWidth, Math.min(cfg.maxTileWidth, w));
    }

    /* ── Loading veil (covers #gameRoot, survives _root rebuilds) ────────── */
    _showLoading(text) {
      this._hideLoading();
      const el = document.createElement('div');
      el.className = 'ro-loading-overlay';
      el.innerHTML = `<div class="ro-spinner"></div><div class="ro-loading-text">${esc(text || 'Loading…')}</div>`;
      this._container.appendChild(el);
      this._loadingEl = el;
    }
    _hideLoading() {
      if (this._loadingEl) { this._loadingEl.remove(); this._loadingEl = null; }
    }

    async mount(container, { mediaId, media, savedState, onProgress }) {
      this._container = container;
      this._mediaId = mediaId;
      this._media = media || getMediaById(mediaId);
      this._mediaUrl = '/media/' + mediaId;
      this._sourceUrl = this._mediaUrl;   // upgraded to a shared blob URL by _ensureSource()
      this._onProgress = onProgress || (() => {});
      container.innerHTML = '<div class="ro-root" id="ro-root"></div>';
      this._root = container.querySelector('#ro-root');

      if (savedState && Array.isArray(savedState.segments) && savedState.segments.length) {
        this._showLoading('Restoring game…');
        try { await this._applyState(savedState); }
        finally { this._hideLoading(); }
      } else {
        this._showDifficultyChooser();
      }
    }

    /* ── Pre-game difficulty chooser (replaces the file-picker setup) ──── */
    _showDifficultyChooser() {
      this._phase = 'setup';
      const dur = this._media?.duration_seconds || 0;
      const cards = Object.entries(TL.Config.difficulties).map(([key, val]) => {
        const minClips = Math.max(TL.Config.clips.minCount, val.minClips || TL.Config.clips.minCount);
        const minDuration = (minClips * TL.Config.clips.minDuration) + ((minClips - 1) * TL.Config.clips.minGap) + 2;
        const tooShort = dur > 0 && dur < minDuration;
        const best = TL.HighScores.get(key);
        return `
          <button class="ro-diff-btn ${tooShort ? 'disabled' : ''}" data-key="${key}" ${tooShort ? 'disabled' : ''}
            title="${tooShort ? `Video too short, needs ${TL.ScoreKeeper.formatMMSS(minDuration)}+` : ''}">
            <strong>${val.label}</strong>
            <small>${Math.round(val.coveragePercent * 100)}% coverage</small>
            <small class="ro-diff-best">${best > 0 ? 'Best: ' + best.toLocaleString() : ''}</small>
          </button>`;
      }).join('');
      this._root.innerHTML = `
        <div class="ro-setup">
          <h2 class="ro-setup-title">🎬 ${esc(this._media?.filename || 'Video')}</h2>
          <p class="ro-setup-sub">Pick a difficulty. More coverage = easier.</p>
          <div class="ro-diff-grid">${cards}</div>
        </div>`;
      this._root.querySelectorAll('.ro-diff-btn:not(.disabled)').forEach(btn => {
        btn.addEventListener('click', () => this._start(btn.dataset.key));
      });
    }

    /* Download the media ONCE and share one blob URL across every clip.
       The original reads from a single file-picker blob, so N <video>s seek
       a local source with no network cost. Streaming /media/:id per clip
       instead opens N HTTP connections and starves the browser's ~6/host
       cap — only the first few clips ever capture a poster. Fetching once
       restores the original's behaviour (many clips, no connection storm). */
    async _ensureSource() {
      if (this._blobUrl) return this._blobUrl;
      try {
        const resp = await fetch(this._mediaUrl);
        if (!resp.ok) throw new Error('media fetch ' + resp.status);
        const blob = await resp.blob();
        this._blobUrl = URL.createObjectURL(blob);
        this._sourceUrl = this._blobUrl;
      } catch (e) {
        console.warn('Reel Order: blob load failed, streaming per clip instead', e);
        this._sourceUrl = this._mediaUrl;
      }
      return this._sourceUrl;
    }

    async _start(difficulty) {
      this._difficulty = difficulty;
      this._showLoading('Loading video…');
      try {
        await this._ensureSource();
        let duration = this._media?.duration_seconds || 0;
        if (!duration) duration = await this._probeDuration(this._sourceUrl);
        this._videoDuration = duration;
        this._segments = TL.Segments.generate(duration, difficulty);
        await this._buildGameUI(duration, null);
        this._phase = 'playing';
        this._onProgress();
      } finally {
        this._hideLoading();
      }
    }

    _probeDuration(url) {
      return new Promise((resolve) => {
        const probe = document.createElement('video');
        probe.preload = 'metadata'; probe.src = url;
        probe.addEventListener('loadedmetadata', () => { resolve(probe.duration); probe.remove(); }, { once: true });
        probe.addEventListener('error', () => { resolve(0); probe.remove(); }, { once: true });
      });
    }

    /* ── Build the play UI. orderedSegments (restore) skips the shuffle ── */
    async _buildGameUI(duration, orderedSegments) {
      this._root.innerHTML = '';
      this._audioManager = new TL.AudioManager();
      TL.UI.buildTopBar(this._root);
      this._gameArea = document.createElement('div');
      this._gameArea.id = 'game-area';
      this._root.appendChild(this._gameArea);
      const tlEl = document.createElement('div');
      tlEl.id = 'timeline';
      this._gameArea.appendChild(tlEl);
      this._timeline = new TL.TimelineBar(tlEl, duration, this._gameArea);
      TL.UI.buildTransportBar(this._root);

      // Layout math needs a sized container; guard against a 0-width first paint
      await this._waitForWidth();
      this._calculateClipSize();
      this._bindControls();
      await this._createClipWindows(orderedSegments);

      this._dragManager = new TL.DragManager(
        this._gameArea, tlEl, this._timeline,
        (win, fraction) => this._onClipDropped(win, fraction),
        (win) => this._onClipRemoved(win),
      );
      this._clipWindows.forEach(w => this._dragManager.register(w));

      // Focus + auto-play the first clip
      if (this._clipWindows.length > 0) {
        this._audioManager.setFocus(this._clipWindows[0]);
        this._playing = true;
        this._audioManager.setGlobalPlaying(true);
        this._clipWindows[0].player.play();
        const playBtn = document.getElementById('btn-play');
        if (playBtn) playBtn.textContent = '❚❚';
      }

      const hudClipDur = document.getElementById('hud-clip-dur');
      if (hudClipDur) {
        const totalClipTime = this._segments.reduce((s, seg) => s + (seg.endTime - seg.startTime), 0);
        hudClipDur.textContent = (totalClipTime / this._segments.length).toFixed(1) + 's';
      }
      const hudBest = document.getElementById('hud-best');
      if (hudBest) { const best = TL.HighScores.get(this._difficulty); hudBest.textContent = best > 0 ? best.toLocaleString() : '–'; }

      this._scorer = new TL.ScoreKeeper(this._timer);
      this._scorer.start((elapsed) => {
        const t = document.getElementById('hud-timer');
        if (t) t.textContent = TL.ScoreKeeper.formatTime(elapsed);
      });
      this._updatePlacedCount();
    }

    _waitForWidth() {
      return new Promise(resolve => {
        let tries = 0;
        const check = () => {
          if (this._gameArea.getBoundingClientRect().width > 0 || tries++ > 60) return resolve();
          requestAnimationFrame(check);
        };
        check();
      });
    }

    _calculateClipSize() {
      const count = this._segments.length, cfg = TL.Config.ui;
      const areaRect = this._gameArea.getBoundingClientRect();
      const tlTop = this._gameArea.querySelector('#timeline').offsetTop;
      const availH = Math.max(120, tlTop - 70), availW = Math.max(240, areaRect.width);
      const aspect = 16 / 9, gap = 12, minW = cfg.minTileWidth;
      // Start at the user's target size, then shrink only if the grid would
      // overflow the play area — it can't scroll, so tiles must fit without
      // overlap. When they all fit, the target width is honoured as-is.
      let w = Math.max(minW, Math.min(this._tileWidth || cfg.defaultTileWidth, cfg.maxTileWidth));
      for (let guard = 0; guard < 80 && w > minW; guard++) {
        const cols = Math.max(1, Math.floor(availW / (w + gap)));
        const rows = Math.ceil(count / cols);
        if (rows * (w / aspect + gap) <= availH && w * cols <= availW) break;
        w -= 6;
      }
      cfg.clipWindowWidth = Math.max(minW, Math.round(w));
      cfg.clipWindowHeight = Math.round(cfg.clipWindowWidth / aspect);
    }

    /** Resize every clip element to the current computed tile size. */
    _applyTileSize() {
      const cfg = TL.Config.ui;
      this._clipWindows.forEach(w => {
        w.el.style.width = cfg.clipWindowWidth + 'px';
        w.el.style.height = cfg.clipWindowHeight + 'px';
      });
    }

    /** Reflow only the not-yet-placed clips into a tidy grid (used on resize). */
    _layoutUnplaced() {
      const cfg = TL.Config.ui;
      const areaRect = this._gameArea.getBoundingClientRect();
      const timelineTop = this._gameArea.querySelector('#timeline').offsetTop;
      const availableH = Math.max(120, timelineTop - 70), availableW = Math.max(240, areaRect.width);
      const cols = Math.max(1, Math.floor(availableW / (cfg.clipWindowWidth + 12)));
      const free = this._clipWindows.filter(w => !w.placed);
      const rows = Math.max(1, Math.ceil(free.length / cols));
      const cellW = availableW / cols, cellH = availableH / rows;
      free.forEach((clipWin, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        const padX = Math.max(0, cellW - cfg.clipWindowWidth) * 0.5;
        const padY = Math.max(0, cellH - cfg.clipWindowHeight) * 0.5;
        let x = col * cellW + padX;
        let y = 10 + row * cellH + padY;
        x = Math.max(8, Math.min(x, availableW - cfg.clipWindowWidth - 8));
        y = Math.max(5, Math.min(y, timelineTop - cfg.clipWindowHeight - 80));
        clipWin.setPosition(x, y);
      });
    }

    /** Slider handler: adopt a new target tile width and re-lay-out the board. */
    _setTileWidth(w) {
      const cfg = TL.Config.ui;
      this._tileWidth = Math.max(cfg.minTileWidth, Math.min(cfg.maxTileWidth, w));
      try { localStorage.setItem('reelorder_tile_w', String(this._tileWidth)); } catch {}
      if (!this._gameArea || !this._segments.length) return;
      this._calculateClipSize();
      this._applyTileSize();
      this._layoutUnplaced();
      // Re-place placed clips so their arrows/connectors follow the new size
      if (this._timeline) {
        this._timeline.getPlacedOrder().forEach(({ clipWindow, fraction }) =>
          this._timeline.placeClip(clipWindow, fraction));
      }
    }

    async _createClipWindows(orderedSegments) {
      const ordered = orderedSegments || (() => {
        const s = [...this._segments];
        for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
        return s;
      })();

      const cfg = TL.Config.ui;
      const areaRect = this._gameArea.getBoundingClientRect();
      const timelineTop = this._gameArea.querySelector('#timeline').offsetTop;
      const availableH = Math.max(120, timelineTop - 70), availableW = Math.max(240, areaRect.width);
      // Cols derived from the ACTUAL clip width so cells never overlap the clips
      const cols = Math.max(1, Math.floor(availableW / (cfg.clipWindowWidth + 12)));
      const rows = Math.ceil(ordered.length / cols);
      const cellW = availableW / cols;
      const cellH = availableH / rows;

      this._clipWindows = [];
      ordered.forEach((seg, i) => {
        const player = new TL.SegmentPlayer(this._sourceUrl, seg.startTime, seg.endTime);
        const clipWin = new TL.ClipWindow(player, i + 1, seg);
        const col = i % cols, row = Math.floor(i / cols);
        const padX = Math.max(0, cellW - cfg.clipWindowWidth) * 0.5;
        const padY = Math.max(0, cellH - cfg.clipWindowHeight) * 0.5;
        let x = col * cellW + padX + (Math.random() - 0.5) * padX * 0.6;
        let y = 10 + row * cellH + padY + (Math.random() - 0.5) * padY * 0.4;
        x = Math.max(8, Math.min(x, availableW - cfg.clipWindowWidth - 8));
        y = Math.max(5, Math.min(y, timelineTop - cfg.clipWindowHeight - 80));
        clipWin.setPosition(x, y);
        this._gameArea.appendChild(clipWin.el);
        this._clipWindows.push(clipWin);
        clipWin.el.addEventListener('pointerdown', () => this._audioManager.setFocus(clipWin));
      });

      // Throttle poster capture (each clip seeks the media over the network)
      const tasks = this._clipWindows.map(w => () => w.player.startLoad());
      await Promise.race([
        runPool(tasks, 3),
        new Promise(r => setTimeout(r, 8000)),
      ]);
    }

    _bindControls() {
      const playBtn = document.getElementById('btn-play');
      const backBtn = document.getElementById('btn-back');
      const fwdBtn = document.getElementById('btn-fwd');
      const volSlider = document.getElementById('volume-slider');
      const submitBtn = document.getElementById('btn-submit');
      const newGameBtn = document.getElementById('btn-new-game');
      const sizeSlider = document.getElementById('ro-tile-size');

      if (sizeSlider) {
        sizeSlider.value = this._tileWidth;
        // Coalesce rapid input events to one relayout per frame
        sizeSlider.addEventListener('input', (e) => {
          this._pendingTileW = parseInt(e.target.value, 10);
          if (this._tileRAF) return;
          this._tileRAF = requestAnimationFrame(() => {
            this._tileRAF = 0;
            if (this._pendingTileW != null) this._setTileWidth(this._pendingTileW);
          });
        });
      }

      playBtn.addEventListener('click', () => {
        this._playing = !this._playing;
        playBtn.textContent = this._playing ? '❚❚' : '▶';
        this._audioManager.setGlobalPlaying(this._playing);
        const f = this._audioManager.focused;
        if (f) { if (this._playing) f.player.play(); else f.player.pause(); }
      });
      backBtn.addEventListener('click', () => { const f = this._audioManager.focused; if (f) f.player.skip(-TL.Config.playback.skipSeconds); });
      fwdBtn.addEventListener('click', () => { const f = this._audioManager.focused; if (f) f.player.skip(TL.Config.playback.skipSeconds); });
      volSlider.addEventListener('input', (e) => this._audioManager.setVolume(parseFloat(e.target.value)));
      submitBtn.addEventListener('click', () => this._submit());
      // New Game restarts on the SAME video with a fresh difficulty choice
      newGameBtn.addEventListener('click', () => { this._resetForNewGame(); this._showDifficultyChooser(); });
    }

    _resetForNewGame() {
      this._timer.pause(); this._timer.setElapsedMs(0);
      if (this._dragManager) { this._dragManager.destroy(); this._dragManager = null; }
      this._clipWindows.forEach(w => w.destroy()); this._clipWindows = [];
      if (this._timeline) { this._timeline.destroy(); this._timeline = null; }
      this._reviewMode = false; this._lastResults = null; this._playing = false;
      this._audioManager = null; this._scorer = null;
    }

    _onClipDropped(clipWindow, fraction) { this._timeline.placeClip(clipWindow, fraction); this._updatePlacedCount(); this._onProgress(); }
    _onClipRemoved(clipWindow) {
      this._timeline.removeClip(clipWindow); this._updatePlacedCount();
      this._audioManager.setFocus(clipWindow);
      if (this._playing) clipWindow.player.play();
      this._onProgress();
    }
    _updatePlacedCount() {
      const placed = this._timeline.placedCount, total = this._clipWindows.length;
      const el = document.getElementById('hud-placed'); if (el) el.textContent = `${placed} / ${total}`;
      const submitBtn = document.getElementById('btn-submit'); if (submitBtn) submitBtn.disabled = (placed < total);
    }

    _submit() {
      this._scorer.stop();
      this._clipWindows.forEach(w => w.player.pause());
      this._playing = false; this._phase = 'review';
      const placedOrder = this._timeline.getPlacedOrder();
      this._lastResults = this._scorer.calculate(placedOrder, this._segments, this._videoDuration);
      this._timeline.showResults(this._lastResults.clipResults);
      TL.UI.showResults(this._root, this._lastResults, this._difficulty,
        () => this._enterReviewMode(),
        () => { this._resetForNewGame(); this._showDifficultyChooser(); });
      this._onProgress();
    }

    _enterReviewMode() {
      this._reviewMode = true;
      this._dragManager.lock();
      const submitBtn = document.getElementById('btn-submit'); if (submitBtn) submitBtn.remove();
      this._timeline.clear();
      const sorted = [...this._clipWindows].sort((a, b) => a.segment.correctOrder - b.segment.correctOrder);
      sorted.forEach((clipWin) => {
        const correctFraction = clipWin.segment.startTime / this._videoDuration;
        clipWin.unplace(); clipWin.el.classList.add('review-mode');
        this._timeline.placeClip(clipWin, correctFraction);
        clipWin.el.classList.remove('placed'); clipWin.el.classList.add('review-mode');
      });
      this._timeline.showResults(this._lastResults.clipResults);
    }

    /* ── Save / restore ─────────────────────────────────────────────────── */
    getState() {
      if (this._phase === 'setup' || !this._segments.length) {
        // Nothing meaningful in progress yet, but keep the slot pointing at the video
        return { v: 1, media_id: this._mediaId, difficulty: this._difficulty, phase: 'setup', elapsedMs: 0, progress: 0 };
      }
      const placed = this._timeline
        ? this._timeline.getPlacedOrder().map(o => ({ segIndex: o.clipWindow.segment.index, fraction: o.fraction }))
        : [];
      return {
        v: 1,
        media_id: this._mediaId,
        difficulty: this._difficulty,
        videoDuration: this._videoDuration,
        segments: this._segments,
        displayOrder: this._clipWindows.map(w => w.segment.index),
        placements: placed,
        // Rough progress for the save card: fraction of clips placed
        progress: this._segments.length ? Math.min(1, placed.length / this._segments.length) : 0,
        elapsedMs: Math.round(this._timer.elapsedMs()),
        phase: this._phase,
      };
    }

    async _applyState(s) {
      this._difficulty = s.difficulty || TL.Config.defaultDifficulty;
      this._videoDuration = s.videoDuration || this._media?.duration_seconds || 0;
      this._segments = s.segments;
      // Reorder segments by saved displayOrder so clip numbering restores
      const byIndex = new Map(this._segments.map(seg => [seg.index, seg]));
      const ordered = (s.displayOrder || this._segments.map(x => x.index))
        .map(i => byIndex.get(i)).filter(Boolean);

      this._timer.setElapsedMs(s.elapsedMs || 0);
      await this._ensureSource();
      await this._buildGameUI(this._videoDuration, ordered);

      // Replay placements
      const winBySeg = new Map(this._clipWindows.map(w => [w.segment.index, w]));
      for (const p of (s.placements || [])) {
        const w = winBySeg.get(p.segIndex);
        if (w) this._timeline.placeClip(w, p.fraction);
      }
      this._updatePlacedCount();

      this._phase = s.phase === 'review' ? 'review' : 'playing';
      if (this._phase === 'review') {
        // Recompute results from the restored placements and lock the board
        this._scorer.stop();
        this._lastResults = this._scorer.calculate(this._timeline.getPlacedOrder(), this._segments, this._videoDuration);
        this._enterReviewMode();
      }
    }

    /* ── Host lifecycle ─────────────────────────────────────────────────── */
    pause() {
      this._timer.pause();
      if (this._audioManager?.focused) this._audioManager.focused.player.pause();
    }
    resume() {
      if (this._phase === 'review') return;             // review board is static
      if (this._timer && this._segments.length) this._timer.resume();
      if (this._playing && this._audioManager?.focused) this._audioManager.focused.player.play();
    }
    destroy() {
      try { this._timer.stop(); } catch {}
      if (this._tileRAF) { cancelAnimationFrame(this._tileRAF); this._tileRAF = 0; }
      this._hideLoading();
      if (this._dragManager) { this._dragManager.destroy(); this._dragManager = null; }
      this._clipWindows.forEach(w => { try { w.destroy(); } catch {} });
      this._clipWindows = [];
      if (this._timeline) { try { this._timeline.destroy(); } catch {} this._timeline = null; }
      if (this._blobUrl) { try { URL.revokeObjectURL(this._blobUrl); } catch {} this._blobUrl = null; }
      if (this._container) this._container.innerHTML = '';
    }
  }

  window.gamesRegister('reelorder', {
    label: 'Reel Order',
    icon: '🎬',
    desc: 'Split a video into clips, then drag them into the correct timeline order.',
    acceptTypes: ['video'],
    factory: () => new ReelOrderGame(),
  });
})();
