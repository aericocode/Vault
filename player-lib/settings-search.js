/* =========================================================================
   SETTINGS SEARCH - the search box at the top of the Settings menu.

   One index (SETTINGS_INDEX below): a line per setting with its page, its
   anchor, its name, a short description and extra words people might use.
   A new setting needs one line here plus data-sfind="<anchor>" on its row
   (settings.js toggleRow / numberRow / segRow add it from the key).

   Typing shows results grouped by page, best first, with the matched words
   marked. The keyboard shortcuts table (player-lib/shortcuts.js) is searched
   too; its rows jump to the Keyboard shortcuts page. Enter or a click goes
   to the page, scrolls to the setting and flashes it. Esc clears the box
   (an empty box lets Esc close Settings as before). Ctrl+F or / focuses the
   box, only while Settings is open; the ? window keeps its own keys.

   Hooks in settings.js: vaultSettingsSearchMount (modal built),
   vaultSettingsSearchReset (modal opened), and from there
   vaultSettingsSelect / vaultSettingsIsOpen.

   The index names each setting's Classic page. Modern has its own pages
   (player-lib/settings-kit.js SETTINGS_PAGES_MODERN): an entry's Modern
   page is its mpage if it has one (the privacy rows moved to Privacy and
   security), else its Classic page under its Modern name (Settings is
   General, Backend is AI servers).
   ========================================================================= */

/** The Settings pages, in menu order, with their names in plain words. */
const SETTINGS_SEARCH_PAGES = [
  { id: 'settings', title: 'Settings' },
  { id: 'library', title: 'Library' },
  { id: 'faces', title: 'Face search' },
  { id: 'shortcuts', title: 'Keyboard shortcuts' },
  { id: 'guides', title: 'Guides' },
  { id: 'models', title: 'Models' },
  { id: 'seedpacks', title: 'Seed packs' },
  { id: 'backend', title: 'Backend' },
  { id: 'about', title: 'About' },
];

/** Classic page ids and the Modern page each one became (settings-kit.js has the same map). */
const SETTINGS_SEARCH_MODERN_PAGE = { settings: 'general', backend: 'servers' };

/** The pages for a look, in menu order: { id, title }. */
function settingsSearchPages(look) {
  if (look === 'modern' && typeof SETTINGS_PAGES_MODERN !== 'undefined') {
    return SETTINGS_PAGES_MODERN.flatMap(g => g.pages.map(p => ({ id: p.id, title: p.title })));
  }
  return SETTINGS_SEARCH_PAGES;
}

/** The page an index entry is on in a look. */
function settingsSearchPageOf(entry, look) {
  if (look !== 'modern') return entry.page;
  return entry.mpage || SETTINGS_SEARCH_MODERN_PAGE[entry.page] || entry.page;
}

/**
 * Every setting on every page. id is the row's data-sfind value. page: its
 * Classic page; mpage: its Modern page when that is not just the Classic
 * page renamed. look: 'modern' or 'classic' for a row only one look shows.
 */
