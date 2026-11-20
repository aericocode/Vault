/**
 * Share privately: the upload job, saved state, resume, the password gate and
 * the copy block (lib/share/service.js, store.js, gate.js, names.js), with a
 * fake gofile client. No 7-Zip needed: shares are made 'checked' directly,
 * with real part files in a real share_temp work folder.
 *
 * Covered (spec section 9): the auto rule (first part alone, then two at a
 * time, one after a rate limit), retries per the setting, a failed part
 * waiting for the user while the others go on, restart with parts present
 * and with parts missing, pause on lock with no resume on unlock, stop and
 * delete, offline making zero requests (deletes included), feature off
 * making zero requests except the deletes of uploads Vault already made
 * (spec section 1, promise 4; the real gofile client with a fake fetch),
 * confirm required,
 * the gate (right, wrong, lockout, no password set), copy formats, what is
 * kept when "remember" settings are off, delete all with per-row results,
 * and that no password or token is in any page-facing answer.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-share-job-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_SHARE_TEMP = path.join(tmp, 'share_temp');
delete process.env.VAULT_DB_PASSWORD;

const config = require('../config');
const db = require('../lib/database');
const vault = require('../lib/vault');
const store = require('../lib/share/store');
const settings = require('../lib/share/settings');
const temp = require('../lib/share/temp');
const gate = require('../lib/share/gate');
const names = require('../lib/share/names');
const service = require('../lib/share/service');
const { GofileClient } = require('../lib/share/gofile');

const TOKEN = 'TOKEN-secret-0123456789abcdef';
const realFetch = globalThis.fetch;
let realFetchCalls = 0;
globalThis.fetch = async () => { realFetchCalls++; throw new Error('no real request in this test'); };

test.before(() => {
  db.init();
  config.net.offline = false;
  service.ensureRecovered();   // as the first route call after start does
});
test.after(() => {
  globalThis.fetch = realFetch;
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
test.afterEach(async () => {
  await service._idle();
  assert.strictEqual(realFetchCalls, 0, 'a real request was made');
});

const immediate = () => new Promise(r => setImmediate(r));
/** Resolves when the upload is aborted (at once if it already was). */
const abortedP = (o) => new Promise(r => (o.signal.aborted ? r() : o.signal.addEventListener('abort', r, { once: true })));

/** A fake gofile client. `onUpload(call)` may throw or wait. */
function fakeClient({ onUpload } = {}) {
  const c = {
    calls: [], inflight: 0, maxInflight: 0, accounts: 0, folderSeq: 0,
    async createAccount() { c.calls.push({ op: 'account' }); c.accounts++; return { token: `${TOKEN}-${c.accounts}` }; },
    async uploadPart(o) {
      const call = { op: 'upload', partFile: o.fileName, folderId: o.folderId, token: o.token, inflightAtStart: c.inflight + 1 };
      c.calls.push(call);
      c.inflight++;
      c.maxInflight = Math.max(c.maxInflight, c.inflight);
      try {
        await immediate();
        if (onUpload) await onUpload(call, o);
        if (o.signal && o.signal.aborted) throw Object.assign(new Error('Stopped.'), { code: 'ABORTED' });
        o.onBytes && o.onBytes(o.size);
        const folder = o.folderId || `folder-${++c.folderSeq}`;
        return { fileId: `file-${o.fileName}`, folderId: folder, code: 'Code123', link: 'https://gofile.io/d/Code123', md5: 'x' };
      } finally {
        c.inflight--;
      }
    },
    async setExpiry(o) { c.calls.push({ op: 'expiry', ...o }); },
    async deleteContent(o) { c.calls.push({ op: 'delete', ...o }); },
  };
  return c;
}

function useClient(c) {
  service._setForTest({ client: c, sleep: () => immediate() });
  return c;
}

/** A share that passed its checks, with real part files on disk. */
function makeChecked({ parts = 3, size = 1000, kind = 'random', password = names.randomPassword(), keepPassword = true } = {}) {
  const wd = temp.createWorkDir();
  const name = names.randomArchiveName();
  const list = [];
  for (let i = 1; i <= parts; i++) {
    const fileName = parts > 1 ? `${name}.7z.${String(i).padStart(3, '0')}` : `${name}.7z`;
    const p = path.join(wd.dir, fileName);
    fs.writeFileSync(p, Buffer.alloc(size, i));
    const st = fs.statSync(p);
    list.push({ partNo: i, fileName, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) });
  }
  const id = store.insertShare({
    archive_name: name, password: keepPassword ? password : null, password_kind: kind, size: parts * size,
    part_count: parts, part_size: size, file_count: 2, status: 'checked', created_at: Date.now(),
    delete_after_days: settings.get().deleteAfterDays, work_dir: wd.name,
    checks: JSON.stringify({ ok: true }),
  });
  store.setParts(id, list);
  store.setFiles(id, [{ fileName: 'a.mp4', size: 1, mediaId: 1 }, { fileName: 'b.mp4', size: 2, mediaId: null }]);
  return { id, wd, name, password, list };
}

