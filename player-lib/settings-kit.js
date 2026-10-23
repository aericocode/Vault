/* =========================================================================
   SETTINGS KIT - the building blocks every Settings page is made of, and
   the map of pages for each look.

   - settingsRowHtml(o)    one setting: its name and a short line on the
                           left, its control on the right. The same markup
                           in both looks (.settings-toggle); Modern styles it
                           as a row inside a card (css/settings-modern.css).
   - settingsCardHtml(o)   Modern: a card per group with a small uppercase
                           heading. Classic pages keep their own headings.
   - settingsFoldHtml(o)   Modern: an "Advanced" fold for developer details
                           (environment variables, command-line flags).
   - settingsDialogHtml(o) Modern: a small dialog that lives in the page and
                           opens from any [data-dlg-open="<id>"] button
                           (settings.js wires the open and close).
   - SETTINGS_PAGES_MODERN, settingsResolvePage(id, look): the Modern menu
     (grouped, with line icons) and how a page id from either look finds its
     page in the other, so a deep link like vaultOpenSettings('backend')
     still lands on AI servers.

   Loaded before thumb-settings-ui.js, watchers-ui.js, scan-settings-ui.js,
   settings.js, settings-search.js and faces.js, which all draw with it.
   ========================================================================= */

/** True when the Modern look is on (settings.js owns the setting). */
function settingsIsModern() {
  return typeof window !== 'undefined' && typeof window.isModernLayout === 'function' && window.isModernLayout();
}

/**
 * One setting row. title and desc are HTML already. tag: 'label' when the
 * whole row should toggle its control, 'div' otherwise. extra: more markup
 * after the description, inside the text column.
 */
function settingsRowHtml({ tag = 'div', sfind = '', cls = '', title = '', titleId = '', desc = '', extra = '', control = '', attrs = '' }) {
  return `
      <${tag} class="settings-toggle${cls ? ` ${cls}` : ''}"${sfind ? ` data-sfind="${sfind}"` : ''}${attrs}>
        <span class="settings-toggle-text">
          <span class="settings-toggle-title"${titleId ? ` id="${titleId}"` : ''}>${title}</span>
          ${desc ? `<span class="settings-toggle-desc">${desc}</span>` : ''}${extra}
        </span>
        ${control}
      </${tag}>`;
}

/** A group of rows under a small uppercase heading (Modern). */
function settingsCardHtml({ title = '', body = '', sfind = '', id = '', cls = '', hidden = false }) {
  return `
    <section class="settings-card${cls ? ` ${cls}` : ''}"${id ? ` id="${id}"` : ''}${sfind ? ` data-sfind="${sfind}"` : ''}${hidden ? ' hidden' : ''}>
      ${title ? `<h3 class="settings-card-h">${title}</h3>` : ''}
      ${body}
    </section>`;
}

/** The "Advanced" fold at the end of a card: developer details only. */
function settingsFoldHtml({ title = 'Advanced', body = '', sfind = '', id = '' }) {
  return `
      <details class="settings-fold"${id ? ` id="${id}"` : ''}${sfind ? ` data-sfind="${sfind}"` : ''}>
        <summary>${title}</summary>
        <div class="settings-fold-body">${body}</div>
      </details>`;
}

/**
 * A small dialog kept in the page, hidden until a [data-dlg-open="<id>"]
 * button opens it. The opener should carry aria-controls="<id>" and
 * aria-expanded="false" (settingsDialogOpenerAttrs), which is also how
 * Settings search unfolds it to reach a setting inside.
 */
function settingsDialogHtml({ id, title, body, wide = false }) {
  const x = typeof vaultIcon === 'function' ? vaultIcon('close') : '&times;';
  return `
      <div class="settings-dlg-ov" id="${id}" hidden>
        <div class="settings-dlg${wide ? ' is-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${id}Title">
          <div class="settings-dlg-head">
            <h3 class="settings-dlg-title" id="${id}Title">${title}</h3>
            <button type="button" class="settings-dlg-x" data-dlg-close title="Close" aria-label="Close">${x}</button>
          </div>
          <div class="settings-dlg-body">${body}</div>
        </div>
      </div>`;
}

/** The attributes a button needs to open a settingsDialogHtml dialog. */
function settingsDialogOpenerAttrs(id) {
  return ` data-dlg-open="${id}" aria-controls="${id}" aria-expanded="false" aria-haspopup="dialog"`;
}

/* ── Pages ────────────────────────────────────────────────────────────── */

/** The Modern menu: four groups, each page with its line icon (player-lib/icons.js). */
const SETTINGS_PAGES_MODERN = [
  { group: 'You', pages: [
    { id: 'general', title: 'General', icon: 'gear' },
    { id: 'privacy', title: 'Privacy and security', icon: 'lock' },
    { id: 'shortcuts', title: 'Keyboard shortcuts', icon: 'keyboard' },
  ] },
  { group: 'Library', pages: [
    { id: 'library', title: 'Library and files', icon: 'library' },
    { id: 'faces', title: 'Face search', icon: 'person' },
  ] },
  { group: 'AI', pages: [
    { id: 'models', title: 'Models and scanning', icon: 'chip' },
    { id: 'servers', title: 'AI servers', icon: 'plug' },
    { id: 'seedpacks', title: 'Seed packs', icon: 'box' },
  ] },
  { group: 'Help', pages: [
    { id: 'guides', title: 'Guides', icon: 'book' },
    { id: 'about', title: 'About', icon: 'info' },
  ] },
];

/** The Modern page ids, in menu order. */
const SETTINGS_PAGE_IDS_MODERN = SETTINGS_PAGES_MODERN.flatMap(g => g.pages.map(p => p.id));

/**
 * A page id from the other look, and where it lands in this one. Classic's
 * Settings page became General and Privacy and security in Modern; its
 * Backend page is AI servers. Everything else kept its id.
 */
const SETTINGS_PAGE_ALIASES = {
  modern: { settings: 'general', backend: 'servers' },
  classic: { general: 'settings', privacy: 'settings', servers: 'backend' },
};

/**
 * The page to show for id in look ('modern' | 'classic'), given that look's
 * page ids. null when it is no page in either look.
 */
function settingsResolvePage(id, look, ids) {
  const list = ids || (look === 'modern' ? SETTINGS_PAGE_IDS_MODERN : []);
  if (list.includes(id)) return id;
  const alias = (SETTINGS_PAGE_ALIASES[look] || {})[id];
  return alias && list.includes(alias) ? alias : null;
}