const SETTINGS_INDEX = [
  // Settings
  { page: 'settings', mpage: 'privacy', id: 'privacyMode', label: 'Privacy mode',
    desc: 'Hide personal data on screen. Ctrl+Shift+H turns it on or off.',
    keywords: ['streaming', 'screen share', 'hide', 'blur', 'private'] },
  { page: 'settings', mpage: 'privacy', id: 'privacyHide', label: 'Privacy mode: what to hide',
    desc: 'File paths, notes, note chips, saved searches, import folders, thumbnails, file names.',
    keywords: ['hide while on', 'blur thumbnails', 'streaming', 'screen share'] },
  { page: 'settings', id: 'resumePlayback', label: 'Resume playback positions',
    desc: 'Go back to where you left off when you open a video or audio file again.',
    keywords: ['continue', 'seek', 'left off', 'position', 'where i left off'] },
  { page: 'settings', id: 'restoreSession', label: 'Restore last session on open',
    desc: 'When Vault starts, open the last file you played, paused.',
    keywords: ['reopen', 'last file', 'startup', 'launch', 'session'] },
  { page: 'settings', id: 'libraryLayout', label: 'Library layout',
    desc: 'Pages fill the screen with whole rows. Continuous scrolls freely.',
    keywords: ['pages', 'continuous', 'scroll', 'infinite', 'pagination', 'browsing'] },
  { page: 'settings', id: 'layoutStyle', label: 'Library look',
    desc: 'Classic or Modern. Modern uses the full width and line icons.',
    keywords: ['classic', 'modern', 'style', 'appearance', 'theme', 'icons', 'emoji'] },
  { page: 'settings', id: 'cardSize', label: 'Card size', look: 'classic',
    desc: 'Small, medium or large tiles. Modern sets this with the Size slider above the grid.',
    keywords: ['tile size', 'thumbnail size', 'bigger', 'smaller', 'zoom'] },
  // Modern sets the size with the slider above the grid, outside Settings:
  // outside names that element (db-viewer.html); going there closes Settings.
  { page: 'settings', id: 'cardSizeRange', outside: 'cardSizeRange', label: 'Card size', look: 'modern',
    desc: 'The Size slider above the library grid. Drag it for smaller or bigger tiles.',
    keywords: ['tile size', 'thumbnail size', 'bigger', 'smaller', 'zoom', 'slider'] },
  { page: 'settings', id: 'gamifyHidden', label: 'Show or hide the Obsession Score',
    desc: 'The score chip and its toasts. Scoring carries on in the background.',
    keywords: ['gamify', 'points', 'streak', 'level', 'achievements', 'flame'] },
  { page: 'settings', id: 'instanceName', label: 'Instance name',
    desc: 'The page title and the word at the top left.',
    keywords: ['rename', 'title', 'second vault', 'this copy'] },
  { page: 'settings', id: 'port', label: 'Port',
    desc: 'The port Vault runs on. Takes effect at the next launch.',
    keywords: ['address', 'url', 'localhost', 'network', '8765'] },
  { page: 'settings', mpage: 'privacy', id: 'modelDownloads', label: 'AI model downloads',
    desc: 'Approve the one-time model downloads for subtitles, translation, speaker detection and face search.',
    keywords: ['download', 'consent', 'hugging face', 'whisper', 'offline', 'internet'] },
  { page: 'settings', mpage: 'privacy', id: 'vaultSecurity', label: 'Vault security',
    desc: 'The database password and how the library locks itself.',
    keywords: ['password', 'encrypt', 'encryption', 'lock', 'padlock'] },
  { page: 'settings', mpage: 'privacy', id: 'autolockMinutes', label: 'Auto-lock after',
    desc: 'Lock the vault after this many minutes with no activity. 0 means never.',
    keywords: ['password', 'lock', 'timeout', 'idle', 'security', 'minutes'] },
  // The Planned group is Classic's only.
  { page: 'settings', id: 'p_confirmTrash', label: 'Confirm before trash (planned)', look: 'classic',
    desc: 'Ask before moving a file to the trash. Not available yet.',
    keywords: ['delete', 'confirm', 'ask'] },
  { page: 'settings', id: 'p_defaultSort', label: 'Default sort and filter on open (planned)', look: 'classic',
    desc: 'Start every session with a saved sort and filter. Not available yet.',
    keywords: ['sort', 'filter', 'preset', 'startup'] },

  // Library
  { page: 'library', id: 'dbFile', label: 'Library file', look: 'modern',
    desc: 'Which database file this library uses, and where it is.',
    keywords: ['database', 'db', 'sqlite', 'path', 'location'] },
  // Watched folders (player-lib/watchers-ui.js)
  { page: 'library', id: 'watchFolders', label: 'Watched folders',
    desc: 'Folders Vault keeps an eye on. New files are added on their own, and files that disappear are marked Missing.',
    keywords: ['watch', 'monitor', 'auto import', 'automatic', 'sync', 'folder', 'new files', 'missing', 'drop folder', 'downloads'] },
  { page: 'library', id: 'watchPauseAll', label: 'Pause all watched folders',
    desc: 'Stop watching every folder until you resume, for example before a big reorganise.',
    keywords: ['watch', 'monitor', 'sync', 'pause', 'resume', 'stop', 'auto import'] },
  { page: 'library', id: 'watchCheckOnStart', label: 'Check for changes when Vault starts',
    desc: 'A quiet walk of every watched folder to catch what changed while Vault was closed.',
    keywords: ['watch', 'monitor', 'sync', 'startup', 'launch', 'catch up', 'scan', 'auto import'] },
  { page: 'library', id: 'thMake', label: 'Make thumbnails',
    desc: 'Off, for every file, or when shown. The small pictures on tiles, in the preview pane and on the Wall.',
    keywords: ['thumbnail', 'pictures', 'previews', 'disk', 'storage', 'space'] },
  { page: 'library', id: 'thKeep', label: 'Keep thumbnails',
    desc: 'When shown: keep them, keep up to a disk limit, or only while Vault is running.',
    keywords: ['disk', 'storage', 'space', 'limit', 'memory', 'cache', 'thumbnails'] },
  { page: 'library', id: 'th-inside', label: 'Use pictures already inside files',
    desc: 'Album art in music and the cover art some videos carry.',
    keywords: ['album art', 'cover', 'embedded', 'thumbnails'] },
  { page: 'library', id: 'th-hover', label: 'Hover preview frames',
    desc: 'Extra pictures for scrubbing when you hover a video tile.',
    keywords: ['scrub', 'hover', 'preview', 'thumbnails', 'disk', 'storage', 'space'] },
  { page: 'library', id: 'thSpace', label: 'Thumbnail space used and cleanup',
    desc: 'See how much space thumbnails take and delete saved ones.',
    keywords: ['disk', 'storage', 'space', 'delete', 'clean', 'cache', 'size', 'free up'] },
  { page: 'library', id: 'deleteMode', label: 'Delete mode',
    desc: 'What the trash button does: soft to the trash folder, the Recycle Bin, or permanent.',
    keywords: ['trash', 'recycle bin', 'remove', 'erase', 'permanent'] },
  { page: 'library', id: 'mig-prefix', label: 'Quick move',
    desc: 'Moved your files to a new drive or folder? Change the start of their paths, no rescan.',
    keywords: ['relink', 'move', 'moved', 'migrate', 'drive', 'path', 'prefix', 'moved your files'] },
  { page: 'library', id: 'mig-auto', label: 'Deep search for moved files',
    desc: 'Finds renamed and shuffled files in a new folder and relinks them.',
    keywords: ['relink', 'move', 'moved', 'renamed', 'migrate', 'missing'] },
  { page: 'library', id: 'playbackCheck', label: 'Check playback support for all files',
    desc: 'Read the video and audio format of older files, so Vault knows which ones play.',
    keywords: ['codec', 'format', 'ffprobe', 'plays', 'compatibility'] },

  // Face search
  { page: 'faces', id: 'faces-enabled', label: 'Face search',
    desc: 'Click a face to see every file that person is in, or search with a photo.',
    keywords: ['faces', 'people', 'person', 'recognition'] },
  { page: 'faces', id: 'facesLibrary', label: 'Face search progress',
    desc: 'How many files are checked and people found. Check everything, pause or stop.',
    keywords: ['people', 'progress', 'queue', 'check all', 'faces'] },
  { page: 'faces', id: 'facesModel', label: 'Face model',
    desc: 'Standard or Best: how well people are told apart.',
    keywords: ['accuracy', 'recognition', 'faces', 'model'] },
  { page: 'faces', id: 'faces-autoIndex', label: 'Find faces in new imports automatically',
    desc: 'New photos and videos are checked for faces after they are added.',
    keywords: ['auto', 'import', 'faces', 'people'] },
  { page: 'faces', id: 'facesInterval', label: 'How closely to check videos',
    desc: 'Check a frame every few seconds. Closer finds more faces but takes longer.',
    keywords: ['frames', 'interval', 'seconds', 'accuracy', 'speed', 'faces'] },
  { page: 'faces', id: 'facesMaxFrames', label: 'Most frames per video',
    desc: 'Long videos spread these frames evenly.',
    keywords: ['frames', 'limit', 'faces'] },
  { page: 'faces', id: 'facesDelete', label: 'Delete all face data',
    desc: 'Remove every face Vault has found. Your photos and videos are not touched.',
    keywords: ['erase', 'reset', 'privacy', 'faces', 'people'] },

  // Keyboard shortcuts (its rows are searched from shortcuts.js as well)
  { page: 'shortcuts', id: 'shortcutsList', label: 'Keyboard shortcuts',
    desc: 'Every key Vault answers to. Press ? anywhere to see them.',
    keywords: ['keys', 'hotkeys', 'keyboard'] },

  // Guides
  { page: 'guides', id: 'guide-ai-scanning', label: 'Guide: AI scanning',
    desc: 'Describe, tag and title your media with a local vision model.',
    keywords: ['lm studio', 'ollama', 'vision model', 'scan', 'tags'] },
  { page: 'guides', id: 'guide-semantic-search', label: 'Guide: Semantic search',
    desc: 'Find media by meaning instead of exact words.',
    keywords: ['meaning', 'embedding', 'search'] },
  { page: 'guides', id: 'guide-music-id', label: 'Guide: Music ID',
    desc: 'Name the songs inside your files by fingerprinting them.',
    keywords: ['fingerprint', 'songs', 'chromaprint', 'music'] },
  { page: 'guides', id: 'guide-beat-bar', label: 'Guide: Beat bar',
    desc: 'A beat overlay for videos, synced to playback.',
    keywords: ['beat', 'rhythm', 'visualizer'] },
  { page: 'guides', id: 'guide-subtitles', label: 'Guide: Subtitles',
    desc: 'Make subtitles and transcripts with a local tool, with translation.',
    keywords: ['transcription', 'captions', 'translate', 'whisper'] },
  { page: 'guides', id: 'guide-games', label: 'Guide: Games',
    desc: 'Reel Order and Frame Fit, made from your videos.',
    keywords: ['reel order', 'frame fit', 'puzzle', 'jigsaw'] },
  { page: 'guides', id: 'guide-obsession-score', label: 'Guide: Obsession Score',
    desc: 'Points, streaks, levels and achievements, all offline.',
    keywords: ['gamify', 'points', 'streak', 'level'] },
  { page: 'guides', id: 'guide-encryption', label: 'Guide: Encryption',
    desc: 'Set a database password and lock the library.',
    keywords: ['password', 'lock', 'encrypt', 'security'] },

  // Models
  { page: 'models', id: 'scanModel', label: 'Scan model',
    desc: 'The model Vault uses to analyse new files, picked from the models LM Studio has on disk.',
    keywords: ['vision model', 'ai scan', 'lm studio', 'analyse', 'analyze', 'default model', 'which model'] },
  { page: 'models', id: 'scanWhenNotLoaded', label: 'When the scan model is not loaded',
    desc: 'Load it if there is room on the GPU, wait until you load it, or always load it.',
    keywords: ['load model', 'auto load', 'vram', 'gpu memory', 'waiting', 'not loaded', 'lms'] },
  { page: 'models', id: 'scanGpuFree', label: 'Only scan watched folders when the GPU is free',
    desc: 'Watched folder files wait while any other model is loaded.',
    keywords: ['watch', 'folder watchers', 'gpu busy', 'text model', 'wait'] },
  { page: 'models', id: 'scanUnloadIdle', label: 'Unload the scan model after',
    desc: 'Free GPU memory once the queue has been idle. Only a copy Vault loaded itself.',
    keywords: ['unload', 'idle', 'eject', 'free vram', 'gpu memory', 'timeout'] },
  { page: 'models', id: 'modelTable', label: 'Model recommendations by GPU size',
    desc: 'Which vision model to load for your graphics card.',
    keywords: ['vram', 'gpu', 'graphics card', 'lm studio', 'vision model', 'whisper', 'quant'] },

  // Seed packs
  { page: 'seedpacks', id: 'seedpacks', label: 'Song seed packs',
    desc: 'Import song references without the audio, then open them in the Editor.',
    keywords: ['songs', 'music id', 'import', 'fingerprints'] },

  // Backend
  { page: 'backend', id: 'backendInstances', label: 'Loaded instances',
    desc: 'What LM Studio has loaded right now, and which copies scans use.',
    keywords: ['lm studio', 'models', 'gpu', 'instances', 'loaded', 'backend', 'ai servers'] },
  { page: 'backend', id: 'scanWorkers', label: 'Workers per instance',
    desc: 'How many files each loaded model scans at once.',
    keywords: ['parallel', 'concurrency', 'speed', 'threads', 'scan', 'backend'] },
  { page: 'backend', id: 'backendModel', label: 'Model for scans',
    desc: 'Auto uses whatever is loaded, or pick one model family.',
    keywords: ['vision model', 'family', 'choose model', 'scan', 'backend'] },
  { page: 'backend', id: 'backendAiServer', label: 'AI server',
    desc: 'Where scans go: LM Studio, Ollama or vLLM on this PC.',
    keywords: ['lm studio', 'ollama', 'vllm', 'endpoint', 'url', 'address', 'backend', 'ai servers'] },
  { page: 'backend', id: 'backendAdvanced', label: 'Advanced: AI servers',
    desc: 'Add a second machine or another program, and test a server.',
    keywords: ['endpoint', 'network', 'remote', 'ollama', 'url', 'lm_studio_urls', 'backend'] },

  // About
  { page: 'about', id: 'about', label: 'About Vault',
    desc: 'Version, license and links.',
    keywords: ['version', 'license', 'github', 'ko-fi', 'donate', 'support'] },
  { page: 'about', id: 'aboutUpdate', label: 'Check for updates',
    desc: 'Compare your version with the latest one on GitHub.',
    keywords: ['update', 'version', 'new version', 'upgrade'] },
  { page: 'about', id: 'setupNotices', label: 'Setup notices',
    desc: 'Show again the setup notices you hid with "Don\'t show again".',
    keywords: ['ffmpeg', 'missing tools', 'banner', 'hidden', 'notice'] },
];

