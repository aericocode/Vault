/**
 * The scan model (lib/scan-model.js): the rules that decide whether Vault
 * loads it (room / no room / no nvidia-smi / Always / Wait), the estimate of
 * what a model needs, the nvidia-smi reading, the "only scan watched folders
 * when the GPU is free" rule, and the idle unload that only ever touches
 * copies Vault loaded itself. LM Studio and the graphics driver are stood in
 * for with injected functions: nothing here loads a real model or fills VRAM.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-scanmodel-'));
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');

const sm = require('../lib/scan-model');

const GB = 1024 ** 3;
const DISK = [
  { modelKey: 'pub/vision-small', displayName: 'Vision small', sizeBytes: 2 * GB, type: 'llm', vision: true },
  { modelKey: 'big-text-27b', displayName: 'Big text', sizeBytes: 16 * GB, type: 'llm', vision: false },
  { modelKey: 'no-size', displayName: 'No size', sizeBytes: null, type: 'llm', vision: true },
];

/** A fake outside world; `calls` records what Vault asked for. */
function world({ gpu = { freeBytes: 20 * GB, totalBytes: 24 * GB, gpus: 1 }, canLoad = { ok: true }, loadResult = { ok: true }, ps = [], busy = false, locked = false, families = [] } = {}) {
  const calls = { load: [], unload: [], refresh: 0 };
  let now = 1_000_000;
  const w = {
    calls,
    advance(ms) { now += ms; },
    deps: {
      listModels: async () => DISK,
      readGpu: async () => gpu,
      load: async (o) => { calls.load.push(o); return loadResult; },
      unload: async (id) => { calls.unload.push(id); return { ok: true }; },
      psRows: async () => ps,
      refresh: async () => { calls.refresh++; },
      loadedFamilies: () => families,
      canLoad: () => canLoad,
      isLocked: () => locked,
      isBusy: () => busy,
      now: () => now,
    },
  };
  return w;
}

function setup(opts, settings = {}) {
  const w = world(opts);
  sm._setDeps(w.deps);
  sm._reset();
  sm.setSettings({ scanModel: 'pub/vision-small', ...settings });
  return w;
}

const settle = () => new Promise(r => setImmediate(r));

