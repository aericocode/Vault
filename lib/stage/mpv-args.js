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
 *     video by itself (on Linux Vault fits it to the video, window-fit.js).
 *
 * Linux: on a Wayland desktop an app cannot place its own window or bring it
 * to the front (GNOME ignores both), so Stage runs on XWayland there when it
 * can (displayPlan). Older mpv (distribution packages lag: Ubuntu 24.04 has
 * 0.37, Debian 12 0.35) stops at an option it does not know, so the newer
 * ones are left out when mpv says it lacks them (fitOptions). How a Free
 * size window is sized with the mouse there, and kept to the picture's
 * shape: windowPlan.
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
 * recent. Off: the processor decodes everything (--hwdec=no). Nothing here is
 * Windows-only: on Linux the copy modes are vaapi-copy (AMD, Intel) and
 * nvdec-copy (NVIDIA); a machine with neither decodes on the processor.
 */
function hwdecArg(on = true, version = null) {
  if (on === false) return '--hwdec=no';
  const m = /^v?(\d+)\.(\d+)/.exec(String(version || ''));
  const old = m && (Number(m[1]) === 0 && Number(m[2]) < 30);
  return old ? '--hwdec=auto-copy' : '--hwdec=auto-copy-safe';
}

/**
 * Options newer than the oldest mpv a Linux distribution still ships, each
 * safe to leave out when mpv does not know it: the feature it turns off is
 * not in that mpv either (a built-in script, a Windows media overlay), or it
 * is only the look (rounded corners, window size following the video).
 * Some were renamed; the old name is used when only that one is known.
 * Everything else in FIXED is old enough for every mpv Vault can run.
 */
const NEWER_OPTIONS = Object.freeze({
  'focus-on': { was: 'focus-on-open', value: 'no' },          // 0.38
  'background-color': null,                                     // 0.38 (black is mpv's default anyway)
  'load-console': { was: 'load-osd-console', value: 'no' },    // 0.40
  'media-controls': null,                                       // 0.39, Windows only
  'autocreate-playlist': null,                                  // 0.39
  'load-select': null,
  'load-commands': null,                                        // 0.40
  'load-positioning': null,
  'load-context-menu': null,
  'window-corners': null,                                       // 0.37, Windows 11 only
  'auto-window-resize': null,                                   // 0.36
  'directory-mode': null,                                       // 0.36
  'input-builtin-bindings': null,                               // 0.34
});

/**
 * The arguments this mpv takes. `known` is the set of option names mpv listed
 * (mpv-find.js askOptions), or null when it could not be asked: then nothing
 * is changed. Only NEWER_OPTIONS are ever dropped or renamed.
 * @param {string[]} args
 * @param {Set<string>|null} known
 */
function fitOptions(args, known) {
  if (!(known instanceof Set) || known.size === 0) return [...args];
  const out = [];
  for (const a of args) {
    const m = /^--([a-z0-9-]+)=/.exec(a);
    const name = m && m[1];
    if (!name || !Object.prototype.hasOwnProperty.call(NEWER_OPTIONS, name) || known.has(name)) { out.push(a); continue; }
    const alt = NEWER_OPTIONS[name];
    if (alt && known.has(alt.was)) out.push(`--${alt.was}=${alt.value}`);
  }
  return out;
}

/** The X11 drawing context for a Stage window on XWayland (OpenGL through EGL; every mpv since 0.28 has it). */
const X11_CONTEXT = '--gpu-context=x11egl';
/**
 * The Wayland drawing context for mpv's own Wayland window (OpenGL through
 * EGL; every mpv since 0.28 has it, for --vo=gpu and gpu-next alike).
 * Without it, an mpv that cannot draw on Wayland quietly draws through
 * XWayland instead (DISPLAY is set). Pinned, the gpu outputs fail there and
 * mpv moves on to its other outputs, which say what they are (current-vo:
 * wlshm or dmabuf-wayland are Wayland, x11, xv, vdpau, vaapi are X11), so
 * Vault can tell which window it got (windowSystemOf). It does not make mpv
 * exit: with --force-window and --idle a failed window leaves mpv running
 * (player/playloop.c handle_force_window), so the start-again fallback
 * cannot be what catches this.
 */
const WAYLAND_CONTEXT = '--gpu-context=wayland';

/**
 * How the Stage window meets the desktop (Linux and other X11/Wayland systems).
 *
 *   - Windows, macOS: as it is (placement and on-top work).
 *   - An X11 session: as it is.
 *   - A Wayland session (WAYLAND_DISPLAY set) with XWayland (DISPLAY set) and
 *     the setting on: mpv draws through X11 (x11: true), which GNOME and KDE
 *     let place its window and keep it in front.
 *   - Wayland without XWayland, or the setting off: mpv's own Wayland window.
 *     It works, but the desktop decides where it opens (placement: false).
 *
 * VAULT_STAGE_XWAYLAND=0 or 1 overrides the setting.
 * @param {object} o
 * @param {string} [o.platform]
 * @param {object} [o.env]
 * @param {boolean} [o.xwayland=true]  Settings › Stage › Use XWayland for the Stage window
 * @returns {{ wayland: boolean, xwayland: boolean, x11: boolean, placement: boolean, forced: boolean }}
 */
