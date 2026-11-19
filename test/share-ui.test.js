/**
 * Share privately, the page side (player-lib/share-client.js, share-ui.js,
 * share-settings-ui.js), run in a VM with no DOM: the one request helper
 * always sends the share header and JSON type; Upload stays off until the box
 * is ticked; hostile file and archive names are escaped; Open only ever links
 * to gofile.io; no share code puts a password in browser storage, the console
 * or a lasting global; the "My shares" privacy category blurs and takes the
 * list out of the keyboard order; the Settings page, its search entries, the
 * custom part size field and the copy format preview.
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
  assert.strictEqual(L.run('shareSelectionButton()'), '');
  assert.strictEqual(L.run(`shareMenuItemHtml({ id: 3, media_type: 'video' })`), '');
  setState(L, { enabled: true });
  assert.match(L.run('shareSelectionButton()'), /onclick="shareOpenForSelection\(\)"[^>]*>📤 Share privately<\/button>/);
  assert.match(L.run(`shareMenuItemHtml({ id: 3, media_type: 'video' })`), /shareOpenForIds\(\[3\]\)/);
  assert.strictEqual(L.run(`shareDetailButtonHtml({ id: 3, media_type: 'mix' })`), '', 'a mix has no file');
  assert.match(read('selection.js'), /shareSelectionButton\(\)/);
});

test('no long dashes in what the share files show', () => {
  for (const f of FILES) {
    const strings = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/[—–]/.test(strings), `${f}: a long dash in its strings`);
  }
});
