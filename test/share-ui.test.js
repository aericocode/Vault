/**
 * Share privately, the page side (player-lib/share-client.js, share-ui.js,
 * share-settings-ui.js), run in a VM with no DOM: the one request helper
 * always sends the share header and JSON type; Upload stays off until the box
 * is ticked; hostile file and archive names are escaped; Open only ever links
 * to gofile.io; no share code puts a password in browser storage, the console
 * or a lasting global; the "My shares" privacy category blurs and takes the
 * list out of the keyboard order; the Settings page, its search entries, the
 * custom part size field and the copy format preview; Share privately from a
 * collection card, the folded file list, and the large share note and ask.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'player-lib');
const read = (f) => fs.readFileSync(path.join(LIB, f), 'utf8');
const noop = () => {};
const FILES = ['share-client.js', 'share-ui.js', 'share-settings-ui.js'];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The three share files with a recording fetch, storage and console. */
function load({ answers = {}, bodyClasses = new Set(), kit = false } = {}) {
  const calls = [];
  const stored = [];
  const logged = [];
  const recStorage = () => ({
    getItem: () => null, setItem: (k, v) => stored.push([k, v]), removeItem: noop, clear: noop, key: () => null, length: 0,
  });
  const ctx = {
    Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, Date, Promise, Error, Symbol, URL,
    console: { log: (...a) => logged.push(a), warn: (...a) => logged.push(a), error: (...a) => logged.push(a), info: (...a) => logged.push(a), debug: (...a) => logged.push(a) },
    setTimeout: () => 0, clearTimeout: noop, requestAnimationFrame: noop,
    localStorage: recStorage(), sessionStorage: recStorage(),
    indexedDB: { open: () => { stored.push(['indexedDB']); return {}; } },
    escapeHtml: esc,
    showToast: noop,
    navigator: { clipboard: { writeText: async () => {} } },
    CustomEvent: class { constructor(type) { this.type = type; } },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const key = `${init.method} ${url}`;
      const a = answers[key] || { status: 200, body: {} };
      return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
    },
    document: {
      body: { classList: { contains: (c) => bodyClasses.has(c) } },
      querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, addEventListener: noop,
    },
  };
  ctx.window = ctx;
  ctx.__shareNoBoot = true;
  ctx.addEventListener = noop;
  ctx.dispatchEvent = noop;
  vm.createContext(ctx);
  // The real Settings row and card builders, for the Settings page tests.
  if (kit) vm.runInContext(read('settings-kit.js'), ctx, { filename: 'settings-kit.js' });
  for (const f of FILES) vm.runInContext(read(f), ctx, { filename: f });
  return { ctx, calls, stored, logged, run: (src) => vm.runInContext(src, ctx) };
}

const STATE = {
  enabled: true, offline: false, sevenZipFound: true, shareCount: 2,
  settings: { enabled: true, passwordChoice: 'random', deleteAfterDays: 7, split: '2g', customPartBytes: 750 * 1024 * 1024,
    nameMode: 'typed', keepLocal: false, onPartFail: 'retry3', accountMode: 'perStart', copyFormat: 'default',
    customFormat: '{link}\npass: {pass}', rememberPasswords: true, rememberFiles: true, hideInPrivacy: true, topBarIcon: true },
  savedPassword: { set: true, vaultPasswordSet: true, warningNeeded: false },
  topBar: { show: false, needsYou: 0 },
};
const setState = (L, patch = {}) => { L.ctx.__st = { ...STATE, ...patch, settings: { ...STATE.settings, ...(patch.settings || {}) } }; L.run('_shareState = __st'); };

const HOSTILE = '"><img src=x onerror=alert(1)>.mp4';
const HOSTILE_NAME = '<script>alert(2)</script>';

/* ── The request helper ──────────────────────────────────────────────── */

test('every request sends X-Vault-Share: 1 and the JSON type, GET and POST alike; polls say they are background', async () => {
  const L = load();
  await L.run(`shareApi('GET', '/state', null, { background: true })`);
  await L.run(`shareApi('POST', '/shares/3/pause')`);
  await L.run(`shareApi('POST', '/settings', { topBarIcon: false })`);
  assert.strictEqual(L.calls.length, 3);
  for (const c of L.calls) {
    assert.ok(c.url.startsWith('/api/share/'), c.url);
    assert.strictEqual(c.init.headers['X-Vault-Share'], '1');
    assert.strictEqual(c.init.headers['Content-Type'], 'application/json');
    assert.strictEqual(c.init.credentials, 'same-origin');
  }
  assert.strictEqual(L.calls[0].init.headers['X-Vault-Background'], '1');
  assert.strictEqual(L.calls[0].init.body, undefined, 'no body on GET');
  assert.strictEqual(L.calls[1].init.body, '{}', 'an empty JSON body when there is nothing to send');
  assert.deepStrictEqual(JSON.parse(L.calls[2].init.body), { topBarIcon: false });
  assert.ok(!('X-Vault-Background' in L.calls[1].init.headers));
});

