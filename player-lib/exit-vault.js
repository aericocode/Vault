/* =========================================================================
   Exit Vault: the button at the bottom of Settings > General (both looks).

   A Vault double-clicked on Linux runs with no terminal window, so this is
   the visible way to stop it. The press asks first, in the app's own confirm
   (vault-dialogs.js), with one line for each kind of work it would cut short
   (a share packing or uploading, an AI scan). Only a yes sends
   POST /api/exit (server/index.js), which answers and then runs the same
   shutdown as Ctrl+C.

   Once Vault has answered, this tab moves to a small page of its own saying
   Vault has stopped. Being a new page is the point: every timer, poll, open
   stream and player of the old one ends with it, so nothing keeps asking a
   server that is gone, and no "Can't reach Vault" notice or error toast
   follows. The page is built here (a blob: address of this origin) in the
   colors the app had on screen, since the server can no longer send any.

   If Vault does not answer yes, the press says so and everything carries on.

   Hook: settings.js calls window.vaultExitVault() from the button.
   ========================================================================= */

(function () {
  'use strict';

  const STOPPED_TITLE = 'Vault has stopped';
  const STOPPED_TEXT = 'You can close this tab. To use Vault again, start it from its folder.';

  let busy = false;

  /** One plain line for each kind of work stopping now would cut short. */
  function exitVaultBusyLines(a) {
    const lines = [];
    if (a && a.share === 'uploading') lines.push('A share is still uploading. It will stop.');
    else if (a && a.share === 'packing') lines.push('A share is still being packed. It will stop.');
    if (a && a.aiScan) lines.push('An AI scan is still running. It will stop.');
    return lines;
  }

  /** What would stop, or nothing when Vault does not say (the confirm still shows). */
  async function activityNow() {
    try {
      const r = await fetch('/api/exit');
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  // Only plain color and font values go into the stopped page's style.
  const cssSafe = (v, fallback) => {
    const s = String(v == null ? '' : v).trim();
    return s && /^[#(),./%\w\s'"-]+$/.test(s) ? s : fallback;
  };

  /** The colors and font on screen now, for the stopped page. */
  function exitVaultColors() {
    const out = { bg: '#0f0f0f', fg: '#e0e0e0', muted: '#a0a0a0', font: 'system-ui, sans-serif' };
    try {
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      const token = (name) => String(root.getPropertyValue(name) || '').trim();
      const bodyBg = String(body.backgroundColor || '').replace(/\s+/g, '');
      const seeThrough = !bodyBg || bodyBg === 'transparent' || /^rgba\(\d+,\d+,\d+,0\)$/.test(bodyBg);
      out.bg = cssSafe(seeThrough ? token('--bg-primary') : body.backgroundColor, out.bg);
      out.fg = cssSafe(token('--text-primary') || body.color, out.fg);
      out.muted = cssSafe(token('--text-secondary'), out.muted);
      out.font = cssSafe(body.fontFamily, out.font);
    } catch { /* defaults above */ }
    return out;
  }

  function exitVaultStoppedHtml(c) {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + `<title>${STOPPED_TITLE}</title><style>`
      + 'html,body{height:100%;margin:0}'
      + `body{display:flex;align-items:center;justify-content:center;background:${c.bg};color:${c.fg};font-family:${c.font}}`
      + 'main{max-width:34rem;padding:2rem 1.5rem;text-align:center}'
      + 'h1{font-size:1.5rem;font-weight:600;margin:0 0 .75rem}'
      + `p{margin:0;font-size:1rem;line-height:1.55;color:${c.muted}}`
      + `</style></head><body><main><h1>${STOPPED_TITLE}.</h1><p>${STOPPED_TEXT}</p></main></body></html>`;
  }

  /** Swap this tab for the stopped page. */
  function showStopped() {
    const html = exitVaultStoppedHtml(exitVaultColors());
    try {
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      location.replace(url);
      return;
    } catch { /* no blob page: write it over this one below */ }
    // Fallback: the same words over everything on this page.
    try {
      const c = exitVaultColors();
      document.title = STOPPED_TITLE;
      document.body.innerHTML = `<main style="position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.75rem;padding:2rem;text-align:center;background:${c.bg};color:${c.fg};font-family:${c.font};z-index:2147483647"><h1 style="font-size:1.5rem;margin:0">${STOPPED_TITLE}.</h1><p style="margin:0;color:${c.muted}">${STOPPED_TEXT}</p></main>`;
    } catch { /* nothing more to do */ }
  }

  /**
   * The button's press. Resolves to what happened: 'cancelled', 'stopped' or
   * 'failed' (and 'busy' for a press while one is already in hand).
   */
  async function vaultExitVault() {
    if (busy) return 'busy';
    busy = true;
    try {
      const lines = exitVaultBusyLines(await activityNow());
      const message = ['Vault will stop on this computer. To use it again, start it from its folder.', ...lines].join('\n\n');
      const yes = await window.vaultConfirm(message, {
        title: 'Exit Vault?', okLabel: 'Exit Vault', cancelLabel: 'Cancel',
        // Work would stop: start on Cancel, with Exit in red.
        danger: lines.length > 0,
      });
      if (!yes) return 'cancelled';
      let r = null;
      let said = '';
      try {
        r = await fetch('/api/exit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exit: true }),
        });
        if (!r.ok) said = ((await r.json().catch(() => null)) || {}).error || '';
      } catch { r = null; }
      if (r && r.ok) {
        showStopped();
        return 'stopped';
      }
      const message2 = r
        ? `Vault did not stop. It is still running.${said ? `\n\n${said}` : ''}`
        : 'Vault did not answer, so it may still be running. Try again in a moment.';
      await window.vaultAlert(message2, { title: 'Exit Vault' });
      return 'failed';
    } finally {
      busy = false;
    }
  }

  window.vaultExitVault = vaultExitVault;
  // For tests.
  window.vaultExitVaultBusyLines = exitVaultBusyLines;
  window.vaultExitVaultStoppedHtml = exitVaultStoppedHtml;
})();
