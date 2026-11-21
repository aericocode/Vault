/**
 * Themes (.notes/THEMES_SPEC.md, token guide .notes/THEMES_TOKENS.md):
 *  - player-lib/theme-colors.js  the color math: every preset and a sweep
 *    of custom picks stay readable in both brightnesses (text, hints and
 *    the highlight as text 4.5:1 on the page and on raised fills, the
 *    highlight and second color 3:1, labels on the highlight 4.5:1; on the
 *    picture the Dark variants in every brightness)
 *  - css/variables.css           Vault Dark is today's values, Vault Light
 *    is exactly derive(Vault, 'light'), every light token has a dark one
 *  - player-lib/theme-boot.js    what goes on <html>: nothing in Classic,
 *    whatever is stored; dark Vault for a fresh profile; Match system
 *  - player-lib/settings.js      the stored shape and its defaults; the
 *    Theme block only on Modern's General page
 *  - lib/stage                   mpv Stage's progress line takes the color
 *    the page sends (Stage setting lineColor)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const C = require('../player-lib/theme-colors.js');

/* ── Color math ──────────────────────────────────────────────────────── */

const TEXT = ['--text-primary', '--text-secondary', '--m-text', '--m-text-2', '--m-muted'];
const SURFACES = ['--bg-primary', '--bg-secondary', '--m-surface-solid'];

function checkReadable(vars, label) {
  for (const t of TEXT) {
    for (const s of SURFACES) {
      const r = C.contrast(vars[t], vars[s]);
      assert.ok(r >= 4.5, `${label}: ${t} on ${s} is ${r.toFixed(2)}:1`);
    }
  }
  for (const t of ['--text-primary', '--text-secondary']) {
    const r = C.contrast(vars[t], vars['--bg-tertiary']);
    assert.ok(r >= 4.5, `${label}: ${t} on --bg-tertiary is ${r.toFixed(2)}:1`);
  }
  for (const s of ['--bg-primary', '--bg-secondary']) {
    const a = C.contrast(vars['--accent'], vars[s]);
    assert.ok(a >= 3, `${label}: highlight on ${s} is ${a.toFixed(2)}:1`);
    const p = C.contrast(vars['--track-progress'], vars[s]);
    assert.ok(p >= 3, `${label}: second color on ${s} is ${p.toFixed(2)}:1`);
  }
  // The highlight as text, and hints, are read as sentences: 4.5:1 on the
  // page, panels, raised fills, fields, and (accent text) its own wash.
  const raisedAll = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--m-surface-solid', '--m-field-solid'];
  for (const s of [...raisedAll, '--bg-hover']) {
    const at = C.contrast(vars['--accent-text'], vars[s]);
    assert.ok(at >= 4.5, `${label}: accent text on ${s} is ${at.toFixed(2)}:1`);
  }
  for (const s of raisedAll) {
    for (const t of ['--text-muted', '--m-muted']) {
      const m = C.contrast(vars[t], vars[s]);
      assert.ok(m >= 4.5, `${label}: ${t} on ${s} is ${m.toFixed(2)}:1`);
    }
  }
  const wash = vars['--accent-bg'].match(/[\d.]+/g).map(Number);
  for (const s of ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--m-surface-solid']) {
    const u = C.hexToRgb(vars[s]);
    const under = C.rgbToHex(u.map((v, i) => wash[i] * wash[3] + v * (1 - wash[3])));
    const at = C.contrast(vars['--accent-text'], under);
    assert.ok(at >= 4.5, `${label}: accent text on the accent wash over ${s} is ${at.toFixed(2)}:1`);
  }
  const on = C.contrast(vars['--on-accent'], vars['--accent']);
  assert.ok(on >= 4.5, `${label}: label on the highlight is ${on.toFixed(2)}:1`);
}