function displayPlan({ platform = process.platform, env = process.env, xwayland = true } = {}) {
  const none = { wayland: false, xwayland: false, x11: false, placement: true, forced: false };
  if (platform === 'win32' || platform === 'darwin') return none;
  if (!env.WAYLAND_DISPLAY) return none;
  const hasX = !!env.DISPLAY;
  const o = env.VAULT_STAGE_XWAYLAND;
  const forced = o === '0' || o === '1';
  const want = forced ? o === '1' : xwayland !== false;
  const x11 = want && hasX;
  return { wayland: true, xwayland: hasX, x11, placement: x11, forced };
}

/**
 * How the Stage window is made off Windows and macOS (Linux and other
 * X11/Wayland systems): which window system draws it, whether it has the
 * desktop's frame at Free size, and whether mpv keeps it to the picture's
 * shape. Windows and macOS: as they always were (nothing here changes them).
 *
 * Why a frame at all: on X11 (and so on XWayland) a borderless mpv window
 * asks the window manager for no decorations, and the window manager's
 * edges are the decorations, so GNOME, KDE and the rest leave nothing to
 * grab; mpv itself only starts moves there (window-dragging), never resizes.
 *
 * The frame (VAULT_STAGE_LINUX_FRAME, read when Stage opens, so it can be
 * tried without a rebuild; anything else means the default):
 *
 *   - wayland (default): on a Wayland desktop, a Free size Stage opens as
 *     mpv's own Wayland window, whatever the XWayland setting says (a preset
 *     size still follows it). That window has no title bar on GNOME (GNOME
 *     draws none for Wayland apps) and mpv makes its own resize edges, about
 *     16 px wide, because it has no frame (mpv only does this without a
 *     border). Dragging the picture moves it. The cost: the desktop decides
 *     where it opens and it cannot be brought to the front.
 *     Not a Wayland desktop, or VAULT_STAGE_XWAYLAND=1: as titled.
 *   - titled: the desktop's normal frame on the X11 (XWayland) window at
 *     Free size: title bar and edges.
 *   - border: as titled, then the window manager is asked for a frame
 *     without a title bar (_MOTIF_WM_HINTS decorations = border only, set
 *     with xprop; see x11-hints.js). Without xprop it stays titled.
 *   - none: the bare X11 window, as Windows has it. No edges on X11; the
 *     mouse wheel over the picture resizes it (bound on Linux, every frame).
 *
 * mpv's own Wayland window never gets a frame: with one, mpv drops its own
 * edges, and GNOME draws none, so nothing could size it.
 *
 * keepAspect (Linux): --keepaspect-window=yes, so a resize keeps the shape
 * mpv was last sized to. On X11 that is a hint to the window manager (WM
 * aspect hints; GNOME's mutter honours them), on Wayland mpv does it itself.
 * Vault sizes the window to each video's shape (window-fit.js), so the shape
 * kept is the video's. It has to be set at launch, so it is on for every
 * size on Linux; a preset window has nothing to drag on X11.
 *
 * The quiet test window stays bare on X11: a window manager keeps a title
 * bar on screen, which would pull it back from far off every screen.
 * @param {object} o
 * @param {string} [o.platform]
 * @param {object} [o.env]
 * @param {boolean} [o.xwayland=true]  Settings › Stage › Use XWayland for the Stage window
 * @param {string} [o.size='free']    'free' or a size preset (settings.js OPEN_SIZES)
 * @param {boolean} [o.quiet]         the test window off every screen
 * @returns {{ frame: string|null, keepAspect: boolean, first: object, fallback: object|null, x11Kind: object|null, waylandKind: object|null }}
 *   first / fallback: { x11, wayland, frameAtFree, borderOnly } for the first
 *   command line and the one tried when that mpv closes as it opens.
 *   x11: draw through XWayland (--gpu-context=x11egl); wayland: mpv's own
 *   Wayland window; frameAtFree: --border=yes while the size is Free;
 *   borderOnly: then ask for a frame without a title bar.
 */