test('no share code calls fetch except through shareApi', () => {
  for (const f of ['share-ui.js', 'share-settings-ui.js']) {
    assert.ok(!/\bfetch\s*\(/.test(read(f)), `${f}: a fetch() of its own`);
  }
  const client = read('share-client.js');
  assert.strictEqual((client.match(/\bfetch\s*\(/g) || []).length, 1, 'one fetch, inside shareApi');
});

test('errors carry the server words; NO_SPACE adds how much more is needed; programming errors stay generic', async () => {
  const L = load({ answers: {
    'POST /api/share/shares': { status: 507, body: { error: 'There is not enough free space to pack these files.', code: 'NO_SPACE', missingBytes: 3 * 1024 ** 3 } },
    'POST /api/share/shares/1/upload': { status: 409, body: { error: 'Vault is set to stay offline (VAULT_OFFLINE=1), so nothing can be uploaded.', code: 'NET_OFF' } },
    'POST /api/share/x': { status: 403, body: { error: 'This request is only allowed from Vault itself.', code: 'SHARE_FORBIDDEN' } },
  } });
  await assert.rejects(L.run(`shareApi('POST', '/shares', {})`), (e) => e.code === 'NO_SPACE' && /3 GB more is needed\.$/.test(e.message));
  await assert.rejects(L.run(`shareApi('POST', '/shares/1/upload', { confirm: true })`), (e) => e.code === 'NET_OFF' && /stay offline/.test(e.message));
  await assert.rejects(L.run(`shareApi('POST', '/x', {})`), (e) => e.message === 'Something went wrong. Try again.');
});

test('a split archive is named without its part number, in the window and in My shares', () => {
  const L = load();
  setState(L);
  L.ctx.__s = { id: 7, archiveName: 'Holiday', archiveFileName: 'Holiday.7z.001', archiveDisplayName: 'Holiday.7z', sizeBytes: 3 * 1024 ** 3,
    partCount: 3, fileCount: 2, passwordKind: 'random', passwordKept: true, deleteAfterDays: 7, link: 'https://gofile.io/d/Ab12', status: 'uploaded', deleteAt: Date.now() + 86400000, timerSet: true };
  const line = L.run('shareArchiveLine(__s, { parts: { count: 3, bytes: 3 * 1024 ** 3 } })');
  assert.match(line, /^Holiday\.7z, .* in 3 parts$/);
  L.ctx.__list = { open: new Set(), files: new Map() };
  const row = L.run('shareRowHtml(__s, __list)');
  assert.ok(row.includes('Holiday.7z'));
  assert.ok(!line.includes('.001') && !row.includes('.001'), 'no part number');
});

/* ── Step 3: the tick box ────────────────────────────────────────────── */

test('Upload stays disabled until the box is ticked', () => {
  const L = load();
  setState(L);
  const w = { ticked: false, busy: false, share: { archiveName: 'k7Qm', archiveFileName: 'k7Qm.7z', sizeBytes: 1660000000, deleteAfterDays: 7, partCount: 1 }, progress: { checks: { parts: { count: 1, bytes: 1660000000 } } } };
  L.ctx.__w = w;
  assert.strictEqual(L.run('shareUploadAllowed(__w)'), false);
  const off = L.run('shareConfirmHtml(__w)');
  assert.match(off, /data-sh-act="upload" disabled>Upload 1\.55 GB<\/button>/);
  assert.match(off, /<input type="checkbox" id="shTick" data-sh-first>/, 'the box starts unticked');
  w.ticked = true;
  assert.strictEqual(L.run('shareUploadAllowed(__w)'), true);
  assert.match(L.run('shareConfirmHtml(__w)'), /data-sh-act="upload">Upload 1\.55 GB<\/button>/);
  w.busy = true;
  assert.strictEqual(L.run('shareUploadAllowed(__w)'), false, 'not twice while the request is out');
  assert.strictEqual(L.run('shareUploadAllowed(null)'), false);
});

test('shareStartUpload sends nothing while the box is unticked, and confirm: true once it is', async () => {
  const L = load({ answers: { 'POST /api/share/shares/9/upload': { status: 200, body: { id: 9, status: 'uploading', upload: { parts: [] } } } } });
  setState(L);
  const box = { innerHTML: '', setAttribute: noop, querySelector: () => null, querySelectorAll: () => [] };
  L.ctx.__w = { id: 9, ticked: false, busy: false, samples: [], m: { box, q: () => null, qa: () => [] } };
  L.run('_shareWin = __w');
  await L.run('shareStartUpload()');
  assert.strictEqual(L.calls.length, 0, 'unticked: no request');
  L.run('_shareWin.ticked = true');
  await L.run('shareStartUpload()');
  assert.strictEqual(L.calls.length, 1);
  assert.strictEqual(L.calls[0].url, '/api/share/shares/9/upload');
  assert.deepStrictEqual(JSON.parse(L.calls[0].init.body), { confirm: true });
});

/* ── Escaping ────────────────────────────────────────────────────────── */

test('a hostile file name and archive name are escaped everywhere they are drawn', () => {
  const L = load();
  setState(L);
  L.ctx.__w = {
    preview: { files: [{ mediaId: 1, name: HOSTILE, nameInArchive: HOSTILE, sizeBytes: 1000 }], totalBytes: 1000, needBytes: 1050, enoughSpace: true,
      split: false, partBytes: 2 * 1024 ** 3, partCount: 1, nameMode: 'typed', passwordChoice: 'random', deleteAfterDays: 7, savedPasswordSet: true, sevenZipFound: true },
    share: { id: 4, archiveName: HOSTILE_NAME, archiveFileName: `${HOSTILE_NAME}.7z`, archiveDisplayName: `${HOSTILE_NAME}.7z`, sizeBytes: 1000, partCount: 1, fileCount: 1, passwordKind: 'random', passwordKept: true, deleteAfterDays: 7, link: 'https://gofile.io/d/Ab12', status: 'uploaded', deleteAt: Date.now() + 86400000 * 3, timerSet: true },
    progress: { checks: { ok: true, test: { ok: true }, listWithoutPassword: { ok: true }, contents: { files: 1 }, parts: { count: 1, bytes: 1000 }, archiveName: { value: HOSTILE_NAME, typed: true } }, upload: { parts: [] } },
    ticked: false, failText: HOSTILE,
  };
  const pages = ['shareReviewHtml', 'shareCheckedHtml', 'shareConfirmHtml', 'shareUploadHtml', 'shareDoneHtml', 'shareFailedHtml'].map(f => L.run(`${f}(__w)`));
  L.ctx.__list = { open: new Set([4]), files: new Map([[4, { files: [{ name: HOSTILE, sizeBytes: 5 }] }]]) };
  pages.push(L.run('shareRowHtml(__w.share, __list)'));
  pages.push(L.run(`sharePartRowHtml({ partNo: 1, fileName: ${JSON.stringify(HOSTILE)}, sizeBytes: 5, status: 'failed' })`));
  for (const html of pages) {
    assert.ok(!/<img|<script/i.test(html), `unescaped markup in: ${html.slice(0, 120)}`);
  }
  assert.ok(pages[0].includes('&lt;img src=x onerror=alert(1)&gt;.mp4'), 'the name is shown, escaped');
  assert.ok(pages[6].includes('&lt;script&gt;alert(2)&lt;/script&gt;.7z'));
});

/* ── Open ────────────────────────────────────────────────────────────── */

test('Open: only a server link that starts with https://gofile.io/', () => {
  const L = load();
  const ok = (u) => L.run(`shareSafeLink(${JSON.stringify(u)})`);
  assert.strictEqual(ok('https://gofile.io/d/Ab12'), 'https://gofile.io/d/Ab12');
  for (const bad of ['http://gofile.io/d/Ab12', 'https://gofile.io.evil.com/d/x', 'https://evil.com/?u=https://gofile.io/', 'javascript:alert(1)',
    'https://gofile.io:8443/d/x', ' https://gofile.io/d/x', 'HTTPS://GOFILE.IO/d/x', '//gofile.io/d/x', null, 42, {}]) {
    assert.strictEqual(ok(bad), null, String(bad));
  }
  setState(L);
  L.ctx.__list = { open: new Set(), files: new Map() };
  const row = (link) => L.run(`shareRowHtml(${JSON.stringify({ id: 2, archiveName: 'a', status: 'uploaded', link, sizeBytes: 1, fileCount: 1, partCount: 1, deleteAt: Date.now() + 1e9, timerSet: true })}, __list)`);
  const good = row('https://gofile.io/d/Ab12');
  assert.match(good, /<a class="vault-btn share-row-btn" href="https:\/\/gofile\.io\/d\/Ab12" target="_blank" rel="noopener noreferrer">Open<\/a>/);
  const evil = row('https://evil.example/d/x');
  assert.ok(!/href=/.test(evil), 'no link at all');
  assert.match(evil, /<button type="button" class="vault-btn share-row-btn" disabled>Open<\/button>/);
});

/* ── Secrets ─────────────────────────────────────────────────────────── */

test('source: no share file touches browser storage, logs to the console, or builds a URL with a password', () => {
  // The one exception: the Settings page remembers which of its four tabs was
  // picked last, under its own key, and only ever stores a known tab id. Those
  // two exact calls are taken out; any other use of storage still fails.
  const TAB_GET = 'try { t = localStorage.getItem(SHARE_TAB_KEY); } catch {}';
  const TAB_SET = 'try { localStorage.setItem(SHARE_TAB_KEY, id); } catch {}';
  const ss = read('share-settings-ui.js');
  assert.strictEqual(ss.split(TAB_GET).length, 2, 'the tab is read once');
  assert.strictEqual(ss.split(TAB_SET).length, 2, 'the tab is written once');
  assert.match(ss, /const SHARE_TAB_KEY = 'vault_share_settings_tab';/);
  assert.match(ss, /function _shareTabSelect\(root, id, focus\) \{\n  if \(!root \|\| !SHARE_TABS\.some\(x => x\.id === id\)\) return;/, 'only a known tab id is stored');
  for (const f of FILES) {
    const src = read(f).replace(TAB_GET, '').replace(TAB_SET, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/localStorage|sessionStorage|indexedDB|IDBFactory|document\.cookie/.test(src), `${f}: browser storage`);
    assert.ok(!/console\.(log|warn|error|info|debug)/.test(src), `${f}: console`);
    assert.ok(!/[?&](pass|password|vaultPassword)=/.test(src), `${f}: a password in a URL`);
  }
});

test('behaviour: passwords from reveal, copy block and the gate never reach storage, the console or a global', async () => {
  const SECRET = 'Zz9Q-SECRET-pass-word-0000';
  const VAULT = 'my-vault-password-123';
  const L = load({ answers: {
    'POST /api/share/shares/4/password': { status: 200, body: { password: SECRET } },
    'POST /api/share/shares/4/copy-block': { status: 200, body: { text: `https://gofile.io/d/Ab12\npass: ${SECRET}`, passwordIncluded: true } },
    'POST /api/share/saved-password/reveal': { status: 200, body: { password: SECRET } },
    'GET /api/share/state': { status: 200, body: STATE },
  } });
  const copied = [];
  L.ctx.navigator.clipboard.writeText = async (t) => { copied.push(t); };
  // The prompt answers with the Vault password, as typed.
  L.run(`shareAskVaultPassword = async () => ${JSON.stringify(VAULT)}`);
  setState(L);
  const share = JSON.stringify({ id: 4, passwordKind: 'saved' });
  const r1 = await L.run(`shareWithGate((vp) => shareApi('POST', '/shares/4/password', vp ? { vaultPassword: vp } : {}), { needed: shareNeedsGate(${share}) })`);
  assert.strictEqual(r1.password, SECRET);
  const r2 = await L.run(`shareWithGate((vp) => shareApi('POST', '/shares/4/copy-block', vp ? { vaultPassword: vp } : {}), { needed: true })`);
  await L.run(`shareCopyText(${JSON.stringify(r2.text)})`);
  await L.run(`shareWithGate((vp) => shareApi('POST', '/saved-password/reveal', vp ? { vaultPassword: vp } : {}), { needed: true })`);
  await L.run('shareStatePoll()');
  // The Vault password went in the body only, never the URL.
  const gated = L.calls.filter(c => c.init.body && c.init.body.includes(VAULT));
  assert.strictEqual(gated.length, 3);
  for (const c of L.calls) assert.ok(!c.url.includes(VAULT) && !c.url.includes(SECRET), c.url);
  assert.deepStrictEqual(L.stored, [], 'nothing written to storage');
  assert.deepStrictEqual(L.logged, [], 'nothing logged');
  assert.deepStrictEqual(copied, [`https://gofile.io/d/Ab12\npass: ${SECRET}`], 'copied on request');
  // No global holds either secret afterwards.
  const globals = L.run(`JSON.stringify({ s: _shareState, w: _shareWin, l: _shareList, t: _shareTop })`);
  assert.ok(!globals.includes(SECRET) && !globals.includes(VAULT), 'no lasting global keeps a password');
});

test('a wrong Vault password asks again with the tries left, and Cancel sends nothing more', async () => {
  const L = load({ answers: { 'POST /api/share/saved-password/reveal': { status: 401, body: { error: 'That is not your Vault password.', code: 'GATE_WRONG', attemptsLeft: 3 } } } });
  const asked = [];
  L.ctx.__ask = asked;
  L.run(`let __n = 0; shareAskVaultPassword = async (why, problem) => { __ask.push(problem || ''); return __n++ ? null : 'wrong'; }`);
  const r = await L.run(`shareWithGate((vp) => shareApi('POST', '/saved-password/reveal', vp ? { vaultPassword: vp } : {}), { needed: true })`);
  assert.strictEqual(r, null);
  assert.deepStrictEqual(asked, ['', 'That is not your Vault password. 3 tries left.']);
  assert.strictEqual(L.calls.length, 1);
});

/* ── Privacy ─────────────────────────────────────────────────────────── */

test('privacy: My shares, the popup text and the file lists are marked private; the CSS blurs them with no pointer', () => {
  const L = load();
  setState(L);
  L.ctx.__list = { shares: [{ id: 1, archiveName: 'a', status: 'uploaded', link: 'https://gofile.io/d/A', sizeBytes: 1, fileCount: 1, partCount: 1, timerSet: true, onGofile: true }], open: new Set(), files: new Map() };
  const list = L.run('shareListHtml(__list)');
  assert.match(list, /<div class="share-table-wrap" data-share-private>\s*<table/, 'the whole table is private');
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'share.css'), 'utf8');
  const rule = /body\.pm-shares \[data-share-private\] \{([^}]*)\}/.exec(css);
  assert.ok(rule);
  assert.match(rule[1], /filter: blur\(7px\)/);
  assert.match(rule[1], /pointer-events: none/);
  assert.match(rule[1], /user-select: none/);
  for (const f of ['shareReviewHtml', 'shareRenderPop', 'shareOpenDeleteAll']) {
    const body = read(f === 'shareOpenDeleteAll' ? 'share-settings-ui.js' : 'share-ui.js').split(`function ${f}(`)[1].split('\nfunction ')[0];
    assert.match(body, /data-share-private/, `${f}: private part`);
  }
  const settings = read('settings.js');
  assert.match(settings, /shares:\s+true,/, 'on by default');
  assert.match(settings, /shares:\s+'pm-shares'/);
  assert.match(settings, /\{ key: 'shares',\s+label: 'My shares/);
  const apply = /function applyPrivacyMode\(on\) \{([\s\S]*?)\n  \}/.exec(settings.replace(/\r\n/g, '\n'));
  assert.match(apply[1], /sharePrivacyChanged\(\)/, 'live when the toggle changes');
});

test('privacy: the keyboard guard makes the private parts inert while pm-shares is on, and gives them back', () => {
  const classes = new Set();
  const L = load({ bodyClasses: classes });
  const els = [0, 1].map(() => ({ inert: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } }));
  const root = { querySelectorAll: (sel) => (sel === '[data-share-private]' ? els : []) };
  L.ctx.__root = root;
  L.run('sharePrivacyChanged(__root)');
  assert.ok(els.every(e => e.inert === false));
  classes.add('pm-shares');
  L.run('sharePrivacyChanged(__root)');
  assert.ok(els.every(e => e.inert === true && e.attrs['aria-hidden'] === 'true'), 'out of the Tab order');
  classes.delete('pm-shares');
  L.run('sharePrivacyChanged(__root)');
  assert.ok(els.every(e => e.inert === false && !('aria-hidden' in e.attrs)));
});

/* Privacy: the archive name, the link and the password, everywhere in the window. */

const P_NAME = 'Holiday-secret';
const P_LINK = 'https://gofile.io/d/SeCr3t';
const P_PASS = 'Pw-9Qz-SECRET-0000';

function privWin(L) {
  setState(L);
  L.ctx.__w = {
    id: 4, step: 'done', ticked: false, samples: [],
    share: { id: 4, archiveName: P_NAME, archiveFileName: `${P_NAME}.7z.001`, archiveDisplayName: `${P_NAME}.7z`, sizeBytes: 3 * 1024 ** 3, partCount: 2, partSize: 2 * 1024 ** 3,
      fileCount: 2, passwordKind: 'random', passwordKept: true, deleteAfterDays: 7, link: P_LINK, code: 'SeCr3t', status: 'uploaded', deleteAt: Date.now() + 86400000, timerSet: true },
    progress: { checks: { test: { ok: true }, listWithoutPassword: { ok: true }, contents: { files: 2 }, parts: { count: 2, bytes: 3 * 1024 ** 3 }, archiveName: { value: P_NAME, typed: true } },
      upload: { parts: [{ partNo: 1, fileName: `${P_NAME}.7z.001`, sizeBytes: 2 * 1024 ** 3, status: 'done' }] } },
  };
  return {
    checked: L.run('shareCheckedHtml(__w)'),
    confirm: L.run('shareConfirmHtml(__w)'),
    upload: L.run('shareUploadHtml(__w)'),
    part: L.run('sharePartRowHtml(__w.progress.upload.parts[0])'),
    done: L.run('shareDoneHtml(__w)'),
  };
}

/** Every element marked data-share-private in some markup: { tag, attrs, inner }. */
function privateEls(html) {
  const out = [];
  const re = /<(input|span|pre|dd|div)\b([^>]*\bdata-share-private\b[^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1];
    let inner = '';
    if (tag !== 'input') {
      const end = html.indexOf(`</${tag}>`, re.lastIndex);
      inner = html.slice(re.lastIndex, end);
    }
    out.push({ tag, attrs: m[2], whole: m[0] + inner });
  }
  return out;
}

/** The markup with every private element (and what is inside it) taken out. */
const withoutPrivate = (html) => privateEls(html).reduce((h, e) => h.split(e.whole).join(''), html);

test('privacy: the archive name, the part names, the link, the password and the block are each inside a private part', () => {
  const L = load();
  const pages = privWin(L);
  for (const [k, html] of Object.entries(pages)) {
    const shows = k === 'done' ? [P_NAME, P_LINK, 'SeCr3t'] : [P_NAME];
    assert.ok(shows.some(s => html.includes(s)), `${k}: the value is drawn`);
    const rest = withoutPrivate(html);
    for (const s of [P_NAME, P_LINK, 'SeCr3t']) assert.ok(!rest.includes(s), `${k}: ${s} outside a private part`);
  }
  // The title line keeps its words; only the name is blurred.
  assert.match(pages.upload, /<h3 id="shareWinTitle">Uploading <span class="share-priv" data-share-private>Holiday-secret<\/span><\/h3>/);
  assert.match(pages.confirm, /<dt>Sending<\/dt><dd class="share-mono"><span class="share-priv" data-share-private>Holiday-secret\.7z<\/span>, 3 GB in 2 parts<\/dd>/);
  assert.match(pages.part, /<span class="share-part-name share-mono" data-share-private>Holiday-secret\.7z\.001<\/span>/);
  // The link and password fields turn into dots too; the block is blurred whole.
  assert.match(pages.done, /<input class="vault-input share-mono" id="shLink" readonly value="https:\/\/gofile\.io\/d\/SeCr3t" data-share-private data-share-mask>/);
  assert.match(pages.done, /<input type="password" id="shPw"[^>]*data-share-private data-share-mask>/);
  assert.match(pages.done, /<pre class="share-pre share-mono"[^>]*data-sh-block data-share-private>/);
  // The buttons are not private: Copy link, Copy password, Copy as block, Delete, Done still work.
  for (const act of ['copy-link', 'pw-copy', 'pw-show', 'copy-block', 'delete-remote', 'close']) {
    assert.ok(withoutPrivate(pages.done).includes(`data-sh-act="${act}"`), `${act} stays usable`);
  }
  assert.ok(withoutPrivate(pages.upload).includes('data-sh-act="stop"') && withoutPrivate(pages.upload).includes('data-sh-act="pause"'));
  assert.ok(withoutPrivate(pages.confirm).includes('data-sh-act="upload"'));
  // The saved password in Settings is masked and blurred the same way.
  const S = load({ kit: true });
  setState(S);
  assert.match(S.run('shareSettingsHtml()'), /id="shSavedPw" readonly autocomplete="off" aria-label="My saved password" data-share-private data-share-mask/);
});

test('privacy: no title or aria attribute carries the archive name or the link', () => {
  const L = load();
  const pages = Object.values(privWin(L));
  L.ctx.__list = { shares: [L.ctx.__w.share], open: new Set([4]), files: new Map([[4, { files: [{ name: 'a.mp4', sizeBytes: 5 }] }]]) };
  pages.push(L.run('shareListHtml(__list)'));
  for (const html of pages) {
    const attrs = html.match(/\b(title|aria-[\w-]+)="[^"]*"/g) || [];
    for (const a of attrs) assert.ok(!a.includes(P_NAME) && !a.includes('SeCr3t'), `leaks: ${a}`);
  }
  // My shares: the name, the Open link and the fold-out all sit inside the one private table.
  const list = pages[pages.length - 1];
  const wrap = list.split('<div class="share-table-wrap" data-share-private>')[1].split('<div class="vault-modal-err"')[0];
  assert.ok(wrap.includes(`${P_NAME}.7z`) && wrap.includes(`href="${P_LINK}"`) && wrap.includes('a.mp4'));
  const outside = list.replace(wrap, '');
  assert.ok(!outside.includes(P_NAME) && !outside.includes('SeCr3t'));
  // The top bar button says what is happening, never which archive.
  const pill = read('share-ui.js').split('function shareRenderPill(')[1].split('\nfunction ')[0];
  assert.ok(!/archiveName/.test(pill));
});

/** A fake element made from one rendered tag, enough for sharePrivacyChanged. */
function fakeEl(e) {
  const type = /\btype="(\w+)"/.exec(e.attrs);
  return {
    tag: e.tag, inert: false, attrs: {}, dataset: {}, type: e.tag === 'input' ? (type ? type[1] : 'text') : undefined,
    mask: /\bdata-share-mask\b/.test(e.attrs),
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
  };
}
const fakeRoot = (els) => ({ querySelectorAll: (sel) => (sel === '[data-share-private]' ? els : sel === '[data-share-mask]' ? els.filter(x => x.mask) : []) });

test('privacy: toggling with step 4 open blurs and masks at once, and gives the revealed password back after', async () => {
  const classes = new Set();
  const L = load({ bodyClasses: classes, answers: { 'POST /api/share/shares/4/password': { status: 200, body: { password: P_PASS } } } });
  const pages = privWin(L);
  const els = privateEls(pages.done).map(fakeEl);
  const link = els.find(e => e.tag === 'input' && e.type === 'text');
  const pw = els.find(e => e.tag === 'input' && e.type === 'password');
  const pre = els.find(e => e.tag === 'pre');
  assert.ok(link && pw && pre);
  // Live: settings.js calls sharePrivacyChanged() with no root, so it reaches the whole page.
  L.ctx.document.querySelectorAll = fakeRoot(els).querySelectorAll;
  L.run('sharePrivacyChanged()');
  assert.ok(els.every(e => !e.inert && !('aria-hidden' in e.attrs)), 'privacy off: nothing hidden');
  assert.strictEqual(link.type, 'text');
  // Show the password while privacy is off.
  const btn = { textContent: 'Show', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  pw.value = '';
  L.ctx.__q = { '#shPw': pw, '[data-sh-block]': pre };
  L.ctx.__btn = btn;
  L.run(`_shareWin = __w; __w.m = { q: (s) => __q[s] || null }`);
  await L.run(`sharePasswordAction('show', __btn)`);
  assert.strictEqual(pw.value, P_PASS);
  assert.strictEqual(pw.type, 'text', 'shown');
  assert.ok(pre.textContent.includes(P_PASS), 'the block has the real password now');
  // Privacy on (Ctrl+Shift+H) with the window open.
  classes.add('pm-shares');
  L.run('sharePrivacyChanged()');
  assert.ok(els.every(e => e.inert === true && e.attrs['aria-hidden'] === 'true'), 'blurred parts are out of the keyboard order');
  assert.strictEqual(link.type, 'password', 'the link field is dots');
  assert.strictEqual(pw.type, 'password', 'the shown password is dots again');
  // Hide and Show under privacy keep the field dots.
  await L.run(`sharePasswordAction('show', __btn)`);
  assert.strictEqual(btn.textContent, 'Show');
  assert.strictEqual(pw.type, 'password');
  await L.run(`sharePasswordAction('show', __btn)`);
  assert.strictEqual(btn.textContent, 'Hide');
  assert.strictEqual(pw.type, 'password', 'still dots while privacy is on');
  // Privacy off: everything back, the password as the user left it (shown).
  classes.delete('pm-shares');
  L.run('sharePrivacyChanged()');
  assert.ok(els.every(e => e.inert === false && !('aria-hidden' in e.attrs)));
  assert.strictEqual(link.type, 'text');
  assert.strictEqual(pw.type, 'text');
  assert.deepStrictEqual({ ...link.dataset }, {}, 'no leftover mark');
});

test('privacy: Copy link, Copy password and Copy as block still copy while pm-shares is on', async () => {
  const classes = new Set(['pm-shares']);
  const L = load({ bodyClasses: classes, answers: {
    'POST /api/share/shares/4/password': { status: 200, body: { password: P_PASS } },
    'POST /api/share/shares/4/copy-block': { status: 200, body: { text: `${P_LINK}\npass: ${P_PASS}`, passwordIncluded: true } },
  } });
  const copied = [];
  L.ctx.navigator.clipboard.writeText = async (t) => { copied.push(t); };
  privWin(L);
  const pw = { type: 'password', value: '', dataset: { shareType: 'password' } };
  const pre = { textContent: '' };
  L.ctx.__q = { '#shPw': pw, '[data-sh-block]': pre };
  L.ctx.__btn = { textContent: 'Copy password', setAttribute: noop };
  L.run(`_shareWin = __w; __w.m = { q: (s) => __q[s] || null }`);
  await L.run(`shareDoneAct('copy-link')`);
  await L.run(`sharePasswordAction('copy', __btn)`);
  await L.run(`shareDoneAct('copy-block')`);
  assert.deepStrictEqual(copied, [P_LINK, P_PASS, `${P_LINK}\npass: ${P_PASS}`]);
  assert.strictEqual(pw.type, 'password', 'copying never shows it');
});

/* ── Stopping ────────────────────────────────────────────────────────── */

test('stopping: My shares says so and offers only Open upload; the share window stays on 3b with its buttons off', async () => {
  const L = load({ answers: {
    'GET /api/share/shares/4/progress': { status: 200, body: { id: 4, status: 'stopping', error: null, upload: {
      bytesDone: 10, bytesTotal: 20, percent: 50, partsAtOnce: 2, waitingInLine: false,
      parts: [{ partNo: 1, fileName: 'a.7z.001', sizeBytes: 10, status: 'done', percent: 100 }, { partNo: 2, fileName: 'a.7z.002', sizeBytes: 10, status: 'failed', percent: 0 }],
    } } },
    'GET /api/share/shares/4': { status: 200, body: { share: { id: 4, status: 'stopping', archiveName: 'a' } } },
  } });
  setState(L);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(L.run(`shareStatusWords({ status: 'stopping' })`))), { text: 'Stopping and deleting', tone: 'busy' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(L.run(`shareRowActions({ status: 'stopping', onGofile: true }, true)`))).map(a => a.key), ['view']);
  const el = () => ({ textContent: '', disabled: false, hidden: false, dataset: {}, setAttribute: noop, firstElementChild: { style: {} } });
  const retry = el();
  const host = { innerHTML: '', querySelector: () => null, querySelectorAll: (s) => (s === '[data-sh-retry]' ? [retry] : []) };
  const q = { '[data-sh-state]': el(), '[data-sh-act="pause"]': el(), '[data-sh-act="stop"]': el(), '[data-sh-parts]': host };
  L.ctx.__q = q;
  L.run(`_shareWin = { id: 4, step: 'upload', samples: [], share: { id: 4, status: 'paused' }, m: { q: (s) => __q[s] || null } }`);
  await L.run('shareWindowRefresh()');
  assert.strictEqual(L.run('_shareWin.step'), 'upload', 'not "This share has ended" while it is stopping');
  assert.strictEqual(q['[data-sh-state]'].textContent, 'Stopping and deleting the uploaded parts.');
  assert.strictEqual(q['[data-sh-act="pause"]'].disabled, true);
  assert.strictEqual(q['[data-sh-act="stop"]'].disabled, true);
  assert.strictEqual(retry.disabled, true);
});

