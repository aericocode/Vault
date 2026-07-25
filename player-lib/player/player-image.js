// =========================================================================
// PLAYER IMAGE - Image and GIF player rendering and controls
// =========================================================================

function renderImagePlayer(content, controlsContainer, fileUrl, filepath, hasPrev, hasNext) {
  content.innerHTML = `
    <img id="mediaImage" src="${fileUrl}" onerror="handleMediaError('${filepath.replace(/'/g, "\\'")}')">
  `;
  
  // Left controls: Zoom
  const leftControls = `
    <button onclick="zoomImage(-0.25)" class="control-btn" title="Zoom Out (-)">➖</button>
    <span class="zoom-display" id="zoomDisplay">100%</span>
    <button onclick="zoomImage(0.25)" class="control-btn" title="Zoom In (+)">➕</button>
  `;
  
  // Right controls: Rotate, Reset, Fullscreen
  const rightControls = `
    <button onclick="rotateImage(-90)" class="control-btn" title="Rotate Left">↺</button>
    <button onclick="rotateImage(90)" class="control-btn" title="Rotate Right (R)">↻</button>
    <button onclick="resetImage()" class="control-btn" title="Reset (0)">Reset</button>
    ${renderFillButton()}
    <button onclick="toggleFullscreen()" class="control-btn" title="Fullscreen (F)">⛶</button>
  `;
  
  controlsContainer.innerHTML = `
    <div class="player-controls-wrapper image-controls">
      ${generateUnifiedControlBar(leftControls, rightControls, hasPrev, hasNext)}
    </div>
  `;
  
  const img = document.getElementById('mediaImage');
  currentMediaState.element = img;
  
  img.addEventListener('mousedown', startPan);
  img.addEventListener('wheel', handleImageWheel);
}

function renderGifPlayer(content, controlsContainer, fileUrl, filepath, hasPrev, hasNext) {
  content.innerHTML = `
    <img id="mediaGif" src="${fileUrl}" onerror="handleMediaError('${filepath.replace(/'/g, "\\'")}')">
  `;
  
  // Left controls: Zoom
  const leftControls = `
    <button onclick="zoomImage(-0.25)" class="control-btn" title="Zoom Out (-)">➖</button>
    <span class="zoom-display" id="zoomDisplay">100%</span>
    <button onclick="zoomImage(0.25)" class="control-btn" title="Zoom In (+)">➕</button>
  `;
  
  // Right controls: Rotate, Reset, Fullscreen
  const rightControls = `
    <button onclick="rotateImage(-90)" class="control-btn" title="Rotate Left">↺</button>
    <button onclick="rotateImage(90)" class="control-btn" title="Rotate Right (R)">↻</button>
    <button onclick="resetImage()" class="control-btn" title="Reset (0)">Reset</button>
    ${renderFillButton()}
    <button onclick="toggleFullscreen()" class="control-btn" title="Fullscreen (F)">⛶</button>
  `;
  
  controlsContainer.innerHTML = `
    <div class="player-controls-wrapper image-controls">
      ${generateUnifiedControlBar(leftControls, rightControls, hasPrev, hasNext)}
    </div>
  `;
  
  const img = document.getElementById('mediaGif');
  currentMediaState.element = img;
  
  img.addEventListener('wheel', handleImageWheel);
}

// Image control functions
function zoomImage(delta) {
  currentMediaState.zoom = Math.max(0.25, Math.min(5, currentMediaState.zoom + delta));
  updateImageTransform();
  showMediaControls();
}

function rotateImage(degrees) {
  currentMediaState.rotation = (currentMediaState.rotation + degrees) % 360;
  updateImageTransform();
  showMediaControls();
}

function resetImage() {
  currentMediaState.zoom = 1;
  currentMediaState.rotation = 0;
  currentMediaState.panX = 0;
  currentMediaState.panY = 0;
  updateImageTransform();
  showMediaControls();
}

function updateImageTransform() {
  const el = currentMediaState.element;
  if (!el) return;
  
  el.style.transform = `translate(${currentMediaState.panX}px, ${currentMediaState.panY}px) scale(${currentMediaState.zoom}) rotate(${currentMediaState.rotation}deg)`;
  
  const zoomDisplay = document.getElementById('zoomDisplay');
  if (zoomDisplay) {
    zoomDisplay.textContent = Math.round(currentMediaState.zoom * 100) + '%';
  }
  
  if (currentMediaState.zoom > 1) {
    el.classList.add('zoomed');
  } else {
    el.classList.remove('zoomed');
  }
}

function handleImageWheel(event) {
  event.preventDefault();
  const delta = event.deltaY > 0 ? -0.1 : 0.1;
  zoomImage(delta);
}

function startPan(event) {
  if (currentMediaState.zoom <= 1) return;
  
  currentMediaState.isPanning = true;
  currentMediaState.startX = event.clientX - currentMediaState.panX;
  currentMediaState.startY = event.clientY - currentMediaState.panY;
  
  document.addEventListener('mousemove', doPan);
  document.addEventListener('mouseup', endPan);
}

function doPan(event) {
  if (!currentMediaState.isPanning) return;
  
  currentMediaState.panX = event.clientX - currentMediaState.startX;
  currentMediaState.panY = event.clientY - currentMediaState.startY;
  updateImageTransform();
}

function endPan() {
  currentMediaState.isPanning = false;
  document.removeEventListener('mousemove', doPan);
  document.removeEventListener('mouseup', endPan);
}
