/**
 * mpv's command line for Stage (PLAYLISTS_SPEC "Stage host, final"). Pure.
 *
 * Fixed, app-controlled options (--no-config: nothing from the user's own
 * mpv.conf, scripts or input.conf), built only from validated values:
 *
 *   - privacy: the window title is the Window name setting, never a file name
 *     (--title has no ${...} in it: a "$" in the name is doubled, so it is
 *     shown as typed and never expanded into a property such as the path);
 *     the media title is a fixed word; no media controls (Windows' overlay
 *     would show file names), no watch-later files, no terminal output;
 *   - no network and nothing that runs code: no scripts (OSC, console,
 *     stats, ytdl hook...), no yt-dlp, protocol whitelists of file only, no
 *     following of playlist or reference files;
 *   - no keys: default and built-in bindings off; Vault binds the window's
 *     close button over IPC (so closing the window hands back to the mini
 *     player) and a double-click to maximise, nothing that seeks or quits;
 *     dragging the picture moves the window;
 *   - the Stage look: borderless, black, square corners, no OSD bar, the
 *     window never takes focus or stays on top, its size never follows the
 *     video.
 */

const FIXED = Object.freeze([
  '--no-config',
  '--idle=yes',
  '--force-window=yes',
  '--keep-open=yes',          // the last frame stays while Control lines up the next file
  // privacy
  '--force-media-title=Stage',
  '--media-controls=no',
  '--save-position-on-quit=no',
  '--resume-playback=no',
  '--write-filename-in-watch-later-config=no',
  '--terminal=no',
  '--msg-level=all=no',
  // no network, no code
  '--ytdl=no',
  '--load-scripts=no',
  '--osc=no',
  '--load-stats-overlay=no',
  '--load-console=no',
  '--load-select=no',
  '--load-commands=no',
  '--load-positioning=no',
  '--load-context-menu=no',
  '--load-auto-profiles=no',
  '--access-references=no',
  '--load-unsafe-playlists=no',
  '--autocreate-playlist=no',
  '--directory-mode=ignore',
  '--cookies=no',
  '--demuxer-lavf-o=protocol_whitelist=[file]',
  '--stream-lavf-o=protocol_whitelist=[file]',
  // nothing loaded beside the file (subtitles, audio, covers): Stage shows the file only
  '--sub-auto=no',
  '--audio-file-auto=no',
  '--cover-art-auto=no',
  '--sid=no',
  '--audio-display=no',
  // no keys
  '--input-default-bindings=no',
  '--input-builtin-bindings=no',
  '--input-media-keys=no',
  // the Stage window
  '--border=no',
  '--window-dragging=yes',
  '--window-corners=donotround',
  '--keepaspect-window=no',
  '--auto-window-resize=no',
  '--focus-on=never',
  '--ontop=no',
  '--background-color=#000000',
  '--osd-level=0',
  '--osd-bar=no',
  '--cursor-autohide-fs-only=no',
  // playback (hardware decoding: hwdecArg below, from the setting)
  '--prefetch-playlist=yes',
  '--gapless-audio=weak',
  // pictures are timed by Vault (paused pictures wait, Hold keeps their time)
  '--image-display-duration=inf',
]);

const DEFAULT_SIZE = Object.freeze({ w: 960, h: 540 });
const QUIET_X = -20000;    // test servers: far off every screen

/** A Window name as mpv shows it: "$" doubled so mpv never expands ${...}. */
function titleArg(name) {
  const s = String(name || 'Vault Stage').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 120);
  return s.replace(/\$/g, '$$$$');
}

const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);

/**
 * Hardware decoding (Settings › Stage › Hardware decoding). On: a copy mode,
 * the graphics card decodes and the frames are copied back to memory before
 * they are drawn. The direct modes (auto-safe picks d3d11va on Windows) hand
 * mpv the card's own frames, padded to the card's block size, and on some
 * videos and drivers that padding shows as a green line along the right or
 * bottom edge; a copy is cropped to the real picture. auto-copy-safe came
 * with auto-safe (mpv 0.30); an mpv older than that gets auto-copy, which
 * every mpv Vault can run has. A version Vault cannot read is taken as
 * recent. Off: the processor decodes everything (--hwdec=no).
 */
function hwdecArg(on = true, version = null) {
  if (on === false) return '--hwdec=no';
  const m = /^v?(\d+)\.(\d+)/.exec(String(version || ''));
  const old = m && (Number(m[1]) === 0 && Number(m[2]) < 30);
  return old ? '--hwdec=auto-copy' : '--hwdec=auto-copy-safe';
}

/** --geometry from a rectangle { x, y, w, h } (position optional). Only integers get through. */
function geometryArg(r) {
  const w = int(r && r.w), h = int(r && r.h);
  if (!(w > 0) || !(h > 0)) return null;
  const x = int(r.x), y = int(r.y);
  if (x === null || y === null) return `${w}x${h}`;
  // mpv takes "+-20" for a spot left of (or above) the main screen.
  return `${w}x${h}+${x}+${y}`;
}

/**
 * @param {object} o
 * @param {string} o.ipcPath        the pipe (server-made, random)
 * @param {string} [o.title]        the Window name setting (cleaned by settings.js)
 * @param {object} [o.bounds]       saved window rectangle { x, y, w, h } (screen pixels)
 * @param {boolean} [o.maximized]
 * @param {number} [o.cursorSeconds]
 * @param {number} [o.volume]       0..1
 * @param {boolean} [o.muted]
 * @param {boolean} [o.forceMute]   VAULT_STAGE_MUTE: silent, no audio device at all
 * @param {boolean} [o.quiet]       VAULT_STAGE_TEST_QUIET: off every screen, never focused
 * @param {boolean} [o.hwdec=true]  Hardware decoding (hwdecArg)
 * @param {string} [o.mpvVersion]   what `mpv --version` said (hwdecArg)
 */
function buildArgs(o = {}) {
  if (typeof o.ipcPath !== 'string' || !o.ipcPath) throw new Error('ipcPath is required');
  const args = [...FIXED, hwdecArg(o.hwdec !== false, o.mpvVersion), `--input-ipc-server=${o.ipcPath}`, `--title=${titleArg(o.title)}`];
  const cursorMs = Math.max(1, Math.min(60, int(o.cursorSeconds) || 1)) * 1000;
  args.push(`--cursor-autohide=${cursorMs}`);
  const vol = Number.isFinite(o.volume) ? Math.max(0, Math.min(1, o.volume)) : 1;
  args.push(`--volume=${Math.round(vol * 100)}`);
  if (o.forceMute) args.push('--mute=yes', '--ao=null');
  else args.push(`--mute=${o.muted ? 'yes' : 'no'}`);
  const size = o.bounds && int(o.bounds.w) > 0 && int(o.bounds.h) > 0 ? o.bounds : DEFAULT_SIZE;
  if (o.quiet) {
    args.push(`--geometry=${geometryArg({ w: size.w, h: size.h, x: QUIET_X, y: 0 })}`);
  } else {
    const g = geometryArg(o.bounds && Number.isFinite(o.bounds.x) ? o.bounds : { w: size.w, h: size.h });
    if (g) args.push(`--geometry=${g}`);
    if (o.maximized) args.push('--window-maximized=yes');
  }
  return args;
}

module.exports = { FIXED, DEFAULT_SIZE, QUIET_X, buildArgs, titleArg, geometryArg, hwdecArg };