/* ── Feature off ─────────────────────────────────────────────────────── */

test('feature off: Delete and Stop stay available in My shares; Resume does not', () => {
  const L = load();
  const acts = (share, on) => JSON.parse(JSON.stringify(L.run(`shareRowActions(${JSON.stringify(share)}, ${on})`)));
  const up = acts({ status: 'uploaded', timerSet: true, deleteAfterDays: 7 }, false);
  assert.deepStrictEqual(up.map(a => a.key), ['copy', 'open', 'gone', 'delete']);
  assert.ok(up.every(a => !a.disabled));
  const noTimer = acts({ status: 'uploaded', timerSet: false, deleteAfterDays: 7 }, false);
  assert.deepStrictEqual(noTimer.map(a => [a.key, a.disabled]), [['copy', false], ['open', false], ['gone', false], ['timer', true], ['delete', false]], 'Set timer again needs the feature on');
  const paused = acts({ status: 'paused' }, false);
  assert.deepStrictEqual(paused.map(a => [a.key, a.disabled]), [['view', false], ['resume', true], ['stop', false]]);
  assert.ok(acts({ status: 'paused' }, true).every(a => !a.disabled));
  assert.deepStrictEqual(acts({ status: 'failed', onGofile: true }, false).map(a => a.key), ['delete', 'remove']);
  assert.deepStrictEqual(acts({ status: 'deleted' }, true).map(a => a.key), ['remove']);
  setState(L, { enabled: false });
  L.ctx.__list = { shares: [{ id: 1, archiveName: 'a', status: 'uploaded', onGofile: true, link: 'https://gofile.io/d/A', sizeBytes: 1, fileCount: 1, partCount: 1, timerSet: true }], open: new Set(), files: new Map() };
  const html = L.run('shareListHtml(__list)');
  assert.match(html, /data-list-act="delete-all">Delete all uploads from gofile/, 'Delete all enabled');
  assert.ok(!/turn on share privately/i.test(html), 'no "turn it on to delete" line');
});

/* ── Settings ────────────────────────────────────────────────────────── */

test('settings: the Private sharing card, then four tabs, no parts-at-once or upload server setting', () => {
  const L = load({ kit: true });
  setState(L);
  const html = L.run('shareSettingsHtml()');
  for (const id of ['shareEnabled', 'sharePasswordChoice', 'shareDeleteAfter', 'shareSplit', 'shareMyShares', 'shareAfterPack', 'shareSavedPassword',
    'shareNameMode', 'shareCustomPart', 'shareKeepLocal', 'shareOnPartFail', 'shareAccount', 'shareCopyFormat', 'shareRememberPasswords',
    'shareRememberFiles', 'shareHideInPrivacy', 'shareTopBarIcon', 'shareReset']) {
    assert.ok(html.includes(`data-sfind="${id}"`), id);
  }
  assert.ok(!/share-more"|More options/.test(html), 'no More options fold');
  assert.match(html, /<div class="settings-seg share-tabs" role="tablist" aria-label="Share privately settings">/);
  const tabs = [...html.matchAll(/<button type="button" class="settings-seg-btn share-tab" role="tab" id="shareTab-(\w+)" data-share-tab="\w+"\s+aria-controls="shareTabPanel-(\w+)" aria-selected="(true|false)" tabindex="(0|-1)">([^<]+)<\/button>/g)]
    .map(m => [m[1], m[2], m[3], m[4], m[5]]);
  assert.deepStrictEqual(tabs, [
    ['basics', 'basics', 'true', '0', 'Basics'], ['packing', 'packing', 'false', '-1', 'Packing'],
    ['upload', 'upload', 'false', '-1', 'Upload'], ['remember', 'remember', 'false', '-1', 'Remembering']]);
  // Which rows sit on which tab (the card above the tabs holds My shares and the switch).
  const panel = (id) => {
    const m = html.match(new RegExp(`<div class="share-tab-panel" role="tabpanel" id="shareTabPanel-${id}" data-share-panel="${id}" aria-labelledby="shareTab-${id}"( hidden)?>`));
    assert.ok(m, id);
    const next = html.indexOf('class="share-tab-panel"', m.index + 10);
    return { hidden: !!m[1], html: html.slice(m.index, next < 0 ? undefined : next) };
  };
  const sf = (h) => [...h.matchAll(/data-sfind="(\w+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(sf(panel('basics').html), ['sharePasswordChoice', 'shareSavedPassword', 'shareDeleteAfter', 'shareSplit', 'shareCustomPart', 'shareCopyFormat']);
  assert.deepStrictEqual(sf(panel('packing').html), ['shareAfterPack', 'shareNameMode', 'shareKeepLocal', 'shareCheckPersonal']);
  assert.deepStrictEqual(sf(panel('upload').html), ['shareOnPartFail', 'shareAccount']);
  assert.deepStrictEqual(sf(panel('remember').html).slice(0, 4), ['shareRememberPasswords', 'shareRememberFiles', 'shareHideInPrivacy', 'shareTopBarIcon']);
  assert.deepStrictEqual(['basics', 'packing', 'upload', 'remember'].map(id => panel(id).hidden), [false, true, true, true]);
  const tablist = html.indexOf('role="tablist"');
  assert.ok(html.indexOf('data-sfind="shareMyShares"') < tablist && html.indexOf('data-sfind="shareEnabled"') < tablist, 'Private sharing stays above the tabs');
  assert.match(html, /<option value="wait" selected>Wait for me to check<\/option><option value="upload">Upload on its own<\/option>/, 'When packing is done: wait by default');
  assert.match(html, /Wait for me keeps the last look at the tested archive before anything leaves this computer\./);
  assert.match(html, /data-share-act="reset">Put back the defaults<\/button>/);  assert.ok(!/parts at once|upload server|closest region/i.test(html));
  assert.match(html, /<option value="2g" selected>2 GB<\/option>/, '2 GB parts by default');
  assert.match(html, /data-share-act="myshares">Open My shares<\/button>/);
  assert.match(html, /<input type="password" class="settings-text share-mono" id="shSavedPw" readonly/, 'the saved password is dots until Show');
  assert.ok(!/[—–]/.test(html.replace(/<[^>]+>/g, '')), 'no long dashes');
  const search = read('settings-search.js');
  assert.match(search, /\{ id: 'sharing', title: 'Private sharing' \}/);
  for (const id of ['shareEnabled', 'shareCustomPart', 'shareCopyFormat', 'shareHideInPrivacy', 'shareAfterPack']) {
    assert.match(search, new RegExp(`page: 'sharing', id: '${id}'`), `search entry ${id}`);
  }
  assert.ok(!/id: 'shareMore'/.test(search), 'no entry for the old fold');
});

test('settings: My saved password shows when it applies; the tab picked last is the one drawn', () => {
  const L = load({ kit: true });
  setState(L, { settings: { passwordChoice: 'random' }, savedPassword: { set: false, vaultPasswordSet: false } });
  assert.match(L.run('shareSettingsHtml()'), /<div data-share-saved-row hidden>/, 'random and none saved: hidden');
  setState(L, { settings: { passwordChoice: 'saved' }, savedPassword: { set: false, vaultPasswordSet: false } });
  assert.match(L.run('shareSettingsHtml()'), /<div data-share-saved-row>/);
  setState(L, { settings: { passwordChoice: 'random' }, savedPassword: { set: true, vaultPasswordSet: false } });
  assert.match(L.run('shareSettingsHtml()'), /<div data-share-saved-row>/, 'one saved: shown so it can be changed');
  // localStorage that throws (a private window): the tab picked in this load still holds.
  L.ctx.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  L.ctx.__root = { querySelectorAll: () => [] };
  L.run(`_shareTabSelect(__root, 'upload', false)`);
  assert.match(L.run('shareSettingsHtml()'), /id="shareTab-upload" data-share-tab="upload"\s+aria-controls="shareTabPanel-upload" aria-selected="true"/);
  L.run(`_shareTabSelect(__root, 'nope', false)`);
  assert.strictEqual(L.run('_shareTabNow()'), 'upload', 'an unknown tab is ignored');
  // A stored tab wins, and only a known one.
  L.ctx.localStorage = { getItem: () => 'remember', setItem: () => {} };
  assert.strictEqual(L.run('_shareTabNow()'), 'remember');
  L.ctx.localStorage = { getItem: () => '<img>', setItem: () => {} };
  assert.strictEqual(L.run('_shareTabNow()'), 'upload');
});

test('settings: the custom part size field shows only when Custom size is picked, and keeps to 50 MB to 16 GB', () => {
  const L = load({ kit: true });
  setState(L, { settings: { split: '2g' } });
  assert.match(L.run('shareSettingsHtml()'), /<div data-share-custom-row hidden>/);
  setState(L, { settings: { split: 'custom', customPartBytes: 750 * 1024 * 1024 } });
  const html = L.run('shareSettingsHtml()');
  assert.match(html, /<div data-share-custom-row>/);
  assert.match(html, /data-share-custom-n value="750"/);
  assert.match(html, /<option selected>MB<\/option>/);
  const parse = (n, u) => L.run(`shareParseCustomSize(${JSON.stringify(n)}, '${u}')`);
  assert.strictEqual(parse('50', 'MB'), 50 * 1024 * 1024);
  assert.strictEqual(parse('16', 'GB'), 16 * 1024 ** 3);
  assert.strictEqual(parse('49', 'MB'), null);
  assert.strictEqual(parse('17', 'GB'), null);
  assert.strictEqual(parse('abc', 'MB'), null);
  assert.deepStrictEqual({ ...L.run('shareCustomSizeParts(4 * 1024 ** 3)') }, { n: 4, unit: 'GB' });
});

test('copy format preview: the default and a custom format, unknown pieces left as typed', () => {
  const L = load();
  const p = (f) => L.run(`shareFormatPreview(${JSON.stringify(f)})`);
  assert.strictEqual(p(L.run('SHARE_READY_FORMATS.default')), 'https://gofile.io/d/x7k2p9Qm\npass: T4rQ-Wq9z-Lm2K-xP7d-Vb6N-hJ3s');
  assert.strictEqual(p('code: {code} | p: {pass}'), 'code: x7k2p9Qm | p: T4rQ-Wq9z-Lm2K-xP7d-Vb6N-hJ3s');
  assert.strictEqual(p('{name} {other} {link}'), 'k7Qm2xVd9LpA {other} https://gofile.io/d/x7k2p9Qm');
  assert.strictEqual(L.run(`shareRenderFormat('{link} {pass}', { link: 'L', pass: null })`), 'L', 'no password kept: the link alone');
  assert.strictEqual(L.run(`shareFormatFor({ copyFormat: 'custom', customFormat: '  ' })`), '{link}\npass: {pass}', 'an empty own format falls back');
  // The same example values as the server's preview route.
  const server = fs.readFileSync(path.join(__dirname, '..', 'lib', 'share', 'service.js'), 'utf8');
  assert.ok(server.includes("pass: 'T4rQ-Wq9z-Lm2K-xP7d-Vb6N-hJ3s'"));
});

test('the selection bar and a file menu offer Share privately only while the feature is on', () => {
  const L = load();
  setState(L, { enabled: false });
  assert.strictEqual(L.run('shareEnabled()'), false);
  assert.strictEqual(L.run(`shareMenuItemHtml({ id: 3, media_type: 'video' })`), '');
  setState(L, { enabled: true });
  assert.strictEqual(L.run('shareEnabled()'), true);
  assert.match(L.run(`shareMenuItemHtml({ id: 3, media_type: 'video' })`), /shareOpenForIds\(\[3\]\)/);
  assert.strictEqual(L.run(`shareDetailButtonHtml({ id: 3, media_type: 'mix' })`), '', 'a mix has no file');
  // The selection bar's Share (selection.js SEL_ACTIONS; the bar's own test runs it): only while on.
  const sel = read('selection.js');
  const at = sel.indexOf("{ id: 'share'");
  const entry = sel.slice(at, sel.indexOf('},', at));
  assert.match(entry, /bar: 'Share', menu: 'Share privately'/);
  assert.match(entry, /visible: \(\) => typeof shareEnabled === 'function' && shareEnabled\(\)/);
  assert.match(entry, /run: \(\) => shareOpenForSelection\(\)/);
});

/* ── Closing by a click outside or Esc ───────────────────────────────── */

/** A stand-in element: listeners, cached children, enough for shareModal and the top bar. */
function stubEl(name) {
  const el = {
    name, listeners: {}, cache: {}, attrs: {}, dataset: {}, style: {}, hidden: false, value: '', disabled: false, isConnected: true,
    classList: { add: noop, remove: noop, contains: () => false },
    textContent: '', innerHTML: '', title: '',
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    fire(t, e) { for (const f of this.listeners[t] || []) f(e); },
    querySelector(sel) { return (this.cache[sel] ||= stubEl(sel)); },
    querySelectorAll: () => [],
    setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; },
    focus: noop, insertBefore: noop, contains: () => false, closest: () => null,
    remove() { this.isConnected = false; },
  };
  return el;
}

/** load() plus a stand-in DOM: windows open, Esc reaches them, the backdrop takes mouse events. */
function loadDom(opts) {
  const L = load(opts);
  const keys = [];
  L.ctx.addEventListener = (t, f) => { if (t === 'keydown') keys.push(f); };
  L.ctx.removeEventListener = (t, f) => { const i = keys.indexOf(f); if (i >= 0) keys.splice(i, 1); };
  L.ctx.document.createElement = () => { const ov = stubEl('ov'); ov.firstElementChild = stubEl('box'); return ov; };
  L.ctx.document.body.appendChild = noop;
  L.ctx.document.activeElement = null;
  L.ctx.vaultConfirm = async () => { throw new Error('no confirm expected'); };
  setState(L);
  const top = () => L.run('_shareModals[_shareModals.length - 1]');
  return {
    L, top,
    esc() { const e = { key: 'Escape', preventDefault: noop, stopImmediatePropagation: noop }; [...keys].forEach(f => f(e)); },
    /** Press and release on the dim backdrop. */
    outside(m = top()) { m.ov.fire('mousedown', { target: m.ov, preventDefault: noop }); m.ov.fire('click', { target: m.ov }); },
    /** A text selection: pressed inside the window, released outside. */
    dragOut(m = top()) { m.ov.fire('mousedown', { target: m.box, preventDefault: noop }); m.ov.fire('click', { target: m.ov }); },
    /** Pressed outside, released inside. */
    dragIn(m = top()) { m.ov.fire('mousedown', { target: m.ov, preventDefault: noop }); m.ov.fire('click', { target: m.box }); },
  };
}

const LISTED = { id: 1, archiveName: 'a', status: 'uploaded', onGofile: true, link: 'https://gofile.io/d/A', sizeBytes: 1, fileCount: 1, partCount: 1, timerSet: true, uploadedAt: Date.now() };

test('My shares: a click outside or Esc closes it; a drag that starts or ends inside does not', async () => {
  const D = loadDom({ answers: { 'GET /api/share/shares': { status: 200, body: { shares: [LISTED] } } } });
  await D.L.run('shareOpenMyShares()');
  const m = D.top();
  D.dragOut();
  D.dragIn();
  assert.strictEqual(m.closed, false, 'a drag across the edge keeps it open');
  D.outside();
  assert.strictEqual(m.closed, true);
  assert.strictEqual(D.L.run('_shareList'), null);
  await D.L.run('shareOpenMyShares()');
  const m2 = D.top();
  D.esc();
  assert.strictEqual(m2.closed, true, 'Esc does the same');
  assert.strictEqual(D.L.run('_shareModals.length'), 0, 'back to what was under it (Settings)');
});

test('Delete all: a click outside or Esc is "Keep them" (My shares stays); not while the deletes run', async () => {
  let release;
  const D = loadDom({ answers: { 'GET /api/share/shares': { status: 200, body: { shares: [LISTED] } } } });
  await D.L.run('shareOpenMyShares()');
  const list = D.top();
  D.L.run('shareOpenDeleteAll()');
  const del = D.top();
  assert.notStrictEqual(del, list);
  D.dragOut(del);
  assert.strictEqual(del.closed, false);
  const before = D.L.calls.length;
  D.outside(del);
  assert.strictEqual(del.closed, true, 'outside = Keep them');
  assert.strictEqual(list.closed, false, 'My shares is still open under it');
  assert.ok(D.L.calls.slice(before).some(c => c.url === '/api/share/shares'), 'the list is asked for again, as Keep them does');
  D.L.run('shareOpenDeleteAll()');
  const del2 = D.top();
  D.esc();
  assert.strictEqual(del2.closed, true, 'Esc = Keep them');
  assert.strictEqual(list.closed, false);
  // While the deletes run, neither closes it: the results must not be missed.
  D.L.ctx.fetch = (url, init) => { D.L.calls.push({ url, init }); return new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({ results: [{ id: 1, ok: true }], deleted: 1, failed: 0 }) }); }); };
  D.L.run('shareOpenDeleteAll()');
  const del3 = D.top();
  const go = del3.q('[data-del-act="go"]');
  go.dataset.delAct = 'go';
  del3.box.fire('click', { target: { closest: (s) => (s === '[data-del-act]' ? go : null) } });
  D.outside(del3);
  D.esc();
  assert.strictEqual(del3.closed, false, 'kept open while deleting');
  release();
  await new Promise(r => setImmediate(r));
  D.esc();
  assert.strictEqual(del3.closed, true, 'Esc closes once the results show');
});