async function waitFor(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const statusOf = (id) => store.getShare(id).status;

function on(patch = {}) {
  settings.save({ ...settings.DEFAULTS, enabled: true, ...patch });
}

// First in the file, so no share from another test is running.
test('top bar: show with the feature on (the page offers My shares); otherwise only while a share runs or needs you', () => {
  useClient(fakeClient());
  const tb = (patch) => { settings.save({ ...settings.DEFAULTS, ...patch }); return service.state().topBar; };
  // Idle: nothing running, nothing failed.
  assert.deepStrictEqual([true, false].map(enabled => tb({ enabled }).show), [true, false], 'idle: with the feature on only');
  assert.strictEqual(tb({ enabled: true }).active, false);
  assert.strictEqual(tb({ enabled: true }).shareId, null);
  // Active: a paused share with a failed part.
  const s = makeChecked({ parts: 2 });
  store.updateShare(s.id, { status: 'paused' });
  store.updatePart(s.id, 2, { status: 'failed' });
  try {
    for (const enabled of [true, false]) {
      const t = tb({ enabled });
      assert.strictEqual(t.show, true, `active, enabled ${enabled}`);
      assert.strictEqual(t.active, true);
      assert.strictEqual(t.needsYou, 1);
      assert.strictEqual(t.shareId, s.id);
    }
    // Running with nothing failed is active too.
    store.updatePart(s.id, 2, { status: 'waiting' });
    store.updateShare(s.id, { status: 'uploading' });
    assert.deepStrictEqual({ show: tb({ enabled: false }).show, active: tb({ enabled: false }).active }, { show: true, active: true });
  } finally {
    store.deleteShare(s.id);
    on();
  }
});

test('upload needs confirm === true, the feature on, and VAULT_OFFLINE off; refusals make no request', async () => {
  const c = useClient(fakeClient());
  on();
  const s = makeChecked();
  await assert.rejects(() => service.confirmUpload(s.id, {}), { code: 'CONFIRM_NEEDED' });
  await assert.rejects(() => service.confirmUpload(s.id, { confirm: 'true' }), { code: 'CONFIRM_NEEDED' });
  on({ enabled: false });
  await assert.rejects(() => service.confirmUpload(s.id, { confirm: true }), { code: 'FEATURE_OFF' });
  on();
  config.net.offline = true;
  try {
    await assert.rejects(() => service.confirmUpload(s.id, { confirm: true }),
      { code: 'NET_OFF', message: 'Vault is set to stay offline (VAULT_OFFLINE=1), so nothing can be uploaded.' });
  } finally { config.net.offline = false; }
  assert.strictEqual(c.calls.length, 0);
  assert.strictEqual(statusOf(s.id), 'checked');
});

test('only a checked share whose checks passed can be uploaded', async () => {
  const c = useClient(fakeClient());
  on();
  const s = makeChecked();
  store.updateShare(s.id, { checks: JSON.stringify({ ok: false }) });
  await assert.rejects(() => service.confirmUpload(s.id, { confirm: true }), { code: 'NOT_CHECKED' });
  store.updateShare(s.id, { checks: JSON.stringify({ ok: true }), status: 'packing' });
  await assert.rejects(() => service.confirmUpload(s.id, { confirm: true }), { code: 'NOT_CHECKED' });
  // Parts changed after the checks: refused, deleted, nothing sent.
  store.updateShare(s.id, { status: 'checked' });
  fs.appendFileSync(path.join(s.wd.dir, s.list[0].fileName), 'tamper');
  await assert.rejects(() => service.confirmUpload(s.id, { confirm: true }), { code: 'PARTS_CHANGED' });
  assert.strictEqual(statusOf(s.id), 'failed');
  assert.strictEqual(c.calls.length, 0);
});

test('auto rule: first part alone, then two at a time, one at a time after a rate limit', async () => {
  let n = 0;
  const c = useClient(fakeClient({
    onUpload: async () => {
      const k = ++n;
      await new Promise(r => setTimeout(r, 5));
      if (k === 4) throw Object.assign(new Error('rate'), { code: 'RATE_LIMIT' });
    },
  }));
  on();
  const s = makeChecked({ parts: 8 });
  service.confirmUpload(s.id, { confirm: true });
  await waitFor(() => statusOf(s.id) === 'uploaded', 'upload');
  const uploads = c.calls.filter(x => x.op === 'upload');
  assert.strictEqual(uploads[0].inflightAtStart, 1, 'first part alone');
  assert.strictEqual(uploads[0].folderId, null);
  assert.ok(uploads.slice(1).every(u => u.folderId === 'folder-1'), 'later parts go into the folder');
  assert.ok(uploads.slice(1, 3).some(u => u.inflightAtStart === 2), 'two at a time at first');
  const afterLimit = uploads.slice(4);
  assert.ok(afterLimit.length >= 3);
  // After the rate limit answer, only the part that was already in flight can overlap once.
  assert.ok(afterLimit.slice(1).every(u => u.inflightAtStart === 1), JSON.stringify(afterLimit.map(u => u.inflightAtStart)));
  assert.strictEqual(service.progress(s.id).upload.partsAtOnce, 1);
  assert.ok(store.getParts(s.id).every(p => p.status === 'done'));
  // Timer set, local parts deleted (keep setting off).
  const exp = c.calls.find(x => x.op === 'expiry');
  assert.ok(exp && exp.folderId === 'folder-1');
  assert.ok(Math.abs(exp.expiresAtSec * 1000 - (Date.now() + 7 * 86400000)) < 60000);
  assert.strictEqual(store.getShare(s.id).timer_set, 1);
  await waitFor(() => !fs.existsSync(s.wd.dir), 'local parts deleted');
  assert.strictEqual(uploads.length, 9, 'the rate-limited part was sent again');
  assert.strictEqual(new Set(uploads.map(u => u.token)).size, 1, 'one account for the whole share');
});

test('"ask me straight away": a failed part waits for the user, the others go on; Try again finishes', async () => {
  let failOnce = true;
  const c = useClient(fakeClient({
    onUpload: async (call) => {
      if (call.partFile.endsWith('.002') && failOnce) { failOnce = false; throw Object.assign(new Error('x'), { code: 'NETWORK' }); }
    },
  }));
  on({ onPartFail: 'ask', deleteAfterDays: 0 });
  const s = makeChecked({ parts: 4 });
  service.confirmUpload(s.id, { confirm: true });
  await waitFor(() => statusOf(s.id) === 'paused', 'paused');
  const parts = store.getParts(s.id);
  assert.deepStrictEqual(parts.map(p => p.status), ['done', 'failed', 'done', 'done']);
  assert.strictEqual(parts[1].tries, 1);
  assert.strictEqual(service.state().topBar.needsYou, 1);
  assert.match(store.getShare(s.id).last_error, /1 part could not be uploaded/);
  service.retryPart(s.id, 2);
  await waitFor(() => statusOf(s.id) === 'uploaded', 'uploaded');
  // Never: no timer call.
  assert.ok(!c.calls.some(x => x.op === 'expiry'));
  assert.strictEqual(store.getShare(s.id).delete_after, null);
});

test('"try 3 more times": a part that fails twice is retried and done', async () => {
  let fails = 0;
  const c = useClient(fakeClient({
    onUpload: async (call) => {
      if (call.partFile.endsWith('.001') && fails < 2) { fails++; throw Object.assign(new Error('x'), { code: 'GOFILE_ERROR' }); }
    },
  }));
  on();
  const s = makeChecked({ parts: 2 });
  service.confirmUpload(s.id, { confirm: true });
  await waitFor(() => statusOf(s.id) === 'uploaded', 'uploaded');
  assert.strictEqual(store.getParts(s.id)[0].tries, 2);
  assert.strictEqual(c.calls.filter(x => x.op === 'upload').length, 4);
});

test('restart while uploading: not resumed by itself, then Resume with the parts present finishes into the same folder', async () => {
  let hold = true;
  let release;
  const gateP = new Promise(r => { release = r; });
  const c = useClient(fakeClient({
    onUpload: async (call, o) => {
      if (!call.partFile.endsWith('.001') && hold) {
        await Promise.race([gateP, abortedP(o)]);
      }
    },
  }));
  on();
  const s = makeChecked({ parts: 3 });
  service.confirmUpload(s.id, { confirm: true });
  await waitFor(() => store.getParts(s.id)[0].status === 'done' && store.getParts(s.id)[1].status === 'uploading', 'part 2 in flight');
  // "Restart": the process dies; memory is gone, the database is not.
  await service.pause(s.id);   // stands in for the in-flight requests dying with the process
  store.updateShare(s.id, { status: 'uploading' });
  service._simulateRestart();
  service.ensureRecovered();
  assert.strictEqual(statusOf(s.id), 'not_finished');
  assert.ok(store.getParts(s.id).every(p => p.status !== 'uploading'));
  const before = c.calls.length;
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(c.calls.length, before, 'nothing resumed by itself');
  assert.strictEqual(service.listShares().find(x => x.id === s.id).canResume, true);
  hold = false; release();
  service.resume(s.id);
  await waitFor(() => statusOf(s.id) === 'uploaded', 'uploaded');
  const later = c.calls.slice(before).filter(x => x.op === 'upload');
  assert.ok(later.length === 2 && later.every(u => u.folderId === 'folder-1'));
  assert.ok(!later.some(u => u.partFile.endsWith('.001')), 'a done part is not sent again');
  const tokens = new Set(c.calls.filter(x => x.op === 'upload').map(u => u.token));
  assert.strictEqual(tokens.size, 1, 'the share keeps its account');
});

test('restart with the parts missing: Resume marks it failed, the uploaded parts can still be deleted', async () => {
  const c = useClient(fakeClient({
    onUpload: async (call) => { if (call.partFile.endsWith('.002')) throw Object.assign(new Error('x'), { code: 'NETWORK' }); },
  }));
  on({ onPartFail: 'ask' });
  const s = makeChecked({ parts: 2 });
  service.confirmUpload(s.id, { confirm: true });
  await waitFor(() => statusOf(s.id) === 'paused', 'paused');
  service._simulateRestart();
  service.ensureRecovered();
  fs.rmSync(s.wd.dir, { recursive: true, force: true });
  await assert.rejects(() => service.resume(s.id), { code: 'PARTS_MISSING' });
  assert.strictEqual(statusOf(s.id), 'failed');
  const out = await service.deleteRemote(s.id);
  assert.strictEqual(out.status, 'deleted');
  const del = c.calls.find(x => x.op === 'delete');
  assert.strictEqual(del.folderId, 'folder-1');
});

test('locking the library pauses the upload; unlocking does not resume it', async () => {
  const c = useClient(fakeClient({
    onUpload: async (call, o) => {
      if (!call.partFile.endsWith('.001')) await abortedP(o);
    },
  }));
  on();
  const s = makeChecked({ parts: 3 });
  service.confirmUpload(s.id, { confirm: true });
  await waitFor(() => store.getParts(s.id).some(p => p.part_no > 1 && p.status === 'uploading'), 'in flight');
  vault._notify('locking');
  await service._idle();
  assert.strictEqual(statusOf(s.id), 'paused');
  assert.match(store.getShare(s.id).last_error, /library was locked/);
  const n = c.calls.length;
  vault._notify('unlocked');
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(c.calls.length, n);
  assert.strictEqual(statusOf(s.id), 'paused');
});

test('turning the feature off pauses a running upload', async () => {
  useClient(fakeClient({
    onUpload: async (call, o) => { if (!call.partFile.endsWith('.001')) await abortedP(o); },
  }));
  on();
  const s = makeChecked({ parts: 2 });
  service.confirmUpload(s.id, { confirm: true });
  await waitFor(() => store.getParts(s.id)[1].status === 'uploading', 'in flight');
  await service.updateSettings({ enabled: false });
  assert.strictEqual(statusOf(s.id), 'paused');
  await assert.rejects(() => service.resume(s.id), { code: 'FEATURE_OFF' });
});

test('stop and delete: gofile folder deleted, then local parts, then cancelled', async () => {
  const c = useClient(fakeClient({
    onUpload: async (call, o) => { if (!call.partFile.endsWith('.001')) await abortedP(o); },
  }));
  on();
  const s = makeChecked({ parts: 3 });
  service.confirmUpload(s.id, { confirm: true });
  await waitFor(() => store.getParts(s.id)[1].status === 'uploading', 'in flight');
  await assert.rejects(service.stop(s.id, {}), { code: 'CONFIRM_NEEDED' });
  const out = await service.stop(s.id, { confirm: true });
  assert.strictEqual(out.status, 'cancelled');
  assert.ok(c.calls.some(x => x.op === 'delete' && x.folderId === 'folder-1'));
  assert.ok(!fs.existsSync(s.wd.dir));
});

test('accounts: one per Vault start by default, a new one per share when chosen, never more', async () => {
  const c = useClient(fakeClient());
  db.get().exec('DELETE FROM share_accounts');
  on({ accountMode: 'perStart' });
  for (let i = 0; i < 2; i++) {
    const s = makeChecked({ parts: 1 });
    service.confirmUpload(s.id, { confirm: true });
    await waitFor(() => statusOf(s.id) === 'uploaded', 'uploaded');
  }
  assert.strictEqual(c.accounts, 1);
  on({ accountMode: 'perShare' });
  for (let i = 0; i < 2; i++) {
    const s = makeChecked({ parts: 1 });
    service.confirmUpload(s.id, { confirm: true });
    await waitFor(() => statusOf(s.id) === 'uploaded', 'uploaded');
  }
  assert.strictEqual(c.accounts, 3);
});

test('one share at a time: a second waits in line', async () => {
  let release;
  const held = new Promise(r => { release = r; });
  const c = useClient(fakeClient({ onUpload: async (call) => { if (call.partFile.startsWith(first.name)) await held; } }));
  on();
  const first = makeChecked({ parts: 1 });
  const second = makeChecked({ parts: 1 });
  service.confirmUpload(first.id, { confirm: true });
  service.confirmUpload(second.id, { confirm: true });
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(service.progress(second.id).upload.waitingInLine, true);
  assert.ok(!c.calls.some(x => x.op === 'upload' && x.partFile.startsWith(second.name)));
  release();
  await waitFor(() => statusOf(second.id) === 'uploaded', 'second uploaded');
});

test('no password or token in anything the page reads', async () => {
  useClient(fakeClient());
  on();
  const s = makeChecked({ parts: 2 });
  service.confirmUpload(s.id, { confirm: true });
  await waitFor(() => statusOf(s.id) === 'uploaded', 'uploaded');
  const text = JSON.stringify([service.state(), service.listShares(), service.getShare(s.id), service.progress(s.id), service.savedPasswordStatus()]);
  assert.ok(!text.includes(s.password), 'password leaked');
  assert.ok(!text.includes(TOKEN), 'token leaked');
  assert.ok(!text.includes('folder-1'), 'folder id leaked');
  // The gated reveal is the one place the password comes back.
  assert.strictEqual(service.revealPassword(s.id).password, s.password);
});

test('copy block: default, one-line, own format, unknown pieces left as typed, values never re-expanded', () => {
  const v = { link: 'https://gofile.io/d/Ab1', code: 'Ab1', pass: 'P{name}ss', name: 'Arch' };
  assert.strictEqual(names.renderBlock(names.READY_FORMATS.default, v), 'https://gofile.io/d/Ab1\npass: P{name}ss');
  assert.strictEqual(names.renderBlock(names.READY_FORMATS.oneLine, v), 'code: Ab1 | pass: P{name}ss');
  assert.strictEqual(names.renderBlock('{name}: {link} {pass} {foo} {LINK} {{code}}', v), 'Arch: https://gofile.io/d/Ab1 P{name}ss {foo} {LINK} {Ab1}');
  // No password kept: the block is the link alone when the format needs it.
  assert.strictEqual(names.renderBlock(names.READY_FORMATS.default, { ...v, pass: null }), 'https://gofile.io/d/Ab1');
  assert.strictEqual(names.renderBlock('code {code}', { ...v, pass: null }), 'code Ab1');
  assert.strictEqual(names.formatFor({ copyFormat: 'custom', customFormat: '{code}' }), '{code}');
  assert.strictEqual(names.formatFor({ copyFormat: 'custom', customFormat: '  ' }), names.READY_FORMATS.default);
  assert.strictEqual(names.formatFor({ copyFormat: 'oneLine' }), names.READY_FORMATS.oneLine);
});

test('names and passwords: secure random, the right shape; typed names cleaned', () => {
  for (let i = 0; i < 50; i++) {
    assert.match(names.randomArchiveName(), /^[A-Za-z0-9]{12}$/);
    assert.match(names.randomPassword(), /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){5}$/);
  }
  assert.strictEqual(names.cleanTypedName('  ../../evil\\name<>:"|?*.  '), 'evilname');
  assert.strictEqual(names.cleanTypedName('Holiday 2026_v2-final.'), 'Holiday 2026_v2-final');
  assert.strictEqual(names.cleanTypedName('x'.repeat(200)).length, 80);
  assert.strictEqual(names.cleanTypedName('...'), '');
  assert.throws(() => names.cleanTypedName('CON'), { code: 'BAD_NAME' });
  assert.throws(() => names.cleanTypedName('nul.txt'), { code: 'BAD_NAME' });
  assert.deepStrictEqual(names.uniqueNames(['a.mp4', 'A.mp4', 'a (2).mp4', 'b', 'b']), ['a.mp4', 'A (2).mp4', 'a (2) (2).mp4', 'b', 'b (2)']);
});

