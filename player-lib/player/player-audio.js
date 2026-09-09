// =========================================================================
// PLAYER AUDIO - Audio player rendering and controls
// =========================================================================

function renderAudioPlayer(content, controlsContainer, fileUrl, filepath, filename, hasPrev, hasNext) {
  content.innerHTML = `
    <div class="audio-visualization" id="audioVisualization">
      <div class="audio-icon">🎵</div>
      <div class="audio-filename">${escapeHtml(filename)}</div>
      <canvas id="audioCanvas" width="400" height="100"></canvas>
    </div>
    <audio id="mediaAudio" onerror="handleMediaError('${filepath.replace(/'/g, "\\'")}')">
      Your browser doesn't support audio playback.
    </audio>
  `;
  
  const initialVolume = savedVolume > 1 ? 1 : savedVolume;
  
  // Left controls: Volume
  const leftControls = `
    <div class="volume-control">
      <button onclick="toggleAudioMute()" id="muteBtn" class="control-btn" title="Mute (M)">🔊</button>
      <input type="range" class="volume-slider" id="volumeSlider" min="0" max="1" step="0.05" value="${playerIsSilent() ? 0 : initialVolume}" oninput="setAudioVolume(this.value)">
      <span class="volume-display" id="volumeDisplay">${Math.round((playerIsSilent() ? 0 : initialVolume) * 100)}%</span>
    </div>
  `;
  
  // Right controls: Fill (speed moved to the playback row; keeps the center
  // Prev/Random/Info/Next in the same spot as video/image)
  const rightControls = `
    ${renderFillButton()}
  `;

  const speedControls = renderSpeedControls();

  controlsContainer.innerHTML = `
    <div class="player-controls-wrapper audio-controls">
      <div class="video-progress-row">
        ${renderProgressTimes('start')}
        <div class="video-progress-wrapper" id="audioProgressWrapper">
          <div class="video-progress" id="audioProgress">
            <div class="video-progress-bar" id="audioProgressBar" style="width: 0%"></div>
          </div>
        </div>
        ${renderProgressTimes('end')}
      </div>
      <div class="video-playback-row">
        <div class="playback-controls">
          ${renderSkipButton(-10, 'skipAudio(-10)', '-10s (J)')}
          ${renderSkipButton(-5, 'skipAudio(-5)', '-5s (←)')}
          <button onclick="toggleAudioPlay()" id="playPauseBtn" class="play-pause-btn" title="Play/Pause (Space)">▶</button>
          ${renderSkipButton(5, 'skipAudio(5)', '+5s (→)')}
          ${renderSkipButton(10, 'skipAudio(10)', '+10s (L)')}
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
  
  const audio = document.getElementById('mediaAudio');
  currentMediaState.element = audio;

  // Repeat preference (A-B loop takes over while active)
  audio.loop = typeof isRepeatOne === 'function' ? isRepeatOne() : false;

  audio.volume = sliderToVolume(initialVolume, 1);
  applySavedMute(audio);   // mute rides across files, same as the level

  // Speed is a session preference and the chrome was just re-rendered as "1x"
  applySpeedTo(audio);
  updateSpeedDisplay();
  if (typeof attachTailWatchdog === 'function') attachTailWatchdog(audio);

  audio.addEventListener('loadedmetadata', () => {
    updateTotalTimeLabel();
    if (typeof updateAbLoopOverlay === 'function') updateAbLoopOverlay();
  });
  
  audio.addEventListener('timeupdate', () => {
    const progressBar = document.getElementById('audioProgressBar');
    const currentTimeEl = document.getElementById('currentTime');
    if (progressBar && audio.duration) {
      const progress = (audio.currentTime / audio.duration) * 100;
      progressBar.style.width = progress + '%';
    }
    if (currentTimeEl) {
      currentTimeEl.textContent = formatDuration(audio.currentTime) || '0:00';
    }
    updateTotalTimeLabel();
    // AB loop check
    if (typeof checkAbLoop === 'function') {
      checkAbLoop(audio);
    }
  });
  
  audio.addEventListener('play', () => {
    const btn = document.getElementById('playPauseBtn');
    if (btn) btn.textContent = '⏸';
  });
  
  audio.addEventListener('pause', () => {
    const btn = document.getElementById('playPauseBtn');
    if (btn) btn.textContent = '▶';
  });
  
  audio.addEventListener('ended', () => {
    const btn = document.getElementById('playPauseBtn');
    if (btn) btn.textContent = '▶';
    if (typeof autoAdvanceOnEnded === 'function') autoAdvanceOnEnded();
  });

  // Pointer scrubbing + hover time on the seek bar (helper lives in
  // player-video.js, which loads before this file)
  if (typeof attachSeekScrubbing === 'function') {
    attachSeekScrubbing(
      document.getElementById('audioProgressWrapper'),
      document.getElementById('audioProgress'),
      () => document.getElementById('mediaAudio')
    );
  }

  // Source comes from the server's playback decision, same as video: audio a
  // browser cannot open (AC-3 inside an MKA, say) is remuxed to AAC in
  // MPEG-TS instead of just failing. See player-stream.js.
  attachPlaybackSource(
    audio,
    currentMediaState.currentMediaData?.id || null,
    filepath,
    fileUrl,
  );
}

// Audio control functions
function toggleAudioPlay() {
  const audio = document.getElementById('mediaAudio');
  if (!audio) return;
  if (audio.paused) {
    audio.play();
    scheduleHideControls();
  } else {
    audio.pause();
    showMediaControls();
  }
}

function skipAudio(seconds) {
  const audio = document.getElementById('mediaAudio');
  if (!audio) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
  showMediaControls();
}

function seekAudio(event) {
  const audio = document.getElementById('mediaAudio');
  const progress = document.getElementById('audioProgress');
  if (!audio || !progress) return;
  
  const rect = progress.getBoundingClientRect();
  const percent = (event.clientX - rect.left) / rect.width;
  audio.currentTime = percent * audio.duration;
}

function setAudioVolume(value) {
  const audio = document.getElementById('mediaAudio');
  if (!audio) return;

  value = parseFloat(value);
  audio.volume = sliderToVolume(value, 1);
  savedVolume = value; // save slider position
  // Reaching for the slider is how you unmute without finding the button.
  if (value > 0) {
    currentMediaState.previousVolume = value;
    savedMuted = false;
  }
  saveVolumePrefs();

  audio.muted = playerIsSilent();
  updateMuteButton();

  const display = document.getElementById('volumeDisplay');
  if (display) {
    display.textContent = Math.round(value * 100) + '%';
  }
}

function toggleAudioMute() {
  const audio = document.getElementById('mediaAudio') || currentMediaState.element;
  if (!audio) return;

  togglePlayerMute();   // owns savedMuted/savedVolume and the store

  audio.volume = sliderToVolume(savedVolume, 1);
  audio.muted = playerIsSilent();
  updateMuteButton();

  // While muted the slider reads zero, which is what the ear is getting.
  const shown = playerIsSilent() ? 0 : savedVolume;
  const slider = document.getElementById('volumeSlider');
  if (slider) slider.value = shown;
  const display = document.getElementById('volumeDisplay');
  if (display) display.textContent = Math.round(shown * 100) + '%';
}
