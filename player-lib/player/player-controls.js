// =========================================================================
// PLAYER CONTROLS - Keyboard shortcuts for media player
// =========================================================================

/**
 * Number keys jump through the file like mpv: 0 = start, 1 = 10%, ... 9 = 90%.
 * Null while the duration is unknown (NaN before metadata, Infinity on a live
 * stream), since assigning either to currentTime throws or goes nowhere.
 */
function percentKeyTime(duration, digit) {
  if (!isFinite(duration) || duration <= 0) return null;
  const d = Number(digit);
  if (!Number.isInteger(d) || d < 0 || d > 9) return null;
  return duration * d / 10;
}

/**
 * Seek the playing video, mix or audio to a number key's percentage. Shared
 * with the mini player keys (app.js): the element is the same one either way,
 * it just moves. Same path as the seek bar: write currentTime, re-sync a mix's
 * followers, pop the controls.
 */
function seekToPercentKey(digit) {
  const type = currentMediaState.type;
  if (!isVideoLike(type) && type !== 'audio') return;
  const el = currentMediaState.element;
  const t = el ? percentKeyTime(el.duration, digit) : null;
  if (t === null) return;
  el.currentTime = t;
  if (type === 'mix' && typeof mixPlayerResync === 'function') mixPlayerResync();
  showMediaControls();
}