test('color math: conversions round-trip and contrast matches WCAG', () => {
  for (const hex of ['#000000', '#ffffff', '#6366f1', '#ff4fa3', '#16203a', '#cbd5e1']) {
    const { h, s, l } = C.hexToHsl(hex);
    assert.strictEqual(C.hslToHex(h, s, l), hex);
  }
  assert.strictEqual(Math.round(C.contrast('#000000', '#ffffff')), 21);
  assert.strictEqual(C.contrast('#777777', '#777777'), 1);
  assert.strictEqual(C.onColor('#ffff00'), '#111114');
  assert.strictEqual(C.onColor('#1e1b4b'), '#ffffff');
});

test('every preset is readable in Dark and Light', () => {
  for (const p of C.PALETTES) {
    for (const mode of ['dark', 'light']) checkReadable(C.derive(p, mode).vars, `${p.id} ${mode}`);
  }
});

test('custom picks: a sweep of hues, strengths and lightnesses, tint on and off, stays readable', () => {
  let n = 0;
  for (let h = 0; h < 360; h += 15) {
    for (const s of [0, 35, 70, 100]) {
      for (const l of [8, 25, 45, 60, 75, 92]) {
        const hex = C.hslToHex(h, s, l);
        const second = C.hslToHex((h + 137) % 360, s, 100 - l);
        for (const tint of [true, false]) {
          const theme = { palette: 'custom', custom: { accent: hex, second, tint } };
          for (const mode of ['dark', 'light']) {
            checkReadable(C.derive(C.seedsOf(theme), mode).vars, `custom ${hex}/${second} tint ${tint} ${mode}`);
            n++;
          }
        }
      }
    }
  }
  assert.ok(n > 2000);
});

test('the guard keeps the hue and says when it moved a pick', () => {
  const pale = { palette: 'custom', custom: { accent: '#fde047', second: '#fef08a', tint: true } };
  const d = C.derive(C.seedsOf(pale), 'light');
  assert.ok(Math.abs(C.hexToHsl(d.vars['--accent']).h - C.hexToHsl('#fde047').h) < 3, 'same hue');
  assert.strictEqual(d.nudged.accent, true);
  assert.match(C.nudgeNote(pale, 'light'), /darker so they stay easy to read in Light\./);
  const fine = { palette: 'custom', custom: { accent: '#6d28d9', second: '#db2777', tint: false } };
  assert.strictEqual(C.nudgeNote(fine, 'light'), '');
  assert.match(C.nudgeNote({ ...fine, custom: { ...fine.custom, accent: '#1e1b4b' } }, 'dark'), /^Your highlight was made a little lighter so it stays easy to read in Dark\.$/);
  assert.strictEqual(C.nudgeNote({ palette: 'midnight' }, 'light'), '', 'presets never show the note');
  for (const m of ['dark', 'light']) assert.ok(!/—/.test(C.nudgeNote(pale, m)), 'no em dash');
});

test('tint off is plain grey; tint on takes the highlight hue', () => {
  const off = C.derive(C.seedsOf({ palette: 'custom', custom: { accent: '#22c55e', second: '#f59e0b', tint: false } }), 'dark').vars;
  assert.strictEqual(off['--bg-primary'], '#0f0f0f');
  assert.strictEqual(off['--bg-secondary'], '#1a1a1a');
  const on = C.derive(C.seedsOf({ palette: 'custom', custom: { accent: '#22c55e', second: '#f59e0b', tint: true } }), 'dark').vars;
  const hsl = C.hexToHsl(on['--bg-secondary']);
  assert.ok(Math.abs(hsl.h - C.hexToHsl('#22c55e').h) < 6 && hsl.s > 5, `tinted green: ${on['--bg-secondary']}`);
});

/* ── Stored theme ────────────────────────────────────────────────────── */

