/**
 * Ask the X11 window manager for a frame without a title bar on the Stage
 * window (VAULT_STAGE_LINUX_FRAME=border, mpv-args.js windowPlan).
 *
 * mpv itself can only ask for the full frame or none (and with
 * --title-bar=no for "everything but the title", which GNOME's mutter does
 * not read: mutter only knows "none" and exactly "border only"). So once
 * mpv's window is up with its frame, Vault sets the window's
 * _MOTIF_WM_HINTS to flags = decorations, decorations = border only
 * (2, 0, 2, 0, 0) with xprop, from the x11-utils package. mpv writes the
 * property again whenever its border option changes, so Vault sets it again
 * after each size pick.
 *
 * xprop is run without a shell, with a window id that is a whole number mpv
 * gave (its window-id property) and fixed arguments. No xprop, or it fails:
 * the window keeps the frame it has (title bar and edges).
 */

const { execFile } = require('child_process');

const BORDER_ONLY = '2, 0, 2, 0, 0';

/** xprop's arguments for one window. */
function borderOnlyArgs(wid) {
  return ['-id', String(wid), '-f', '_MOTIF_WM_HINTS', '32c', '-set', '_MOTIF_WM_HINTS', BORDER_ONLY];
}

/**
 * @param {object} o
 * @param {number} o.wid    mpv's window-id (an X11 window)
 * @param {object} [o.env]  DISPLAY is mpv's (Vault's own environment)
 * @returns {Promise<'ok'|'no-xprop'|'failed'|'no-window'>}
 */
function setBorderOnly({ wid, env = process.env, run = execFile } = {}) {
  if (!Number.isSafeInteger(wid) || wid <= 0) return Promise.resolve('no-window');
  return new Promise((resolve) => {
    try {
      run('xprop', borderOnlyArgs(wid), { env, timeout: 3000, windowsHide: true }, (err) => {
        if (!err) resolve('ok');
        else resolve(err.code === 'ENOENT' ? 'no-xprop' : 'failed');
      });
    } catch { resolve('failed'); }
  });
}

module.exports = { setBorderOnly, borderOnlyArgs, BORDER_ONLY };