test('the share window and Change saved password ignore a click outside; Esc still closes them', async () => {
  const D = loadDom();
  D.L.run('shareWindowOpen()');
  const w = D.top();
  D.outside();
  assert.strictEqual(w.closed, false, 'a stray click never closes the share window');
  assert.ok(D.L.run('_shareWin'), 'the share window is still there');
  D.esc();
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(w.closed, true, 'Esc asks to close, as Close does');
  D.L.run('shareOpenChangePassword()');
  const cp = D.top();
  D.outside();
  assert.strictEqual(cp.closed, false, 'a typed password is never dropped by a stray click');
  D.esc();
  assert.strictEqual(cp.closed, true, 'Esc is Cancel');
  // The Vault password prompt keeps Esc as Cancel and has no outside close.
  const src = read('share-ui.js');
  assert.ok(!/shareGateDlg[\s\S]{0,200}outside: true/.test(src));
});

test('Copy format editor: closes on a click outside or Esc only while nothing was changed', () => {
  const D = loadDom({ kit: true });
  D.L.run('shareOpenCopyFormat(null)');
  const m = D.top();
  D.dragOut();
  assert.strictEqual(m.closed, false);
  D.outside();
  assert.strictEqual(m.closed, true, 'no edits: outside closes it');
  D.L.run('shareOpenCopyFormat(null)');
  const m2 = D.top();
  m2.q('#shFmtText').value = 'mine: {link}';
  D.outside();
  D.esc();
  assert.strictEqual(m2.closed, false, 'unsaved edits: kept open');
  const cancel = { dataset: { fmtAct: 'cancel' } };
  m2.box.fire('click', { target: { closest: (s) => (s === '[data-fmt-act]' ? cancel : null) } });
  assert.strictEqual(m2.closed, true, 'Cancel still closes');
  D.L.run('shareOpenCopyFormat(null)');
  const m3 = D.top();
  D.esc();
  assert.strictEqual(m3.closed, true, 'no edits: Esc closes it');
});

/* ── Copy format: the row and the editor ─────────────────────────────── */

test('Copy format: Edit shows only for My own format; the editor has no ready-format dropdown', () => {
  const D = loadDom({ kit: true });
  const row = (fmt) => D.L.run(`_shareState.settings.copyFormat = ${JSON.stringify(fmt)}; shareSettingsHtml()`);
  assert.match(row('default'), /data-share-act="format-edit" hidden>Edit</);
  assert.match(row('oneLine'), /data-share-act="format-edit" hidden>Edit</);
  assert.match(row('custom'), /data-share-act="format-edit">Edit</);
  assert.match(row('custom'), /data-share-sel="copyFormat"/, 'the ready formats stay on the row');
  D.L.run('shareOpenCopyFormat(null)');
  const html = D.top().ov.innerHTML;
  assert.ok(!/<select|shFmtChoice/.test(html), 'no dropdown in the editor');
  for (const want of ['id="shFmtText"', 'data-fmt-piece="{link}"', 'data-fmt-piece="{code}"', 'data-fmt-piece="{pass}"', 'data-fmt-piece="{name}"',
    'data-fmt-preview', 'data-fmt-act="default">Back to the default', 'data-fmt-act="save">Save']) {
    assert.ok(html.includes(want), want);
  }
  assert.ok(!/[—–]/.test(html.replace(/<[^>]+>/g, '')), 'no long dashes');
});

test('Copy format: picking My own format the first time opens the editor with the format in use; closing puts the dropdown back', async () => {
  const D = loadDom({ kit: true });
  D.L.run(`_shareState.settings.copyFormat = 'oneLine'`);
  const edit = stubEl('edit');
  edit.hidden = true;
  const root = stubEl('root');
  root.cache['[data-share-act="format-edit"]'] = edit;
  const sel = { value: 'custom' };
  D.L.ctx.__root = root;
  D.L.ctx.__sel = sel;
  await D.L.run(`shareCopyFormatPicked(__sel, 'custom', __root)`);
  const m = D.top();
  assert.ok(m, 'the editor opened');
  assert.ok(m.ov.innerHTML.includes('>code: {code} | pass: {pass}</textarea>'), 'prefilled with the one-line format');
  assert.strictEqual(D.L.calls.filter(c => c.init.method === 'POST').length, 0, 'nothing saved yet');
  D.outside();
  assert.strictEqual(m.closed, true);
  assert.strictEqual(sel.value, 'oneLine', 'the dropdown goes back');
  // Save stores both: the choice and the text.
  await D.L.run(`shareCopyFormatPicked(__sel, 'custom', __root)`);
  const m2 = D.top();
  m2.q('#shFmtText').value = 'code: {code} | pass: {pass} | {name}';
  const save = { dataset: { fmtAct: 'save' } };
  m2.box.fire('click', { target: { closest: (s) => (s === '[data-fmt-act]' ? save : null) } });
  await new Promise(r => setImmediate(r));
  const post = D.L.calls.find(c => c.init.method === 'POST' && c.url === '/api/share/settings');
  assert.deepStrictEqual(JSON.parse(post.init.body), { copyFormat: 'custom', customFormat: 'code: {code} | pass: {pass} | {name}' });
  assert.strictEqual(m2.closed, true);
});

test('Copy format: with an own format already saved, picking it just switches; a ready one hides Edit', async () => {
  const D = loadDom({ kit: true, answers: { 'POST /api/share/settings': { status: 200, body: { settings: {} } } } });
  D.L.run(`_shareState.settings.copyFormat = 'default'; _shareState.settings.customFormat = 'mine {link}'`);
  const edit = stubEl('edit');
  edit.hidden = true;
  const root = stubEl('root');
  root.cache['[data-share-act="format-edit"]'] = edit;
  D.L.ctx.__root = root;
  await D.L.run(`shareCopyFormatPicked({ value: 'custom' }, 'custom', __root)`);
  assert.strictEqual(D.L.run('_shareModals.length'), 0, 'no editor');
  assert.deepStrictEqual(JSON.parse(D.L.calls.at(-1).init.body), { copyFormat: 'custom' });
  assert.strictEqual(edit.hidden, false, 'Edit shows');
  await D.L.run(`shareCopyFormatPicked({ value: 'oneLine' }, 'oneLine', __root)`);
  assert.deepStrictEqual(JSON.parse(D.L.calls.at(-1).init.body), { copyFormat: 'oneLine' });
  assert.strictEqual(edit.hidden, true, 'Edit hides');
});

/* ── The top bar button ──────────────────────────────────────────────── */

/** loadDom plus the top bar made by shareEnsureTopBar. */
function loadTopBar() {
  const D = loadDom();
  const btns = stubEl('buttons');
  let wrap = null;
  D.L.ctx.document.querySelector = (s) => (s === '.header-buttons' ? btns : null);
  D.L.ctx.document.getElementById = (id) => (!wrap ? null : {
    sharePillWrap: wrap, sharePill: wrap.cache['#sharePill'], sharePop: wrap.cache['#sharePop'], sharePillBadge: wrap.cache.badge ||= stubEl('badge'),
  }[id] || null);
  wrap = D.L.run('shareEnsureTopBar()');
  const opened = [];
  D.L.ctx.__opened = opened;
  D.L.run(`shareOpenMyShares = () => __opened.push('list'); shareOpenShare = (id) => __opened.push(id)`);
  const pill = wrap.cache['#sharePill'];
  const pop = wrap.cache['#sharePop'];
  pop.hidden = true;
  const show = (topBar) => { D.L.ctx.__tb = topBar; D.L.run('_shareState.topBar = __tb; shareRenderPill()'); };
  const clickPill = () => pill.fire('click', { stopPropagation: noop });
  return { D, wrap, pill, pop, opened, show, clickPill };
}

test('top bar: idle it is a plain button that opens My shares; hidden when the server says so', () => {
  const T = loadTopBar();
  T.show({ show: false, active: false, needsYou: 0, shareId: null });
  assert.strictEqual(T.wrap.hidden, true, 'feature or setting off and nothing running: hidden');
  T.show({ show: true, active: false, needsYou: 0, shareId: null, status: null, percent: null });
  assert.strictEqual(T.wrap.hidden, false);
  assert.strictEqual(T.wrap.dataset.state, 'idle');
  assert.strictEqual(T.pill.attrs['aria-label'], 'My shares');
  assert.ok(!('aria-haspopup' in T.pill.attrs), 'no popup to announce');
  T.clickPill();
  assert.deepStrictEqual(T.opened, ['list'], 'opens My shares directly');
  assert.strictEqual(T.pop.hidden, true, 'no popup');
  // The idle button shows nothing private, so privacy mode leaves it alone.
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'share.css'), 'utf8');
  assert.match(css, /\.share-pill-wrap:not\(\[data-state="idle"\]\) \.share-pill \{ border-color: var\(--accent\)/, 'the accent look only while active');
});

test('top bar: while a share runs or needs you it keeps its look and opens the popup, with Open My shares and an Open per row', () => {
  const T = loadTopBar();
  const up = { shareId: 7, archiveName: 'secret-name', status: 'paused', error: 'Paused by you.', percent: 40, partNo: 2, partCount: 3, waitingInLine: false };
  T.show({ show: true, active: true, needsYou: 1, shareId: 7, archiveName: 'secret-name', status: 'paused', percent: 40,
    packing: null, upload: up, packWaiting: 0, readyToCheck: 0 });
  assert.strictEqual(T.wrap.dataset.state, 'needs');
  assert.strictEqual(T.wrap.cache.badge.textContent, '1');
  assert.strictEqual(T.wrap.cache.badge.hidden, false);
  assert.strictEqual(T.wrap.cache.badge.dataset.tone, 'red', 'a failed part: red');
  assert.strictEqual(T.pill.attrs['aria-haspopup'], 'dialog');
  assert.strictEqual(T.pill.attrs['aria-label'], 'Shares: an upload is paused, 1 part needs you');
  T.clickPill();
  assert.strictEqual(T.pop.hidden, false, 'the popup opens');
  assert.deepStrictEqual(T.opened, [], 'not My shares straight away');
  const html = T.pop.innerHTML;
  assert.match(html, /data-share-list>Open My shares<\/button>/);
  assert.match(html, /data-share-open="7">Open<\/button>/);
  assert.match(html, /<b>Paused: secret-name<\/b>/);
  assert.match(html, /Paused by you\./);
  assert.match(html, /1 part of an upload failed and needs you/);
  assert.ok(withoutPrivate(html).includes('data-share-list') && withoutPrivate(html).includes('data-share-open="7"') && !withoutPrivate(html).includes('secret-name'),
    'the buttons are usable, the name stays covered');
  assert.ok(!/left|minute|hour|second/i.test(html), 'no time figures');
  // The two links.
  T.pop.fire('click', { target: { closest: (s) => (s === '[data-share-list]' ? {} : null) } });
  assert.deepStrictEqual(T.opened, ['list']);
  assert.strictEqual(T.pop.hidden, true, 'the popup closes');
  T.clickPill();
  T.pop.fire('click', { target: { closest: (s) => (s === '[data-share-open]' ? { dataset: { shareOpen: '7' } } : null) } });
  assert.deepStrictEqual(T.opened, ['list', 7]);
  // Uploading with nothing failed: today's look, no red count.
  T.show({ show: true, active: true, needsYou: 0, shareId: 7, status: 'uploading', percent: 10,
    packing: null, upload: { ...up, status: 'uploading', error: null, percent: 10 }, packWaiting: 0, readyToCheck: 0 });
  assert.strictEqual(T.wrap.dataset.state, 'uploading');
  assert.strictEqual(T.wrap.cache.badge.hidden, true);

  // Once it ends the button goes idle and the popup shuts.
  T.clickPill();
  T.show({ show: true, active: false, needsYou: 0, shareId: null });
  assert.strictEqual(T.pop.hidden, true);
  assert.strictEqual(T.wrap.dataset.state, 'idle');
});