test('normalizeTheme: defaults are Dark + Vault, anything bad falls back', () => {
  assert.deepStrictEqual(C.normalizeTheme(undefined), { mode: 'dark', palette: 'vault', custom: { accent: '#2dd4bf', second: '#f5b83d', tint: true } });
  assert.deepStrictEqual(C.normalizeTheme({ mode: 'neon', palette: 'lava', custom: { accent: 'red', second: '#ABCDEF', tint: 'yes' } }),
    { mode: 'dark', palette: 'vault', custom: { accent: '#2dd4bf', second: '#abcdef', tint: true } });
  assert.deepStrictEqual(C.normalizeTheme({ mode: 'system', palette: 'custom', custom: { tint: false } }).custom.tint, false);
  assert.strictEqual(C.resolveMode('system', true), 'light');
  assert.strictEqual(C.resolveMode('system', false), 'dark');
  assert.strictEqual(C.resolveMode('light', false), 'light');
  assert.deepStrictEqual(C.themeVars({ palette: 'vault', mode: 'light' }, 'light'), {}, 'Vault lives in variables.css');
  assert.ok(Object.keys(C.themeVars({ palette: 'ember' }, 'dark')).length > 15);
  assert.strictEqual(C.secondColor(null, 'dark'), '#ff4fa3');
});

test('on the picture: the highlight and second color keep their Dark values in Light, and mpv gets that line', () => {
  for (const p of C.PALETTES) {
    const dark = p.id === 'vault' ? { '--accent': '#6366f1', '--track-progress': '#ff4fa3' } : C.derive(p, 'dark').vars;
    for (const mode of ['dark', 'light']) {
      const theme = { palette: p.id, mode };
      assert.strictEqual(C.secondColor(theme, mode), dark['--track-progress'], `${p.id} ${mode} mpv line`);
      if (p.id === 'vault') { assert.deepStrictEqual(C.themeVars(theme, mode), {}); continue; }
      const v = C.themeVars(theme, mode);
      assert.strictEqual(v['--ov-progress'], dark['--track-progress'], `${p.id} ${mode}`);
      assert.strictEqual(v['--ov-accent'], dark['--accent'], `${p.id} ${mode}`);
      // Readable against a dark frame (the video's own black).
      for (const k of ['--ov-progress', '--ov-accent']) {
        const r = C.contrast(v[k], '#000000');
        assert.ok(r >= 3, `${p.id} ${mode} ${k} on black is ${r.toFixed(2)}:1`);
      }
    }
  }
  // Midnight Light used to send its darkened page purple (#5c28f6, 2.6:1 on black).
  assert.strictEqual(C.secondColor({ palette: 'midnight' }, 'light'), '#a78bfa');
});

/* ── variables.css ───────────────────────────────────────────────────── */

function cssBlock(css, selector) {
  const i = css.indexOf(selector + ' {');
  assert.ok(i >= 0, `no ${selector} block`);
  const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('\n}', i));
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const CSS = read('css/variables.css');
const DARK = cssBlock(CSS, ':root');
const LIGHT = cssBlock(CSS, ':root[data-theme="light"]');

test('variables.css: Vault Dark keeps every value it had before themes', () => {
  const before = {
    '--bg-primary': '#0f0f0f', '--bg-secondary': '#1a1a1a', '--bg-tertiary': '#252525', '--bg-hover': '#2a2a2a',
    '--text-primary': '#e0e0e0', '--text-secondary': '#a0a0a0', '--text-muted': '#666',
    '--accent': '#6366f1', '--accent-hover': '#818cf8', '--accent-bg': 'rgba(99, 102, 241, 0.16)',
    '--brand': 'var(--gamify-a, var(--accent))', '--track-progress': '#ff4fa3', '--border': '#333',
    '--success': '#22c55e', '--warning': '#f59e0b', '--danger': '#ef4444', '--now-playing': '#22c55e',
    '--tag-bg': '#333', '--boost-color': '#f59e0b',
    '--player-bg': 'rgba(0, 0, 0, 0.85)', '--player-control-bg': 'rgba(255, 255, 255, 0.1)',
    '--player-control-hover': 'rgba(255, 255, 255, 0.25)', '--player-border': 'rgba(255, 255, 255, 0.1)',
    '--m-surface': 'rgba(22, 22, 27, 0.96)', '--m-surface-solid': '#16161b', '--m-border': 'rgba(255, 255, 255, 0.12)',
    '--m-border-strong': 'rgba(255, 255, 255, 0.14)', '--m-field': 'rgba(255, 255, 255, 0.05)', '--m-btn': 'rgba(255, 255, 255, 0.06)',
    '--m-btn-hover': 'rgba(255, 255, 255, 0.11)', '--m-text': '#ececf1', '--m-text-2': '#b4b4bf', '--m-muted': '#8b8b97',
    '--m-danger-text': '#fca5a5', '--m-success-text': '#86efac', '--m-radius': '12px', '--m-radius-sm': '8px',
    '--m-shadow': '0 12px 32px rgba(0, 0, 0, 0.45)',
  };
  for (const [k, v] of Object.entries(before)) assert.strictEqual(DARK[k], v, k);
});