/** How many keyboard shortcut rows show before "Show all". */
const SETTINGS_SEARCH_SHORTCUT_LIMIT = 6;

/* ── Matching ─────────────────────────────────────────────────────────── */

function settingsSearchWords(query) {
  return String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * How well one entry matches every word (null: some word is not there).
 * A word in the name counts most (more at the start of a word), then the
 * description, then the extra words. related: the extra words that matched
 * a query word found nowhere else, shown so the result makes sense.
 */
function settingsSearchScore(entry, words) {
  if (!words.length) return null;
  const label = entry.label.toLowerCase();
  const desc = (entry.desc || '').toLowerCase();
  const kws = (entry.keywords || []).map(k => k.toLowerCase());
  let score = 0;
  const related = [];
  for (const w of words) {
    const atStart = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(label);
    if (label.includes(w)) { score += atStart ? 6 : 4; continue; }
    if (desc.includes(w)) { score += 2; continue; }
    const kw = kws.find(k => k.includes(w));
    if (kw) { score += 1; if (!related.includes(kw)) related.push(kw); continue; }
    return null;
  }
  return { score, related };
}

/** A keyboard shortcut row as a result: its words, its keys and its group. */
function settingsSearchShortcutItem(row) {
  const keyText = row.keys.map(alt => (Array.isArray(alt) ? alt : [alt])
    .map(k => (k === 'click' ? 'click' : (typeof shortcutKeyLabel === 'function' ? shortcutKeyLabel(k) : k)))
    .join('+')).join(' or ');
  const group = (typeof SHORTCUT_GROUPS !== 'undefined' && SHORTCUT_GROUPS.find(g => g.id === row.ctx)) || null;
  return {
    page: 'shortcuts',
    id: `sk-${SHORTCUTS.indexOf(row)}`,
    label: row.desc,
    desc: `${keyText}${group ? ` · ${group.title}` : ''}`,
    shortcut: true,
  };
}

/**
 * The results for a query: groups in the order of their best match (menu
 * order breaks ties), each with its items best first. look: 'modern' or
 * 'classic' (rows only one look shows are left out of the other). The
 * shortcuts group lists its first few rows; more says how many it left out.
 */
function settingsSearch(query, opts = {}) {
  const words = settingsSearchWords(query);
  if (!words.length) return [];
  const look = opts.look || 'classic';
  const limit = opts.shortcutLimit == null ? SETTINGS_SEARCH_SHORTCUT_LIMIT : opts.shortcutLimit;
  const byPage = new Map();
  const add = (item, m) => {
    if (!byPage.has(item.page)) byPage.set(item.page, []);
    byPage.get(item.page).push({ item, score: m.score, related: m.related });
  };
  for (const e of SETTINGS_INDEX) {
    if (e.look && e.look !== look) continue;
    const m = settingsSearchScore(e, words);
    // The result names the page it is on in this look.
    if (m) add({ ...e, page: settingsSearchPageOf(e, look) }, m);
  }
  let more = 0;
  if (typeof SHORTCUTS !== 'undefined' && typeof shortcutsFilter === 'function') {
    // shortcuts.js decides what a row matches (its words, keys and group), as
    // the ? window and the Keyboard shortcuts page do.
    const rows = shortcutsFilter(SHORTCUTS, query);
    rows.slice(0, limit).forEach(r => {
      const item = settingsSearchShortcutItem(r);
      add(item, settingsSearchScore(item, words) || { score: 1, related: [] });
    });
    more = Math.max(0, rows.length - limit);
  }
  const pages = settingsSearchPages(look);
  const order = pages.map(p => p.id);
  return [...byPage.entries()]
    .map(([page, items]) => {
      // Within a page: best first; the shortcut rows keep the table's order
      // after the page's own entries.
      items.sort((a, b) => (a.item.shortcut === b.item.shortcut ? b.score - a.score : a.item.shortcut ? 1 : -1));
      return {
        page,
        title: (pages.find(p => p.id === page) || { title: page }).title,
        items,
        best: Math.max(...items.filter(i => !i.item.shortcut).map(i => i.score), 0),
        more: page === 'shortcuts' ? more : 0,
      };
    })
    .sort((a, b) => b.best - a.best || order.indexOf(a.page) - order.indexOf(b.page));
}

function settingsSearchEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Text with every query word marked (<mark>), escaped. */
function settingsSearchMark(text, words) {
  const s = String(text || '');
  const lower = s.toLowerCase();
  const spans = [];
  for (const w of words) {
    let i = lower.indexOf(w);
    while (w && i >= 0) { spans.push([i, i + w.length]); i = lower.indexOf(w, i + w.length); }
  }
  spans.sort((a, b) => a[0] - b[0]);
  let out = '', at = 0;
  for (const [a, b] of spans) {
    if (b <= at) continue;
    const from = Math.max(a, at);
    out += settingsSearchEsc(s.slice(at, from)) + `<mark>${settingsSearchEsc(s.slice(from, b))}</mark>`;
    at = b;
  }
  return out + settingsSearchEsc(s.slice(at));
}

/** Where a result goes: "page|anchor" in Settings, or "@id" for a control
    outside it (the Modern Size slider). */
function settingsSearchTarget(item) {
  return item.outside ? `@${item.outside}` : `${item.page}|${item.id}`;
}

/** The results panel for a query: a listbox of options, grouped by page.
    Items carry data-sfind-go (settingsSearchTarget). */
function settingsSearchResultsHtml(groups, query) {
  const words = settingsSearchWords(query);
  if (!groups.length) {
    return `<p class="sfind-empty">No settings match "${settingsSearchEsc(String(query).trim())}".</p>`;
  }
  let n = 0;
  return groups.map(g => `
    <section class="sfind-group" role="group" aria-label="${settingsSearchEsc(g.title)}">
      <h3 class="settings-h sfind-gh" aria-hidden="true">${settingsSearchEsc(g.title)}</h3>
      ${g.items.map(({ item, related }) => `
        <button type="button" class="sfind-item${item.shortcut ? ' sfind-sk' : ''}" role="option" id="sfindOpt${n++}"
                aria-selected="false" tabindex="-1" data-sfind-go="${settingsSearchEsc(settingsSearchTarget(item))}">
          <span class="sfind-text">
            <span class="sfind-label">${settingsSearchMark(item.label, words)}</span>
            <span class="sfind-desc">${settingsSearchMark(item.desc, words)}</span>
            ${related.length ? `<span class="sfind-rel">Also matches: ${settingsSearchMark(related.join(', '), words)}</span>` : ''}
          </span>
          <span class="sfind-go">Go to it<kbd class="sfind-enter" aria-hidden="true">Enter</kbd></span>
        </button>`).join('')}
      ${g.more ? `<button type="button" class="sfind-item sfind-more" role="option" id="sfindOpt${n++}" aria-selected="false"
                tabindex="-1" data-sfind-all="${settingsSearchEsc(String(query).trim())}">Show all ${g.items.filter(i => i.item.shortcut).length + g.more} shortcuts</button>` : ''}
    </section>`).join('');
}

/** What takes focus on the row you land on: a field only, never a button,
    so a held Enter cannot press Delete, Check for updates or anything else
    the row carries. null: just scroll and flash. */
const SETTINGS_SEARCH_FIELD = 'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]), select, textarea';
function settingsSearchFocusTarget(el) {
  if (!el) return null;
  const c = el.matches(SETTINGS_SEARCH_FIELD) ? el : el.querySelector(SETTINGS_SEARCH_FIELD);
  return c && !c.disabled ? c : null;
}

/* ── The box ──────────────────────────────────────────────────────────── */

(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.addEventListener) return;

  const $input = () => document.getElementById('settingsSearch');
  const $results = () => document.getElementById('settingsResults');
  const $body = () => document.getElementById('settingsBody');
  const look = () => (typeof window.isModernLayout === 'function' && window.isModernLayout() ? 'modern' : 'classic');
  let active = 0;
  let goSeq = 0;      // a newer jump (or a new search) cancels a pending one

  function items() { const r = $results(); return r ? [...r.querySelectorAll('.sfind-item')] : []; }

  function setActive(i) {
    const list = items();
    if (!list.length) return;
    active = (i + list.length) % list.length;
    list.forEach((el, n) => {
      el.classList.toggle('is-active', n === active);
      el.setAttribute('aria-selected', n === active ? 'true' : 'false');
    });
    list[active].scrollIntoView({ block: 'nearest' });
    $input()?.setAttribute('aria-activedescendant', list[active].id);
  }

  function show(on) {
    const r = $results(), b = $body(), input = $input();
    if (r) r.hidden = !on;
    if (b) b.hidden = on;
    if (input) {
      input.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (!on) input.removeAttribute('aria-activedescendant');
    }
  }

  function run() {
    const input = $input(), r = $results();
    if (!input || !r) return;
    goSeq++;
    const q = input.value;
    if (!q.trim()) { show(false); return; }
    r.innerHTML = settingsSearchResultsHtml(settingsSearch(q, { look: look() }), q);
    r.scrollTop = 0;
    show(true);
    active = 0;
    if (items().length) setActive(0);
    else $input()?.removeAttribute('aria-activedescendant');
  }

  function clear() {
    goSeq++;
    const input = $input();
    if (input) input.value = '';
    show(false);
  }

  const visible = (el) => !!el && el.getClientRects().length > 0;

  /** The row to show for an anchor that is hidden right now (its group is
      folded away, or only one look shows it): the nearest one above it. */
  function fallbackFor(el, body) {
    const all = [...body.querySelectorAll('[data-sfind]')];
    const i = el ? all.indexOf(el) : -1;
    for (let n = (i < 0 ? all.length : i) - 1; n >= 0; n--) if (visible(all[n])) return all[n];
    return all.find(visible) || null;
  }

  function flash(el) {
    el.classList.remove('sfind-flash');
    void el.offsetWidth;   // restart the animation on a second visit
    el.classList.add('sfind-flash');
    setTimeout(() => el.classList.remove('sfind-flash'), 2200);
  }

  function reveal(anchor, seq, tries = 0) {
    const body = $body();
    if (!body || seq !== goSeq) return;
    let el = body.querySelector(`[data-sfind="${anchor.replace(/["\\]/g, '\\$&')}"]`);
    const det = el && (el.tagName === 'DETAILS' ? el : el.closest('details'));
    if (det) det.open = true;
    // Folded behind a "show more" button (Deep search): unfold it.
    const fold = el && !visible(el) ? el.closest('[hidden][id]') : null;
    const opener = fold && body.querySelector(`[aria-controls="${fold.id}"][aria-expanded="false"]`);
    if (opener) opener.click();
    // Some rows fill in once the server answers (setup notices, face search):
    // give them a moment before settling for the row above.
    if (!visible(el) && tries < 8) { setTimeout(() => reveal(anchor, seq, tries + 1), 100); return; }
    // The row above stands in, but only to be seen: its own field is a
    // different setting, so nothing takes focus then.
    const standIn = !visible(el);
    if (standIn) el = fallbackFor(el, body);
    if (!el) return;
    const smooth = !(typeof prefersReducedMotion === 'function' && prefersReducedMotion());
    el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    flash(el);
    // Inside a dialog the result itself takes focus when it is a button
    // (Pause all), so the dialog's own first field does not keep it.
    const inDialog = !standIn && el.closest('.settings-dlg-ov') && el.matches('button:not([disabled])');
    const control = standIn ? null : (inDialog ? el : settingsSearchFocusTarget(el));
    if (control && visible(control)) {
      try { control.focus({ preventScroll: true }); } catch {}
    }
  }

  /** A control outside Settings (the Modern Size slider): close Settings,
      show the Library, and flash and focus it there. */
  function goOutside(id) {
    clear();
    window.vaultCloseSettings?.();
    if (typeof currentTab !== 'undefined' && currentTab !== 'library' && typeof switchTab === 'function') switchTab('library');
    const el = document.getElementById(id);
    if (!el) return;
    const box = el.closest('.card-size-control') || el;
    const smooth = !(typeof prefersReducedMotion === 'function' && prefersReducedMotion());
    box.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    flash(box);
    const control = settingsSearchFocusTarget(el);
    if (control) { try { control.focus({ preventScroll: true }); } catch {} }
  }

  function go(target) {
    if (String(target).startsWith('@')) { goOutside(String(target).slice(1)); return; }
    const [page, anchor] = String(target).split('|');
    clear();
    window.vaultSettingsSelect?.(page);
    const seq = ++goSeq;
    // selectSection renders the page synchronously, so the anchor is there now.
    if (anchor) reveal(anchor, seq);
  }

  /** "Show all N shortcuts": the Keyboard shortcuts page, its own box filled in. */
  function showAllShortcuts(query) {
    clear();
    window.vaultSettingsSelect?.('shortcuts');
    const box = document.getElementById('skSettingsSearch');
    if (!box) return;
    box.value = query;
    box.dispatchEvent(new Event('input'));
    box.focus();
  }

  function mount() {
    const nav = document.getElementById('settingsNav');
    const body = $body();
    if (!nav || !body || $input()) return;
    const ic = typeof vaultIconSwap === 'function' ? vaultIconSwap('🔍', 'search') : '🔍';
    nav.insertAdjacentHTML('afterbegin', `
      <div class="sfind-box" role="search">
        <span class="sfind-ic" aria-hidden="true">${ic}</span>
        <input type="search" class="sfind-input" id="settingsSearch" placeholder="Search settings"
               role="combobox" aria-autocomplete="list" aria-expanded="false"
               aria-label="Search settings" aria-controls="settingsResults" aria-keyshortcuts="Control+F /"
               autocomplete="off" spellcheck="false">
      </div>`);
    body.insertAdjacentHTML('afterend',
      '<div class="settings-body sfind-results" id="settingsResults" role="listbox" aria-label="Search results" hidden></div>');

    const input = $input();
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // An empty box lets Esc through, so Settings closes as it always has.
        if (!input.value) return;
        e.preventDefault();
        e.stopPropagation();
        clear();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items().length) return;
        e.preventDefault();
        setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter') {
        const pick = items()[active];
        if (!pick) return;
        e.preventDefault();
        if (pick.dataset.sfindAll != null) showAllShortcuts(pick.dataset.sfindAll);
        else go(pick.dataset.sfindGo);
      }
    });
    $results().addEventListener('click', (e) => {
      const item = e.target.closest('[data-sfind-go]');
      if (item) { go(item.dataset.sfindGo); return; }
      const all = e.target.closest('[data-sfind-all]');
      if (all) showAllShortcuts(all.dataset.sfindAll);
    });
    $results().addEventListener('mousemove', (e) => {
      const item = e.target.closest('.sfind-item');
      if (item) { const i = items().indexOf(item); if (i !== active) setActive(i); }
    });
    // Picking a page from the menu leaves the search.
    nav.addEventListener('click', (e) => { if (e.target.closest('.settings-nav-item')) clear(); });
  }

  /* Ctrl+F (Cmd+F) or / while Settings is open: the search box. Capture on
     window, after shortcuts.js (which loads first and owns every key while
     the ? window is open), so nothing behind Settings hears these. Ctrl+F
     with Settings closed is the browser's find, as before. */
  window.addEventListener('keydown', (e) => {
    if (!(typeof window.vaultSettingsIsOpen === 'function' && window.vaultSettingsIsOpen())) return;
    const input = $input();
    if (!input || e.altKey || e.isComposing) return;
    const ctrlF = (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'f' || e.key === 'F');
    const typing = typeof shortcutsIsTyping === 'function'
      ? shortcutsIsTyping(e.target) : /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
    const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !typing;
    if (!ctrlF && !slash) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    input.focus();
    input.select();
  }, true);

  window.vaultSettingsSearchMount = mount;
  window.vaultSettingsSearchReset = clear;
  // Settings may already be built (this script loads after settings.js).
  mount();
})();