document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('mediaPlayerOverlay');
  if (!overlay.classList.contains('active')) return;
  // A password, lock or import dialog over the player has the keyboard.
  if (typeof vaultModalOpen === 'function' && vaultModalOpen()) return;

  // Alt+Arrow for sidebar navigation (works even in textarea)
  if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    e.preventDefault();
    if (e.key === 'ArrowRight') {
      playNextMedia();
    } else {
      playPreviousMedia();
    }
    return;
  }
  
  // Escape inside the sidebar has to work even though focus sits in a field —
  // the sidebar autofocuses its note textarea, so the input early-return below
  // would otherwise swallow the key and leave no keyboard way back out.
  // Empty field: step straight out of the sidebar. Half-typed note: just blur,
  // so a second Escape closes the sidebar without the first one losing text.
  if (e.key === 'Escape' && e.target.closest && e.target.closest('#mediaSidebar')) {
    e.preventDefault();
    const empty = !String(e.target.value || '').trim();
    e.target.blur();
    if (empty) toggleSidebar();
    return;
  }

  // Don't capture keys when focused on inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  // Ctrl / Cmd with a letter or symbol is the browser's: Ctrl+R reloads
  // rather than picking a random file, Ctrl+= zooms the page, not the picture
  // (shortcuts.js). Space, the arrows and Esc keep working.
  if (typeof isBrowserChord === 'function' && isBrowserChord(e)) return;

  const mediaType = currentMediaState.type;
  
  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (mediaType === 'video') {
        togglePlay();
      } else if (mediaType === 'audio') {
        toggleAudioPlay();
      }
      break;
      
    case 'ArrowLeft':
      e.preventDefault();
      if (mediaType === 'video') {
        skipVideo(-5);
      } else if (mediaType === 'audio') {
        skipAudio(-5);
      }
      break;
      
    case 'ArrowRight':
      e.preventDefault();
      if (mediaType === 'video') {
        skipVideo(5);
      } else if (mediaType === 'audio') {
        skipAudio(5);
      }
      break;
      
    case 'j':
    case 'J':
      if (mediaType === 'video') {
        skipVideo(-10);
      } else if (mediaType === 'audio') {
        skipAudio(-10);
      }
      break;
      
    case 'l':
    case 'L':
      if (mediaType === 'video') {
        skipVideo(10);
      } else if (mediaType === 'audio') {
        skipAudio(10);
      }
      break;
      
    case 'm':
    case 'M':
      if (mediaType === 'video') {
        toggleMute();
      } else if (mediaType === 'audio') {
        toggleAudioMute();
      }
      break;
      
    case 'ArrowUp':
      e.preventDefault();
      if (mediaType === 'video' || mediaType === 'audio') {
        const slider = document.getElementById('volumeSlider');
        if (slider) {
          const newVal = Math.min(parseFloat(slider.max), parseFloat(slider.value) + 0.1);
          slider.value = newVal;
          if (mediaType === 'video') {
            setVolume(newVal);
          } else {
            setAudioVolume(newVal);
          }
        }
      } else if (mediaType === 'image' || mediaType === 'gif') {
        zoomImage(0.25);
      }
      break;
      
    case 'ArrowDown':
      e.preventDefault();
      if (mediaType === 'video' || mediaType === 'audio') {
        const slider = document.getElementById('volumeSlider');
        if (slider) {
          const newVal = Math.max(0, parseFloat(slider.value) - 0.1);
          slider.value = newVal;
          if (mediaType === 'video') {
            setVolume(newVal);
          } else {
            setAudioVolume(newVal);
          }
        }
      } else if (mediaType === 'image' || mediaType === 'gif') {
        zoomImage(-0.25);
      }
      break;
      
    case 'f':
    case 'F':
      e.preventDefault();
      toggleFullscreen();
      break;
      
    case 'Escape':
      // Peel one layer at a time: fullscreen, then the sidebar, then the player.
      // Modern: a loop waiting for its B point is the first thing Esc drops.
      if (typeof ModernDock !== 'undefined' && ModernDock.mounted() && abLoopA !== null && abLoopB === null) {
        clearAbLoop();   // the A marker going away says it
      } else if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (typeof sidebarOpen !== 'undefined' && sidebarOpen) {
        toggleSidebar();
      } else {
        closeMediaInfo();
        closeMediaPlayer();
      }
      break;
      
    case 'q':
    case 'Q':
      if (currentMediaState.type === 'video' || currentMediaState.type === 'audio') {
        minimizePlayer();
        // app.js's mini player keys run next on this same key press, and with
        // the mini player now showing, its Q would bring the full player
        // straight back.
        e.stopImmediatePropagation();
      }
      break;
      
    case 'i':
    case 'I':
      showMediaInfo();
      break;
      
    case 'n':
    case 'N':
      playNextMedia();
      break;
      
    case 'p':
    case 'P':
      playPreviousMedia();
      break;
      
    case 'r':
    case 'R':
      if (mediaType === 'image' || mediaType === 'gif') {
        rotateImage(90);
      } else {
        playRandomMedia();
      }
      break;

    case '0':
      if (mediaType === 'image' || mediaType === 'gif') {
        resetImage();
        break;
      }
      // falls through: 0 seeks to the start of a video, mix or audio
    case '1': case '2': case '3': case '4': case '5':
    case '6': case '7': case '8': case '9':
      // Leave Ctrl+0 (browser zoom reset), Alt+digit and friends alone
      if (e.ctrlKey || e.altKey || e.metaKey) break;
      seekToPercentKey(e.key);
      break;
      
    case '+':
    case '=':
      if (mediaType === 'image' || mediaType === 'gif') {
        zoomImage(0.25);
      } else if (mediaType === 'document') {
        adjustDocFontSize(2);
      }
      break;
      
    case '-':
    case '_':
      if (mediaType === 'image' || mediaType === 'gif') {
        zoomImage(-0.25);
      } else if (mediaType === 'document') {
        adjustDocFontSize(-2);
      }
      break;

    // AB Loop controls
    case '[':
      if (mediaType === 'video' || mediaType === 'audio') {
        if (abLoopA === null) {
          toggleAbLoop(); // set A
        }
      }
      break;

    case ']':
      if (mediaType === 'video' || mediaType === 'audio') {
        if (abLoopA !== null && abLoopB === null) {
          toggleAbLoop(); // set B
        }
      }
      break;

    case '\\':
      if (mediaType === 'video' || mediaType === 'audio') {
        clearAbLoop();
      }
      break;

    // Playback speed controls
    case '<':
    case ',':
      if (mediaType === 'video' || mediaType === 'audio') {
        cycleSpeed(-1);
      }
      break;

    case '>':
    case '.':
      if (mediaType === 'video' || mediaType === 'audio') {
        cycleSpeed(1);
      }
      break;
  }
});
