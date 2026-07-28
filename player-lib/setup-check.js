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

   Required tools (ffmpeg) get the amber warning treatment; optional ones
   (fpcalc — Music ID only) are listed beneath, dimmer, so the banner tells
   the truth about severity. Each row's ⬇ button drives the per-tool server
   download (POST /api/setup/download/:tool) and flips its row green on
   success — no restart, because spawns re-resolve per call.

   Shown once per page load, dismissible, and it stays dismissed for the
   session only — a setup problem that survives a reload deserves to be seen
   again. Degrades to silence: an older server without the route, or a locked
   vault answering 423, simply renders nothing.
   ========================================================================= */
(function () {
  const DISMISS_KEY = 'vault_setup_banner_dismissed';

  function toolRow(key, t) {
    const manual = [
      t.install.winget ? `<code class="setup-cmd" data-cmd="${escapeHtml(t.install.winget)}">${escapeHtml(t.install.winget)}</code>
        <button class="setup-banner-btn" data-copy="${escapeHtml(t.install.winget)}" title="Copy this command">Copy</button>
        (then restart Vault), or a manual build:` : 'Manual install:',
      `<a href="${escapeHtml(t.install.url)}" target="_blank" rel="noopener">${escapeHtml(t.install.url)}</a>`,
    ].join(' ');
    return `
      <div class="setup-banner-row ${t.required ? '' : 'setup-banner-row-optional'}" data-tool="${key}">
        <span class="setup-banner-ic">${t.required ? '⚠' : '·'}</span>
        <div class="setup-banner-text">
          <div class="setup-banner-title">${escapeHtml(t.label)} not found${t.required ? '' : ' <span class="setup-banner-tag">optional</span>'}</div>
          <div class="setup-banner-desc">Needed for ${escapeHtml(t.needed)}.</div>
          <div class="setup-banner-cmd">
            ${t.downloadable ? `<button class="setup-banner-btn setup-banner-primary" data-dl="${key}"
              title="Fetches it and puts it next to Vault — nothing else is installed">⬇ Download for me (~${t.sizeMB} MB)</button>
            <span class="setup-banner-desc" data-dl-status="${key}"></span>` : ''}
          </div>
          <div class="setup-banner-desc">Or install it yourself — ${manual}</div>
        </div>
      </div>`;
  }

  function render(missing) {
    if (document.getElementById('setupBanner')) return;

    const el = document.createElement('div');
    el.id = 'setupBanner';
    el.className = 'setup-banner';
    el.innerHTML = missing.map(([key, t]) => toolRow(key, t)).join('')
      + `<button class="setup-banner-x" id="setupDismissBtn" title="Dismiss for this session">✕</button>`;
    document.body.insertBefore(el, document.body.firstChild);

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
      try {
        const r = await fetch(`/api/setup/download/${key}`, { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { status.textContent = '⚠ ' + (j.error || `HTTP ${r.status}`); btn.disabled = false; return; }
      } catch (e) {
        status.textContent = '⚠ ' + e.message; btn.disabled = false; return;
      }
      const poll = setInterval(async () => {
        let s;
        try { s = await (await fetch(`/api/setup/download/${key}`)).json(); }
        catch { return; }                        // transient — keep polling
        if (s.state === 'downloading') status.textContent = `Downloading… ${s.pct || 0}%`;
        else if (s.state === 'extracting') status.textContent = 'Extracting…';
        else if (s.state === 'done') {
          clearInterval(poll);
          const row = el.querySelector(`.setup-banner-row[data-tool="${key}"]`);
          row.classList.add('setup-banner-ok');
          row.querySelector('.setup-banner-ic').textContent = '✓';
          row.querySelector('.setup-banner-text').innerHTML =
            `<div class="setup-banner-title">Installed next to Vault — ready, no restart needed.</div>`;
          showToast?.('✓ ' + key + ' ready');
          setTimeout(() => {
            row.remove();
            // Last row gone → the banner itself has nothing left to say.
            if (!el.querySelector('.setup-banner-row')) el.remove();
          }, 6000);
        } else if (s.state === 'error') {
          clearInterval(poll);
          status.textContent = `⚠ ${s.error || 'download failed'} — try the manual install below`;
          btn.disabled = false;
        }
      }, 700);
    }));

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
    // Required tools first, so the row that blocks scanning tops the banner.
    const missing = Object.entries(tools || {})
      .filter(([, t]) => t && !t.ok)
      .sort(([, a], [, b]) => (b.required ? 1 : 0) - (a.required ? 1 : 0));
    if (missing.length) render(missing);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