test('top bar setting: plain words, and the search entry matches', () => {
  const L = load({ kit: true });
  setState(L);
  const html = L.run('shareSettingsHtml()');
  assert.match(html, /Show the share button in the top bar/);
  assert.ok(!/while an upload is running/.test(html), 'the old label is gone');
  assert.match(read('settings-search.js'), /id: 'shareTopBarIcon', label: 'Share button in the top bar'/);
});

test('no long dashes in what the share files show', () => {
  for (const f of FILES) {
    const strings = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/[—–]/.test(strings), `${f}: a long dash in its strings`);
  }
});

/* ── A collection's share, the folded list and large shares ──────────── */

const GB = 1024 ** 3;
const COLL_SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'collections.js'), 'utf8');

/** One top-level function of collections.js, by its name. */
function grabColl(name) {
  let at = COLL_SRC.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is there`);
  if (COLL_SRC.slice(at - 6, at) === 'async ') at -= 6;
  let depth = 0;
  for (let i = COLL_SRC.indexOf(') {', at) + 2; i < COLL_SRC.length; i++) {
    if (COLL_SRC[i] === '{') depth++;
    else if (COLL_SRC[i] === '}' && --depth === 0) return COLL_SRC.slice(at, i + 1);
  }
  throw new Error(`${name}: no end`);
}

/** The card menu (collections.js openCardMenu) for one card, with sharing on or off. */
function cardMenu(kind, sharing) {
  const shared = [];
  const menu = { innerHTML: '', style: {}, offsetHeight: 100, offsetWidth: 160, removed: false, remove() { this.removed = true; } };
  const ctx = {
    collectionsList: [{ id: 4, name: 'Beach trip', kind }],
    shareEnabled: () => sharing,
    shareOpenForCollection: (id) => shared.push(id),
    document: { createElement: () => menu, body: { appendChild: noop }, addEventListener: noop, removeEventListener: noop },
    window: { innerHeight: 900, innerWidth: 1600 },
    setTimeout: noop,
  };
  ctx.getCollectionById = (id) => ctx.collectionsList.find(c => c.id === id);
  vm.createContext(ctx);
  vm.runInContext(`let _cardMenuEl = null;\n${grabColl('openCardMenu')}\n${grabColl('_cardMenuOutside')}\n${grabColl('_cardMenuEsc')}\n${grabColl('closeCardMenu')}\n${grabColl('cardShare')}`, ctx);
  vm.runInContext('openCardMenu(4, { getBoundingClientRect: () => ({ bottom: 100, left: 100 }) })', ctx);
  const labels = [...menu.innerHTML.matchAll(/<button[^>]*>([^<]*)<\/button>|<div class="coll-menu-sep"/g)].map(m => m[1] || '---');
  return { ctx, menu, labels, shared };
}

test('collection card menu: Share privately after Duplicate, a line, then Delete; only for a collection while sharing is on', () => {
  const on = cardMenu('collection', true);
  assert.deepStrictEqual(on.labels, ['Rename', 'Move to…', 'Duplicate', 'Share privately', '---', 'Delete']);
  assert.match(on.menu.innerHTML, /<button class="coll-menu-item" data-coll-act="share" onclick="cardShare\(4\)">Share privately<\/button>/);
  assert.ok(!cardMenu('collection', false).labels.includes('Share privately'), 'sharing off: not there');
  assert.ok(!cardMenu('folder', true).labels.includes('Share privately'), 'a folder: never');
  // The same condition as the selection bar's Share (selection.js SEL_ACTIONS).
  assert.match(grabColl('openCardMenu'), /typeof shareEnabled === 'function' && shareEnabled\(\)/);
  // A click closes the menu and opens the share window for that collection.
  vm.runInContext('cardShare(4)', on.ctx);
  assert.strictEqual(on.menu.removed, true, 'the menu closes');
  assert.deepStrictEqual(on.shared, [4]);
});

const PREVIEW = (files, totalBytes, extra = {}) => ({
  files, totalBytes, needBytes: Math.ceil(totalBytes * 1.02), enoughSpace: true, split: false, partBytes: null, partCount: 1,
  nameMode: 'random', passwordChoice: 'random', deleteAfterDays: 7, savedPasswordSet: false, sevenZipFound: true, ...extra,
});
const fileRows = (n, size = 1000) => Array.from({ length: n }, (_, i) => ({ mediaId: i + 1, name: `clip${i + 1}.mp4`, nameInArchive: `clip${i + 1}.mp4`, sizeBytes: size }));

/** The window opened from a collection, with a stand-in Library and a preview answer. */
async function openFromCollection({ ids = [5, 6, 7], complete = true, preview = PREVIEW(fileRows(3), 3000), kind = 'collection' } = {}) {
  const toasts = [];
  const D = loadDom({ answers: { 'POST /api/share/preview': { status: 200, body: preview }, 'POST /api/share/shares': { status: 200, body: { share: { id: 9 } } } } });
  const specs = [];
  D.L.ctx.showToast = (msg) => toasts.push(msg);
  D.L.ctx.getCollectionById = (id) => (id === 4 ? { id: 4, name: 'Beach <trip>', kind } : null);
  D.L.ctx.Library = { queryOnce: async (spec, opts) => { specs.push({ spec, opts }); return { ids: Uint32Array.from(ids), complete, total: complete ? ids.length : null }; } };
  await D.L.run('shareOpenForCollection(4)');
  return { D, toasts, specs, previewCalls: () => D.L.calls.filter(c => c.url === '/api/share/preview') };
}

test('a collection share asks the server for every id (skipped ones too) and opens step 1 with all of them', async () => {
  const { D, specs, previewCalls } = await openFromCollection({ ids: [5, 6, 7] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(specs)), [{ spec: { collectionId: 4, filters: { mediaTypes: ['video', 'audio', 'image', 'gif'], trashed: '0' } }, opts: { pageSize: 1, allIds: true } }],
    'the whole list from the server, not the drawn page, with no skip filter (test/library-query.test.js runs this spec)');
  assert.deepStrictEqual(JSON.parse(previewCalls()[0].init.body), { mediaIds: [5, 6, 7] });
  assert.strictEqual(D.L.run('_shareWin.step'), 'review');
  assert.strictEqual(D.L.run('_shareWin.collectionName'), 'Beach <trip>');
});

test('a collection share: the name is on step 1 only, private, and never sent', async () => {
  const { D } = await openFromCollection();
  const html = D.L.run('shareReviewHtml(_shareWin)');
  assert.match(html, /Collection: <span class="share-priv" data-share-private>Beach &lt;trip&gt;<\/span>\. Review what will be packed\. Nothing is uploaded yet\./);
  const plain = D.L.run('_shareWin.collectionName = ""; shareReviewHtml(_shareWin)');
  assert.match(plain, /<p class="vault-modal-hint share-sub">Review what will be packed\. Nothing is uploaded yet\.<\/p>/, 'not from a collection: as before');
  D.L.run('_shareWin.collectionName = "Beach <trip>"');
  await D.L.run('sharePack()');
  const sent = D.L.calls.filter(c => c.init.body && c.init.body.includes('Beach'));
  assert.deepStrictEqual(sent, [], 'the collection name is in no request');
  const pack = D.L.calls.find(c => c.url === '/api/share/shares');
  assert.ok(!('name' in JSON.parse(pack.init.body)), 'it does not name the archive');
});

test('a collection share: empty gives a toast and no window; a folder or a cut-short list does nothing', async () => {
  let r = await openFromCollection({ ids: [] });
  assert.deepStrictEqual(r.toasts, ['This collection has no files to share.']);
  assert.strictEqual(r.D.L.run('_shareWin'), null);
  assert.strictEqual(r.previewCalls().length, 0);
  r = await openFromCollection({ kind: 'folder' });
  assert.strictEqual(r.specs.length, 0, 'a folder is never shared');
  r = await openFromCollection({ ids: [5], complete: false });
  assert.strictEqual(r.D.L.run('_shareWin'), null, 'only the first page came: nothing opens');
  assert.match(r.toasts[0], /Could not read this collection/);
});

test('step 1: more than 6 files fold to the first 3 and a real button opens the rest', () => {
  const L = load();
  setState(L);
  L.ctx.__w = { preview: PREVIEW(fileRows(10), 10000), filesOpen: false, collectionName: '' };
  const html = L.run('shareReviewHtml(__w)');
  const rows = [...html.matchAll(/<div class="share-file"( hidden)? data-mid="\d+">/g)];
  assert.strictEqual(rows.length, 10, 'every row is there');
  assert.deepStrictEqual(rows.map(r => !!r[1]), [false, false, false, true, true, true, true, true, true, true]);
  assert.match(html, /<button type="button" class="share-link-btn share-more-files" data-sh-more aria-controls="shFilesList" aria-expanded="false">and 7 more files<\/button>/);
  L.ctx.__w.filesOpen = true;
  const open = L.run('shareReviewHtml(__w)');
  assert.ok(!/<div class="share-file" hidden data-mid=/.test(open));
  assert.match(open, /aria-expanded="true">Show fewer<\/button>/);
  // Six or fewer: no fold.
  L.ctx.__w = { preview: PREVIEW(fileRows(6), 6000), filesOpen: false };
  const six = L.run('shareReviewHtml(__w)');
  assert.ok(!/data-sh-more/.test(six) && !/<div class="share-file" hidden data-mid=/.test(six));
  // The button opens and closes the rows in place.
  const rowEls = Array.from({ length: 10 }, (_, i) => ({ hidden: i >= 3 }));
  const btn = { textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  L.ctx.__w = { filesOpen: false, m: { box: { querySelectorAll: () => rowEls } } };
  L.ctx.__btn = btn;
  L.run('shareToggleFiles(__w, __btn)');
  assert.ok(rowEls.every(r => !r.hidden));
  assert.strictEqual(btn.textContent, 'Show fewer');
  assert.strictEqual(btn.attrs['aria-expanded'], 'true');
  L.run('shareToggleFiles(__w, __btn)');
  assert.deepStrictEqual(rowEls.map(r => r.hidden), [false, false, false, true, true, true, true, true, true, true]);
  assert.strictEqual(btn.textContent, 'and 7 more files');
});

test('step 1: at 10 GB or more the total is amber with a triangle and one note line; below, neither', () => {
  const L = load();
  setState(L);
  L.ctx.vaultIcon = (n) => `<svg class="vi vi-${n}" aria-hidden="true"></svg>`;
  assert.strictEqual(L.run('SHARE_LARGE_BYTES'), 10 * GB);
  assert.strictEqual(L.run('SHARE_HUGE_BYTES'), 30 * GB);
  const step1 = (bytes, extra) => { L.ctx.__w = { preview: PREVIEW(fileRows(2, bytes / 2), bytes, extra) }; return L.run('shareReviewHtml(__w)'); };
  const below = step1(10 * GB - 1024 ** 2);
  assert.ok(!/share-big/.test(below), 'just under 10 GB: no warning');
  const at = step1(10 * GB, { needBytes: 10.2 * GB, split: true, partBytes: 2 * GB, partCount: 5 });
  assert.match(at, /<span class="share-big-total"><svg[^>]*vi-alert[^]*?<span class="share-sr">Large share: <\/span>10 GB<\/span>/, 'amber, triangle, words for a screen reader');
  assert.strictEqual((at.match(/data-sh-bignote/g) || []).length, 1, 'one note line');
  const note = /data-sh-bignote>[^]*?<span>([^<]*)<\/span>/.exec(at)[1];
  assert.strictEqual(note, 'Large share. Packing and uploading 10 GB can take a long time, and packing needs about 10.2 GB of free space. It will upload as 5 parts.');
  assert.ok(!/data-sh-act="pack"[^>]*disabled/.test(at), 'nothing extra to click');
  // Part count not known: that sentence is left out.
  const unknown = step1(12 * GB, { partCount: undefined });
  assert.match(unknown, /of free space\.<\/span>/);
  assert.ok(!/upload as/.test(unknown));
  assert.match(step1(40 * GB), /data-sh-bignote/, '30 GB and up shows it too');
});

/** The window at step 1 with a preview of this size. */
async function bigWindow(bytes, extra = {}) {
  const D = loadDom({ answers: {
    'POST /api/share/preview': { status: 200, body: PREVIEW(fileRows(4, bytes / 4), bytes, { needBytes: bytes + GB, split: true, partBytes: 2 * GB, partCount: Math.ceil(bytes / (2 * GB)), ...extra }) },
    'POST /api/share/shares': { status: 200, body: { share: { id: 9 } } },
  } });
  await D.L.run('shareOpenForIds([1, 2, 3, 4], { collectionName: "Beach trip" })');
  const packs = () => D.L.calls.filter(c => c.url === '/api/share/shares').length;
  return { D, packs };
}

test('Pack files under 30 GB packs straight away', async () => {
  const { D, packs } = await bigWindow(29 * GB);
  await D.L.run('sharePackClicked()');
  assert.strictEqual(packs(), 1);
  assert.strictEqual(D.L.run('_shareModals.length'), 1, 'no ask');
});

test('Pack files at 30 GB asks first: the words, the facts, Go back bottom right, Pack anyway bottom left', async () => {
  const { D, packs } = await bigWindow(30 * GB);
  D.L.run('sharePackClicked()');
  const ask = D.top();
  assert.notStrictEqual(ask, D.L.run('_shareWin.m'), 'a dialog over the window');
  assert.strictEqual(packs(), 0, 'nothing started');
  const html = ask.ov.innerHTML;
  assert.match(html, /<h3 id="shareBigTitle">This share is very large<\/h3>/);
  assert.match(html, /Packing and uploading this much can take a long time\. You can stop at any point, and parts already uploaded can be deleted\./);
  const facts = [...html.matchAll(/<dt>([^<]*)<\/dt><dd[^>]*>([^]*?)<\/dd>/g)].map(m => [m[1], m[2].replace(/<[^>]+>/g, '')]);
  assert.deepStrictEqual(facts, [['Collection', 'Beach trip'], ['Files', '4'], ['Total size', '30 GB'], ['Free space needed to pack', '31 GB'], ['Uploads as', '15 parts of up to 2 GB']]);
  assert.match(html, /<dd class="share-big-total">30 GB<\/dd>/, 'the total is amber');
  assert.match(html, /<dd><span class="share-priv" data-share-private>Beach trip<\/span><\/dd>/, 'the collection name is private');
  const acts = /<div class="vault-modal-actions share-actions">([^]*?)<\/div>/.exec(html)[1];
  assert.match(acts, /^\s*<button type="button" class="vault-btn share-btn-amber" data-sh-big="go">Pack 30 GB anyway<\/button>\s*<span class="share-sp"><\/span>\s*<button type="button" class="vault-btn vault-btn-primary" data-sh-big="back">Go back<\/button>\s*$/,
    'Pack anyway first (left), a spacer, Go back last (right) and the main button');
  assert.ok(!/<input/.test(html), 'no tick box');
  // Not from a collection: no Collection row.
  const plain = await bigWindow(30 * GB);
  plain.D.L.run('_shareWin.collectionName = ""; sharePackClicked()');
  assert.ok(!/Collection/.test(plain.D.top().ov.innerHTML));
});

test('the ask: a second click on Pack files, a click outside, Esc and Go back all leave step 1 with nothing started', async () => {
  const { D, packs } = await bigWindow(31 * GB, { partCount: undefined });
  D.L.run('sharePackClicked()');
  const ask = D.top();
  assert.ok(!/Uploads as/.test(ask.ov.innerHTML), 'a fact that is not known is left out');
  D.L.run('sharePackClicked()');
  assert.strictEqual(D.top(), ask, 'the second click of a double click lands on nothing');
  assert.strictEqual(D.L.run('_shareModals.length'), 2);
  D.outside(ask);
  assert.strictEqual(ask.closed, false, 'a click outside does not confirm or close');
  let kept = false;
  ask.ov.fire('mousedown', { target: ask.ov, preventDefault: () => { kept = true; } });
  assert.ok(kept, 'a press on the backdrop (the second click of a double click) leaves the focus on Go back');
  D.esc();
  assert.strictEqual(ask.closed, true, 'Esc goes back');
  assert.strictEqual(D.L.run('_shareWin.step'), 'review', 'the window stays on step 1');
  assert.strictEqual(D.L.run('_shareWin.bigAsk'), null);
  D.L.run('sharePackClicked()');
  const again = D.top();
  assert.notStrictEqual(again, ask, 'it asks again next time');
  again.box.querySelector('[data-sh-big="back"]').fire('click');
  assert.strictEqual(again.closed, true, 'Go back');
  await new Promise(r => setImmediate(r));
  assert.strictEqual(packs(), 0, 'nothing packed');
  assert.strictEqual(D.L.run('_shareWin.step'), 'review');
});

test('the ask: Pack anyway packs, once', async () => {
  const { D, packs } = await bigWindow(30 * GB);
  D.L.run('sharePackClicked()');
  const ask = D.top();
  const go = ask.box.querySelector('[data-sh-big="go"]');
  go.fire('click');
  go.fire('click');
  await new Promise(r => setImmediate(r));
  assert.strictEqual(ask.closed, true);
  assert.strictEqual(packs(), 1, 'one pack');
  assert.strictEqual(D.L.run('_shareWin.step'), 'packing');
});

test('the new words: no time figures and no long dashes', () => {
  const src = read('share-ui.js').replace(/\r\n/g, '\n');
  const pieces = ['shareBigNote', 'shareAskBig', 'shareOpenForCollection', 'shareToggleFiles', 'shareUploadsAs']
    .map(f => src.split(`function ${f}(`)[1].split('\nfunction ')[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''));
  pieces.push(/function shareReviewHtml\(w\) \{([^]*?)\n\}/.exec(src)[1]);
  for (const p of pieces) {
    const strings = [...p.matchAll(/'([^'\n]*)'|`([^`]*)`/g)].map(m => m[1] ?? m[2]).join(' | ');
    assert.ok(!/\b(hours?|minutes?|seconds?|days?|hrs?|mins?)\b/i.test(strings), `a time figure in: ${strings.slice(0, 200)}`);
    assert.ok(!/[—–]/.test(strings), 'no long dashes');
  }
  assert.ok(!/[—–]/.test(grabColl('openCardMenu')));
});