test('variables.css: the tint and shade ladders are named by their dark alpha', () => {
  for (const [k, v] of Object.entries(DARK)) {
    const t = k.match(/^--tint-(\d\d)$/);
    if (t) assert.strictEqual(v, `rgba(255, 255, 255, ${Number(t[1]) / 100})`, k);
    const s = k.match(/^--(?:shade|ov-black)-(\d\d)$/);
    if (s) assert.strictEqual(v, `rgba(0, 0, 0, ${Number(s[1]) / 100})`, k);
    const w = k.match(/^--ov-white-(\d\d)$/);
    if (w) assert.strictEqual(v, `rgba(255, 255, 255, ${Number(w[1]) / 100})`, k);
  }
  for (const k of Object.keys(LIGHT)) {
    if (/^--tint-/.test(k)) assert.match(LIGHT[k], /^rgba\(0, 0, 0, /, `${k} is black in light`);
  }
});

test('variables.css: Vault Light is derive(Vault, light), light only overrides tokens dark has, over-video never changes', () => {
  const d = C.derive(C.PALETTES[0], 'light').vars;
  for (const [k, v] of Object.entries(d)) assert.strictEqual(LIGHT[k], v, `${k}: css ${LIGHT[k]} vs derive ${v}`);
  for (const k of Object.keys(LIGHT)) assert.ok(k in DARK, `${k} has no dark value`);
  for (const k of Object.keys(LIGHT)) assert.ok(!/^--(ov-|player-)/.test(k), `${k} sits on the picture and must not change`);
  // Every palette token derive() writes inline exists in :root, so Classic and Vault have it too.
  for (const k of Object.keys(d)) assert.ok(k in DARK, `${k} missing from :root`);
  // Meaning colors as text stay readable in Light on the page.
  for (const k of ['--success', '--danger', '--warning-text', '--danger-text', '--m-danger-text', '--m-success-text', '--star', '--type-video-text', '--type-image-text', '--type-gif-text', '--type-audio-text', '--accent-text']) {
    for (const bg of ['--bg-primary', '--bg-secondary']) {
      const r = C.contrast(LIGHT[k], LIGHT[bg]);
      assert.ok(r >= 4.5, `light ${k} on ${bg}: ${r.toFixed(2)}:1`);
    }
  }
});

/* Guards over the whole of css/ (integration pass). */
function cssFiles(dir = path.join(ROOT, 'css')) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) out.push(...cssFiles(p));
    else if (f.endsWith('.css')) out.push(p);
  }
  return out;
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const ALL_CSS = cssFiles().map(p => ({ file: path.relative(ROOT, p), css: stripComments(fs.readFileSync(p, 'utf8')) }));

