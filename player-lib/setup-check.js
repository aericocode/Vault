/* =========================================================================
   SETUP CHECK — one banner for missing external tools, with one-click fixes.

   ffmpeg/ffprobe and fpcalc are not bundled in the portable build; they're
   spawned by name (lib/ffmpeg-locate.js resolves a copy next to the exe
   first, then PATH). Before this, a user who downloaded Vault.exe and ran it
   got a working app, a working library, and then EVERY imported file failing
   with "Could not read media info" — with nothing naming ffmpeg anywhere.
   The console banner (server/index.js) covers people watching the terminal;
   this covers everyone else, since the whole point of the exe is that you
   don't have to.

   Required tools (ffmpeg) get the warning icon; optional ones (fpcalc, Music
   ID only) are listed beneath with an info icon and an Optional tag, so the
   banner tells the truth about severity. Titles use the plain name from the
   server's label ("Video tools are missing"); the program's own name and the
   manual install sit in an "Other ways to install" fold. Each row's Download
   button drives the per-tool server download (POST /api/setup/download/:tool)
   and marks its row done on success, no restart, because spawns re-resolve
   per call. Modern draws the banner as a card (css/header.css).

   Shown once per page load, dismissible, and it stays dismissed for the
   session only — a setup problem that survives a reload deserves to be seen
   again. Degrades to silence: an older server without the route, or a locked
   vault answering 423, simply renders nothing.

   Optional rows also get "Don't show again", which hides that one tool for
   good (POST /api/setup/hidden, stored server side so every browser that opens
   this library agrees). Settings > About lists what is hidden and can show it
   again. Required tools never get the link: ffmpeg missing means imports fail.
   ========================================================================= */