/* ── The one-time warning with no Vault password (spec 6.5) ─────────── */

/** shareStartRequest with a server that asks for the warning once. */
async function startWithWarning(pick) {
  const L = load();
  setState(L);
  const sent = [];
  let shares = 0;
  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  L.ctx.fetch = async (url, init) => {
    sent.push([`${init.method} ${url}`, init.body ? JSON.parse(init.body) : null]);
    if (url === '/api/share/shares' && shares++ === 0) {
      return answer(409, { error: 'There is no Vault password, so passwords, links and upload keys of shares would be stored unprotected in the library file. Confirm that first.', code: 'WARNING_NEEDED' });
    }
    if (url === '/api/share/settings') return answer(200, { settings: { ...STATE.settings, rememberPasswords: false } });
    return answer(202, { share: { id: 5 } });
  };
  const asked = [];
  L.ctx.vaultChoose = async (message, o) => { asked.push({ message, o }); return pick; };
  const r = await L.run('shareStartRequest({ mediaIds: [1, 2] })');
  return { L, r, sent, asked };
}

test('first share with no Vault password: the warning offers Continue, Do not remember passwords and Cancel', async () => {
  const go = await startWithWarning('continue');
  assert.strictEqual(go.asked.length, 1);
  const { message, o } = go.asked[0];
  assert.deepStrictEqual(Array.from(o.buttons, b => b.value), ['cancel', 'forget', 'continue']);
  assert.strictEqual(o.cancelValue, 'cancel');
  assert.match(message, /no Vault password/);
  assert.match(message, /passwords of past shares/);
  assert.match(message, /links and upload keys/);
  assert.match(message, /set a Vault password/i);
  // "Do not remember passwords" leaves the warning due, so no "only once" promise.
  assert.ok(!/only once/i.test(message), 'no promise it is shown only once');
  assert.match(message, /shows it again when that is turned back on/);
  assert.ok(!/[—–]/.test(message + o.title + o.buttons.map(b => b.label).join(' ')), 'no long dashes');
  assert.ok(!/\b(hours?|minutes?|seconds?|days?)\b/i.test(message), 'no time figures');
  assert.deepStrictEqual(go.sent.map(s => s[0]), ['POST /api/share/shares', 'POST /api/share/shares']);
  assert.strictEqual(go.sent[0][1].acknowledgeNoVaultPassword, undefined, 'never acknowledged before it was shown');
  assert.strictEqual(go.sent[1][1].acknowledgeNoVaultPassword, true);
  assert.strictEqual(go.r.share.id, 5);

  const forget = await startWithWarning('forget');
  assert.deepStrictEqual(forget.sent.map(s => s[0]), ['POST /api/share/shares', 'POST /api/share/settings', 'POST /api/share/shares']);
  assert.deepStrictEqual(forget.sent[1][1], { rememberPasswords: false, confirm: true });
  assert.strictEqual(forget.sent[2][1].acknowledgeNoVaultPassword, undefined, 'no acknowledgement: nothing is kept that needs it');
  assert.strictEqual(forget.L.run('_shareState.settings.rememberPasswords'), false);
  assert.strictEqual(forget.r.share.id, 5);

  const cancel = await startWithWarning('cancel');
  assert.deepStrictEqual(cancel.sent.map(s => s[0]), ['POST /api/share/shares'], 'nothing more is sent');
  assert.strictEqual(cancel.r, null);
});

test('Change saved password shows the same one-time warning', () => {
  const src = read('share-settings-ui.js');
  const fn = src.split('function shareNoVaultPasswordWarning(')[1].split('\nfunction ')[0];
  assert.ok(fn.includes('SHARE_PLAIN_WARNING'));
});

/* ── Privacy: file names under "File names" too; the new saved password field ── */

test('privacy: the step 1 list (folded rows too) and the files of a share in My shares also hide under "File names"', () => {
  const L = load();
  setState(L);
  L.ctx.__w = { preview: PREVIEW(fileRows(10), 10000), filesOpen: false, collectionName: '' };
  const step1 = L.run('shareReviewHtml(__w)');
  const list = /<div class="share-files-list" id="shFilesList" data-share-names>([\s\S]*?)\n\s*<\/div>/.exec(step1);
  assert.ok(list, 'the list is marked');
  assert.strictEqual([...list[1].matchAll(/<div class="share-file"/g)].length, 10, 'every row, folded ones too, is inside it');
  L.ctx.__list = { open: new Set([3]), files: new Map([[3, { files: [{ name: 'secret-holiday.mp4', sizeBytes: 5 }] }]]) };
  const row = L.run("shareRowHtml({ id: 3, archiveName: 'a', status: 'uploaded', sizeBytes: 5, fileCount: 1, partCount: 1, timerSet: true }, __list)");
  assert.match(row, /<div class="share-fold-files" data-share-names><div class="share-file"><span class="share-file-name">secret-holiday\.mp4<\/span>/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'share.css'), 'utf8');
  const rule = /body\.pm-shares \[data-share-names\],\s*body\.pm-names \[data-share-names\] \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'blurred under either category');
  assert.match(rule[1], /filter: blur\(7px\)/);
  assert.match(rule[1], /pointer-events: none/);
  assert.match(rule[1], /user-select: none/);
});

test('privacy: "File names" takes the name lists out of the keyboard order, but not the rest of My shares', () => {
  const classes = new Set();
  const L = load({ bodyClasses: classes });
  const mk = () => ({ inert: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });
  const priv = [mk()];
  const names = [mk(), mk()];
  L.ctx.__root = { querySelectorAll: (sel) => (sel === '[data-share-private]' ? priv : sel === '[data-share-names]' ? names : []) };
  classes.add('pm-names');
  L.run('sharePrivacyChanged(__root)');
  assert.ok(names.every(e => e.inert === true && e.attrs['aria-hidden'] === 'true'));
  assert.strictEqual(priv[0].inert, false, 'My shares itself is not hidden by "File names"');
  classes.delete('pm-names');
  classes.add('pm-shares');
  L.run('sharePrivacyChanged(__root)');
  assert.ok([...priv, ...names].every(e => e.inert === true));
  classes.clear();
  L.run('sharePrivacyChanged(__root)');
  assert.ok([...priv, ...names].every(e => e.inert === false && !('aria-hidden' in e.attrs)));
});

test('Change saved password: a masked text field the browser does not offer to save, with its label, note and Show button', () => {
  const src = read('share-settings-ui.js');
  const input = /<input [^>]*id="shCpNew"[^>]*>/.exec(src)[0];
  assert.match(input, /type="text"/);
  assert.match(input, /autocomplete="off"/);
  assert.ok(!/new-password|current-password/.test(input));
  assert.match(input, /data-share-secret="hidden"/);
  assert.match(input, /data-share-mask/);
  assert.match(input, /aria-describedby="shCpNewNote"/);
  assert.match(src, /<label class="vault-label" for="shCpNew">New share password<\/label>/);
  assert.match(src, /<button type="button" class="vault-btn" data-sh-show="shCpNew" aria-pressed="false">Show<\/button>/);
  assert.match(src, /const newField = shareSecretField\(m\.q\('#shCpNew'\)\);/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'share.css'), 'utf8');
  const rule = /\[data-share-secret="hidden"\],\s*body\.pm-shares \[data-share-secret\] \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'dots until Show, and always under "My shares"');
  assert.match(rule[1], /-webkit-text-security: disc/);
});

/** A field and its Show button, wired by shareWireShowButtons. */
function showPair(L, field) {
  const btn = { dataset: { shShow: 'f' }, attrs: {}, textContent: 'Show', on: null,
    addEventListener(t, fn) { this.on = fn; }, setAttribute(k, v) { this.attrs[k] = v; } };
  L.ctx.__root = { querySelectorAll: (sel) => (sel === '[data-sh-show]' ? [btn] : sel === '[data-share-mask]' ? [field] : []), querySelector: () => field };
  L.run('shareWireShowButtons(__root)');
  return btn;
}

test('Show on the new saved password: shows and hides; with "My shares" privacy on it stays dots', () => {
  const classes = new Set();
  const L = load({ bodyClasses: classes });
  L.ctx.CSS = { supports: (p) => p === '-webkit-text-security' };
  const field = { type: 'text', value: 'Typed-Pass-123', dataset: { shareSecret: 'hidden' } };
  L.ctx.__f = field;
  assert.strictEqual(L.run('shareSecretField(__f)'), field);
  assert.strictEqual(field.type, 'text', 'never a password field, so nothing offers to save it');
  const btn = showPair(L, field);
  btn.on();
  assert.strictEqual(field.dataset.shareSecret, 'shown');
  assert.strictEqual(btn.textContent, 'Hide');
  assert.strictEqual(btn.attrs['aria-pressed'], 'true');
  btn.on();
  assert.strictEqual(field.dataset.shareSecret, 'hidden');
  assert.strictEqual(btn.attrs['aria-pressed'], 'false');
  // Privacy on: the field is left to the CSS (dots whatever Show says), its type untouched.
  classes.add('pm-shares');
  L.run('sharePrivacyChanged(__root)');
  assert.strictEqual(field.type, 'text');
});

test('Show on the new saved password, in a browser that cannot draw dots: a password field, and Show keeps the dots under privacy', () => {
  const classes = new Set(['pm-shares']);
  const L = load({ bodyClasses: classes });
  L.ctx.CSS = { supports: () => false };
  const field = { type: 'text', value: 'Typed-Pass-123', dataset: { shareSecret: 'hidden' }, parentNode: null };
  L.ctx.__f = field;
  L.run('shareSecretField(__f)');
  assert.strictEqual(field.type, 'password');
  assert.ok(!('shareSecret' in field.dataset));
  const btn = showPair(L, field);
  L.run('sharePrivacyChanged(__root)');
  btn.on();
  assert.strictEqual(field.type, 'password', 'privacy keeps it dots');
  assert.strictEqual(btn.attrs['aria-pressed'], 'true');
  classes.clear();
  L.run('sharePrivacyChanged(__root)');
  assert.strictEqual(field.type, 'text', 'shown once privacy is off, as Show asked');
});

/* ── Packing in the background, the pack line, Upload on its own ─────── */

test('background: X, Esc, Close and Keep using Vault only hide the window on steps 2 and 3; nothing is cancelled', async () => {
  for (const step of ['queued', 'packing', 'checked', 'confirm']) {
    const D = loadDom();
    const toasts = [];
    D.L.ctx.showToast = (msg) => toasts.push(msg);
    D.L.run('shareWindowOpen()');
    D.L.run(`_shareWin.id = 9; _shareWin.step = ${JSON.stringify(step)}`);
    const w = D.top();
    await D.L.run('shareWindowRequestClose()');   // vaultConfirm throws if it is asked
    assert.strictEqual(w.closed, true, `${step}: hidden`);
    assert.strictEqual(D.L.run('_shareWin'), null);
    assert.deepStrictEqual(D.L.calls.filter(c => c.init.method === 'POST'), [], `${step}: no cancel`);
    assert.strictEqual(toasts.length, 1, `${step}: one quiet toast`);
    assert.ok(/My shares/.test(toasts[0]) && !/[—–]/.test(toasts[0]));
  }
  // Only the button cancels.
  const src = read('share-ui.js');
  assert.match(src, /data-sh-act="cancel-archive">Cancel and delete archive<\/button>/);
});

test('background: the packing step says the user need not wait, with Keep using Vault as the main button', () => {
  const L = load();
  setState(L);
  L.ctx.__w = { id: 9, step: 'packing', collectionName: 'Summer <2026>', preview: { files: fileRows(48), totalBytes: 14.2 * GB }, share: { id: 9, status: 'packing' }, progress: null };
  const html = L.run('sharePackingHtml(__w)');
  assert.match(html, /<div class="share-kicker">Step 2 of 4<\/div>\s*<h3 id="shareWinTitle">Packing<\/h3>/);
  assert.match(html, /Collection: <span class="share-priv" data-share-private>Summer &lt;2026&gt;<\/span>, 48 files, 14\.2 GB\. Nothing is uploaded yet\./);
  assert.match(html, /You do not need to wait here\. Packing carries on in My shares while you use Vault, and it will be ready for you to check when it is done\. The drive may feel slower until then\./);
  assert.match(html, /data-sh-act="cancel-archive">Cancel and delete archive<\/button>\s*<span class="share-sp"><\/span>\s*<button type="button" class="vault-btn vault-btn-primary" data-sh-act="close" data-sh-first>Keep using Vault<\/button>/);
  L.ctx.__w.progress = { uploadsOnItsOwn: true };
  assert.match(L.run('sharePackingHtml(__w)'), /once it is packed and checked it uploads on its own/);
  assert.strictEqual(L.run('SHARE_PHASE_WORDS.packing'), 'Packing and encrypting');
  // Opened from My shares (no step 1 here): the share's own counts, no collection.
  L.ctx.__w = { id: 9, step: 'packing', collectionName: '', preview: null, share: { id: 9, status: 'packing', fileCount: 3, sizeBytes: 3 * GB }, progress: null };
  assert.match(L.run('sharePackingHtml(__w)'), /<p class="vault-modal-hint share-sub">3 files, 3 GB\. Nothing is uploaded yet\.<\/p>/);
});

