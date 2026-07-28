/* =========================================================================
   SETUP CHECK — one banner for a missing required external tool.

   ffmpeg/ffprobe are not bundled in the portable build; they're spawned by
   name from PATH. Before this, a user who downloaded Vault.exe and ran it got
   a working app, a working library, and then EVERY imported file failing with
   "Could not read media info" — with nothing naming ffmpeg anywhere. The
   console banner (server/index.js) covers people watching the terminal; this
   covers everyone else, since the whole point of the exe is that you don't
   have to.

   Shown once per page load, dismissible, and it stays dismissed for the
   session only — a setup problem that survives a reload deserves to be seen
   again. Degrades to silence: an older server without the route, or a locked
   vault answering 423, simply renders nothing.
   ========================================================================= */
(function () {
  const DISMISS_KEY = 'vault_setup_banner_dismissed';

  function render(missing) {
    if (document.getElementById('setupBanner')) return;

    const el = document.createElement('div');
    el.id = 'setupBanner';
    el.className = 'setup-banner';
    el.innerHTML = missing.map(t => `
      <div class="setup-banner-row">
        <span class="setup-banner-ic">⚠</span>
        <div class="setup-banner-text">
          <div class="setup-banner-title">${escapeHtml(t.label)} not found</div>
          <div class="setup-banner-desc">Needed for ${escapeHtml(t.needed)}.</div>
          <div class="setup-banner-cmd">
            <button class="setup-banner-btn setup-banner-primary" id="setupDlBtn"
              title="Fetches ffmpeg from gyan.dev and puts it next to Vault — nothing else is installed">⬇ Download for me (~90 MB)</button>
            <span class="setup-banner-desc" id="setupDlStatus"></span>
          </div>
          <div class="setup-banner-desc">
            Or install it yourself — <code id="setupCmd">${escapeHtml(t.install.winget)}</code>
            <button class="setup-banner-btn" id="setupCopyBtn" title="Copy this command">Copy</button>
            (then restart Vault), or a manual build:
            <a href="${escapeHtml(t.install.url)}" target="_blank" rel="noopener">${escapeHtml(t.install.url)}</a>
          </div>
        </div>
        <button class="setup-banner-x" id="setupDismissBtn" title="Dismiss for this session">✕</button>
      </div>`).join('');

    document.body.insertBefore(el, document.body.firstChild);

    /* One click → server fetches the zip and drops ffmpeg.exe/ffprobe.exe next
       to Vault (user-initiated egress; see lib/net.js purpose 'tool'). Spawns
       re-resolve per call, so on success everything works immediately — the
       banner flips green instead of telling anyone to restart. */
    const dlBtn = el.querySelector('#setupDlBtn');
    const dlStatus = el.querySelector('#setupDlStatus');
    dlBtn?.addEventListener('click', async () => {
      dlBtn.disabled = true;
      try {
        const r = await fetch('/api/setup/download-ffmpeg', { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { dlStatus.textContent = '⚠ ' + (j.error || `HTTP ${r.status}`); dlBtn.disabled = false; return; }
      } catch (e) {
        dlStatus.textContent = '⚠ ' + e.message; dlBtn.disabled = false; return;
      }
      const poll = setInterval(async () => {
        let s;
        try { s = await (await fetch('/api/setup/download-ffmpeg')).json(); }
        catch { return; }                        // transient — keep polling
        if (s.state === 'downloading') dlStatus.textContent = `Downloading… ${s.pct || 0}%`;
        else if (s.state === 'extracting') dlStatus.textContent = 'Extracting…';
        else if (s.state === 'done') {
          clearInterval(poll);
          el.classList.add('setup-banner-ok');
          el.querySelector('.setup-banner-ic').textContent = '✓';
          el.querySelector('.setup-banner-text').innerHTML =
            `<div class="setup-banner-title">ffmpeg installed next to Vault</div>
             <div class="setup-banner-desc">Scanning, thumbnails and duration are ready — no restart needed.</div>`;
          showToast?.('✓ ffmpeg ready');
          setTimeout(() => el.remove(), 6000);
        } else if (s.state === 'error') {
          clearInterval(poll);
          dlStatus.textContent = `⚠ ${s.error || 'download failed'} — try the manual install below`;
          dlBtn.disabled = false;
        }
      }, 700);
    });

    el.querySelector('#setupCopyBtn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(missing[0].install.winget);
        btn.textContent = 'Copied';
        setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy'; }, 1500);
      } catch {
        // Clipboard can be blocked; select the text so Ctrl+C still works.
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('setupCmd'));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });

    el.querySelector('#setupDismissBtn')?.addEventListener('click', () => {
      try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch {}
      el.remove();
    });
  }

  async function run() {
    try { if (sessionStorage.getItem(DISMISS_KEY)) return; } catch {}
    let tools;
    try {
      const resp = await fetch('/api/setup-check');
      if (!resp.ok) return;                 // 423 while locked, or an older server
      tools = await resp.json();
    } catch { return; }
    const missing = Object.values(tools || {}).filter(t => t && t.required && !t.ok);
    if (missing.length) render(missing);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