test('password gate: no Vault password set passes; right, wrong, lockout after 5, wait a minute', () => {
  try {
    gate._setForTest({ encrypted: () => false });
    assert.strictEqual(gate.check(undefined), true);
    let t = 1000000;
    gate._setForTest({ encrypted: () => true, verify: (p) => p === 'right-pass', now: () => t });
    assert.throws(() => gate.check(undefined), { code: 'GATE_NEEDED', status: 401 });
    assert.strictEqual(gate.check('right-pass'), true);
    for (let i = 1; i <= 4; i++) assert.throws(() => gate.check('wrong'), { code: 'GATE_WRONG', attemptsLeft: 5 - i });
    assert.throws(() => gate.check('wrong'), { code: 'GATE_LOCKED', status: 429 });
    // During the wait, even the right password is refused (and not checked).
    assert.throws(() => gate.check('right-pass'), { code: 'GATE_LOCKED' });
    t += 61000;
    assert.strictEqual(gate.check('right-pass'), true);
    // A right password clears the count.
    assert.throws(() => gate.check('wrong'), { code: 'GATE_WRONG' });
    assert.strictEqual(gate.check('right-pass'), true);
    for (let i = 1; i <= 4; i++) assert.throws(() => gate.check('wrong'), { code: 'GATE_WRONG' });
  } finally {
    gate._reset();
  }
});

