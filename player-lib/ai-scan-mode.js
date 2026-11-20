/* Settings > General > AI scan, as the viewer sees it: 'off' | 'on' | 'auto'
   (server side: lib/ai-scan-mode.js, GET/POST /api/settings/app aiScan).

   Off hides every way to start or retry an AI scan and every nudge about it.
   Most of that is CSS: <html data-ai-scan="off"> and css/ai-scan.css hide the
   buttons, badges and the scan tab wherever they are drawn. Code that would
   show a toast or start a scan asks window.vaultAiScan.isOff() first.

   The last mode seen is kept in localStorage so a reload in Off never flashes
   the scan buttons before the server answers. The server stays the authority:
   it refuses a scan request in Off whatever the page shows.

   Loaded early (right after utils.js and icons.js): everything after it may ask. */
(function () {
  'use strict';
  const LS_KEY = 'vault_ai_scan';
  const MODES = ['off', 'on', 'auto'];
  let mode = 'on';
  try {
    const cached = localStorage.getItem(LS_KEY);
    if (MODES.includes(cached)) mode = cached;
  } catch {}

  function apply(next, { fromServer = false } = {}) {
    if (!MODES.includes(next)) return;
    const prev = mode;
    mode = next;
    document.documentElement.dataset.aiScan = mode;
    try { localStorage.setItem(LS_KEY, mode); } catch {}
    if (prev !== mode) {
      window.dispatchEvent(new CustomEvent('vault:ai-scan', { detail: { mode, prev, fromServer } }));
    }
  }
  apply(mode);

  let retry = null;
  async function refresh() {
    try {
      const r = await fetch('/api/settings/app', { headers: { 'X-Vault-Background': '1' }, cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      apply(j.aiScan, { fromServer: true });
      if (retry) { clearTimeout(retry); retry = null; }
    } catch {
      // Locked (423) or offline: the cached mode holds; look again shortly.
      if (!retry) retry = setTimeout(() => { retry = null; refresh(); }, 20000);
    }
  }
  refresh();
  // Another tab or device may have changed it.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  window.addEventListener('vault:online', refresh);

  window.vaultAiScan = {
    mode: () => mode,
    isOff: () => mode === 'off',
    isAuto: () => mode === 'auto',
    /** Settings saved a new mode (the server already has it). */
    set: (m) => apply(m),
    refresh,
  };
})();