test('css/: every var(--x) without a fallback names a property something defines', () => {
  const defined = new Set();
  for (const { css } of ALL_CSS) for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  // Set at run time from JS (style.setProperty, inline style strings).
  const js = ['player-lib', 'db-viewer.html'].map(p => {
    const full = path.join(ROOT, p);
    if (!fs.statSync(full).isDirectory()) return fs.readFileSync(full, 'utf8');
    const all = [];
    (function walk(d) {
      for (const f of fs.readdirSync(d)) {
        const q = path.join(d, f);
        if (fs.statSync(q).isDirectory()) walk(q);
        else if (f.endsWith('.js')) all.push(fs.readFileSync(q, 'utf8'));
      }
    })(full);
    return all.join('\n');
  }).join('\n');
  const missing = [];
  for (const { file, css } of ALL_CSS) {
    for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      const name = m[1];
      if (defined.has(name)) continue;
      if (new RegExp(`['"\`]${name}['"\`]|${name}\\s*:`).test(js)) continue;
      missing.push(`${file}: ${name}`);
    }
  }
  assert.deepStrictEqual([...new Set(missing)], []);
});

test('variables.css: every token a Light or palette block sets exists in :root', () => {
  const css = stripComments(CSS);
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (sel === ':root' || sel.startsWith('body.')) continue;
    assert.match(sel, /^:root\[data-(theme|palette)/, `unexpected block ${sel}`);
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:/g)) {
      assert.ok(d[1] in DARK, `${d[1]} (in ${sel.replace(/\s+/g, ' ')}) has no :root value`);
      assert.ok(!/^--(ov-|player-)/.test(d[1]), `${d[1]} sits on the picture and must not change`);
    }
  }
});

test('Classic can never match a theme selector: data-theme / data-palette only on <html>, only from theme-boot.js', () => {
  // theme-boot.js puts nothing on <html> in Classic (tested above). Other
  // elements use data-theme too (the Classic level theme picker), so every
  // theme selector must be anchored on :root / html.
  for (const { file, css } of ALL_CSS) {
    for (const m of css.matchAll(/([^{}]*)\{/g)) {
      for (const part of m[1].split(',')) {
        if (!/\[data-(theme|palette)[=\]]/.test(part)) continue;
        assert.match(part.trim(), /^(:root|html)\[data-(theme|palette)/, `${file}: ${part.trim()}`);
      }
    }
  }
  const setters = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const q = path.join(d, f);
      if (fs.statSync(q).isDirectory()) walk(q);
      else if (f.endsWith('.js') && /setAttribute\(\s*['"]data-(theme|palette)['"]|dataset\.(theme|palette)\s*=[^=]/.test(fs.readFileSync(q, 'utf8'))) setters.push(path.relative(ROOT, q));
    }
  })(path.join(ROOT, 'player-lib'));
  assert.deepStrictEqual(setters, [path.join('player-lib', 'theme-boot.js')]);
});

test('variables.css: Modern takes brand and score colors from the theme', () => {
  const body = cssBlock(CSS, 'body.layout-modern');
  assert.strictEqual(body['--brand'], 'var(--accent)');
  assert.strictEqual(body['--gamify-a'], 'var(--accent)');
  assert.strictEqual(body['--gamify-b'], 'var(--track-progress)');
  assert.strictEqual(body['--brand-text'], 'var(--accent-fg)');
});

test('css/: the highlight as text goes through --accent-fg (exact in Vault Dark, 4.5:1 everywhere else)', () => {
  assert.strictEqual(DARK['--accent-fg'], 'var(--accent)');
  assert.strictEqual(DARK['--accent-hover-fg'], 'var(--accent-hover)');
  const others = cssBlock(CSS, ':root[data-theme="light"],\n:root[data-palette]:not([data-palette="vault"])');
  assert.strictEqual(others['--accent-fg'], 'var(--accent-text)');
  assert.strictEqual(others['--accent-hover-fg'], 'var(--accent-text)');
  // Drawings, not text: chart shapes and rings. The
  // logo's --accent is only Classic's last fallback.
  const allowed = /flow-chart|act-ring-fg|ft-head-ring|^\s*\.logo\s*$/;
  const bad = [];
  for (const { file, css } of ALL_CSS) {
    if (file.endsWith('variables.css')) continue;
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const d of m[2].matchAll(/(?:^|[;\s])(color|fill|stroke)\s*:\s*([^;]*)/g)) {
        if (!/var\(--(accent|accent-hover|track-progress)\s*[,)]/.test(d[2])) continue;
        if (allowed.test(m[1])) continue;
        bad.push(`${file}: ${m[1].trim().replace(/\s+/g, ' ')} { ${d[1]}: ${d[2].trim()} }`);
      }
    }
  }
  assert.deepStrictEqual(bad, []);
});