test('saved-password shares are gated; random ones are not', () => {
  useClient(fakeClient());
  on();
  const s = makeChecked({ kind: 'saved', password: 'My-Saved-Pass-1' });
  store.updateShare(s.id, { link: 'https://gofile.io/d/Code123', code: 'Code123', status: 'uploaded' });
  try {
    gate._setForTest({ encrypted: () => true, verify: (p) => p === 'vault-pass' });
    assert.throws(() => service.revealPassword(s.id, {}), { code: 'GATE_NEEDED' });
    assert.throws(() => service.copyBlock(s.id, {}), { code: 'GATE_NEEDED' });
    assert.throws(() => service.copyBlock(s.id, { vaultPassword: 'nope' }), { code: 'GATE_WRONG' });
    assert.strictEqual(service.revealPassword(s.id, { vaultPassword: 'vault-pass' }).password, 'My-Saved-Pass-1');
    assert.strictEqual(service.copyBlock(s.id, { vaultPassword: 'vault-pass' }).text, 'https://gofile.io/d/Code123\npass: My-Saved-Pass-1');
    // A format without {pass} needs no Vault password.
    assert.strictEqual(service.copyBlock(s.id, { format: '{link} ({name})' }).text, `https://gofile.io/d/Code123 (${s.name})`);
    const r = makeChecked({ kind: 'random', password: 'Rand-Om00-Pass' });
    store.updateShare(r.id, { link: 'https://gofile.io/d/R1', code: 'R1', status: 'uploaded' });
    assert.strictEqual(service.revealPassword(r.id, {}).password, 'Rand-Om00-Pass');
  } finally {
    gate._reset();
  }
});