(function () {
  const DISMISS_KEY = 'vault_setup_banner_dismissed';

  /* The server's label is "Video tools (ffmpeg)": the plain name leads the
     title ("Video tools are missing") and the program's own name goes in the
     install fold, where someone installing it by hand needs it. An older
     server's bare "ffmpeg / ffprobe" is used as it is. */
  function splitLabel(label) {
    const m = String(label || '').match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    return m ? { name: m[1], tech: m[2] } : { name: String(label || ''), tech: '' };
  }

  /** "Video tools are missing", "Music ID helper is missing". */
  function areOrIs(name) {
    return /s$/i.test(String(name).trim().split(/\s+/).pop() || '') ? 'are' : 'is';
  }

  function hostOf(url) {
    try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; }
  }

  // Classic's glyphs, Modern's line icons (player-lib/icons.js).
  const ic = (emoji, name) => (typeof vaultIconSwap === 'function' ? vaultIconSwap(emoji, name) : emoji);

  function toolRow(key, t) {
    const { name, tech } = splitLabel(t.label);
    const what = tech || name;
    const manual = [
      t.install.winget ? `<div class="setup-banner-desc">Run this command, then restart Vault:
          <code class="setup-cmd" data-cmd="${escapeHtml(t.install.winget)}">${escapeHtml(t.install.winget)}</code>
          <button class="setup-banner-btn" data-copy="${escapeHtml(t.install.winget)}" title="Copy this command">Copy</button></div>` : '',
      t.install.url ? `<div class="setup-banner-desc">${t.install.winget ? 'Or download' : 'Download'} ${escapeHtml(what)} yourself from
          <a href="${escapeHtml(t.install.url)}" target="_blank" rel="noopener" title="${escapeHtml(t.install.url)}">${escapeHtml(hostOf(t.install.url))}</a>.</div>` : '',
    ].join('');
    return `
      <div class="setup-banner-row ${t.required ? '' : 'setup-banner-row-optional'}" data-tool="${key}">
        <span class="setup-banner-ic" aria-hidden="true">${t.required ? ic('⚠', 'alert') : ic('ℹ', 'info')}</span>
        <div class="setup-banner-text">
          <div class="setup-banner-title">${escapeHtml(`${name} ${areOrIs(name)} missing`)}${t.required ? '' : ' <span class="setup-banner-tag">Optional</span>'}</div>
          <div class="setup-banner-desc">Needed for ${escapeHtml(t.needed)}.</div>
          <div class="setup-banner-cmd">
            ${t.downloadable ? `<button class="setup-banner-btn setup-banner-primary" data-dl="${key}"
              title="Vault downloads it and puts it next to itself. Nothing else is installed">${ic('⬇ ', 'download')}Download (${t.sizeMB} MB)</button>` : ''}
            ${t.required ? '' : `<button class="setup-banner-link" data-hide="${key}"
              title="Hide this notice on this computer. Show it again from Settings > About">Don't show again</button>`}
            <span class="setup-banner-desc setup-banner-status" data-dl-status="${key}" aria-live="polite"></span>
          </div>
          ${manual ? `<details class="setup-banner-more">
            <summary>Other ways to install</summary>
            ${manual}
          </details>` : ''}
        </div>
      </div>`;
  }

  /* The banner sits above the sticky header, so showing, shrinking or
     removing it moves the header without resizing it: tell the things pinned
     under the header (the filter rail, the preview pane, the grid's row
     maths) to measure again. */
  function chromeMoved() {
    try {
      window.dispatchEvent(new CustomEvent('vault:top-chrome'));
      window.dispatchEvent(new Event('resize'));
    } catch { /* no window events (the unit test's VM) */ }
  }

  function render(missing) {
    if (document.getElementById('setupBanner')) return;

    const el = document.createElement('div');
    el.id = 'setupBanner';
    el.className = 'setup-banner';
    el.role = 'region';
    el.ariaLabel = 'Setup';
    el.innerHTML = missing.map(([key, t]) => toolRow(key, t)).join('')
      + `<button class="setup-banner-x" id="setupDismissBtn" title="Hide until Vault is opened again" aria-label="Hide this notice">${ic('✕', 'close')}</button>`;
    document.body.insertBefore(el, document.body.firstChild);
    chromeMoved();
    // Opening the install fold or a status line wrapping changes its height.
    if (typeof ResizeObserver === 'function') {
      let lastH = el.offsetHeight;
      new ResizeObserver(() => {
        if (!el.isConnected || el.offsetHeight === lastH) return;
        lastH = el.offsetHeight;
        chromeMoved();
      }).observe(el);
    }
    const nameOf = (key) => splitLabel((missing.find(([k]) => k === key) || [])[1]?.label || key).name;

    el.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = 'Copied';
        setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy'; }, 1500);
      } catch {
        // Clipboard can be blocked; select the text so Ctrl+C still works.
        const code = btn.parentElement.querySelector('.setup-cmd');
        if (!code) return;
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }));

    /* One click → server fetches the zip and drops the binaries next to Vault
       (user-initiated egress; see lib/net.js purpose 'tool'). Spawns re-resolve
       per call, so on success the row flips green immediately — no restart. */
    el.querySelectorAll('[data-dl]').forEach(btn => btn.addEventListener('click', async () => {
      const key = btn.dataset.dl;
      const status = el.querySelector(`[data-dl-status="${key}"]`);
      btn.disabled = true;
      const ok = await downloadTool(key, (msg) => { status.textContent = msg; });
      if (!ok) { btn.disabled = false; return; }
      const row = el.querySelector(`.setup-banner-row[data-tool="${key}"]`);
      row.classList.add('setup-banner-ok');
      row.querySelector('.setup-banner-ic').innerHTML = ic('✓', 'check');
      const name = nameOf(key);
      row.querySelector('.setup-banner-text').innerHTML =
        `<div class="setup-banner-title">${escapeHtml(name)} installed. Ready, no restart needed.</div>`;
      showToast?.(`${name} ${areOrIs(name)} ready.`, { type: 'success' });
      setTimeout(() => removeRow(row), 6000);
    }));

    el.querySelectorAll('[data-hide]').forEach(btn => btn.addEventListener('click', async () => {
      const key = btn.dataset.hide;
      const status = el.querySelector(`[data-dl-status="${key}"]`);
      btn.disabled = true;
      try {
        const r = await fetch('/api/setup/hidden', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: key, hidden: true }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }
      } catch (e) {
        if (status) status.textContent = friendlyError(e, 'saving that');
        btn.disabled = false;
        return;
      }
      removeRow(el.querySelector(`.setup-banner-row[data-tool="${key}"]`));
    }));

    function removeRow(row) {
      row?.remove();
      // Last row gone → the banner itself has nothing left to say.
      if (!el.querySelector('.setup-banner-row')) el.remove();
      chromeMoved();
    }

    el.querySelector('#setupDismissBtn')?.addEventListener('click', () => {
      try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch {}
      el.remove();
      chromeMoved();
    });
  }

  /* POST the download, then poll until it lands. onStatus gets each progress
     line; resolves true once the binary is in place and verified. Shared with
     Music ID, which offers the same download where fpcalc is actually used. */
  async function downloadTool(key, onStatus) {
    try {
      const r = await fetch(`/api/setup/download/${key}`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onStatus(friendlyError(j.error ? j : { status: r.status }, 'starting the download')); return false; }
    } catch (e) {
      onStatus(friendlyError(e, 'starting the download')); return false;
    }
    return new Promise((resolve) => {
      const poll = setInterval(async () => {
        let s;
        try { s = await (await fetch(`/api/setup/download/${key}`)).json(); }
        catch { return; }                        // transient — keep polling
        if (s.state === 'downloading') onStatus(`Downloading… ${s.pct || 0}%`);
        else if (s.state === 'extracting') onStatus('Extracting…');
        else if (s.state === 'done') { clearInterval(poll); onStatus('Ready'); resolve(true); }
        else if (s.state === 'error') {
          clearInterval(poll);
          onStatus(`${s.error || 'The download failed'}. Try one of the other ways to install.`);
          resolve(false);
        }
      }, 700);
    });
  }

  /* Which rows the banner shows: missing tools, minus optional ones the user
     hid. A required tool shows whenever it is missing, even if a stale or
     hand-edited setting claims it is hidden. Required first, so the row that
     blocks scanning tops the banner. */
  function bannerRows(tools) {
    return Object.entries(tools || {})
      .filter(([, t]) => t && !t.ok && (t.required || !t.hidden))
      .sort(([, a], [, b]) => (b.required ? 1 : 0) - (a.required ? 1 : 0));
  }

  window.vaultSetup = { bannerRows, downloadTool };

  async function run() {
    try { if (sessionStorage.getItem(DISMISS_KEY)) return; } catch {}
    let tools;
    try {
      const resp = await fetch('/api/setup-check');
      if (!resp.ok) return;                 // 423 while locked, or an older server
      tools = await resp.json();
    } catch { return; }
    const missing = bannerRows(tools);
    if (missing.length) render(missing);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