/* ── theme-boot.js: what goes on <html> ──────────────────────────────── */

function boot(stored, { systemLight = false } = {}) {
  const attrs = {}, style = {};
  let meta = null;
  const listeners = [];
  const events = [];
  const root = {
    setAttribute: (k, v) => { attrs[k] = String(v); }, removeAttribute: (k) => { delete attrs[k]; },
    style: { setProperty: (k, v) => { style[k] = v; }, removeProperty: (k) => { delete style[k]; } },
  };
  const ctx = {
    console, JSON, Object, Math,
    localStorage: { getItem: () => (stored === undefined ? null : JSON.stringify(stored)) },
    matchMedia: () => ({ get matches() { return systemLight; }, addEventListener: (_e, f) => listeners.push(f) }),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    dispatchEvent: (e) => events.push(e),
    document: {
      documentElement: root, head: { appendChild: (m) => { meta = m; } },
      querySelector: () => meta,
      createElement: () => { const m = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }; return m; },
    },
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('player-lib/theme-colors.js'), ctx);
  vm.runInContext(read('player-lib/theme-boot.js'), ctx);
  return {
    attrs, style, events, ctx,
    meta: () => meta && meta.attrs.content,
    flipSystem: (light) => { systemLight = light; listeners.forEach(f => f()); },
  };
}

test('theme-boot: a fresh profile is dark Vault with nothing inline', () => {
  const b = boot(undefined);
  assert.deepStrictEqual({ ...b.attrs }, { 'data-theme': 'dark', 'data-palette': 'vault' });
  assert.deepStrictEqual({ ...b.style }, {});
  assert.strictEqual(b.meta(), '#0f0f0f');
});

test('theme-boot: Classic gets nothing on <html>, whatever theme is stored', () => {
  for (const theme of [{ mode: 'light', palette: 'vault' }, { mode: 'dark', palette: 'ember' }, { mode: 'system', palette: 'custom', custom: { accent: '#ff0000' } }]) {
    const b = boot({ layoutStyle: 'classic', theme }, { systemLight: true });
    assert.deepStrictEqual({ ...b.attrs }, {}, JSON.stringify(theme));
    assert.deepStrictEqual({ ...b.style }, {}, JSON.stringify(theme));
    assert.strictEqual(b.meta(), '#0f0f0f');
    assert.strictEqual(b.events[b.events.length - 1].detail.second, '#ff4fa3', 'mpv keeps the pink');
  }
});

test('theme-boot: a palette goes inline, Light sets data-theme, switching back to Classic clears it all', () => {
  const b = boot({ theme: { mode: 'light', palette: 'midnight' } });
  assert.strictEqual(b.attrs['data-theme'], 'light');
  assert.strictEqual(b.attrs['data-palette'], 'midnight');
  assert.strictEqual(b.style['--accent'], C.derive(C.PALETTES[1], 'light').vars['--accent']);
  assert.strictEqual(b.meta(), C.derive(C.PALETTES[1], 'light').vars['--bg-primary']);
  b.ctx.vaultThemeApply({ mode: 'light', palette: 'midnight' }, false);
  assert.deepStrictEqual({ ...b.attrs }, {});
  assert.deepStrictEqual({ ...b.style }, {});
});