test('saved default password: gated show and change, one-time warning with no Vault password, safe characters only', () => {
  gate._setForTest({ encrypted: () => false });
  try {
    store.kvSet('plain_warning_shown', null);
    store.kvSet('warning_shown', '1');   // the older, narrower warning does not count
    store.kvSet('saved_password', null);
    assert.strictEqual(service.savedPasswordStatus().warningNeeded, true);
    assert.throws(() => service.changeSavedPassword({ password: 'Good-Password-1' }), { code: 'WARNING_NEEDED' });
    assert.throws(() => service.changeSavedPassword({ random: true }), { code: 'WARNING_NEEDED' });
    assert.strictEqual(store.kvGet('saved_password'), null, 'nothing stored without the warning');
    // A password that is refused anyway does not use up the warning.
    assert.throws(() => service.changeSavedPassword({ password: 'short', acknowledgeNoVaultPassword: true }), { code: 'BAD_PASSWORD' });
    assert.strictEqual(service.savedPasswordStatus().warningNeeded, true);
    const r = service.changeSavedPassword({ password: 'Good-Password-1', acknowledgeNoVaultPassword: true });
    assert.deepStrictEqual(r, { set: true, password: 'Good-Password-1' });
    assert.strictEqual(service.savedPasswordStatus().warningNeeded, false);
    for (const bad of ['short', 'has\nnewline-xx', 'tab\there-xxxx', ' leading-space', 'ünïcode-pass', 'x'.repeat(129)]) {
      assert.throws(() => service.changeSavedPassword({ password: bad }), { code: 'BAD_PASSWORD' }, bad);
    }
    const rnd = service.changeSavedPassword({ random: true });
    assert.match(rnd.password, /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){5}$/);
    assert.strictEqual(service.revealSavedPassword({}).password, rnd.password);
    gate._setForTest({ encrypted: () => true, verify: (p) => p === 'vault-pass' });
    assert.throws(() => service.revealSavedPassword({}), { code: 'GATE_NEEDED' });
    assert.throws(() => service.changeSavedPassword({ password: 'Another-Pass-2' }), { code: 'GATE_NEEDED' });
    assert.throws(() => service.changeSavedPassword({ vaultPassword: 'bad', password: 'Another-Pass-2' }), { code: 'GATE_WRONG' });
    assert.strictEqual(service.changeSavedPassword({ vaultPassword: 'vault-pass', password: 'Another-Pass-2' }).set, true);
    assert.deepStrictEqual(service.changeSavedPassword({ vaultPassword: 'vault-pass', clear: true }), { set: false });
    assert.strictEqual(service.savedPasswordStatus().set, false);
  } finally {
    gate._reset();
  }
});

test('"Passwords of past shares" off: needs a confirm, clears stored passwords; new ones live in memory only', async () => {
  useClient(fakeClient());
  on();
  const old = makeChecked({ password: 'Old-Pass-Word-1' });
  store.updateShare(old.id, { status: 'uploaded', link: 'https://gofile.io/d/Old1', code: 'Old1' });
  await assert.rejects(service.updateSettings({ rememberPasswords: false }), { code: 'CONFIRM_NEEDED' });
  assert.strictEqual(settings.get().rememberPasswords, true);
  const out = await service.updateSettings({ rememberPasswords: false }, { confirm: true });
  assert.ok(out.passwordsCleared >= 1);
  assert.strictEqual(store.getShare(old.id).password, null);
  assert.strictEqual(service.copyBlock(old.id).text, 'https://gofile.io/d/Old1');
  assert.throws(() => service.revealPassword(old.id), { code: 'NO_PASSWORD' });
  await assert.rejects(service.updateSettings({ rememberFiles: false }), { code: 'CONFIRM_NEEDED' });
  await service.updateSettings({ rememberFiles: false }, { confirm: true });
  assert.strictEqual(service.getShare(old.id).files.length, 0);
  settings.save({ rememberPasswords: true, rememberFiles: true });
});