test('pack line: a share started while another packs opens on Waiting to pack, which names the one ahead and can be cancelled', async () => {
  const D = loadDom({ answers: {
    'POST /api/share/preview': { status: 200, body: PREVIEW(fileRows(2), 2000, { packBusy: true }) },
    'POST /api/share/shares': { status: 202, body: { share: { id: 12, status: 'queued', waitingFor: 'k7Qm<2>.7z', fileCount: 2, sizeBytes: 2000 } } },
    'POST /api/share/shares/12/cancel': { status: 200, body: { ok: true } },
  } });
  const toasts = [];
  D.L.ctx.showToast = (msg) => toasts.push(msg);
  await D.L.run('shareOpenForIds([1, 2])');
  const review = D.L.run('shareReviewHtml(_shareWin)');
  assert.match(review, /data-sh-packbusy>Another share is being packed\. This one waits its turn and starts on its own, so you can keep using Vault meanwhile\.<\/p>/);
  assert.match(review, /data-sh-act="pack">Pack files<\/button>/, 'not blocked: it waits its turn');
  await D.L.run('sharePack()');
  assert.strictEqual(D.L.run('_shareWin.step'), 'queued');
  const html = D.L.run('shareQueuedHtml(_shareWin)');
  assert.match(html, /<h3 id="shareWinTitle">Waiting to pack<\/h3>/);
  assert.match(html, /Starts when <span class="share-priv" data-share-private>k7Qm&lt;2&gt;\.7z<\/span> is packed\./);
  assert.match(html, /data-sh-act="cancel-archive">Cancel this share<\/button>/);
  assert.match(html, /data-sh-act="close" data-sh-first>Keep using Vault<\/button>/);
  await D.L.run('shareCancelArchive()');
  assert.ok(D.L.calls.some(c => c.url === '/api/share/shares/12/cancel'));
  assert.deepStrictEqual(toasts, ['Cancelled. Nothing was packed.']);
  assert.strictEqual(D.L.run('_shareWin'), null);
});

test('pack line: the window follows a waiting share into packing (refresh maps queued, and the name ahead updates in place)', async () => {
  const L = load({ answers: {
    'GET /api/share/shares/12/progress': { status: 200, body: { id: 12, status: 'queued', waitingFor: 'b.7z', error: null, packing: null, upload: null } },
    'GET /api/share/shares/12': { status: 200, body: { share: { id: 12, status: 'queued', fileCount: 1, sizeBytes: 5 } } },
  } });
  setState(L);
  const waitFor = { innerHTML: 'Starts when a.7z is packed.', querySelectorAll: () => [] };
  L.ctx.__q = { '[data-sh-waitfor]': waitFor };
  L.run(`_shareWin = { id: 12, step: 'queued', samples: [], share: { id: 12, status: 'queued' }, m: { q: (s) => __q[s] || null } }`);
  await L.run('shareWindowRefresh()');
  assert.strictEqual(L.run('_shareWin.step'), 'queued');
  assert.match(waitFor.innerHTML, /Starts when <span class="share-priv" data-share-private>b\.7z<\/span> is packed\./);
});

test('Upload on its own: step 1 explains it and asks with a tick box; only a ticked box sends confirmUpload', async () => {
  const open = async (extra) => {
    const D = loadDom({ answers: {
      'POST /api/share/preview': { status: 200, body: PREVIEW(fileRows(1), 1000, extra) },
      'POST /api/share/shares': { status: 202, body: { share: { id: 9, status: 'packing' } } },
    } });
    await D.L.run('shareOpenForIds([1])');
    return D;
  };
  let D = await open({ afterPack: 'wait' });
  assert.ok(!/shAutoTick|data-sh-auto/.test(D.L.run('shareReviewHtml(_shareWin)')), 'Wait for me: no tick box');
  await D.L.run('sharePack()');
  assert.ok(!('confirmUpload' in JSON.parse(D.L.calls.find(c => c.url === '/api/share/shares').init.body)));

  D = await open({ afterPack: 'upload' });
  const html = D.L.run('shareReviewHtml(_shareWin)');
  assert.match(html, /<div class="share-warn" data-sh-auto>When packing is done is set to Upload on its own\. Once this share is packed and checked, Vault uploads it to gofile\.io without asking again\./);
  assert.match(html, /<input type="checkbox" id="shAutoTick">/, 'unticked to start with');
  assert.match(html, /Leave it unticked and Vault waits for you to check the archive first\./);
  assert.ok(!/[—–]/.test(html.replace(/<[^>]+>/g, '')), 'no long dashes');
  assert.ok(!/minute|hour|second/i.test(html.replace(/<[^>]+>/g, '')), 'no time figures');
  await D.L.run('sharePack()');
  assert.ok(!('confirmUpload' in JSON.parse(D.L.calls.find(c => c.url === '/api/share/shares').init.body)), 'unticked: the share waits for the check');

  D = await open({ afterPack: 'upload' });
  D.L.run(`_shareWin.m.q('#shAutoTick').checked = true`);
  await D.L.run('sharePack()');
  assert.strictEqual(JSON.parse(D.L.calls.find(c => c.url === '/api/share/shares').init.body).confirmUpload, true);

  // The tick alone is not enough once the setting is Wait for me (the preview says which is in force).
  D = await open({ afterPack: 'wait' });
  D.L.run(`_shareWin.m.q('#shAutoTick').checked = true`);
  await D.L.run('sharePack()');
  assert.ok(!('confirmUpload' in JSON.parse(D.L.calls.find(c => c.url === '/api/share/shares').init.body)));
});

test('Upload on its own: the password note shows when a new random password would not be kept', async () => {
  const L = load();
  setState(L, { settings: { rememberPasswords: false } });
  L.ctx.__w = { preview: { savedPasswordSet: false, passwordChoice: 'random' }, m: { q: () => null } };
  const html = L.run('shareAutoBlockHtml(__w, _shareState.settings)');
  assert.match(html, /<p class="vault-modal-hint" data-sh-autopw>Vault is not keeping the passwords of past shares, so this share waits for you to see its password before it uploads\.<\/p>/);
  setState(L, { settings: { rememberPasswords: true } });
  assert.match(L.run('shareAutoBlockHtml(__w, _shareState.settings)'), /data-sh-autopw hidden>/);
  setState(L, { settings: { rememberPasswords: false } });
  L.ctx.__w.m.q = (s) => (s === '#shPwSrc' ? { value: 'saved' } : null);
  assert.match(L.run('shareAutoBlockHtml(__w, _shareState.settings)'), /data-sh-autopw hidden>/, 'the saved password lasts');
});

test('Ready to check: the check step shows why a share did not upload on its own, and updates it in place', async () => {
  const L = load();
  setState(L);
  const note = 'Packed and checked, but not uploaded on its own. Vault is set to stay offline (VAULT_OFFLINE=1), so it cannot reach gofile.io.';
  L.ctx.__w = { id: 9, step: 'checked', share: { id: 9, status: 'checked', passwordKept: true, fileCount: 1 }, progress: { status: 'checked', error: note, checks: {} } };
  const html = L.run('shareCheckedHtml(__w)');
  assert.ok(html.includes(`<div class="share-warn" data-sh-autonote>${esc(note)}</div>`));
  L.ctx.__w.progress.error = null;
  assert.match(L.run('shareCheckedHtml(__w)'), /<div class="share-warn" data-sh-autonote hidden><\/div>/);
  const el = { textContent: '', hidden: true };
  L.ctx.__w.m = { q: (s) => (s === '[data-sh-autonote]' ? el : null) };
  L.ctx.__w.progress.error = 'Later words.';
  L.run('_shareWin = __w; shareCheckedNoteUpdate()');
  assert.deepStrictEqual([el.textContent, el.hidden], ['Later words.', false]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(L.run(`shareStatusWords({ status: 'checked' })`))), { text: 'Ready to check', tone: 'soon' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(L.run(`shareStatusWords({ status: 'queued' })`))), { text: 'Waiting to pack', tone: 'plain' });
});

test('My shares: working shares at the top with their badges and actions; the footer line; live polling stops on close', async () => {
  const L = load();
  setState(L);
  const rows = [
    { id: 1, archiveName: 'old', status: 'uploaded', onGofile: true, link: 'https://gofile.io/d/A', sizeBytes: 1, fileCount: 3, partCount: 1, timerSet: true, uploadedAt: Date.now() },
    { id: 5, archiveName: 'up', archiveDisplayName: 'up.7z', status: 'uploading', sizeBytes: 4, fileCount: 12, partCount: 3, upload: { percent: 40, partNo: 2, partCount: 3, waitingInLine: false } },
    { id: 7, archiveName: 'ready', archiveDisplayName: 'ready.7z', status: 'checked', sizeBytes: 1, fileCount: 3, partCount: 1 },
    { id: 9, archiveName: 'w2', archiveDisplayName: 'w2.7z', status: 'queued', waitingFor: 'w1.7z', sizeBytes: 1, fileCount: 1, partCount: 1 },
    { id: 8, archiveName: 'w1', archiveDisplayName: 'w1.7z', status: 'queued', waitingFor: 'pk.7z', sizeBytes: 1, fileCount: 1, partCount: 1 },
    { id: 6, archiveName: 'pk', archiveDisplayName: 'pk.7z', status: 'packing', packing: { phase: 'packing', percent: 42 }, sizeBytes: 1, fileCount: 48, partCount: 1 },
  ];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(L.run(`shareListSorted(${JSON.stringify(rows)})`))).map(s => s.id), [6, 8, 9, 7, 5, 1],
    'packing, then waiting in the order they pack, ready to check, uploading, then the rest');
  L.ctx.__list = { shares: rows, open: new Set(), files: new Map() };
  const html = L.run('shareListHtml(__list)');
  assert.match(html, /Shares being packed or uploaded stay at the top\. Everything else is from Vault's own records\./);
  assert.match(html, /<span class="share-badge is-busy">[^]*?Packing 42%<\/span><div class="share-bar share-row-bar"[^>]*aria-valuenow="42"/);
  assert.match(html, /<span class="share-badge is-plain">Waiting to pack<\/span><div class="share-small share-mut">Starts when pk\.7z is packed<\/div>/);
  assert.match(html, /<span class="share-badge is-soon">Ready to check<\/span><div class="share-small share-mut">Waiting for you\. Nothing uploaded\.<\/div>/);
  assert.match(html, /3 files, packed and tested/);
  assert.match(html, /<span class="share-badge is-busy">Uploading part 2 of 3<\/span>/);
  assert.match(html, /data-share-bg-note>Vault packs one share at a time and uploads one at a time\./);
  assert.match(html, /Locking it yourself still works: uploads pause and can be resumed, and a share that is being packed or is waiting to be packed is cancelled\.<\/p>/,
    'a lock cancels waiting shares too, and the note says so');
  const acts = (s) => JSON.parse(JSON.stringify(L.run(`shareRowActions(${JSON.stringify(s)}, true)`))).map(a => a.key);
  assert.deepStrictEqual(acts({ status: 'packing' }), ['view', 'cancel']);
  assert.deepStrictEqual(acts({ status: 'queued' }), ['cancel']);
  assert.deepStrictEqual(acts({ status: 'checked' }), ['check', 'cancel']);
  assert.deepStrictEqual(acts({ status: 'uploading' }), ['view', 'pause']);
  assert.match(html, /<button type="button" class="vault-btn vault-btn-primary share-row-btn" data-row-act="check" data-row-id="7">Check and upload<\/button>/);
  assert.match(html, /data-row-act="cancel" data-row-id="6">Cancel<\/button>/);
  assert.match(html, /data-row-act="view" data-row-id="6">Open<\/button>/);
  assert.match(html, /data-row-act="pause" data-row-id="5">Pause<\/button>/);
  assert.ok(!/[—–]/.test(html.replace(/<[^>]+>/g, '')), 'no long dashes');
  // Nothing working: no footer line.
  L.ctx.__list = { shares: [rows[0]], open: new Set(), files: new Map() };
  assert.ok(!/data-share-bg-note/.test(L.run('shareListHtml(__list)')));
  // A note from Upload on its own shows on the row, amber, not as a failure.
  L.ctx.__list = { shares: [{ ...rows[2], error: 'Packed and checked, but not uploaded on its own.' }], open: new Set(), files: new Map() };
  assert.match(L.run('shareListHtml(__list)'), /<div class="share-small share-mut share-st is-soon">Packed and checked, but not uploaded on its own\.<\/div>/);
  // The poll: background requests, every 2 s while a share works; none once closed.
  const src = read('share-settings-ui.js');
  assert.match(src, /l\.timer = setTimeout\(shareListRefresh, l\.shares\.some\(shareWorking\) \? 2000 : 10000\);/);
  assert.match(src, /function shareListClose\(\) \{\n  const l = _shareList;\n  if \(!l\) return;\n  clearTimeout\(l\.timer\);/);
  assert.match(src, /shareApi\('GET', '\/shares', null, \{ background: true \}\)/);
});

test('My shares: Check and upload reopens the window on the check step; Cancel asks first; Pause pauses', async () => {
  const D = loadDom({ answers: {
    'GET /api/share/shares': { status: 200, body: { shares: [{ id: 7, archiveName: 'r', status: 'checked', sizeBytes: 1, fileCount: 1, partCount: 1 }, { id: 5, archiveName: 'u', status: 'uploading', sizeBytes: 1, fileCount: 1, partCount: 1 }] } },
    'GET /api/share/shares/7/progress': { status: 200, body: { id: 7, status: 'checked', error: null, checks: {} } },
    'GET /api/share/shares/7': { status: 200, body: { share: { id: 7, status: 'checked', passwordKept: true, fileCount: 1 } } },
  } });
  await D.L.run('shareOpenMyShares()');
  const click = async (act, id) => {
    const b = { disabled: false, dataset: { rowAct: act, rowId: String(id) } };
    await D.L.run('_shareList').m.box.listeners.click[0]({ target: { closest: (s) => (s === '[data-row-act]' ? b : null) } });
  };
  let asked = 0;
  D.L.ctx.vaultConfirm = async () => { asked++; return false; };
  await click('cancel', 7);
  assert.strictEqual(asked, 1, 'Cancel asks first');
  assert.ok(!D.L.calls.some(c => c.url.endsWith('/cancel')), 'kept when the user says no');
  await click('pause', 5);
  assert.ok(D.L.calls.some(c => c.url === '/api/share/shares/5/pause' && c.init.method === 'POST'));
  await click('check', 7);
  await new Promise(r => setImmediate(r));
  assert.strictEqual(D.L.run('_shareList'), null, 'the list closed');
  assert.strictEqual(D.L.run('_shareWin.id'), 7);
  assert.strictEqual(D.L.run('_shareWin.step'), 'checked', 'on the check step');
});

