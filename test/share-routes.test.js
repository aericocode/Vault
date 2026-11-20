/**
 * Share privately routes (/api/share/*) over HTTP against the real Express
 * app (server/index.js), a temp library, a temp share_temp, the real 7-Zip
 * when present (the packing flow is skipped cleanly without it) and a fake
 * gofile client. No request leaves the machine: the global fetch is replaced
 * by one that fails the test for anything but this test's own server.
 *
 * Covered: the share-only request guard (custom header + JSON, same-origin
 * only) on top of the app-wide ones; feature off; settings; preview; start
 * -> packing -> checks -> upload with the explicit confirm only; offline
 * blocks the upload; cancel deletes the archive; copy block; delete; with
 * the feature off, Delete / Delete all / Stop delete only stored folders
 * (body ids ignored) while the upload-side routes answer FEATURE_OFF; the
 * real Vault password gate (verifyPassword on an encrypted library) with its
 * lockout; 423 while locked; no password or token in any non-gated answer;
 * the one-time warning with no Vault password (WARNING_NEEDED before the
 * first share is stored, nothing stored without it, one warning for the
 * share and the saved password).
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-share-routes-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_SHARE_TEMP = path.join(tmp, 'share_temp');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;
// 7-Zip: VAULT_7ZIP when set, else the copy shipped in vendor/7zip/ (found
// by lib/share/sevenzip.js like the app does).

const config = require('../config');
const db = require('../lib/database');
const vault = require('../lib/vault');
const gate = require('../lib/share/gate');
const sevenzip = require('../lib/share/sevenzip');
const service = require('../lib/share/service');
const store = require('../lib/share/store');
const { GofileClient } = require('../lib/share/gofile');
const { app } = require('../server/index');

const skip7z = sevenzip.locate() ? false : 'no 7-Zip program found';
const TOKEN = 'TOKEN-routes-0123456789abcdef';

let server;
let base;
const seen = [];          // [path, text] of every answer
const realFetch = globalThis.fetch;
let strayFetches = 0;

test.before(async () => {
  db.init();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith(base)) return realFetch(url, opts);
    strayFetches++;
    return Promise.reject(new Error('no real request in this test'));
  };
});
test.after(async () => {
  globalThis.fetch = realFetch;
  await service._idle();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { require('../lib/secure-assets').close(); } catch {}
  gate._reset();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

async function call(method, p, body, { headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (method !== 'GET' && !raw) { h['Content-Type'] = 'application/json'; h['X-Vault-Share'] = '1'; }
  const res = await fetch(base + p, { method, headers: h, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });
  const text = await res.text();
  seen.push([p, text]);
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// A small library.
const libDir = path.join(tmp, 'media');
const mediaIds = [];
function addMedia(rel, bytes) {
  const p = path.join(libDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, crypto.randomBytes(bytes));
  const r = db.get().prepare("INSERT INTO media (filepath, filename, media_type, filesize_bytes) VALUES (?, ?, 'video', ?)").run(p, path.basename(p), bytes);
  mediaIds.push(Number(r.lastInsertRowid));
}

function fakeClient() {
  const c = {
    calls: [],
    async createAccount() { c.calls.push('account'); return { token: TOKEN }; },
    async uploadPart(o) { c.calls.push(`upload ${o.fileName}`); o.onBytes && o.onBytes(o.size); return { fileId: 'f1', folderId: 'folder-9', code: 'Zz9', link: 'https://gofile.io/d/Zz9', md5: 'x' }; },
    async setExpiry() { c.calls.push('expiry'); },
    async deleteContent() { c.calls.push('delete'); },
  };
  service._setForTest({ client: c, sleep: () => Promise.resolve() });
  return c;
}

async function waitStatus(id, want, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = (await call('GET', `/api/share/shares/${id}/progress`)).json;
    if (want.includes(last.status)) return last;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`share ${id} stuck at ${JSON.stringify(last)}`);
}

test('share writes need X-Vault-Share and a JSON body; other sites are refused', async () => {
  addMedia('a/one.mp4', 5000);
  addMedia('b/one.mp4', 6000);
  addMedia('c/two.jpg', 700);
  const noHeader = await call('POST', '/api/share/settings', { enabled: true }, { raw: true, headers: { 'Content-Type': 'application/json' } });
  assert.strictEqual(noHeader.status, 403);
  assert.strictEqual(noHeader.json.code, 'SHARE_FORBIDDEN');
  const formLike = await fetch(`${base}/api/share/settings`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Vault-Share': '1' }, body: '{"enabled":true}' });
  assert.strictEqual(formLike.status, 403);
  const typed = await call('GET', '/api/share/state', undefined, { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.strictEqual(typed.status, 403);
  const cross = await call('POST', '/api/share/settings', { enabled: true }, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.strictEqual(cross.status, 403);
  const evil = await call('POST', '/api/share/settings', { enabled: true }, { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(evil.status, 403);
  // A broken JSON body gets a plain 400 that does not quote the body.
  const broken = await fetch(`${base}/api/share/saved-password/reveal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vault-Share': '1' }, body: '{"vaultPassword": "Hunter2-secret',
  });
  const brokenText = await broken.text();
  assert.strictEqual(broken.status, 400);
  assert.strictEqual(JSON.parse(brokenText).code, 'BAD_INPUT');
  assert.ok(!brokenText.includes('Hunter2'));
  const same = await call('GET', '/api/share/state', undefined, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.strictEqual(same.status, 200);
  assert.strictEqual(same.json.enabled, false, 'none of the refused calls turned it on');
});

test('feature off: starting a share is refused; settings are checked', async () => {
  const r = await call('POST', '/api/share/shares', { mediaIds });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'FEATURE_OFF');
  const bad = await call('POST', '/api/share/settings', { split: '3g' });
  assert.strictEqual(bad.status, 400);
  const size = await call('POST', '/api/share/settings', { customPartBytes: 1 });
  assert.strictEqual(size.json.code, 'BAD_PART_SIZE');
  const on = await call('POST', '/api/share/settings', { enabled: true });
  assert.strictEqual(on.status, 200);
  assert.strictEqual(on.json.settings.enabled, true);
  const st = (await call('GET', '/api/share/state')).json;
  assert.strictEqual(st.enabled, true);
  assert.strictEqual(st.offline, true);
  assert.ok(!('nameMode' in st.settings), 'no Archive name setting');
  assert.ok(!('topBarIcon' in st.settings), 'no share button setting');
  const old = await call('POST', '/api/share/settings', { topBarIcon: false });
  assert.strictEqual(old.status, 400, 'the old setting is refused');
});

test('preview: names, sizes, space, split; same names get (2)', async () => {
  const r = await call('POST', '/api/share/preview', { mediaIds });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.files.map(f => f.nameInArchive), ['one.mp4', 'one (2).mp4', 'two.jpg']);
  assert.strictEqual(r.json.totalBytes, 11700);
  assert.strictEqual(r.json.split, false);
  assert.strictEqual(r.json.enoughSpace, true);
  assert.ok(!('nameMode' in r.json));
  const missing = await call('POST', '/api/share/preview', { mediaIds: [999999] });
  assert.strictEqual(missing.status, 404);
  const junk = await call('POST', '/api/share/preview', { mediaIds: ['1; DROP'] });
  assert.strictEqual(junk.status, 400);
});

let shareId;
let sharePassword;

test('no Vault password, passwords remembered: the first share needs the one-time warning, and nothing is stored without it', { skip: skip7z }, async () => {
  const folders = () => (fs.existsSync(process.env.VAULT_SHARE_TEMP) ? fs.readdirSync(process.env.VAULT_SHARE_TEMP).filter(n => n.startsWith('share-')) : []);
  assert.strictEqual(store.kvGet('plain_warning_shown'), null);
  // The older flag (given for the saved password only) does not count.
  store.kvSet('warning_shown', '1');
  const before = folders();
  const r = await call('POST', '/api/share/shares', { mediaIds, passwordChoice: 'random' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'WARNING_NEEDED');
  assert.match(r.json.error, /no Vault password/);
  assert.deepStrictEqual((await call('GET', '/api/share/shares')).json.shares, [], 'no share was stored');
  assert.deepStrictEqual(store.listShares(), [], 'not even a hidden one');
  assert.deepStrictEqual(folders(), before, 'no work folder was made');
  // Anything but true is no answer.
  for (const ack of ['true', 1, 'yes', {}]) {
    const again = await call('POST', '/api/share/shares', { mediaIds, acknowledgeNoVaultPassword: ack });
    assert.strictEqual(again.json.code, 'WARNING_NEEDED', JSON.stringify(ack));
  }
  assert.strictEqual(store.kvGet('plain_warning_shown'), null);
  // "Passwords of past shares" off: no password is kept, so no warning.
  await call('POST', '/api/share/settings', { rememberPasswords: false, confirm: true });
  const off = await call('POST', '/api/share/shares', { mediaIds: [mediaIds[2]] });
  assert.strictEqual(off.status, 202, off.text);
  assert.strictEqual(store.kvGet('plain_warning_shown'), null, 'and the warning is still due');
  await waitStatus(off.json.share.id, ['checked', 'failed']);
  assert.deepStrictEqual((await call('POST', `/api/share/shares/${off.json.share.id}/cancel`, {})).json, { removed: true });
  await call('POST', '/api/share/settings', { rememberPasswords: true });
});

test('start -> packing -> checks pass; upload only with confirm, never while offline', { skip: skip7z }, async () => {
  const c = fakeClient();
  // A file from an older build with Archive name set to Always random: the
  // stale key is ignored, so a typed name is still used.
  const appSettings = require('../lib/app-settings');
  appSettings.set({ share: { ...appSettings.all().share, nameMode: 'random' } });
  const start = await call('POST', '/api/share/shares', { mediaIds, name: '  My Holiday!! ', passwordChoice: 'random', deleteAfterDays: 1, acknowledgeNoVaultPassword: true });
  assert.strictEqual(start.status, 202, start.text);
  assert.strictEqual(store.kvGet('plain_warning_shown'), '1', 'shown once');
  shareId = start.json.share.id;
  assert.strictEqual(start.json.share.archiveName, 'My Holiday');
  assert.strictEqual(start.json.share.nameTyped, true);
  const p = await waitStatus(shareId, ['checked', 'failed']);
  assert.strictEqual(p.status, 'checked', JSON.stringify(p));
  assert.strictEqual(p.checks.ok, true);
  assert.deepStrictEqual([p.checks.test.ok, p.checks.listWithoutPassword.ok, p.checks.contents.ok, p.checks.parts.ok], [true, true, true, true]);
  assert.deepStrictEqual(p.checks.archiveName, { value: 'My Holiday', typed: true });

  // Step 2 shows the password (a random one: no Vault password needed).
  const pw = await call('POST', `/api/share/shares/${shareId}/password`, {});
  assert.strictEqual(pw.status, 200);
  sharePassword = pw.json.password;
  assert.match(sharePassword, /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){5}$/);

  const noConfirm = await call('POST', `/api/share/shares/${shareId}/upload`, {});
  assert.strictEqual(noConfirm.status, 400);
  assert.strictEqual(noConfirm.json.code, 'CONFIRM_NEEDED');
  const offline = await call('POST', `/api/share/shares/${shareId}/upload`, { confirm: true });
  assert.strictEqual(offline.status, 409);
  assert.strictEqual(offline.json.code, 'NET_OFF');
  assert.strictEqual(offline.json.error, 'Vault is set to stay offline (VAULT_OFFLINE=1), so nothing can be uploaded.');
  assert.deepStrictEqual(c.calls, [], 'nothing sent before the confirmed upload');

  config.net.offline = false;
  try {
    const up = await call('POST', `/api/share/shares/${shareId}/upload`, { confirm: true });
    assert.strictEqual(up.status, 200, up.text);
    const done = await waitStatus(shareId, ['uploaded', 'paused', 'failed']);
    assert.strictEqual(done.status, 'uploaded', JSON.stringify(done));
    assert.strictEqual(done.link, 'https://gofile.io/d/Zz9');
    assert.deepStrictEqual(c.calls, ['account', 'upload My Holiday.7z', 'expiry']);
    // A second confirm on an uploaded share does nothing.
    const again = await call('POST', `/api/share/shares/${shareId}/upload`, { confirm: true });
    assert.strictEqual(again.json.code, 'NOT_CHECKED');
  } finally {
    config.net.offline = true;
  }

  const detail = (await call('GET', `/api/share/shares/${shareId}`)).json.share;
  assert.deepStrictEqual(detail.files.map(f => f.name), ['one.mp4', 'one (2).mp4', 'two.jpg']);
  assert.strictEqual(detail.passwordKept, true);
  const block = await call('POST', `/api/share/shares/${shareId}/copy-block`, {});
  assert.strictEqual(block.json.text, `https://gofile.io/d/Zz9\npass: ${sharePassword}`);
  const own = await call('POST', `/api/share/shares/${shareId}/copy-block`, { format: '{name} {code} {nope}' });
  assert.strictEqual(own.json.text, 'My Holiday Zz9 {nope}');
});

test('cancel during packing deletes the archive and the record', { skip: skip7z }, async () => {
  const start = await call('POST', '/api/share/shares', { mediaIds: [mediaIds[0]] });
  assert.strictEqual(start.status, 202);
  const id = start.json.share.id;
  const c = await call('POST', `/api/share/shares/${id}/cancel`, {});
  assert.strictEqual(c.status, 200);
  assert.deepStrictEqual(c.json, { removed: true });
  assert.strictEqual((await call('GET', `/api/share/shares/${id}`)).status, 404);
  const left = fs.readdirSync(process.env.VAULT_SHARE_TEMP).filter(n => n !== '.vault-owned');
  assert.ok(left.length <= 1, `left behind: ${left}`);   // the uploaded share keeps nothing (keep setting off)
});

test('delete from gofile is refused while offline, then works; remove from list', { skip: skip7z }, async () => {
  const c = fakeClient();
  const off = await call('POST', `/api/share/shares/${shareId}/delete-remote`, {});
  assert.strictEqual(off.json.code, 'NET_OFF');
  assert.strictEqual(off.json.error, 'Vault is set to stay offline (VAULT_OFFLINE=1), so nothing can be deleted from gofile.');
  config.net.offline = false;
  try {
    const del = await call('POST', `/api/share/shares/${shareId}/delete-remote`, {});
    assert.strictEqual(del.status, 200);
    assert.strictEqual(del.json.share.status, 'deleted');
    assert.deepStrictEqual(c.calls, ['delete']);
    const all = await call('POST', '/api/share/delete-all', { confirm: true });
    assert.deepStrictEqual(all.json, { results: [], deleted: 0, failed: 0 });
  } finally {
    config.net.offline = true;
  }
  const rm = await call('POST', `/api/share/shares/${shareId}/remove`, {});
  assert.deepStrictEqual(rm.json, { removed: true });
});

test('real Vault password gate: no password set, then set; wrong, lockout, right', async () => {
  // No Vault password: the saved password needs the one-time warning, no prompt.
  if (skip7z) {
    const warn = await call('POST', '/api/share/saved-password/change', { password: 'Saved-Pass-001' });
    assert.strictEqual(warn.json.code, 'WARNING_NEEDED');
  }
  // The warning seen at the first share covers the saved password too.
  const set = await call('POST', '/api/share/saved-password/change', { password: 'Saved-Pass-001', ...(skip7z ? { acknowledgeNoVaultPassword: true } : {}) });
  assert.strictEqual(set.status, 200, set.text);
  assert.strictEqual((await call('POST', '/api/share/saved-password/warning-shown', {})).status, 404, 'no route sets the flag on its own');
  assert.strictEqual((await call('POST', '/api/share/saved-password/reveal', {})).json.password, 'Saved-Pass-001');

  const sp = await call('POST', '/api/vault/setpass', { pass: 'vault-pass-1' }, { raw: true, headers: { 'Content-Type': 'application/json' } });
  assert.strictEqual(sp.status, 200, sp.text);

  const status = (await call('GET', '/api/share/saved-password')).json;
  assert.deepStrictEqual(status, { set: true, vaultPasswordSet: true, warningNeeded: false });
  assert.strictEqual((await call('POST', '/api/share/saved-password/reveal', {})).json.code, 'GATE_NEEDED');
  let t = Date.now();
  gate._setForTest({ now: () => t });
  for (let i = 1; i <= 4; i++) {
    const w = await call('POST', '/api/share/saved-password/reveal', { vaultPassword: 'nope' });
    assert.strictEqual(w.status, 401);
    assert.strictEqual(w.json.attemptsLeft, 5 - i);
    assert.ok(!('password' in w.json));
  }
  const locked = await call('POST', '/api/share/saved-password/reveal', { vaultPassword: 'nope' });
  assert.strictEqual(locked.status, 429);
  const stillLocked = await call('POST', '/api/share/saved-password/reveal', { vaultPassword: 'vault-pass-1' });
  assert.strictEqual(stillLocked.status, 429);
  assert.ok(!stillLocked.text.includes('Saved-Pass-001'));
  t += 61000;
  const ok = await call('POST', '/api/share/saved-password/reveal', { vaultPassword: 'vault-pass-1' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.password, 'Saved-Pass-001');
  const ch = await call('POST', '/api/share/saved-password/change', { vaultPassword: 'vault-pass-1', random: true });
  assert.strictEqual(ch.status, 200);
  assert.match(ch.json.password, /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){5}$/);
});

test('423 while the library is locked', async () => {
  await vault.lock({ force: true });
  try {
    const r = await call('GET', '/api/share/state');
    assert.strictEqual(r.status, 423);
  } finally {
    vault.unlock('vault-pass-1');
  }
  assert.strictEqual((await call('GET', '/api/share/state')).status, 200);
});

test('feature off: delete routes delete only the stored folder, whatever the body says; the rest answer FEATURE_OFF', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ method: opts.method, url, auth: new Headers(opts.headers).get('authorization'), body: JSON.parse(opts.body || 'null') });
    return new Response(JSON.stringify({ status: 'ok', data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  // The real client: the real switch, the real offline setting, a fake fetch.
  service._setForTest({ client: new GofileClient({ fetch: fakeFetch }), sleep: () => Promise.resolve() });
  const acc = store.insertAccount(`${TOKEN}-stored`, 'old-session');
  const mk = (status, folder) => store.insertShare({
    archive_name: `R${folder}`, password_kind: 'random', size: 1, part_count: 1, part_size: 1, file_count: 1,
    status, created_at: Date.now(), delete_after_days: 7, delete_after: Date.now() + 86400000, timer_set: 0,
    folder_id: folder, account_id: acc, link: 'https://gofile.io/d/R1',
  });
  const one = mk('uploaded', 'stored-one');
  const paused = mk('paused', 'stored-paused');
  store.setParts(paused, [{ partNo: 1, fileName: 'Rstored-paused.7z', size: 1, mtimeMs: 1 }]);
  store.updatePart(paused, 1, { status: 'failed' });
  const other = mk('uploaded', 'stored-other');
  const timerless = mk('uploaded', 'stored-timer');

  const off = await call('POST', '/api/share/settings', { enabled: false });
  assert.strictEqual(off.json.settings.enabled, false);
  config.net.offline = false;
  try {
    const sneaky = { folderId: 'evil-folder', contentsId: 'evil-folder', folder_id: 'evil-folder', id: other, token: 'EVIL-TOKEN-123456', confirm: true };
    // Upload-side routes: refused, nothing sent.
    for (const [p, b] of [[`/api/share/shares/${paused}/resume`, {}], [`/api/share/shares/${paused}/parts/1/retry`, {}],
      [`/api/share/shares/${timerless}/retry-timer`, {}], ['/api/share/shares', { mediaIds }]]) {
      const r = await call('POST', p, b);
      assert.strictEqual(r.status, 409, p);
      assert.strictEqual(r.json.code, 'FEATURE_OFF', p);
    }
    assert.deepStrictEqual(calls, []);

    const del = await call('POST', `/api/share/shares/${one}/delete-remote`, sneaky);
    assert.strictEqual(del.status, 200, del.text);
    assert.strictEqual(del.json.share.status, 'deleted');
    const stop = await call('POST', `/api/share/shares/${paused}/stop`, sneaky);
    assert.strictEqual(stop.status, 200, stop.text);
    assert.strictEqual(stop.json.share.status, 'cancelled');
    const all = await call('POST', '/api/share/delete-all', sneaky);
    assert.strictEqual(all.status, 200, all.text);
    assert.deepStrictEqual(calls.map(c => [c.method, c.url, c.auth, c.body]), [
      ['DELETE', 'https://api.gofile.io/contents', `Bearer ${TOKEN}-stored`, { contentsId: 'stored-one' }],
      ['DELETE', 'https://api.gofile.io/contents', `Bearer ${TOKEN}-stored`, { contentsId: 'stored-paused' }],
      ...[[timerless, 'stored-timer'], [other, 'stored-other']].sort((a, b) => b[0] - a[0])
        .map(([, f]) => ['DELETE', 'https://api.gofile.io/contents', `Bearer ${TOKEN}-stored`, { contentsId: f }]),
    ]);
    assert.ok(!JSON.stringify(calls).includes('evil') && !JSON.stringify(calls).includes('EVIL'));

    // Offline: deletes too are refused, nothing sent.
    calls.length = 0;
    const again = mk('uploaded', 'stored-offline');
    config.net.offline = true;
    assert.strictEqual((await call('POST', `/api/share/shares/${again}/delete-remote`, {})).json.code, 'NET_OFF');
    const allOff = await call('POST', '/api/share/delete-all', { confirm: true });
    assert.strictEqual(allOff.json.code, 'NET_OFF');
    assert.match(allOff.json.error, /so nothing can be deleted from gofile\.$/);
    assert.deepStrictEqual(calls, []);
  } finally {
    config.net.offline = true;
    await call('POST', '/api/share/settings', { enabled: true });
  }
});

test('no token anywhere; the share password only in the gated answers', () => {
  const gated = /\/password$|\/copy-block$|\/saved-password\/(reveal|change)$/;
  for (const [p, text] of seen) {
    assert.ok(!text.includes(TOKEN), `token in ${p}`);
    assert.ok(!text.includes('folder-9'), `folder id in ${p}`);
    if (sharePassword && !gated.test(p)) assert.ok(!text.includes(sharePassword), `password in ${p}`);
    if (!gated.test(p)) assert.ok(!text.includes('Saved-Pass-001'), `saved password in ${p}`);
  }
  assert.strictEqual(strayFetches, 0);
});
