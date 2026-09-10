// =========================================================================
// PLAYER DOCUMENT - Document viewer rendering and controls
// =========================================================================

/* ── How the reader is set up ─────────────────────────────────────────────
   Text size and word wrap are how this person reads, not facts about one
   file, so they belong to the session the way volume and speed do. They used
   to snap back to 14px and wrapped on every single document. */

const DOC_VIEW_KEY = 'player_doc_view';

let docFontSize = 14;
let docWordWrap = true;

(function loadDocViewPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(DOC_VIEW_KEY) || 'null');
    if (!stored || typeof stored !== 'object') return;
    const size = Number(stored.fontSize);
    if (isFinite(size) && size >= 8 && size <= 32) docFontSize = size;
    if (typeof stored.wordWrap === 'boolean') docWordWrap = stored.wordWrap;
  } catch {}
})();

function saveDocViewPrefs() {
  try {
    localStorage.setItem(DOC_VIEW_KEY,
      JSON.stringify({ fontSize: docFontSize, wordWrap: docWordWrap }));
  } catch {}
}

/**
 * Put the session's reading settings on whatever document is on screen, and
 * on the controls that report them. Called on render and again once the text
 * has actually loaded, which is when the element they apply to exists.
 */
function applyDocViewPrefs() {
  currentMediaState.fontSize = docFontSize;
  currentMediaState.wordWrap = docWordWrap;

  const content = document.querySelector('.document-content');
  if (content) {
    content.style.fontSize = docFontSize + 'px';
    content.style.whiteSpace = docWordWrap ? 'pre-wrap' : 'pre';
  }

  const display = document.getElementById('fontSizeDisplay');
  if (display) display.textContent = docFontSize + 'px';

  const btn = document.getElementById('wordWrapBtn');
  if (btn) {
    btn.classList.toggle('active', docWordWrap);
    btn.setAttribute('aria-pressed', docWordWrap ? 'true' : 'false');
  }
}

function renderDocumentPlayer(content, controlsContainer, fileUrl, filepath, filename, hasPrev, hasNext) {
  const ext = filename.split('.').pop().toLowerCase();
  
  if (ext === 'pdf') {
    content.innerHTML = `
      <iframe id="mediaDocument" class="document-viewer pdf-viewer" src="${fileUrl}" onerror="handleMediaError('${filepath.replace(/'/g, "\\'")}')"></iframe>
    `;
  } else {
    content.innerHTML = `
      <div class="document-viewer text-viewer" id="mediaDocument">
        <div class="document-loading">Loading document...</div>
      </div>
    `;
    loadTextDocument(fileUrl, ext);
  }
  
  // Left controls: Font size
  const leftControls = `
    <button onclick="adjustDocFontSize(-2)" class="control-btn" title="Decrease Font Size (-)">A-</button>
    <span class="font-size-display" id="fontSizeDisplay">${docFontSize}px</span>
    <button onclick="adjustDocFontSize(2)" class="control-btn" title="Increase Font Size (+)">A+</button>
    <button onclick="toggleDocWordWrap()" id="wordWrapBtn" class="control-btn" title="Toggle Word Wrap">↔ Wrap</button>
  `;
  
  // Right controls: Copy, Fullscreen
  const rightControls = `
    <button onclick="copyDocContent()" class="control-btn" title="Copy Content">📋 Copy</button>
    ${renderFillButton()}
    <button onclick="toggleFullscreen()" class="control-btn" title="Fullscreen (F)">⛶</button>
  `;
  
  controlsContainer.innerHTML = `
    <div class="player-controls-wrapper document-controls">
      ${generateUnifiedControlBar(leftControls, rightControls, hasPrev, hasNext)}
    </div>
  `;
  
  currentMediaState.element = document.getElementById('mediaDocument');
  applyDocViewPrefs();
}

async function loadTextDocument(fileUrl, ext) {
  const docEl = document.getElementById('mediaDocument');
  if (!docEl) return;
  
  try {
    const response = await fetch(fileUrl);
    const text = await response.text();
    
    let formattedContent = escapeHtml(text);
    
    if (['js', 'ts', 'json'].includes(ext)) {
      formattedContent = highlightCode(text, ext);
    } else if (['html', 'xml'].includes(ext)) {
      formattedContent = highlightCode(text, 'html');
    } else if (ext === 'md') {
      formattedContent = renderMarkdown(text);
    }
    
    docEl.innerHTML = `<pre class="document-content" id="documentContent">${formattedContent}</pre>`;
    applyDocViewPrefs();
  } catch (err) {
    docEl.innerHTML = `<div class="document-error">Error loading document: ${err.message}</div>`;
  }
}

function highlightCode(code, lang) {
  let escaped = escapeHtml(code);
  
  if (lang === 'json') {
    escaped = escaped
      .replace(/(".*?")\s*:/g, '<span class="code-key">$1</span>:')
      .replace(/:\s*(".*?")/g, ': <span class="code-string">$1</span>')
      .replace(/:\s*(\d+)/g, ': <span class="code-number">$1</span>')
      .replace(/:\s*(true|false|null)/g, ': <span class="code-keyword">$1</span>');
  } else if (['js', 'ts'].includes(lang)) {
    escaped = escaped
      .replace(/\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new)\b/g, '<span class="code-keyword">$1</span>')
      .replace(/(".*?"|'.*?'|`.*?`)/g, '<span class="code-string">$1</span>')
      .replace(/(\/\/.*$)/gm, '<span class="code-comment">$1</span>')
      .replace(/\b(\d+)\b/g, '<span class="code-number">$1</span>');
  } else if (lang === 'html') {
    escaped = escaped
      .replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="code-tag">$2</span>')
      .replace(/([\w-]+)=(".*?")/g, '<span class="code-attr">$1</span>=<span class="code-string">$2</span>')
      .replace(/(&lt;!--.*?--&gt;)/gs, '<span class="code-comment">$1</span>');
  }
  
  return escaped;
}

function renderMarkdown(text) {
  let html = escapeHtml(text);
  
  html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`(.+?)`/g, '<code>$1</code>');
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/\n/g, '<br>');
  
  return `<div class="markdown-content">${html}</div>`;
}

function adjustDocFontSize(delta) {
  docFontSize = Math.max(8, Math.min(32, docFontSize + delta));
  saveDocViewPrefs();
  applyDocViewPrefs();
}

function toggleDocWordWrap() {
  docWordWrap = !docWordWrap;
  saveDocViewPrefs();
  applyDocViewPrefs();
}

function copyDocContent() {
  const content = document.querySelector('.document-content');
  if (content) {
    navigator.clipboard.writeText(content.textContent).then(() => {
      showToast('Document content copied!');
    });
  }
}
