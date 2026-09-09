/* =========================================================================
   PLAYER MIX - Custom mixes (media_type 'mix') inside the MAIN player.

   A mix tile plays like a single video: the saved config (sources, layout,
   effects, opacities, volumes, master, sync offsets) renders as a synced
   stack/grid stage, and the standard video control bar drives the MASTER
   track (currentMediaState.element), so seek, A-B loop, speed, volume,
   loop/next/prev/random/done all work natively. Followers ride a drift-
   corrected sync loop (same approach as the Editor).

   Fine-tuning (layers, effects, nudges, save/update) lives in the Editor —
   the sidebar's "🎛 Open in Editor" button jumps there.
   ========================================================================= */

let _mixPlayer = null; // { timer, videos }

function stopMixPlayer() {
  if (!_mixPlayer) return;
  clearInterval(_mixPlayer.timer);
  for (const v of _mixPlayer.videos) {
    try { stopMediaElement(v); } catch {}
  }
  _mixPlayer = null;
}

async function renderMixPlayer(content, controlsContainer, filepath, filename, hasPrev, hasNext) {
  stopMixPlayer();
  const row = allMedia.find(m => m.filepath === filepath);
  content.innerHTML = '<div class="unsupported-media"><div class="unsupported-icon">🎛</div><div class="unsupported-text">Loading mix…</div></div>';
  controlsContainer.innerHTML = '';

  let mix = null;
  if (row) {
    try { mix = await fetch(`/api/music/mixes/${row.id}`).then(r => r.json()); } catch {}
  }
  const ids = (mix?.media_ids || []).filter(id => getMediaById(id));

  // The user may have navigated away while the config loaded
  if (currentMediaState.currentMediaData?.filepath !== filepath) return;

  if (!mix || mix.error || ids.length < 2) {
    content.innerHTML = `
      <div class="unsupported-media">
        <div class="unsupported-icon">🎛</div>
        <div class="unsupported-text">${!mix || mix.error ? 'Mix config missing' : 'Source videos are no longer in the library'}</div>
        <div class="unsupported-filename">${escapeHtml(filename)}</div>
      </div>`;
    controlsContainer.innerHTML = generateUnifiedControlBar('', '', hasPrev, hasNext);
    return;
  }

  const cfg = mix.config || {};
  const layout = cfg.l === 'grid' ? 'grid' : 'stack';
  const cols = Math.max(1, Math.min(4, cfg.c || 2));
  const tcfg = Array.isArray(cfg.t) ? cfg.t : [];
  const masterIdx = (typeof cfg.m === 'number' && cfg.m >= 0 && cfg.m < ids.length) ? cfg.m : 0;
  const starts = ids.map((_, i) => tcfg[i]?.s ?? 0);
  const durations = ids.map(id => getMediaById(id)?.duration_seconds || 0);

  /* ── Stage (reuses the Editor's stack/grid CSS) ─────────────────────── */
  content.innerHTML = `
    <div class="editor-stage mix-player-stage" data-layout="${layout}" style="--cols:${cols};">
      ${ids.map((id, i) => `
        <div class="editor-tile" data-idx="${i}">
          <video data-idx="${i}" ${i === masterIdx ? 'id="mediaVideo"' : ''} muted playsinline preload="auto" loop src="/media/${id}"></video>
        </div>`).join('')}
    </div>`;

  const stage = content.querySelector('.mix-player-stage');
  const videos = [...stage.querySelectorAll('video')];
  const master = videos[masterIdx];
  currentMediaState.element = master;

  // Per-layer opacity/effects/volume from the saved config (legacy configs
  // kept opacity inside uniform/blend effects — editorApplyEffectToTile is
  // the Editor's applier, shared here)
  videos.forEach((v, i) => {
    const t = tcfg[i] || {};
    const vol = Math.max(0, Math.min(1, t.v ?? (i === masterIdx ? 1 : 0)));
    if (i !== masterIdx) { v.volume = vol; v.muted = vol <= 0; }
    const opacity = typeof t.o === 'number' ? t.o
      : (typeof t.e?.opacity === 'number' ? t.e.opacity : 1);
    const tile = stage.querySelector(`.editor-tile[data-idx="${i}"]`);
    if (typeof editorApplyEffectToTile === 'function') {
      editorApplyEffectToTile(tile, t.e || { type: 'uniform' }, opacity);
    }
  });

  /* ── Standard video control bar (drives the master) ───────────────────── */
  const leftControls = `
    <div class="volume-control">
      <button onclick="toggleMute()" id="muteBtn" class="control-btn" title="Mute (M)">🔊</button>
      <input type="range" class="volume-slider" id="volumeSlider" min="0" max="1.5" step="0.01" value="${playerIsSilent() ? 0 : savedVolume}" oninput="setVolume(this.value)">
      <span class="volume-display" id="volumeDisplay">${Math.round((playerIsSilent() ? 0 : savedVolume) * 100)}%</span>
    </div>
  `;
  const rightControls = `
    ${renderFillButton()}
    <button onclick="toggleFullscreen()" class="control-btn" title="Fullscreen (F)">⛶</button>
  `;
  const speedControls = renderSpeedControls();

  controlsContainer.innerHTML = `
    <div class="player-controls-wrapper video-controls">
      <div class="video-progress-row">
        ${renderProgressTimes('start')}
        <div class="video-progress-wrapper" id="videoProgressWrapper">
          <div class="video-progress" id="videoProgress" onclick="seekVideo(event); mixPlayerResync();">
            <div class="video-progress-bar" id="videoProgressBar" style="width: 0%"></div>
          </div>
        </div>
        ${renderProgressTimes('end')}
      </div>
      <div class="video-playback-row">
        <div class="playback-controls">
          ${renderSkipButton(-10, 'skipVideo(-10); mixPlayerResync();', '-10s (J)')}
          ${renderSkipButton(-5, 'skipVideo(-5); mixPlayerResync();', '-5s (←)')}
          <button onclick="togglePlay()" id="playPauseBtn" class="play-pause-btn" title="Play/Pause (Space)">▶</button>
          ${renderSkipButton(5, 'skipVideo(5); mixPlayerResync();', '+5s (→)')}
          ${renderSkipButton(10, 'skipVideo(10); mixPlayerResync();', '+10s (L)')}
        </div>
      </div>
      <div class="video-extras-row">
        <div class="pr-side pr-left">
          ${typeof renderAbLoopButton === 'function' ? renderAbLoopButton() : ''}
        </div>
        <div class="pr-center">
          ${speedControls}
          ${typeof renderRepeatButton === 'function' ? renderRepeatButton() : ''}
        </div>
        <div class="pr-side pr-right">
          ${typeof renderHotButton === 'function' ? renderHotButton() : ''}
          ${typeof renderDoneButton === 'function' ? renderDoneButton() : ''}
        </div>
      </div>
      ${generateUnifiedControlBar(leftControls, rightControls, hasPrev, hasNext)}
    </div>
  `;

  // Repeat preference on the master; followers always loop natively (the sync
  // loop re-aligns them across their own wraps)
  master.loop = typeof isRepeatOne === 'function' ? isRepeatOne() : false;

  // Volume boost + saved volume, exactly like the video player
  setupAudioBoost(master);
  const max = currentMediaState.gainNode ? 1.5 : 1;
  applyVolume(sliderToVolume(savedVolume, max));   // also carries the mute flag over
  updateVolumeDisplay(playerIsSilent() ? 0 : savedVolume, max);
  const volumeSlider = document.getElementById('volumeSlider');
  if (volumeSlider) volumeSlider.max = max;

  // Session playback speed (the followers pick it up from the sync timer)
  if (typeof applySpeedTo === 'function') {
    applySpeedTo(master);
    if (typeof updateSpeedDisplay === 'function') updateSpeedDisplay();
  }

  /* ── Master listeners (progress/time/AB — same as the video player) ──── */
  master.addEventListener('loadedmetadata', () => {
    if (typeof updateTotalTimeLabel === 'function') updateTotalTimeLabel();
    if (master.currentTime < starts[masterIdx]) master.currentTime = starts[masterIdx];
    syncAll();
    if (typeof updateAbLoopOverlay === 'function') updateAbLoopOverlay();
  }, { once: true });

  master.addEventListener('timeupdate', () => {
    const bar = document.getElementById('videoProgressBar');
    const cur = document.getElementById('currentTime');
    if (bar && master.duration) bar.style.width = `${(master.currentTime / master.duration) * 100}%`;
    if (cur) cur.textContent = formatDuration(master.currentTime) || '0:00';
    if (typeof updateTotalTimeLabel === 'function') updateTotalTimeLabel();
    if (typeof checkAbLoop === 'function') checkAbLoop(master);
  });

  master.addEventListener('play', () => {
    const btn = document.getElementById('playPauseBtn');
    if (btn) btn.textContent = '⏸';
    videos.forEach((v, i) => {
      // blank tiles stay paused — syncTrack resumes them when back in range
      if (i !== masterIdx && !v.closest('.editor-tile')?.classList.contains('mix-tile-blank')) {
        v.play().catch(() => {});
      }
    });
  });
  master.addEventListener('pause', () => {
    const btn = document.getElementById('playPauseBtn');
    if (btn) btn.textContent = '▶';
    videos.forEach((v, i) => { if (i !== masterIdx) v.pause(); });
  });
  master.addEventListener('ended', () => {
    const btn = document.getElementById('playPauseBtn');
    if (btn) btn.textContent = '▶';
    if (typeof autoAdvanceOnEnded === 'function') autoAdvanceOnEnded();
  });
  // Bound to the STAGE, not the master. Only the master carries id="mediaVideo",
  // so with the handlers on it alone a click was play/pause on whichever mix
  // happened to put the master under the pointer, and "close the player" on
  // every other one — the same gesture doing two different things depending on
  // the layout. Clicks bubble from any layer to here, and handleVideoClick
  // stops propagation, so the gutter outside the stage still minimizes.
  stage.addEventListener('click', handleVideoClick);
  stage.addEventListener('dblclick', handleVideoDoubleClick);

  /* ── Follower sync engine (drift correction + range blanking + self-heal) ──
     Range mode comes from the saved config (`b`, default blank): blank mode
     hides a follower outside its own content instead of the old modulo-wrap
     (which replayed random slices ~2x/sec wherever offsets didn't overlap);
     loop mode (b:0) keeps the legacy wrap-forever behavior. */
  const blankOutOfRange = cfg.b === undefined ? true : (cfg.b !== 0 && cfg.b !== false);
  const RANGE_BUF = 0.3;   // edge buffer: alignment jitter must not clip song starts/ends
  const songToVideo = (i, T) => starts[i] + T;
  const masterT = () => Math.max(0, master.currentTime - starts[masterIdx]);
  videos.forEach((v, i) => { if (i !== masterIdx) v.loop = !blankOutOfRange; });

  videos.forEach((v, i) => {
    if (i !== masterIdx) {
      // Engines self-pause occluded muted videos — keep followers rolling.
      // Blank tiles are intentionally paused — never fight that.
      v.addEventListener('pause', () => {
        if (master.paused) return;
        setTimeout(() => {
          if (_mixPlayer && !master.paused && v.paused && v.src
              && !v.closest('.editor-tile')?.classList.contains('mix-tile-blank')) {
            v.play().catch(() => {});
          }
        }, 0);
      });
    }
  });

  function syncTrack(v, i, T, threshold) {
    if (i === masterIdx) return;
    const dur = durations[i] || v.duration || 0;
    const target = songToVideo(i, T);
    const tile = v.closest('.editor-tile');

    if (!blankOutOfRange) {
      // legacy: wrap through the file's own content forever
      tile?.classList.remove('mix-tile-blank');
      const wrapped = dur > 0 ? ((target % dur) + dur) % dur : target;
      const nearWrap = wrapped < 0.5 || (dur > 0 && wrapped > dur - 0.5);
      if (Math.abs(v.currentTime - wrapped) > (nearWrap ? Math.max(0.5, threshold) : threshold)) v.currentTime = wrapped;
      if (v.paused && !master.paused) v.play().catch(() => {});
      return;
    }

    const inRange = target >= -RANGE_BUF && (dur <= 0 || target < dur + RANGE_BUF);
    tile?.classList.toggle('mix-tile-blank', !inRange);
    if (!inRange) {
      if (!v.paused) v.pause();
      const park = target < 0 ? 0 : Math.max(0, dur - 0.05);
      if (Math.abs(v.currentTime - park) > 0.5) v.currentTime = park;
      return;
    }
    // Buffer zone: hold the frozen boundary frame; play only on real content
    const clamped = Math.max(0, dur > 0 ? Math.min(target, dur - 0.05) : target);
    if (Math.abs(v.currentTime - clamped) > threshold) v.currentTime = clamped;
    const playable = target >= 0 && (dur <= 0 || target < dur);
    if (playable) {
      if (v.paused && !master.paused) v.play().catch(() => {});
    } else if (!v.paused) {
      v.pause();
    }
  }

  function syncAll() {
    const T = masterT();
    videos.forEach((v, i) => syncTrack(v, i, T, 0.25));
  }
  window.mixPlayerResync = () => { if (_mixPlayer) syncAll(); };

  const timer = setInterval(() => {
    // Content replaced (next media / player closed) → stop the streams
    if (!master.isConnected) { stopMixPlayer(); return; }
    if (master.paused) return;
    const T = masterT();
    videos.forEach((v, i) => {
      if (i === masterIdx) return;
      // Speed control covers all tracks. defaultPlaybackRate too: a follower
      // that reloads its source would otherwise drop back to 1x and fight the
      // drift correction until the next tick.
      v.defaultPlaybackRate = master.playbackRate;
      v.playbackRate = master.playbackRate;
      syncTrack(v, i, T, 0.18);
    });
  }, 400);

  _mixPlayer = { timer, videos };

  master.play().catch(() => {});
}

/** Sidebar action: hand this mix to the Editor for tweaking. */
function openMixInEditor(mediaId) {
  if (typeof closeMediaPlayer === 'function') closeMediaPlayer();
  if (typeof editorPlayLibraryMix === 'function') editorPlayLibraryMix(mediaId);
}