test('delete all: one by one, a failing row stays with its reason', async () => {
  const c = useClient(fakeClient());
  c.deleteContent = async (o) => {
    c.calls.push({ op: 'delete', ...o });
    if (o.folderId === 'bad-folder') throw Object.assign(new Error('gofile refused the request.'), { code: 'GOFILE_ERROR' });
  };
  on();
  for (const r of store.listShares()) store.deleteShare(r.id);
  const acc = store.insertAccount(TOKEN, 'x');
  const a = makeChecked(); store.updateShare(a.id, { status: 'uploaded', folder_id: 'good-folder', account_id: acc, link: 'https://gofile.io/d/A' });
  const b = makeChecked(); store.updateShare(b.id, { status: 'uploaded', folder_id: 'bad-folder', account_id: acc, link: 'https://gofile.io/d/B' });
  const g = makeChecked(); store.updateShare(g.id, { status: 'gone', folder_id: 'old-folder', account_id: acc });
  await assert.rejects(service.deleteAll({}), { code: 'CONFIRM_NEEDED' });
  const r = await service.deleteAll({ confirm: true });
  assert.strictEqual(r.deleted, 1);
  assert.strictEqual(r.failed, 1);
  assert.deepStrictEqual(r.results.map(x => [x.id, x.ok]).sort(), [[a.id, true], [b.id, false]].sort());
  assert.strictEqual(statusOf(a.id), 'deleted');
  assert.strictEqual(statusOf(b.id), 'uploaded');
  assert.match(store.getShare(b.id).last_error, /Could not delete/);
  assert.ok(!c.calls.some(x => x.folderId === 'old-folder'), 'a share marked gone is left alone');
  assert.ok(!JSON.stringify(r).includes(TOKEN));
  // Offline: delete makes no request at all, with the feature on or off.
  const n = c.calls.length;
  config.net.offline = true;
  try {
    for (const enabled of [true, false]) {
      on({ enabled });
      // The message fits a delete, not an upload.
      const delMsg = 'Vault is set to stay offline (VAULT_OFFLINE=1), so nothing can be deleted from gofile.';
      await assert.rejects(service.deleteRemote(b.id), { code: 'NET_OFF', message: delMsg });
      await assert.rejects(service.deleteAll({ confirm: true }), { code: 'NET_OFF', message: delMsg });
    }
  } finally { config.net.offline = false; on(); }
  assert.strictEqual(c.calls.length, n);
  assert.strictEqual(statusOf(b.id), 'uploaded');
});

/**
 * The real gofile client (lib/share/gofile.js) with only its fetch faked, so
 * the feature switch and VAULT_OFFLINE are checked where they really are.
 */
