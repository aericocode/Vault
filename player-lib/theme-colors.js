/* =========================================================================
   THEME COLORS: the color math behind Settings > General > Look > Theme
   (.notes/THEMES_SPEC.md, token guide .notes/THEMES_TOKENS.md).

   Pure: no DOM, no storage. Loaded in <head> before theme-boot.js (browser
   global VaultThemeColors) and required by the node tests.

   Every palette, ready-made or Custom, is three values: a highlight, a
   second color and a background seed (Custom: the highlight when "Tint the
   background to match" is on, plain grey when off). derive() turns those
   plus a brightness into the palette's tokens, with the readability guard:
   the highlight and second color keep their hue but move in lightness until
   they read against the page, text on the highlight flips dark or white,
   and every text grey is pushed until it reads on every surface.

   Vault is hand-written in css/variables.css (dark on :root, light under
   :root[data-theme="light"]), so themeVars() gives nothing for it. Its light
   block holds exactly what derive() gives for Vault light (a test checks).
   ========================================================================= */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VaultThemeColors = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The six ready-made palettes. bg is the background seed (hue and strength of the tint). */
  const PALETTES = Object.freeze([
    { id: 'vault', name: 'Vault', bg: '#1a1a1a', accent: '#6366f1', second: '#ff4fa3' },
    { id: 'midnight', name: 'Midnight', bg: '#16203a', accent: '#38bdf8', second: '#a78bfa' },
    { id: 'ember', name: 'Ember', bg: '#2a1f18', accent: '#f97316', second: '#facc15' },
    { id: 'forest', name: 'Forest', bg: '#18261f', accent: '#34d399', second: '#fbbf24' },
    { id: 'rose', name: 'Rose', bg: '#2a1a26', accent: '#f472b6', second: '#c084fc' },
    { id: 'graphite', name: 'Graphite', bg: '#1c1e22', accent: '#cbd5e1', second: '#94a3b8' },
  ].map(Object.freeze));
  const PALETTE_IDS = PALETTES.map(p => p.id);
  const MODES = Object.freeze(['dark', 'light', 'system']);
  /** The grey Custom uses when the tint is off (Vault's own, so no hue). */
  const NEUTRAL_BG = '#1a1a1a';

  const DEFAULT_THEME = Object.freeze({
    mode: 'dark',
    palette: 'vault',
    custom: Object.freeze({ accent: '#2dd4bf', second: '#f5b83d', tint: true }),
  });

  /* The minimum contrast each kind of color has to keep (WCAG ratios). */
  const MIN = Object.freeze({ text: 4.5, accent: 3, onAccent: 4.5, second: 3, muted: 4.5 });

  /* ── Conversions ─────────────────────────────────────────────────────── */

  const isHex = (s) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function hexToRgb(hex) {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }
  /** { h: 0..360, s: 0..100, l: 0..100 } */
  function hexToHsl(hex) {
    const [r, g, b] = hexToRgb(hex).map(v => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0, s = 0;
    const l = (mx + mn) / 2;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: s * 100, l: l * 100 };
  }
  function hslToHex(h, s, l) {
    s = clamp(s, 0, 100) / 100;
    l = clamp(l, 0, 100) / 100;
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return rgbToHex([r + m, g + m, b + m].map(v => v * 255));
  }
  /** WCAG relative luminance of a #rrggbb color. */
  function luminance(hex) {
    const a = hexToRgb(hex).map(v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  /** WCAG contrast ratio between two #rrggbb colors (1..21). */
  function contrast(a, b) {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  const rgba = (hex, a) => `rgba(${hexToRgb(hex).join(', ')}, ${a})`;
  /** hex at alpha a laid over the opaque color under (what the eye sees). */
  function over(hex, a, under) {
    const f = hexToRgb(hex), u = hexToRgb(under);
    return rgbToHex(f.map((v, i) => v * a + u[i] * (1 - a)));
  }

  /**
   * Move lightness l by dir (+1 lighter, -1 darker) until color(l) has at
   * least `ratio` against every color in `against`. Stops at 0 or 100.
   */
  function pushUntil(color, l, against, ratio, dir) {
    const ok = (x) => against.every(c => contrast(color(x), c) >= ratio);
    while (!ok(l) && l + dir >= 0 && l + dir <= 100) l += dir;
    return l;
  }

  const ON_DARK = '#111114';
  const ON_LIGHT = '#ffffff';
  /** The label color for a button filled with `hex`: whichever of dark or white reads better. */
  function onColor(hex) {
    return contrast(hex, ON_LIGHT) >= contrast(hex, ON_DARK) ? ON_LIGHT : ON_DARK;
  }

  /* ── The derive function (the mock's derive(), plus the guard) ───────── */

  /* The grey ramp's lightness per brightness (the approved mock). Dark lands
     on today's Vault greys exactly when the seed has no hue. */
  const RAMP = Object.freeze({
    dark: { bg: 6, panel: 10, raised: 14.5, hover: 16.5, border: 20, text: 88, text2: 63, muted: 44,
      surface: 9.5, mText: 92.5, mText2: 73, mMuted: 57 },
    light: { bg: 96, panel: 99.5, raised: 92.5, hover: 89, border: 83, text: 12, text2: 35, muted: 46,
      surface: 99.5, mText: 12, mText2: 32, mMuted: 42 },
  });
  /* The highlight and second color are pulled into these lightness ranges first. */
  const ACCENT_L = Object.freeze({ dark: [55, 80], light: [36, 52] });
  const SECOND_L = Object.freeze({ dark: [52, 78], light: [38, 56] });

  /**
   * The palette tokens for seeds { bg, accent, second } in mode 'dark' | 'light'.
   * @returns {{ vars: Object<string,string>, nudged: { accent: boolean, second: boolean }, mode: string }}
   */
  function derive(p, mode) {
    const dark = mode !== 'light';
    const R = dark ? RAMP.dark : RAMP.light;
    const dir = dark ? 1 : -1;                 // which way "more readable" is for a color on the page
    const b = hexToHsl(isHex(p.bg) ? p.bg : NEUTRAL_BG);
    const a = hexToHsl(isHex(p.accent) ? p.accent : DEFAULT_THEME.custom.accent);
    const s2 = hexToHsl(isHex(p.second) ? p.second : DEFAULT_THEME.custom.second);
    // The tint: the seed's hue at a capped strength, so text contrast never drops.
    const sat = dark ? Math.min(b.s, 32) : Math.min(b.s * 1.3, 42);
    const surf = (l) => hslToHex(b.h, sat, l);
    const inkAt = (l) => hslToHex(b.h, sat * 0.3, l);

    const bg = surf(R.bg), panel = surf(R.panel), raised = surf(R.raised), hover = surf(R.hover);
    const border = surf(R.border), surface = surf(R.surface);
    const field = dark ? surf(11.5) : surf(100);
    const pageSurfaces = [bg, panel, raised];
    const ink = (l, against, ratio) => inkAt(pushUntil(inkAt, l, against, ratio, dir));

    const text = ink(R.text, [...pageSurfaces, hover, surface], MIN.text);
    const text2 = ink(R.text2, [...pageSurfaces, surface], MIN.text);
    // Hints are real sentences too (setting descriptions, group headers):
    // 4.5:1 on the page, panels, raised fills and fields.
    const muted = ink(R.muted, [...pageSurfaces, surface, field], MIN.muted);
    const mText = ink(R.mText, [...pageSurfaces, surface], MIN.text);
    const mText2 = ink(R.mText2, [...pageSurfaces, surface], MIN.text);
    const mMuted = ink(R.mMuted, [...pageSurfaces, surface, field], MIN.muted);

    // The highlight: in range, then readable on the page, then under its own label.
    const accAt = (l) => hslToHex(a.h, a.s, l);
    let aL = clamp(a.l, ...ACCENT_L[dark ? 'dark' : 'light']);
    aL = pushUntil(accAt, aL, [bg, panel], MIN.accent, dir);
    // The label on a filled button. Light: always white, with the fill darkened
    // (a few steps at most) until white reads at 4.5:1. A mid-tone fill scores
    // slightly higher with dark text by the WCAG sum, but reads far worse, and
    // Vault's own blue carries white. Dark: bright fills carry dark text.
    const labelOf = (hex) => dark ? onColor(hex) : ON_LIGHT;
    const labelOk = (l) => contrast(accAt(l), labelOf(accAt(l))) >= MIN.onAccent;
    while (!labelOk(aL) && aL + dir >= 0 && aL + dir <= 100) aL += dir;
    const accent = accAt(aL);
    // The highlight as text: 4.5:1 on everything it is drawn on, including
    // raised fills, hovered rows, fields and its own wash (--accent-bg).
    const accentBgA = dark ? 0.16 : 0.13;
    const accentText = accAt(pushUntil(accAt, clamp(aL + 12 * dir, 0, 100),
      [...pageSurfaces, hover, surface, field, ...[bg, panel, raised, surface].map(u => over(accent, accentBgA, u))],
      MIN.text, dir));

    const secAt = (l) => hslToHex(s2.h, s2.s, l);
    let sL = clamp(s2.l, ...SECOND_L[dark ? 'dark' : 'light']);
    sL = pushUntil(secAt, sL, [bg, panel], MIN.second, dir);

    return {
      mode: dark ? 'dark' : 'light',
      nudged: { accent: Math.abs(aL - a.l) > 4, second: Math.abs(sL - s2.l) > 4 },
      vars: {
        '--bg-primary': bg,
        '--bg-secondary': panel,
        '--bg-tertiary': raised,
        '--bg-hover': hover,
        '--border': border,
        '--tag-bg': dark ? border : hover,
        '--text-primary': text,
        '--text-secondary': text2,
        '--text-muted': muted,
        '--accent': accent,
        '--accent-hover': accAt(clamp(aL + 7 * dir, 0, 100)),
        '--accent-bg': rgba(accent, accentBgA),
        '--accent-text': accentText,
        '--on-accent': labelOf(accent),
        '--track-progress': secAt(sL),
        // Opaque in Light: thumbnails would show through a popover or toast.
        '--m-surface': rgba(surface, dark ? 0.96 : 1),
        '--m-surface-solid': surface,
        '--m-field-solid': field,
        '--m-text': mText,
        '--m-text-2': mText2,
        '--m-muted': mMuted,
      },
    };
  }

  /* ── Stored theme ────────────────────────────────────────────────────── */

  /** A complete, valid theme from anything (a stored blob, a hand edit). */
  function normalizeTheme(raw) {
    const t = raw && typeof raw === 'object' ? raw : {};
    const c = t.custom && typeof t.custom === 'object' ? t.custom : {};
    const d = DEFAULT_THEME;
    return {
      mode: MODES.includes(t.mode) ? t.mode : d.mode,
      palette: PALETTE_IDS.includes(t.palette) || t.palette === 'custom' ? t.palette : d.palette,
      custom: {
        accent: isHex(c.accent) ? c.accent.toLowerCase() : d.custom.accent,
        second: isHex(c.second) ? c.second.toLowerCase() : d.custom.second,
        tint: typeof c.tint === 'boolean' ? c.tint : d.custom.tint,
      },
    };
  }

  /** 'dark' | 'light' for a stored mode, given whether the system asks for light. */
  function resolveMode(mode, systemLight) {
    if (mode === 'light' || mode === 'dark') return mode;
    return mode === 'system' && systemLight ? 'light' : 'dark';
  }

  /** The three seeds of a (normalized) theme. */
  function seedsOf(theme) {
    const t = normalizeTheme(theme);
    if (t.palette === 'custom') {
      return { bg: t.custom.tint ? t.custom.accent : NEUTRAL_BG, accent: t.custom.accent, second: t.custom.second };
    }
    return PALETTES.find(p => p.id === t.palette);
  }

  /**
   * The custom properties to set inline on <html> for theme in 'dark' | 'light'.
   * Empty for Vault: css/variables.css carries it in both brightnesses.
   */
  function themeVars(theme, mode) {
    const t = normalizeTheme(theme);
    if (t.palette === 'vault') return {};
    return { ...derive(seedsOf(t), mode).vars, ...onPicture(t) };
  }

  /**
   * The highlight and second color as drawn ON the picture (--ov-accent,
   * --ov-progress): the Dark derivation in every brightness, since a video
   * frame is dark and the Light values are darkened for a light page.
   * Vault's are in css/variables.css (:root).
   */
  function onPicture(theme) {
    const t = normalizeTheme(theme);
    if (t.palette === 'vault') return { '--ov-accent': '#6366f1', '--ov-progress': '#ff4fa3', '--ov-on-accent': '#fff' };
    const d = derive(seedsOf(t), 'dark').vars;
    return { '--ov-accent': d['--accent'], '--ov-progress': d['--track-progress'], '--ov-on-accent': d['--on-accent'] };
  }

  /** The page background for theme in mode (the theme-color meta). */
  function pageColor(theme, mode) {
    return derive(seedsOf(theme), mode).vars['--bg-primary'];
  }

  /**
   * The line Settings shows when Custom's picks were moved to stay readable,
   * or '' when they were not.
   */
  function nudgeNote(theme, mode) {
    const t = normalizeTheme(theme);
    if (t.palette !== 'custom') return '';
    const { nudged } = derive(seedsOf(t), mode);
    const way = mode === 'light' ? 'darker' : 'lighter';
    const look = mode === 'light' ? 'Light' : 'Dark';
    if (nudged.accent && nudged.second) return `Your colors were made a little ${way} so they stay easy to read in ${look}.`;
    if (nudged.accent) return `Your highlight was made a little ${way} so it stays easy to read in ${look}.`;
    if (nudged.second) return `Your second color was made a little ${way} so it stays easy to see in ${look}.`;
    return '';
  }

  /**
   * The second color as the progress line on the picture draws it
   * (--ov-progress), for mpv Stage, which draws on the video. The same in
   * Dark and Light (callers still pass the mode; it is not needed).
   */
  function secondColor(theme) {
    return onPicture(theme)['--ov-progress'];
  }

  return {
    PALETTES, PALETTE_IDS, MODES, DEFAULT_THEME, NEUTRAL_BG, MIN,
    isHex, hexToRgb, rgbToHex, hexToHsl, hslToHex, luminance, contrast, onColor,
    derive, normalizeTheme, resolveMode, seedsOf, themeVars, onPicture, pageColor, nudgeNote, secondColor,
  };
});