test('top bar: packing, an upload, shares waiting and ready to check, each in the popup; the badge is amber for ready ones', () => {
  const T = loadTopBar();
  T.show({ show: true, active: true, needsYou: 0, shareId: 6, status: 'packing', percent: 42,
    packing: { shareId: 6, archiveName: 'Summer', phase: 'packing', percent: 42 },
    upload: { shareId: 5, archiveName: 'holiday', status: 'uploading', error: null, percent: 50, partNo: 2, partCount: 3, waitingInLine: false },
    packWaiting: 1, readyToCheck: 1 });
  assert.strictEqual(T.wrap.dataset.state, 'ready');
  assert.strictEqual(T.wrap.cache.badge.textContent, '1');
  assert.strictEqual(T.wrap.cache.badge.dataset.tone, 'amber');
  assert.strictEqual(T.pill.attrs['aria-label'], 'Shares: 3 working, 1 ready to check');
  T.clickPill();
  const html = T.pop.innerHTML;
  assert.match(html, /<b>Packing Summer<\/b><span class="watch-pop-mut">42%<\/span>/);
  assert.match(html, /<b>Uploading holiday<\/b><span class="watch-pop-mut">Part 2 of 3<\/span>/);
  assert.match(html, />1 waiting to pack</);
  assert.match(html, /class="share-link-btn share-pop-ready" data-share-list>1 packed and ready for you to check<\/button>/);
  assert.match(html, /data-share-open="6">Open<\/button>/);
  assert.match(html, /data-share-open="5">Open<\/button>/);
  assert.match(html, /data-share-list>Open My shares<\/button>/);
  const bare = withoutPrivate(html);
  assert.ok(!/Summer|holiday/.test(bare), 'names stay covered under privacy');
  assert.ok(/data-share-open="6"/.test(bare) && /packed and ready/.test(bare), 'the buttons and counts stay usable');
  // Packing alone: the accent look, no badge.
  T.show({ show: true, active: true, needsYou: 0, packing: { shareId: 6, archiveName: 'S', phase: 'staging', percent: 0 }, upload: null, packWaiting: 0, readyToCheck: 0 });
  assert.strictEqual(T.wrap.dataset.state, 'packing');
  assert.strictEqual(T.wrap.cache.badge.hidden, true);
  assert.strictEqual(T.pill.attrs['aria-label'], 'Shares: 1 working');
});

/* ── Check files for personal details ─────────────────────────────────── */

const META_DONE = (extra = {}) => ({ id: 'a'.repeat(24), done: true, checked: 2, total: 2, files: [], personalCount: 0, uncheckedCount: 0,
  extraBytes: 0, needBytes: 2040, enoughSpace: true, missingBytes: 0, ...extra });

test('personal details: checking, the amber box (plurals, fold, both choices), the quiet line; values escaped and hidden under File names', () => {
  const L = load();
  setState(L);
  L.ctx.__w = { preview: PREVIEW(fileRows(3), 3000, { checkPersonal: true }), meta: null, metaProgress: { checked: 1, total: 3 }, metaChoice: 'remove', metaOpen: false };
  assert.match(L.run('shareMetaHtml(__w)'), /role="status" data-sh-metamsg>Checking for personal details… 1 of 3<\/p>/);
  L.ctx.__w.meta = META_DONE({ personalCount: 2, uncheckedCount: 1, extraBytes: 2 * 1024 * 1024, files: [
    { mediaId: 1, findings: [{ label: 'Location', value: '52.37, 4.89' }, { label: 'Device', value: 'Apple iPhone 15 Pro' }] },
    { mediaId: 3, findings: [{ label: 'Name', value: HOSTILE_NAME }] },
  ] });
  const html = L.run('shareMetaHtml(__w)');
  assert.match(html, /<span class="share-meta-title" id="shMetaTitle">2 files carry personal details<\/span>/);
  assert.match(html, /data-sh-metafold aria-controls="shMetaList" aria-expanded="false">Show details<\/button>/);
  assert.match(html, /<div class="share-meta-list" id="shMetaList" data-share-names hidden>/, 'folded, and hidden under File names privacy');
  assert.match(html, /<span class="share-meta-name">clip1\.mp4<\/span><span class="share-meta-what"><span class="share-meta-label">Location:<\/span> 52\.37, 4\.89<\/span>/);
  assert.ok(!html.includes(HOSTILE_NAME) && html.includes(esc(HOSTILE_NAME)), 'a found value is escaped');
  assert.match(html, /value="remove" checked>/, 'Remove is picked to start with');
  assert.match(html, /value="keep">/);
  assert.match(html, /Remove from the packed copies.*Only these 2 files are copied and cleaned\. Your originals are not changed\. Needs about 2(\.0)? MB more free space\./s);
  assert.match(html, /Share as they are.*Whoever opens the archive can read these details\./s);
  assert.match(html, /<p class="vault-modal-hint" data-sh-metaunchecked>1 file could not be checked and is packed as it is\.<\/p>/);
  const words = html.replace(/<[^>]+>/g, '');
  assert.ok(!/[—–]/.test(words), 'no long dashes');
  assert.ok(!/all (the )?metadata|every detail/i.test(words), 'never claims to remove everything');
  assert.ok(!/minute|hour|second/i.test(words), 'no time figures');
  L.ctx.__w.metaChoice = 'keep';
  L.ctx.__w.metaOpen = true;
  const kept = L.run('shareMetaHtml(__w)');
  assert.match(kept, /value="remove">/);
  assert.match(kept, /value="keep" checked>/);
  assert.match(kept, /aria-expanded="true">Hide details</);
  assert.match(kept, /id="shMetaList" data-share-names>/);
  // One file.
  L.ctx.__w.meta = META_DONE({ personalCount: 1, files: [{ mediaId: 2, findings: [{ label: 'Folder path', value: 'C:\\Users\\sam' }] }] });
  assert.match(L.run('shareMetaHtml(__w)'), /1 file carries personal details.*Only this file is copied and cleaned\./s);
  // Nothing found: no box; only the quiet line when some could not be checked.
  L.ctx.__w.meta = META_DONE();
  assert.strictEqual(L.run('shareMetaHtml(__w)'), '');
  L.ctx.__w.meta = META_DONE({ uncheckedCount: 4 });
  assert.strictEqual(L.run('shareMetaHtml(__w)'), '<p class="vault-modal-hint" data-sh-metaunchecked>4 files could not be checked and are packed as they are.</p>');
});

test('personal details: a check that did not finish is a problem in the box, never clean; with or without findings', () => {
  const L = load();
  setState(L);
  L.ctx.__w = { preview: PREVIEW(fileRows(3), 3000, { checkPersonal: true }), metaChoice: 'remove', metaOpen: true };
  // Only failures: the box shows, the file is listed as not checked, Remove explains packing stops.
  L.ctx.__w.meta = META_DONE({ failedCount: 1, failedFiles: [{ mediaId: 2 }], uncheckedCount: 1 });
  let html = L.run('shareMetaHtml(__w)');
  assert.match(html, /id="shMetaTitle">1 file could not be checked for personal details<\/span>/);
  assert.match(html, /<div class="share-meta-file share-meta-failed"><span class="share-meta-name">clip2\.mp4<\/span><span class="share-meta-what">The check did not finish for this file\.<\/span><\/div>/);
  assert.match(html, /Remove from the packed copies.*Your originals are not changed\. Vault checks the file that could not be checked again when packing starts\. If one still cannot be checked, packing stops and nothing is uploaded\./s);
  assert.match(html, /Share as they are.*It is packed as it is, without the check\./s);
  assert.match(html, /data-sh-metaunchecked>1 file could not be checked and is packed as it is\./, 'a type Vault does not read is still the quiet line');
  assert.ok(!/[—–]/.test(html.replace(/<[^>]+>/g, '')), 'no long dashes');
  // Findings and failures together.
  L.ctx.__w.meta = META_DONE({ personalCount: 1, files: [{ mediaId: 1, findings: [{ label: 'Name', value: 'Sam' }] }], failedCount: 2, failedFiles: [{ mediaId: 2 }, { mediaId: 3 }] });
  html = L.run('shareMetaHtml(__w)');
  assert.match(html, /id="shMetaTitle">1 file carries personal details, 2 could not be checked<\/span>/);
  assert.strictEqual((html.match(/share-meta-failed/g) || []).length, 2);
  assert.match(html, /Only this file is copied and cleaned\. Your originals are not changed\. Vault checks the files that could not be checked again when packing starts\./);
  assert.match(html, /Whoever opens the archive can read these details\. The files that could not be checked are packed as they are\./);
  // The failed rows are under File names privacy with the rest.
  assert.match(html, /id="shMetaList" data-share-names>/);
});

test('personal details: flagged rows carry the tag; the space figures count the copies only while Remove is picked', () => {
  const L = load();
  setState(L);
  const preview = PREVIEW(fileRows(3), 3000, { checkPersonal: true, needBytes: 3060, enoughSpace: true, missingBytes: 0 });
  L.ctx.__w = { preview, mediaIds: [1, 2, 3], step: 'review', metaChoice: 'remove', metaOpen: false,
    meta: META_DONE({ personalCount: 1, files: [{ mediaId: 2, findings: [{ label: 'Name', value: 'Sam' }] }], extraBytes: 1000, needBytes: 4060, enoughSpace: false, missingBytes: 500 }) };
  const html = L.run('shareReviewHtml(__w)');
  assert.match(html, /data-mid="2"><span class="share-file-name">clip2\.mp4<span class="share-meta-tag">Personal details<\/span><\/span>/);
  assert.match(html, /data-mid="1"><span class="share-file-name">clip1\.mp4<\/span>/);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(L.run('shareSpaceNow(__w)'))), { needBytes: 4060, enoughSpace: false, missingBytes: 500 });
  assert.match(html, /There is not enough free space to pack these files/);
  L.ctx.__w.metaChoice = 'keep';
  assert.deepStrictEqual(JSON.parse(JSON.stringify(L.run('shareSpaceNow(__w)'))), { needBytes: 3060, enoughSpace: true, missingBytes: 0 });
  assert.ok(!/There is not enough free space/.test(L.run('shareReviewHtml(__w)')));
});

test('personal details: the check runs only when the setting is on; Pack files sends only a yes or no, never a file list', async () => {
  const open = async (preview, meta = META_DONE({ personalCount: 1, files: [{ mediaId: 1, findings: [{ label: 'Name', value: 'Sam' }] }] })) => {
    const D = loadDom({ answers: {
      'POST /api/share/preview': { status: 200, body: preview },
      'POST /api/share/meta-check': { status: 200, body: meta },
      'POST /api/share/shares': { status: 202, body: { share: { id: 9, status: 'packing' } } },
    } });
    await D.L.run('shareOpenForIds([1, 2])');
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    return D;
  };
  const body = (D) => JSON.parse(D.L.calls.find(c => c.url === '/api/share/shares').init.body);
  let D = await open(PREVIEW(fileRows(2), 2000));
  assert.ok(!D.L.calls.some(c => c.url.includes('meta-check')), 'setting off: no check asked for');
  await D.L.run('sharePack()');
  assert.ok(!('removePersonal' in body(D)));

  D = await open(PREVIEW(fileRows(2), 2000, { checkPersonal: true }));
  assert.deepStrictEqual(JSON.parse(D.L.calls.find(c => c.url === '/api/share/meta-check').init.body), { mediaIds: [1, 2] });
  assert.strictEqual(D.L.run('_shareWin.meta.personalCount'), 1);
  await D.L.run('sharePack()');
  assert.deepStrictEqual(Object.keys(body(D)).filter(k => /personal|clean|files/i.test(k)), ['removePersonal']);
  assert.strictEqual(body(D).removePersonal, true, 'Remove is the default');

  D = await open(PREVIEW(fileRows(2), 2000, { checkPersonal: true }));
  D.L.run(`_shareWin.metaChoice = 'keep'`);
  await D.L.run('sharePack()');
  assert.strictEqual(body(D).removePersonal, false);
});

test('personal details: Pack files pressed before the check ends waits for it; nothing found packs, something found lets the user pick', async () => {
  for (const found of [false, true]) {
    const D = loadDom({ answers: {
      'POST /api/share/preview': { status: 200, body: PREVIEW(fileRows(2), 2000, { checkPersonal: true }) },
      'POST /api/share/meta-check': { status: 200, body: { id: 'b'.repeat(24), done: false, checked: 0, total: 2 } },
      [`GET /api/share/meta-check/${'b'.repeat(24)}`]: { status: 200, body: META_DONE(found ? { personalCount: 1, files: [{ mediaId: 2, findings: [{ label: 'Name', value: 'Sam' }] }] } : {}) },
      'POST /api/share/shares': { status: 202, body: { share: { id: 9, status: 'packing' } } },
    } });
    const polls = [];
    D.L.ctx.setTimeout = (f, ms) => { if (ms === 700) polls.push(f); return 1; };
    await D.L.run('shareOpenForIds([1, 2])');
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    assert.strictEqual(D.L.run('shareMetaPending(_shareWin)'), true);
    D.L.run('sharePackClicked()');
    const btn = D.L.run(`_shareWin.m.q('[data-sh-act="pack"]')`);
    assert.deepStrictEqual([btn.disabled, btn.textContent], [true, 'Waiting for the check…']);
    assert.ok(!D.L.calls.some(c => c.url === '/api/share/shares'), 'nothing packs before the answer');
    // The answer comes.
    polls.splice(0).forEach(f => f());
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
    assert.ok(D.L.calls.some(c => c.url.startsWith('/api/share/meta-check/') && c.init.method === 'GET'));
    assert.strictEqual(D.L.run('_shareWin.metaWaitPack'), false);
    assert.strictEqual(btn.textContent, found ? 'Pack files' : 'Starting…');
    assert.strictEqual(D.L.calls.some(c => c.url === '/api/share/shares'), !found, found ? 'found: the user picks first' : 'nothing found: packs on');
  }
});

test('personal details: a failed share names the file privately; the setting, its search entry and the stage words', () => {
  const L = load();
  setState(L);
  const msg = `Vault could not remove personal details from ${HOSTILE}, so this share was not packed. Nothing was uploaded. Your own file was not changed.`;
  const html = L.run(`shareErrorHtml(${JSON.stringify(msg)})`);
  assert.ok(html.includes(`from <span class="share-priv" data-share-names>${esc(HOSTILE)}</span>, so this share`), html);
  assert.ok(!html.includes(HOSTILE));
  assert.strictEqual(L.run(`shareErrorHtml('Packing failed. <b>')`), 'Packing failed. &lt;b&gt;');
  // A check that did not finish names the file the same way; counts stay readable.
  const tail = ' for personal details, so this share was not packed. Nothing was uploaded. To pack it without the check, start the share again and pick Share as they are.';
  const chk = L.run(`shareErrorHtml(${JSON.stringify(`Vault could not check ${HOSTILE} and 1 more file${tail}`)})`);
  assert.ok(chk.startsWith(`Vault could not check <span class="share-priv" data-share-names>${esc(HOSTILE)}</span> and 1 more file for personal details`), chk);
  assert.ok(!chk.includes(HOSTILE));
  assert.strictEqual(L.run(`shareErrorHtml(${JSON.stringify(`Vault could not check 2 of the files${tail}`)})`), `Vault could not check 2 of the files${tail}`);
  const svc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'share', 'service.js'), 'utf8');
  assert.ok(svc.includes(`const CHECK_FAILED_END = '${tail}';`), 'the words match the server');
  assert.strictEqual(L.run('SHARE_PHASE_WORDS.cleaning'), 'Removing personal details');
  const src = read('share-settings-ui.js');
  assert.match(src, /'Check files for personal details'/);
  assert.match(src, /Looks for location, device, names and folder paths stored inside the files, and offers to remove them from the packed copies\./);
  assert.match(src, /checkPersonal: false/, 'off by default on the page too');
  const search = read('settings-search.js');
  assert.match(search, /shareCheckPersonal/);
});