test.after(() => { sm.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

/* ── Pure rules ────────────────────────────────────────────────────────── */

test('need: the file size plus a fifth for context, never less than 1 GB extra', () => {
  assert.strictEqual(sm.estimateNeedBytes(2 * GB), 3 * GB, 'a small model gets the 1 GB floor');
  assert.strictEqual(sm.estimateNeedBytes(10 * GB), 12 * GB, 'a big one gets a fifth');
  assert.strictEqual(sm.estimateNeedBytes(null), null);
  assert.strictEqual(sm.estimateNeedBytes(0), null);
});

test('load decision: room / no room / no nvidia-smi / Always / Wait', () => {
  const need = 6 * GB;
  assert.deepStrictEqual(sm.decideLoad({ policy: 'room', needBytes: need, gpu: { freeBytes: 8 * GB } }), { load: true, code: 'room' });
  assert.deepStrictEqual(sm.decideLoad({ policy: 'room', needBytes: need, gpu: { freeBytes: 2 * GB } }), { load: false, code: 'no-room' });
  assert.deepStrictEqual(sm.decideLoad({ policy: 'room', needBytes: need, gpu: null }), { load: false, code: 'no-gpu-info' },
    'no NVIDIA tool: "if there is room" behaves like Wait');
  assert.deepStrictEqual(sm.decideLoad({ policy: 'room', needBytes: null, gpu: { freeBytes: 8 * GB } }), { load: false, code: 'unknown-size' });
  assert.deepStrictEqual(sm.decideLoad({ policy: 'always', needBytes: need, gpu: null }), { load: true, code: 'always' },
    'Always loads with no reading at all');
  assert.deepStrictEqual(sm.decideLoad({ policy: 'always', needBytes: need, gpu: { freeBytes: 0 } }), { load: true, code: 'always' });
  assert.deepStrictEqual(sm.decideLoad({ policy: 'wait', needBytes: need, gpu: { freeBytes: 99 * GB } }), { load: false, code: 'policy-wait' },
    'Wait never loads, whatever the room');
});

test('nvidia-smi: one line per GPU in MiB, summed; junk is no reading', () => {
  const r = sm.parseNvidiaSmi('3507, 16376\r\n9524, 24576\r\n15713, 16311\r\n');
  assert.strictEqual(r.gpus, 3);
  assert.strictEqual(r.freeBytes, (3507 + 9524 + 15713) * 1024 * 1024);
  assert.strictEqual(r.totalBytes, (16376 + 24576 + 16311) * 1024 * 1024);
  assert.strictEqual(sm.parseNvidiaSmi(''), null);
  assert.strictEqual(sm.parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate'), null);
});

test('GPU-free rule: only watched-folder files, only while another model is loaded', () => {
  const on = { enabled: true, scanFamily: 'vis' };
  assert.strictEqual(sm.gpuFreeBlocks({ ...on, source: 'watch', loadedFamilies: ['vis', 'big-text'] }), true);
  assert.strictEqual(sm.gpuFreeBlocks({ ...on, source: 'watch', loadedFamilies: ['vis'] }), false, 'only the scan model loaded');
  assert.strictEqual(sm.gpuFreeBlocks({ ...on, source: 'watch', loadedFamilies: [] }), false, 'nothing loaded');
  assert.strictEqual(sm.gpuFreeBlocks({ ...on, source: 'import', loadedFamilies: ['vis', 'big-text'] }), false,
    'files the user added are never held');
  assert.strictEqual(sm.gpuFreeBlocks({ ...on, source: 'retry', loadedFamilies: ['big-text'] }), false);
  assert.strictEqual(sm.gpuFreeBlocks({ enabled: false, scanFamily: 'vis', source: 'watch', loadedFamilies: ['big-text'] }), false, 'off by default');
});

/* ── Settings ──────────────────────────────────────────────────────────── */

test('settings: defaults, saved to the prefs file, bad values refused', () => {
  setup({});
  sm._reset();
  assert.deepStrictEqual(sm.settings(), { scanModel: '', whenNotLoaded: 'room', gpuFreeForWatch: false, unloadIdleMin: 10 });
  assert.strictEqual(sm.chosenModel(), null, 'automatic by default');
  assert.ok(sm.setSettings({ whenNotLoaded: 'sometimes' }).error);
  assert.ok(sm.setSettings({ unloadIdleMin: 7 }).error);
  assert.ok(sm.setSettings({ gpuFreeForWatch: 'yes' }).error);
  const ok = sm.setSettings({ scanModel: ' pub/vision-small ', whenNotLoaded: 'wait', unloadIdleMin: 30 });
  assert.strictEqual(ok.settings.scanModel, 'pub/vision-small');
  const saved = JSON.parse(fs.readFileSync(process.env.VAULT_SETTINGS_FILE, 'utf8')).scanSettings;
  assert.strictEqual(saved.whenNotLoaded, 'wait');
  assert.strictEqual(saved.unloadIdleMin, 30);
});

/* ── Deciding to load, with LM Studio and the driver stood in for ──────── */

test('room: Vault loads the scan model under its own key, and remembers it loaded it', async () => {
  const w = setup({ gpu: { freeBytes: 10 * GB } });
  const r = await sm.maybeLoad();
  assert.strictEqual(r.code, 'loading');
  assert.match(r.reason, /Loading vision-small in LM Studio/);
  await settle(); await settle();
  assert.deepStrictEqual(w.calls.load, [{ modelKey: 'pub/vision-small', identifier: 'pub/vision-small' }]);
  assert.deepStrictEqual(sm.status().vaultLoaded, ['pub/vision-small']);
  assert.strictEqual(w.calls.refresh, 1, 'the registry looks again once it is loaded');
});

test('no room: waits with the numbers and the model in the way, loads nothing', async () => {
  const w = setup({ gpu: { freeBytes: 2.1 * GB }, families: ['big-text-27b'] });
  const r = await sm.maybeLoad();
  assert.strictEqual(r.code, 'no-room');
  assert.match(r.reason, /needs about 3\.0 GB, 2\.1 GB free/);
  assert.match(r.reason, /while big-text-27b is loaded/);
  assert.ok(!/[–—]/.test(r.reason), 'no dashes');
  assert.strictEqual(w.calls.load.length, 0);
});

test('no nvidia-smi: "if there is room" waits; Always and Load anyway still load', async () => {
  let w = setup({ gpu: null });
  assert.strictEqual((await sm.maybeLoad()).code, 'no-gpu-info');
  assert.strictEqual(w.calls.load.length, 0);

  w = setup({ gpu: null }, { whenNotLoaded: 'always' });
  assert.strictEqual((await sm.maybeLoad()).code, 'loading');
  await settle();
  assert.strictEqual(w.calls.load.length, 1);

  w = setup({ gpu: null });
  assert.strictEqual((await sm.maybeLoad({ force: true })).code, 'loading', 'Load anyway ignores the room check');
  await settle();
  assert.strictEqual(w.calls.load.length, 1);
});

test('Wait until I load it: never loads', async () => {
  const w = setup({ gpu: { freeBytes: 99 * GB } }, { whenNotLoaded: 'wait' });
  const r = await sm.maybeLoad();
  assert.strictEqual(r.code, 'policy-wait');
  assert.match(r.reason, /Files start when you load it/);
  assert.strictEqual(w.calls.load.length, 0);
});

test('nothing to load: no scan model chosen, not on disk, or no way to load here', async () => {
  let w = setup({});
  sm.setSettings({ scanModel: '' });
  assert.strictEqual((await sm.maybeLoad()).code, 'no-model');

  w = setup({}, { scanModel: 'gone/model' });
  assert.strictEqual((await sm.maybeLoad()).code, 'not-on-disk');

  w = setup({ canLoad: { ok: false, reason: 'the AI server is not LM Studio on this PC' } });
  const r = await sm.maybeLoad();
  assert.strictEqual(r.code, 'cannot-load');
  assert.match(r.reason, /not LM Studio on this PC/);
  assert.strictEqual(w.calls.load.length, 0);

  w = setup({ locked: true });
  assert.strictEqual((await sm.maybeLoad({ force: true })).code, 'locked', 'nothing loads while locked');
  assert.strictEqual(w.calls.load.length, 0);
});

test('a model LM Studio lists as text only is never loaded for scans', async () => {
  const w = setup({}, { scanModel: 'big-text-27b', whenNotLoaded: 'always' });
  const r = await sm.maybeLoad({ force: true });
  assert.strictEqual(r.code, 'not-vision');
  assert.match(r.reason, /big-text-27b cannot read pictures/);
  assert.strictEqual(w.calls.load.length, 0);
});

test('a failed load is not retried on its own for a while; Load anyway still tries', async () => {
  const w = setup({ loadResult: { ok: false, error: 'out of memory' } });
  await sm.maybeLoad();
  await settle(); await settle();
  assert.strictEqual(w.calls.load.length, 1);
  const again = await sm.maybeLoad();
  assert.strictEqual(again.code, 'load-failed');
  assert.match(again.reason, /out of memory/);
  assert.strictEqual(w.calls.load.length, 1, 'no second attempt yet');
  w.advance(11 * 60_000);
  assert.strictEqual((await sm.maybeLoad()).code, 'loading', 'tried again after the back-off');
  await settle();
  assert.strictEqual((await sm.maybeLoad({ force: true })).code, 'loading');
  assert.strictEqual(sm.status().vaultLoaded.length, 0, 'a failed load is never remembered as Vault-loaded');
});

test('a copy listed although lms load failed is used, but Vault never unloads it', async () => {
  const w = setup({ loadResult: { ok: false, listed: true, error: 'timed out' } });
  await sm.maybeLoad();
  await settle(); await settle();
  assert.strictEqual(w.calls.load.length, 1);
  assert.deepStrictEqual(sm.status().vaultLoaded, [], 'it may be the copy of the user');
  assert.strictEqual(sm.status().lastLoad.ok, true, 'but it is there, so files can start');
});

test('one load at a time', async () => {
  let release;
  const w = setup({});
  sm._setDeps({ load: (o) => { w.calls.load.push(o); return new Promise(r => { release = r; }); } });
  assert.strictEqual((await sm.maybeLoad()).code, 'loading');
  assert.strictEqual((await sm.maybeLoad({ force: true })).code, 'loading');
  assert.strictEqual(w.calls.load.length, 1);
  release({ ok: true });
  await settle(); await settle();
});

/* ── Idle unload: only copies Vault loaded itself ──────────────────────── */

test('idle unload: after N minutes idle, only Vault-loaded copies, never the user\'s', async () => {
  const w = setup({ ps: [{ identifier: 'pub/vision-small' }, { identifier: 'users-own-model' }] }, { unloadIdleMin: 10 });
  sm._markVaultLoaded('pub/vision-small');
  sm._setLastBusy(w.deps.now());

  w.advance(9 * 60_000);
  assert.deepStrictEqual(await sm.unloadIfIdle(), [], 'not idle long enough');
  w.advance(2 * 60_000);
  assert.deepStrictEqual(await sm.unloadIfIdle(), ['pub/vision-small']);
  assert.deepStrictEqual(w.calls.unload, ['pub/vision-small'], 'the user\'s own model is never touched');
  assert.deepStrictEqual(sm.status().vaultLoaded, []);
});

test('idle unload: nothing while scanning, while locked, when set to Never, or with nothing Vault loaded', async () => {
  let w = setup({ ps: [{ identifier: 'pub/vision-small' }], busy: true }, { unloadIdleMin: 5 });
  sm._markVaultLoaded('pub/vision-small');
  w.advance(60 * 60_000);
  assert.deepStrictEqual(await sm.unloadIfIdle(), [], 'busy resets the idle clock');

  w = setup({ ps: [{ identifier: 'pub/vision-small' }], locked: true }, { unloadIdleMin: 5 });
  sm._markVaultLoaded('pub/vision-small');
  w.advance(60 * 60_000);
  assert.deepStrictEqual(await sm.unloadIfIdle(), []);

  w = setup({ ps: [{ identifier: 'pub/vision-small' }] }, { unloadIdleMin: 0 });
  sm._markVaultLoaded('pub/vision-small');
  w.advance(60 * 60_000);
  assert.deepStrictEqual(await sm.unloadIfIdle(), [], 'Never');

  w = setup({ ps: [{ identifier: 'users-own-model' }] }, { unloadIdleMin: 5 });
  w.advance(60 * 60_000);
  assert.deepStrictEqual(await sm.unloadIfIdle(), []);
  assert.deepStrictEqual(w.calls.unload, []);
});

test('idle unload: a copy the user already unloaded is just forgotten', async () => {
  const w = setup({ ps: [] }, { unloadIdleMin: 5 });
  sm._markVaultLoaded('pub/vision-small');
  w.advance(60 * 60_000);
  assert.deepStrictEqual(await sm.unloadIfIdle(), []);
  assert.deepStrictEqual(w.calls.unload, [], 'no unload of something that is not loaded');
  assert.deepStrictEqual(sm.status().vaultLoaded, []);
});

test('wait reasons are plain sentences with no dashes', () => {
  for (const code of ['no-model', 'policy-wait', 'no-room', 'no-gpu-info', 'unknown-size', 'loading', 'load-failed',
    'not-on-disk', 'cannot-load', 'not-running', 'model-stopped', 'gpu-busy', 'not-vision']) {
    const w = sm.describeWait(code, { model: 'pub/m', needBytes: 6 * GB, freeBytes: GB, others: ['t'], error: 'x', why: 'y', detail: 'z' });
    assert.strictEqual(w.code, code);
    assert.ok(w.reason.length > 20, code);
    assert.ok(!/[–—]/.test(w.reason), `${code}: no dashes`);
    assert.ok(!/undefined|NaN/.test(w.reason), `${code}: ${w.reason}`);
  }
});