function windowPlan({ platform = process.platform, env = process.env, xwayland = true, size = 'free', quiet = false } = {}) {
  const bare = { x11: false, wayland: false, frameAtFree: false, borderOnly: false };
  if (platform === 'win32' || platform === 'darwin') return { frame: null, keepAspect: false, first: bare, fallback: null, x11Kind: null, waylandKind: null };
  const display = displayPlan({ platform, env, xwayland });
  const frame = linuxFrame(env);
  const x11Window = (x11) => ({
    x11, wayland: false,
    frameAtFree: !quiet && frame !== 'none',
    borderOnly: !quiet && frame === 'border',
  });
  const waylandWindow = { x11: false, wayland: true, frameAtFree: false, borderOnly: false };
  let first;
  let fallback = null;
  if (!display.wayland) {
    first = x11Window(false);                                   // an X11 session
  } else if (!display.x11) {
    first = waylandWindow;                                      // no XWayland, or turned off
  } else {
    const forcedX = display.forced && env.VAULT_STAGE_XWAYLAND === '1';
    const own = frame === 'wayland' && size === 'free' && !quiet && !forcedX;
    // pin: only this window names its drawing context (--gpu-context=wayland), so mpv cannot
    // quietly draw it through XWayland instead. Where there is no XWayland to fall to, or as
    // the fallback, mpv picks its own (Vulkan included), as it always did.
    first = own ? { ...waylandWindow, pin: true } : x11Window(true);
    fallback = own ? x11Window(true) : waylandWindow;
  }
  // What the window is if mpv made the other kind than asked (windowSystemOf).
  const x11Kind = x11Window(display.wayland);
  return { frame, keepAspect: true, first, fallback, x11Kind, waylandKind: display.wayland ? waylandWindow : null };
}

const LINUX_FRAMES = Object.freeze(['wayland', 'titled', 'border', 'none']);
const DEFAULT_LINUX_FRAME = 'wayland';

/**
 * Which window system mpv's window is really on, from what mpv says after it
 * started: the drawing context (current-gpu-context, mpv 0.38 on), the video
 * output (current-vo, every version), or a window id (window-id, 0.36 on;
 * only X11 windows have one). 'wayland', 'x11', or null when it cannot tell.
 * Pure.
 */
function windowSystemOf({ vo = null, context = null, windowId = null } = {}) {
  const c = typeof context === 'string' ? context.toLowerCase() : '';
  if (/wayland/.test(c)) return 'wayland';
  if (/x11|glx|xlib/.test(c)) return 'x11';
  const v = typeof vo === 'string' ? vo.toLowerCase() : '';
  if (v === 'wlshm' || v === 'dmabuf-wayland') return 'wayland';
  if (v === 'x11' || v === 'xv' || v === 'vdpau' || v === 'vaapi') return 'x11';
  if (Number.isSafeInteger(windowId) && windowId > 0) return 'x11';
  return null;
}

/**
 * The window Stage really has: the one asked for, or, when mpv says it made
 * the other kind, that one (so an XWayland window gets its frame and can be
 * sized, and mpv's own Wayland window never gets one). Pure.
 * @param {object} plan    windowPlan()
 * @param {object} asked   plan.first or plan.fallback
 * @param {string|null} system  windowSystemOf()
 */
function actualKind(plan, asked, system) {
  if (!plan || !asked) return asked || null;
  if (system === 'x11' && asked.wayland && plan.x11Kind) return plan.x11Kind;
  if (system === 'wayland' && !asked.wayland && plan.waylandKind) return plan.waylandKind;
  return asked;
}

/** VAULT_STAGE_LINUX_FRAME, or the default. */
function linuxFrame(env = process.env) {
  const v = String((env && env.VAULT_STAGE_LINUX_FRAME) || '').trim().toLowerCase();
  return LINUX_FRAMES.includes(v) ? v : DEFAULT_LINUX_FRAME;
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
 * @param {Set<string>} [o.mpvOptions]  the options this mpv knows (fitOptions)
 * @param {boolean} [o.x11]         draw through X11 (displayPlan: a Wayland desktop with XWayland)
 * @param {boolean} [o.framed]      the desktop's frame (windowPlan frameAtFree); never for a quiet window
 * @param {boolean} [o.keepAspect]  --keepaspect-window=yes (windowPlan; Linux only)
 * @param {boolean} [o.wayland]     mpv's own Wayland window: the Wayland context (windowPlan)
 */
function buildArgs(o = {}) {
  if (typeof o.ipcPath !== 'string' || !o.ipcPath) throw new Error('ipcPath is required');
  const framed = o.framed === true && !o.quiet;
  const keep = o.keepAspect === true;
  const fixed = framed || keep
    ? FIXED.map((a) => {
      if (framed && a === '--border=no') return '--border=yes';
      if (keep && a === '--keepaspect-window=no') return '--keepaspect-window=yes';
      return a;
    })
    : FIXED;
  const args = [...fitOptions(fixed, o.mpvOptions || null), hwdecArg(o.hwdec !== false, o.mpvVersion), `--input-ipc-server=${o.ipcPath}`, `--title=${titleArg(o.title)}`];
  if (o.x11) args.push(X11_CONTEXT);
  else if (o.wayland && o.pinWayland === true) args.push(WAYLAND_CONTEXT);
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

module.exports = { FIXED, DEFAULT_SIZE, QUIET_X, NEWER_OPTIONS, X11_CONTEXT, WAYLAND_CONTEXT, buildArgs, titleArg, geometryArg, hwdecArg, fitOptions, displayPlan, windowPlan, windowSystemOf, actualKind, linuxFrame, LINUX_FRAMES, DEFAULT_LINUX_FRAME };