test('theme-boot: Match system follows the OS live', () => {
  const b = boot({ theme: { mode: 'system', palette: 'vault' } }, { systemLight: false });
  assert.strictEqual(b.attrs['data-theme'], 'dark');
  b.flipSystem(true);
  assert.strictEqual(b.attrs['data-theme'], 'light');
  assert.strictEqual(b.meta(), '#f5f5f5');
  const fixed = boot({ theme: { mode: 'dark', palette: 'vault' } });
  fixed.flipSystem(true);
  assert.strictEqual(fixed.attrs['data-theme'], 'dark', 'a fixed brightness ignores the OS');
});

test('db-viewer.html loads the theme scripts in <head>, before the first stylesheet', () => {
  const html = read('db-viewer.html');
  const head = html.slice(0, html.indexOf('</head>'));
  const colors = head.indexOf('player-lib/theme-colors.js');
  const bootAt = head.indexOf('player-lib/theme-boot.js');
  const css = head.indexOf('rel="stylesheet"');
  assert.ok(colors > 0 && bootAt > colors && css > bootAt);
  assert.match(head, /<meta name="theme-color" content="#0f0f0f">/);
});

/* ── settings.js ─────────────────────────────────────────────────────── */

function loadSettings(stored) {
  const store = { vault_settings: JSON.stringify(stored) };
  const applied = [];
  const noop = () => {};
  const stubEl = () => ({
    addEventListener: noop, appendChild: noop, prepend: noop, insertAdjacentHTML: noop,
    setAttribute: noop, removeAttribute: noop, querySelector: () => stubEl(), querySelectorAll: () => [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: {}, dataset: {},
  });
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, Date, Promise, Error, Symbol,
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop, requestAnimationFrame: noop,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { port: '8765', hostname: '127.0.0.1' },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    escapeHtml: (s) => String(s ?? ''), showToast: noop,
    vaultThemeApply: (theme, modern) => applied.push({ theme, modern }),
  };
  ctx.document = {
    readyState: 'complete', addEventListener: noop, body: stubEl(), documentElement: stubEl(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: stubEl,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.addEventListener = noop;
  ctx.dispatchEvent = noop;
  vm.createContext(ctx);
  vm.runInContext(read('player-lib/theme-colors.js'), ctx);
  for (const f of ['icons.js', 'shortcuts.js', 'settings-kit.js', 'thumb-settings-ui.js', 'watchers-ui.js', 'scan-settings-ui.js', 'stage-settings-ui.js', 'share-client.js', 'share-ui.js', 'share-settings-ui.js', 'settings.js']) {
    vm.runInContext(read(path.join('player-lib', f)), ctx);
  }
  return { ctx, store, applied, saved: () => JSON.parse(store.vault_settings) };
}

test('settings.js: no stored theme means Dark + Vault, and nothing is written for it', () => {
  const s = loadSettings({ layoutStyle: 'modern' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.ctx.vaultTheme())), C.normalizeTheme(null));
  assert.ok(!('theme' in s.saved()) || s.saved().theme === null, 'a profile that never picked stores no theme');
  assert.strictEqual(s.applied.length, 1);
  assert.strictEqual(s.applied[0].modern, true);
});

test('settings.js: a change is saved in vault_settings.theme and applied; Classic applies it as Classic', () => {
  const s = loadSettings({ layoutStyle: 'modern' });
  s.ctx.vaultSetTheme({ mode: 'light' });
  s.ctx.vaultSetTheme({ palette: 'custom' });
  s.ctx.vaultSetTheme({ custom: { accent: '#123456' } });
  assert.deepStrictEqual(s.saved().theme, { mode: 'light', palette: 'custom', custom: { accent: '#123456', second: '#f5b83d', tint: true } });
  assert.strictEqual(s.applied[s.applied.length - 1].theme.custom.accent, '#123456');
  const c = loadSettings({ layoutStyle: 'classic', theme: { mode: 'light', palette: 'rose' } });
  assert.strictEqual(c.applied[0].modern, false, 'Classic: theme-boot is told to put nothing on the page');
  assert.strictEqual(c.ctx.vaultTheme().palette, 'rose', 'the stored choice is kept for Modern');
});

test('settings.js: the Theme block is on Modern General only, with the mock\'s choices and no em dashes', () => {
  const src = read('player-lib/settings.js');
  const block = src.slice(src.indexOf('function themeBlockHtml'), src.indexOf('function syncThemeUI'));
  for (const w of ['Brightness', 'Colors', 'Custom: pick your own colors', 'Highlight', 'Second color', 'Tint the background to match']) {
    assert.ok(block.includes(w), w);
  }
  assert.ok(!/—/.test(block), 'no em dash in the Theme block');
  assert.match(src, /\{ value: 'dark', label: 'Dark' \}, \{ value: 'light', label: 'Light' \}, \{ value: 'system', label: 'Match system' \}/);
  const general = src.slice(src.indexOf('function RENDERERS_general'), src.indexOf('function instanceRowsModern'));
  assert.match(general, /themeBlockHtml\(\)/);
  assert.strictEqual((src.match(/(?<!function )themeBlockHtml\(\)/g) || []).length, 1, 'only one page draws it');
});

/* ── Level colors retired in Modern ──────────────────────────────────── */

test('gamify-ui.js: level colors are written in Classic only, and Modern has no level color picker', () => {
  const src = read('player-lib/gamify-ui.js');
  const fn = src.slice(src.indexOf('function applyTheme'), src.indexOf('/* ── Header chip'));
  assert.match(fn, /if \(isModern\(\)\) \{\s*root\.style\.removeProperty\('--gamify-a'\);\s*root\.style\.removeProperty\('--gamify-b'\);\s*return;/);
  assert.match(src, /\(isModern\(\) \? '' : sectionThemes\(stats\)\)/);
  assert.match(src, /stop-color:var\(--accent\)/);
});

/* ── mpv Stage's line ────────────────────────────────────────────────── */

test('mpv Stage: the progress line takes lineColor, pink by default, and the setting is checked', () => {
  const Overlay = require('../lib/stage/mpv-overlay');
  const Settings = require('../lib/stage/settings');
  assert.strictEqual(Overlay.assColor('#38bdf8'), '&HF8BD38&');
  assert.strictEqual(Overlay.assColor('nope'), Overlay.LINE_RGB);
  assert.match(Overlay.lineEvent(0.5, { color: '#a78bfa' }), /\\1c&HFA8BA7&/);
  assert.match(Overlay.lineEvent(0.5), new RegExp(Overlay.LINE_RGB));
  assert.strictEqual(Settings.DEFAULTS.lineColor, '#ff4fa3');
  assert.strictEqual(Settings.normalize({ lineColor: '#A78BFA' }).lineColor, '#a78bfa');
  assert.strictEqual(Settings.normalize({ lineColor: 'red' }).lineColor, '#ff4fa3');
  assert.strictEqual(Settings.validatePatch({ lineColor: 'red' }, {}).ok, false);
  assert.strictEqual(Settings.validatePatch({ lineColor: '#38bdf8' }, {}).settings.lineColor, '#38bdf8');
  assert.match(read('lib/stage/engine.js'), /lineEvent\(p\.frac, \{ canvasW: cw, osdH: mp\.oh, fade: lineFade, color: lineColorNow\(\) \}\)/);
});

test('Light: a filled highlight button always carries white text at 4.5:1 or better', () => {
  const T = require('../player-lib/theme-colors.js');
  const seeds = [...T.PALETTES.map(p => p.accent), '#facc15', '#84cc16', '#2dd4bf', '#ef4444', '#22d3ee', '#ffffff', '#000000'];
  for (const accent of seeds) {
    const v = T.derive({ bg: '#1a1a1a', accent, second: '#ff4fa3' }, 'light').vars;
    assert.equal(v['--on-accent'], '#ffffff', accent);
    assert.ok(T.contrast(v['--accent'], '#ffffff') >= 4.5, `${accent} -> ${v['--accent']}`);
  }
});
