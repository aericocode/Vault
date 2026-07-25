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
    <audio id="mediaAudio" src="${fileUrl}" onerror="handleMediaError('${filepath.replace(/'/g, "\\'")}')">
      Your browser doesn't support audio playback.
    </audio>
  `;
  
  const initialVolume = savedVolume > 1 ? 1 : savedVolume;
  
  // Left controls: Volume
  const leftControls = `
    <div class="volume-control">
      <button onclick="toggleAudioMute()" id="muteBtn" class="control-btn" title="Mute (M)">🔊</button>
      <input type="range" class="volume-slider" id="volumeSlider" min="0" max="1" step="0.05" value="${initialVolume}" oninput="setAudioVolume(this.value)">
      <span class="volume-display" id="volumeDisplay">${Math.round(initialVolume * 100)}%</span>
    </div>
  `;
  
  // Right controls: Fill (speed moved to the playback row; keeps the center
  // Prev/Random/Info/Next in the same spot as video/image)
  const rightControls = `
    ${renderFillButton()}
  `;

  const speedControls = `
    <div class="speed-control">
      <button onclick="cycleSpeed(-1)" class="control-btn speed-btn" title="Slower (<)">−</button>
      <span class="speed-display" id="speedDisplay">1x</span>
      <button onclick="cycleSpeed(1)" class="control-btn speed-btn" title="Faster (>)">+</button>
    </div>
  `;
  
  controlsContainer.innerHTML = `
    <div class="player-controls-wrapper audio-controls">
      <div class="video-progress-wrapper" id="audioProgressWrapper">
        <div class="video-progress" id="audioProgress" onclick="seekAudio(event)">
          <div class="video-progress-bar" id="audioProgressBar" style="width: 0%"></div>
        </div>
      </div>
      <div class="video-playback-row">
        <span class="video-time">
          <span id="currentTime">0:00</span>
          <span class="time-separator">/</span>
          <span id="totalTime">0:00</span>
        </span>
        <div class="playback-controls">
          <button onclick="skipAudio(-10)" class="control-btn" title="-10s (J)">
            <span>⏪</span><span class="seek-label">10</span>
          </button>
          <button onclick="skipAudio(-5)" class="control-btn" title="-5s (←)">
            <span>◀</span><span class="seek-label">5</span>
          </button>
          <button onclick="toggleAudioPlay()" id="playPauseBtn" class="play-pause-btn" title="Play/Pause (Space)">▶</button>
          <button onclick="skipAudio(5)" class="control-btn" title="+5s (→)">
            <span class="seek-label">5</span><span>▶</span>
          </button>
          <button onclick="skipAudio(10)" class="control-btn" title="+10s (L)">
            <span class="seek-label">10</span><span>⏩</span>
          </button>
        </div>
      </div>
      <div class="video-extras-row">
        <div class="pr-side pr-left">
          ${typeof renderAbLoopButton === 'function' ? renderAbLoopButton() : ''}
        </div>
        <div class="pr-center">
          ${typeof renderLoopButton === 'function' ? renderLoopButton() : ''}
          ${speedControls}
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

  // Loop preference (A-B loop takes over while active)
  audio.loop = typeof isLoopEnabled === 'function' ? isLoopEnabled() : true;

  audio.volume = sliderToVolume(initialVolume, 1);
  
  audio.addEventListener('loadedmetadata', () => {
    const el = document.getElementById('totalTime');
    if (el) el.textContent = formatDuration(audio.duration);
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
      currentTimeEl.textContent = formatDuration(audio.currentTime);
    }
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

  audio.play().catch(() => {});
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
  const actualVolume = sliderToVolume(value, 1);
  
  audio.volume = actualVolume;
  savedVolume = value; // save slider position
  
  const muteBtn = document.getElementById('muteBtn');
  if (muteBtn) {
    muteBtn.textContent = value === 0 ? '🔇' : value < 0.5 ? '🔉' : '🔊';
  }
  
  const display = document.getElementById('volumeDisplay');
  if (display) {
    display.textContent = Math.round(value * 100) + '%';
  }
}

function toggleAudioMute() {
  const audio = document.getElementById('mediaAudio');
  const slider = document.getElementById('volumeSlider');
  if (!audio) return;
  
  if (audio.volume > 0) {
    currentMediaState.previousVolume = savedVolume; // save slider position
    setAudioVolume(0);
    if (slider) slider.value = 0;
  } else {
    const vol = currentMediaState.previousVolume || 1;
    setAudioVolume(vol);
    if (slider) slider.value = vol;
  }
}