function realClientWithFakeFetch(handlers = {}) {
  const calls = [];
  const fetch = async (url, opts) => {
    if (opts.body && typeof opts.body !== 'string') { for await (const chunk of opts.body) void chunk; }
    const call = {
      method: opts.method, url, purpose: opts.purpose,
      auth: new Headers(opts.headers).get('authorization'),
      body: typeof opts.body === 'string' ? JSON.parse(opts.body) : null,
    };
    calls.push(call);
    const fn = handlers[`${opts.method} ${url}`];
    const out = fn ? fn(call) : { status: 'error-notFound', data: {} };
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new GofileClient({ fetch });   // the real switch and the real offline setting
  service._setForTest({ client, sleep: () => immediate() });
  return { client, calls };
}

const OK = { status: 'ok', data: {} };

test('feature off, real client: the upload job sends no later part and sets no timer once the switch is off', async () => {
  for (const r of store.listShares()) store.deleteShare(r.id);
  on({ accountMode: 'perShare', onPartFail: 'retry3' });
  let first = true;
  const f = realClientWithFakeFetch({
    'POST https://api.gofile.io/accounts': () => ({ status: 'ok', data: { token: `${TOKEN}-real` } }),
    'POST https://upload.gofile.io/uploadfile': () => {
      // The switch goes off while the first part is on its way (settings saved
      // directly, so the job is not paused for us: the client must refuse).
      if (first) { first = false; on({ enabled: false }); }
      return { status: 'ok', data: { id: 'file-1', parentFolder: 'fo-job', parentFolderCode: 'Cj1', downloadPage: 'https://gofile.io/d/Cj1' } };
    },
  });
  const s = makeChecked({ parts: 3 });
  service.confirmUpload(s.id, { confirm: true });
  await waitFor(() => statusOf(s.id) === 'paused', 'paused');
  await service._idle();
  assert.deepStrictEqual(f.calls.map(x => `${x.method} ${x.url}`), [
    'POST https://api.gofile.io/accounts', 'POST https://upload.gofile.io/uploadfile',
  ]);
  assert.match(store.getShare(s.id).last_error, /turned off/);

  // A one-part share whose upload finishes as the switch goes off: no timer.
  on({ accountMode: 'perShare' });
  first = true;
  const one = makeChecked({ parts: 1 });
  service.confirmUpload(one.id, { confirm: true });
  await waitFor(() => statusOf(one.id) === 'uploaded', 'uploaded');
  await service._idle();
  assert.ok(!f.calls.some(x => x.method === 'PUT'), 'no timer request');
  assert.strictEqual(store.getShare(one.id).timer_set, 0);
});

test('feature off, real client: delete, delete all and stop-and-delete send exactly their DELETEs; nothing else is sent', async () => {
  for (const r of store.listShares()) store.deleteShare(r.id);
  on({ onPartFail: 'ask' });
  const f = realClientWithFakeFetch({ 'DELETE https://api.gofile.io/contents': () => OK });
  const accA = store.insertAccount(`${TOKEN}-acc-a`, 'old-session');
  const accB = store.insertAccount(`${TOKEN}-acc-b`, 'old-session');

  // Uploaded, timer not set: Delete and Set timer again.
  const up = makeChecked();
  store.updateShare(up.id, { status: 'uploaded', folder_id: 'fo-up', account_id: accA, link: 'https://gofile.io/d/U1',
    delete_after: Date.now() + 86400000, timer_set: 0 });
  // Paused with a failed part, parts on disk: Resume, Try again, Stop and delete.
  const paused = makeChecked({ parts: 2 });
  store.updateShare(paused.id, { status: 'paused', folder_id: 'fo-paused', account_id: accB });
  store.updatePart(paused.id, 1, { status: 'done' });
  store.updatePart(paused.id, 2, { status: 'failed', tries: 1 });
  // Two more uploaded, one marked gone, for Delete all.
  const all1 = makeChecked();
  store.updateShare(all1.id, { status: 'uploaded', folder_id: 'fo-all-1', account_id: accA, link: 'https://gofile.io/d/A1' });
  const all2 = makeChecked();
  store.updateShare(all2.id, { status: 'not_finished', folder_id: 'fo-all-2', account_id: accB });
  const gone = makeChecked();
  store.updateShare(gone.id, { status: 'gone', folder_id: 'fo-gone', account_id: accA });
  // Checked, never sent: Upload.
  const fresh = makeChecked();

  on({ enabled: false, onPartFail: 'ask' });

  // (b) Everything that would upload, make an account or set a timer: FEATURE_OFF, zero requests.
  await assert.rejects(() => service.confirmUpload(fresh.id, { confirm: true }), { code: 'FEATURE_OFF' });
  await assert.rejects(() => service.resume(paused.id), { code: 'FEATURE_OFF' });
  await assert.rejects(() => service.retryPart(paused.id, 2), { code: 'FEATURE_OFF' });
  await assert.rejects(service.retryTimer(up.id), { code: 'FEATURE_OFF' });
  assert.throws(() => service.start({ mediaIds: [1] }), { code: 'FEATURE_OFF' });
  await assert.rejects(f.client.createAccount(), { code: 'FEATURE_OFF' });
  assert.strictEqual(f.calls.length, 0);
  assert.strictEqual(statusOf(fresh.id), 'checked');
  assert.strictEqual(statusOf(paused.id), 'paused');

  // (a) Delete one: one DELETE of its stored folder with its stored token.
  const d = await service.deleteRemote(up.id);
  assert.strictEqual(d.status, 'deleted');
  assert.deepStrictEqual(f.calls, [{ method: 'DELETE', url: 'https://api.gofile.io/contents', purpose: 'share',
    auth: `Bearer ${TOKEN}-acc-a`, body: { contentsId: 'fo-up' } }]);

  // Stop and delete: one DELETE, then cancelled and the local parts gone.
  f.calls.length = 0;
  const st = await service.stop(paused.id, { confirm: true });
  assert.strictEqual(st.status, 'cancelled');
  assert.deepStrictEqual(f.calls, [{ method: 'DELETE', url: 'https://api.gofile.io/contents', purpose: 'share',
    auth: `Bearer ${TOKEN}-acc-b`, body: { contentsId: 'fo-paused' } }]);
  assert.ok(!fs.existsSync(paused.wd.dir));

  // Delete all: one DELETE per share that may be online; the gone one is left alone.
  f.calls.length = 0;
  const r = await service.deleteAll({ confirm: true });
  assert.strictEqual(r.deleted, 2);
  assert.strictEqual(r.failed, 0);
  assert.deepStrictEqual(f.calls.map(x => [x.method, x.url, x.auth, x.body.contentsId]).sort(), [
    ['DELETE', 'https://api.gofile.io/contents', `Bearer ${TOKEN}-acc-a`, 'fo-all-1'],
    ['DELETE', 'https://api.gofile.io/contents', `Bearer ${TOKEN}-acc-b`, 'fo-all-2'],
  ]);
  assert.strictEqual(statusOf(gone.id), 'gone');
  assert.ok(!JSON.stringify(r).includes(TOKEN));
  assert.ok(f.calls.every(x => x.method === 'DELETE'), 'nothing but deletes');
  on();
});

test('feature off and VAULT_OFFLINE, real client: delete, delete all and stop-and-delete make zero requests', async () => {
  for (const r of store.listShares()) store.deleteShare(r.id);
  const f = realClientWithFakeFetch({ 'DELETE https://api.gofile.io/contents': () => OK });
  const acc = store.insertAccount(`${TOKEN}-acc-off`, 'old-session');
  const up = makeChecked();
  store.updateShare(up.id, { status: 'uploaded', folder_id: 'fo-o1', account_id: acc, link: 'https://gofile.io/d/O1' });
  const paused = makeChecked({ parts: 2 });
  store.updateShare(paused.id, { status: 'paused', folder_id: 'fo-o2', account_id: acc });
  on({ enabled: false });
  config.net.offline = true;
  try {
    await assert.rejects(service.deleteRemote(up.id), { code: 'NET_OFF' });
    await assert.rejects(service.deleteAll({ confirm: true }), { code: 'NET_OFF' });
    await assert.rejects(service.stop(paused.id, { confirm: true }), { code: 'NET_OFF', message: /so nothing can be deleted from gofile\.$/ });
    await assert.rejects(f.client.deleteContent({ token: `${TOKEN}-acc-off`, folderId: 'fo-o1' }), { code: 'NET_OFF', message: /deleted from gofile/ });
  } finally {
    config.net.offline = false;
    on();
  }
  assert.strictEqual(f.calls.length, 0);
  assert.strictEqual(statusOf(up.id), 'uploaded');
  assert.strictEqual(statusOf(paused.id), 'failed');   // stopped; Delete in My shares can try again
  const err = service.getShare(paused.id).error;
  assert.match(err, /^Stopped\. Vault is set to stay offline \(VAULT_OFFLINE=1\), so the uploaded parts could not be deleted from gofile yet\./);
  assert.ok(!/uploaded\.$|nothing can be uploaded/.test(err), err);
});

test('a split share is listed under its archive name without the part number', () => {
  on();
  const split = makeChecked({ parts: 3 });
  const one = makeChecked({ parts: 1 });
  const a = service.listShares().find(x => x.id === split.id);
  assert.strictEqual(a.archiveFileName, `${split.name}.7z.001`, 'the first part on disk');
  assert.strictEqual(a.archiveDisplayName, `${split.name}.7z`);
  const b = service.getShare(one.id);
  assert.strictEqual(b.archiveFileName, `${one.name}.7z`);
  assert.strictEqual(b.archiveDisplayName, `${one.name}.7z`);
});

test('my shares: timer ran out is worked out from the clock; mark gone; remove asks first while it may be online', async () => {
  useClient(fakeClient());
  on();
  const s = makeChecked();
  store.updateShare(s.id, { status: 'uploaded', folder_id: 'f1', delete_after: Date.now() - 1000, link: 'https://gofile.io/d/X' });
  assert.strictEqual(service.listShares().find(x => x.id === s.id).status, 'expired');
  const t = makeChecked();
  store.updateShare(t.id, { status: 'uploaded', folder_id: 'f2', delete_after: Date.now() + 100000, link: 'https://gofile.io/d/Y' });
  await assert.rejects(service.remove(t.id, {}), { code: 'STILL_ONLINE' });
  assert.strictEqual((await service.markGone(t.id)).status, 'gone');
  assert.deepStrictEqual(await service.remove(t.id, {}), { removed: true });
  assert.strictEqual(store.getShare(t.id), null);
  assert.deepStrictEqual(await service.remove(s.id, {}), { removed: true });
});

test('restart throws away shares that never reached the upload, with their files', async () => {
  const s = makeChecked();
  service._simulateRestart();
  service.ensureRecovered();
  // Hidden at once ('removing'), gone once the clean-up has deleted its folder.
  assert.throws(() => service.getShare(s.id), { code: 'NOT_FOUND' });
  await service._idle();
  assert.strictEqual(store.getShare(s.id), null);
  assert.ok(!fs.existsSync(s.wd.dir), 'its folder was deleted');
});

test('settings: custom part size 50 MB to 16 GB, a bad value keeps the last good one', () => {
  on({ split: 'custom', customPartBytes: 100 * settings.MB });
  assert.throws(() => settings.validatePatch({ customPartBytes: 10 * settings.MB }), { code: 'BAD_PART_SIZE' });
  assert.throws(() => settings.validatePatch({ customPartBytes: 17 * settings.GB }), { code: 'BAD_PART_SIZE' });
  assert.throws(() => settings.validatePatch({ split: '3g' }), { code: 'BAD_INPUT' });
  assert.throws(() => settings.validatePatch({ enabled: 'yes' }), { code: 'BAD_INPUT' });
  assert.throws(() => settings.validatePatch({ somethingElse: 1 }), { code: 'BAD_INPUT' });
  assert.strictEqual(settings.get().customPartBytes, 100 * settings.MB);
  assert.strictEqual(settings.partBytes(), 100 * settings.MB);
  on({ split: 'none' });
  assert.strictEqual(settings.partBytes(), null);
  // Reset keeps the on/off switch.
  const r = settings.reset();
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.split, '2g');
});

