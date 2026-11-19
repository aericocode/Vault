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
  for (const f of FILES) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
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

test('settings: short page, More options folded, no parts-at-once or upload server setting', () => {
  const L = load({ kit: true });
  setState(L);
  const html = L.run('shareSettingsHtml()');
  for (const id of ['shareEnabled', 'sharePasswordChoice', 'shareDeleteAfter', 'shareSplit', 'shareMyShares', 'shareMore', 'shareSavedPassword',
    'shareNameMode', 'shareCustomPart', 'shareKeepLocal', 'shareOnPartFail', 'shareAccount', 'shareCopyFormat', 'shareRememberPasswords',
    'shareRememberFiles', 'shareHideInPrivacy', 'shareTopBarIcon', 'shareReset']) {
    assert.ok(html.includes(`data-sfind="${id}"`), id);
  }
  assert.match(html, /<details class="settings-acc share-more" data-sfind="shareMore">/, 'More options folded by default');
  assert.ok(!/parts at once|upload server|closest region/i.test(html));
  assert.match(html, /<option value="2g" selected>2 GB<\/option>/, '2 GB parts by default');
  assert.match(html, /My shares \(<span data-share-count>2<\/span>\)/);
  assert.match(html, /<input type="password" class="settings-text share-mono" id="shSavedPw" readonly/, 'the saved password is dots until Show');
  assert.ok(!/[—–]/.test(html.replace(/<[^>]+>/g, '')), 'no long dashes');
  const search = read('settings-search.js');
  assert.match(search, /\{ id: 'sharing', title: 'Private sharing' \}/);
  for (const id of ['shareEnabled', 'shareCustomPart', 'shareCopyFormat', 'shareHideInPrivacy']) {
    assert.match(search, new RegExp(`page: 'sharing', id: '${id}'`), `search entry ${id}`);
  }
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

test('top bar: while a share runs or needs you it keeps its look and opens the popup, with My shares beside Open upload', () => {
  const T = loadTopBar();
  T.show({ show: true, active: true, needsYou: 1, shareId: 7, archiveName: 'secret-name', status: 'paused', percent: 40 });
  assert.strictEqual(T.wrap.dataset.state, 'needs');
  assert.strictEqual(T.wrap.cache.badge.textContent, '1');
  assert.strictEqual(T.wrap.cache.badge.hidden, false);
  assert.strictEqual(T.pill.attrs['aria-haspopup'], 'dialog');
  assert.match(T.pill.attrs['aria-label'], /^Share upload paused, 40 percent, 1 part needs you$/);
  T.clickPill();
  assert.strictEqual(T.pop.hidden, false, 'the popup opens');
  assert.deepStrictEqual(T.opened, [], 'not My shares straight away');
  const html = T.pop.innerHTML;
  assert.match(html, /data-share-list>My shares<\/button>/);
  assert.match(html, /data-share-open="7">Open upload<\/button>/);
  assert.ok(withoutPrivate(html).includes('data-share-list') && !withoutPrivate(html).includes('secret-name'), 'the link is usable, the name stays covered');
  // The two links.
  T.pop.fire('click', { target: { closest: (s) => (s === '[data-share-list]' ? {} : null) } });
  assert.deepStrictEqual(T.opened, ['list']);
  assert.strictEqual(T.pop.hidden, true, 'the popup closes');
  T.clickPill();
  T.pop.fire('click', { target: { closest: (s) => (s === '[data-share-open]' ? { dataset: { shareOpen: '7' } } : null) } });
  assert.deepStrictEqual(T.opened, ['list', 7]);
  // Uploading with nothing failed: today's look, no red count.
  T.show({ show: true, active: true, needsYou: 0, shareId: 7, status: 'uploading', percent: 10 });
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
  const rows = [...html.matchAll(/<div class="share-file"( hidden)?>/g)];
  assert.strictEqual(rows.length, 10, 'every row is there');
  assert.deepStrictEqual(rows.map(r => !!r[1]), [false, false, false, true, true, true, true, true, true, true]);
  assert.match(html, /<button type="button" class="share-link-btn share-more-files" data-sh-more aria-controls="shFilesList" aria-expanded="false">and 7 more files<\/button>/);
  L.ctx.__w.filesOpen = true;
  const open = L.run('shareReviewHtml(__w)');
  assert.ok(!/<div class="share-file" hidden>/.test(open));
  assert.match(open, /aria-expanded="true">Show fewer<\/button>/);
  // Six or fewer: no fold.
  L.ctx.__w = { preview: PREVIEW(fileRows(6), 6000), filesOpen: false };
  const six = L.run('shareReviewHtml(__w)');
  assert.ok(!/data-sh-more/.test(six) && !/<div class="share-file" hidden>/.test(six));
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
