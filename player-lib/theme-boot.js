/* =========================================================================
   THEME BOOT: puts the theme on <html> before the first paint.

   Loaded blocking in <head>, right after theme-colors.js and before the
   stylesheets, so a Light theme never flashes dark. It reads the theme from
   the vault_settings blob itself (settings.js loads much later, at the end
   of <body>); after that settings.js owns the setting and calls
   vaultThemeApply() whenever the theme or the Library look changes.

   Themes are a Modern-look feature. In Classic (layoutStyle 'classic') this
   puts nothing on <html>, so Classic is exactly Vault Dark whatever is stored.

   On <html>, Modern only:
   - data-theme="dark|light"   the brightness in use (Match system resolved)
   - data-palette="vault|midnight|ember|forest|rose|graphite|custom"
   - inline custom properties for every palette but Vault (theme-colors.js)
   And <meta name="theme-color"> tracks the page background.

   Match system follows the OS live. Every apply fires 'vault:theme' on
   window with { mode, palette, second } for canvases and mpv Stage.
   ========================================================================= */

(function () {
  const C = window.VaultThemeColors;
  if (!C) return;
  const root = document.documentElement;
  let mq = null;
  try { mq = window.matchMedia('(prefers-color-scheme: light)'); } catch {}

  let state = { theme: C.normalizeTheme(null), modern: true };
  let inlineKeys = [];

  function readStored() {
    try {
      const raw = JSON.parse(localStorage.getItem('vault_settings') || 'null');
      if (raw && typeof raw === 'object') {
        return { theme: C.normalizeTheme(raw.theme), modern: raw.layoutStyle !== 'classic' };
      }
    } catch {}
    return { theme: C.normalizeTheme(null), modern: true };
  }

  function setMeta(color) {
    let m = document.querySelector('meta[name="theme-color"]');
    if (!m) {
      m = document.createElement('meta');
      m.name = 'theme-color';
      (document.head || root).appendChild(m);
    }
    m.setAttribute('content', color);
  }

  function apply(theme, modern) {
    state = { theme: C.normalizeTheme(theme), modern: modern !== false };
    for (const k of inlineKeys) root.style.removeProperty(k);
    inlineKeys = [];
    if (!state.modern) {
      root.removeAttribute('data-theme');
      root.removeAttribute('data-palette');
      setMeta('#0f0f0f');
      fire('dark');
      return;
    }
    const mode = C.resolveMode(state.theme.mode, !!(mq && mq.matches));
    root.setAttribute('data-theme', mode);
    root.setAttribute('data-palette', state.theme.palette);
    const vars = C.themeVars(state.theme, mode);
    for (const [k, v] of Object.entries(vars)) {
      root.style.setProperty(k, v);
      inlineKeys.push(k);
    }
    setMeta(C.pageColor(state.theme, mode));
    fire(mode);
  }

  function fire(mode) {
    const detail = {
      mode,
      palette: state.modern ? state.theme.palette : 'vault',
      second: state.modern ? C.secondColor(state.theme, mode) : C.secondColor(null, 'dark'),
    };
    try { window.dispatchEvent(new CustomEvent('vault:theme', { detail })); } catch {}
  }

  /** Put theme on the page now. modern: the Library look is Modern. */
  window.vaultThemeApply = apply;
  /** What is on the page: { theme, modern, mode, second }. */
  window.vaultThemeNow = () => {
    const mode = state.modern ? C.resolveMode(state.theme.mode, !!(mq && mq.matches)) : 'dark';
    return {
      theme: state.theme, modern: state.modern, mode,
      second: state.modern ? C.secondColor(state.theme, mode) : C.secondColor(null, 'dark'),
    };
  };

  // Match system: follow the OS while the page is open.
  if (mq) {
    const onChange = () => { if (state.theme.mode === 'system') apply(state.theme, state.modern); };
    try { mq.addEventListener('change', onChange); } catch { try { mq.addListener(onChange); } catch {} }
  }

  const s = readStored();
  apply(s.theme, s.modern);
})();