test('settings: When packing is done is wait (the default) or upload; anything else is refused; reset puts back wait', () => {
  on();
  assert.strictEqual(settings.get().afterPack, 'wait');
  assert.deepStrictEqual(settings.validatePatch({ afterPack: 'upload' }), { afterPack: 'upload' });
  assert.deepStrictEqual(settings.validatePatch({ afterPack: 'wait' }), { afterPack: 'wait' });
  for (const v of ['auto', 'Upload', true, 1, null]) {
    assert.throws(() => settings.validatePatch({ afterPack: v }), { code: 'BAD_INPUT' }, String(v));
  }
  settings.save({ afterPack: 'upload' });
  assert.strictEqual(settings.get().afterPack, 'upload');
  // A hand-edited file can only give an allowed value.
  require('../lib/app-settings').set({ share: { ...settings.get(), afterPack: 'sometimes' } });
  assert.strictEqual(settings.get().afterPack, 'wait');
  settings.save({ afterPack: 'upload' });
  assert.strictEqual(settings.reset().afterPack, 'wait');
  on();
});

test('settings: an old file with Archive name (nameMode) loads, the key is ignored and dropped on the next save', () => {
  on();
  const appSettings = require('../lib/app-settings');
  for (const v of ['typed', 'random']) {
    appSettings.set({ share: { ...settings.get(), afterPack: 'upload', nameMode: v } });
    const s = settings.get();
    assert.ok(!('nameMode' in s), v);
    assert.strictEqual(s.afterPack, 'upload', 'the other values still load');
    settings.save({ keepLocal: true });
    assert.ok(!('nameMode' in appSettings.all().share), 'dropped from the file');
  }
  assert.ok(!('nameMode' in settings.DEFAULTS));
  assert.throws(() => settings.validatePatch({ nameMode: 'random' }), { code: 'BAD_INPUT' });
  on();
});

test('settings: an old file with "Show the share button in the top bar" (topBarIcon) loads, the key is ignored and dropped on the next save', () => {
  on();
  const appSettings = require('../lib/app-settings');
  for (const v of [true, false]) {
    appSettings.set({ share: { ...settings.get(), afterPack: 'upload', topBarIcon: v } });
    const s = settings.get();
    assert.ok(!('topBarIcon' in s), String(v));
    assert.strictEqual(s.afterPack, 'upload', 'the other values still load');
    assert.ok(!('topBarIcon' in service.state().settings), 'not in the state answer');
    assert.strictEqual(service.state().topBar.show, true, 'a stale false does not hide anything');
    settings.save({ keepLocal: true });
    assert.ok(!('topBarIcon' in appSettings.all().share), 'dropped from the file');
  }
  assert.ok(!('topBarIcon' in settings.DEFAULTS));
  assert.throws(() => settings.validatePatch({ topBarIcon: true }), { code: 'BAD_INPUT' });
  on();
});

test('restart: a share still waiting to pack is thrown away like a packing one', async () => {
  const id = store.insertShare({
    archive_name: names.randomArchiveName(), password: null, password_kind: 'random', size: 10,
    part_count: 1, part_size: null, file_count: 1, status: 'queued', created_at: Date.now(),
    delete_after_days: 7, work_dir: null,
  });
  service._simulateRestart();
  service.ensureRecovered();
  assert.throws(() => service.getShare(id), { code: 'NOT_FOUND' });
  await service._idle();
  await service._cleanupNow();
  assert.strictEqual(store.getShare(id), null);
});

test('Upload on its own does not skip the no Vault password warning: the share needs it at start, and nothing is stored without it', () => {
  on({ afterPack: 'upload', rememberPasswords: true });
  const media = path.join(path.dirname(process.env.VAULT_DB), 'warn-clip.mp4');
  fs.writeFileSync(media, Buffer.alloc(100, 1));
  const mid = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'video')").run(media, 'warn-clip.mp4').lastInsertRowid);
  service._setForTest({ program: 'fake-7zip' });
  const kept = store.kvGet('plain_warning_shown');
  store.kvSet('plain_warning_shown', null);
  const before = store.listShares().length;
  try {
    assert.strictEqual(gate.required(), false, 'no Vault password in this test library');
    assert.throws(() => service.start({ mediaIds: [mid], confirmUpload: true }), { code: 'WARNING_NEEDED' });
    assert.strictEqual(store.listShares().length, before, 'no record');
  } finally {
    store.kvSet('plain_warning_shown', kept);
    service._setForTest({ program: null });
    db.get().prepare('DELETE FROM media WHERE id = ?').run(mid);
    on();
  }
});
