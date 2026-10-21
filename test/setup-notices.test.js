/**
 * "Don't show again" for setup banner rows: the stored hidden list
 * (lib/setup-notices.js), the route that writes it (POST /api/setup/hidden),
 * and the banner's own row filter (player-lib/setup-check.js, run in a VM).
 *
 * The rule under test everywhere: only OPTIONAL tools can be hidden. A
 * required tool (ffmpeg) shows whenever it is missing, whatever is stored.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-setupnotices-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const notices = require('../lib/setup-notices');

const TOOLS = {
  ffmpeg: { ok: false, required: true, label: 'ffmpeg / ffprobe' },
  fpcalc: { ok: false, required: false, label: 'fpcalc (Chromaprint)' },
};

// ── Stored list validation ────────────────────────────────────────────────

test('sanitizeHidden keeps known optional tools only, once each', () => {
  assert.deepStrictEqual(notices.sanitizeHidden(['fpcalc', 'fpcalc'], TOOLS), ['fpcalc']);
  assert.deepStrictEqual(notices.sanitizeHidden(['ffmpeg', 'fpcalc'], TOOLS), ['fpcalc'],
    'a required tool in the file is ignored');
  assert.deepStrictEqual(notices.sanitizeHidden(['nope', 7, null, { a: 1 }, 'constructor', '__proto__'], TOOLS), []);
  for (const junk of [undefined, null, 'fpcalc', 42, { fpcalc: true }]) {
    assert.deepStrictEqual(notices.sanitizeHidden(junk, TOOLS), [], `junk: ${JSON.stringify(junk)}`);
  }
});

test('annotate marks hidden optional tools, never required ones, and copies', () => {
  const out = notices.annotate(TOOLS, ['fpcalc', 'ffmpeg']);
  assert.strictEqual(out.fpcalc.hidden, true);
  assert.strictEqual(out.ffmpeg.hidden, false, 'required is never hidden');
  assert.strictEqual(TOOLS.fpcalc.hidden, undefined, 'the cached input is not mutated');
  assert.strictEqual(notices.annotate(TOOLS, []).fpcalc.hidden, false);
});

test('applyChange validates the body and toggles one tool', () => {
  assert.strictEqual(notices.applyChange([], { tool: 'ffmpeg', hidden: true }, TOOLS).ok, false);
  assert.strictEqual(notices.applyChange([], { tool: 'nope', hidden: true }, TOOLS).ok, false);
  assert.strictEqual(notices.applyChange([], { tool: 'toString', hidden: true }, TOOLS).ok, false);
  assert.strictEqual(notices.applyChange([], { tool: 'fpcalc', hidden: 'yes' }, TOOLS).ok, false);
  assert.strictEqual(notices.applyChange([], null, TOOLS).ok, false);

  let r = notices.applyChange(undefined, { tool: 'fpcalc', hidden: true }, TOOLS);
  assert.deepStrictEqual(r, { ok: true, hidden: ['fpcalc'] });
  r = notices.applyChange(r.hidden, { tool: 'fpcalc', hidden: true }, TOOLS);
  assert.deepStrictEqual(r.hidden, ['fpcalc'], 'hiding twice stays one entry');
  r = notices.applyChange(r.hidden, { tool: 'fpcalc', hidden: false }, TOOLS);
  assert.deepStrictEqual(r.hidden, []);
});

// ── The banner's row filter (client) ──────────────────────────────────────

/** Load setup-check.js in a VM with a fake /api/setup-check answer. */
async function loadBanner(tools) {
  const inserted = [];
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Object, Array, String,
    sessionStorage: { getItem: () => null, setItem: () => {} },
    fetch: async (url) => {
      assert.strictEqual(url, '/api/setup-check');
      return { ok: true, status: 200, json: async () => tools };
    },
    escapeHtml: (s) => String(s),
    document: {
      readyState: 'complete',
      getElementById: () => null,
      createElement: () => ({ querySelectorAll: () => [], querySelector: () => null }),
      body: { firstChild: null, insertBefore: (el) => inserted.push(el) },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'setup-check.js'), 'utf8'), ctx);
  await new Promise(r => setTimeout(r, 10));   // run() is async
  return { api: ctx.vaultSetup, inserted };
}

test('banner: a hidden optional tool drops out; a required tool never does', async () => {
  const { api } = await loadBanner({});
  const rows = (tools) => api.bannerRows(tools).map(([k]) => k);

  assert.deepStrictEqual(rows({ ...TOOLS }), ['ffmpeg', 'fpcalc'], 'required first');
  assert.deepStrictEqual(rows({ ffmpeg: TOOLS.ffmpeg, fpcalc: { ...TOOLS.fpcalc, hidden: true } }), ['ffmpeg']);
  assert.deepStrictEqual(rows({ ffmpeg: { ...TOOLS.ffmpeg, hidden: true }, fpcalc: TOOLS.fpcalc }), ['ffmpeg', 'fpcalc'],
    'a required tool marked hidden still shows');
  assert.deepStrictEqual(rows({ ffmpeg: { ...TOOLS.ffmpeg, ok: true }, fpcalc: { ...TOOLS.fpcalc, hidden: true } }), []);
});

test('banner: nothing renders when the only missing tool is hidden', async () => {
  const hiddenOnly = await loadBanner({
    ffmpeg: { ...TOOLS.ffmpeg, ok: true },
    fpcalc: { ...TOOLS.fpcalc, hidden: true },
  });
  assert.strictEqual(hiddenOnly.inserted.length, 0);

  const visible = await loadBanner({ ffmpeg: { ...TOOLS.ffmpeg, ok: true }, fpcalc: { ...TOOLS.fpcalc, install: { url: 'u' } } });
  assert.strictEqual(visible.inserted.length, 1);
  assert.match(visible.inserted[0].innerHTML, /data-hide="fpcalc"/, 'optional row offers Don\'t show again');

  const required = await loadBanner({ ffmpeg: { ...TOOLS.ffmpeg, install: { url: 'u', winget: 'w' } } });
  assert.strictEqual(required.inserted.length, 1);
  assert.doesNotMatch(required.inserted[0].innerHTML, /data-hide=/, 'required row has no Don\'t show again');
});

// ── The route, against the real app ───────────────────────────────────────

test('POST /api/setup/hidden stores the list; GET /api/setup-check reflects it; locked = 423', async (t) => {
  const db = require('../lib/database');
  const vault = require('../lib/vault');
  const { app } = require('../server/index');
  db.init();
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    vault._locked = false;
    await new Promise((resolve) => server.close(resolve));
    db.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/setup/hidden`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  assert.strictEqual((await post({ tool: 'ffmpeg', hidden: true })).status, 400, 'required refused');
  assert.strictEqual((await post({ tool: 'nope', hidden: true })).status, 400);
  assert.strictEqual((await post({ tool: 'fpcalc', hidden: 1 })).status, 400);

  let r = await post({ tool: 'fpcalc', hidden: true });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await r.json()).hidden, ['fpcalc']);
  const stored = JSON.parse(fs.readFileSync(process.env.VAULT_SETTINGS_FILE, 'utf8'));
  assert.deepStrictEqual(stored.hiddenSetupNotices, ['fpcalc'], 'kept with the server settings');

  let check = await (await fetch(`${base}/api/setup-check`)).json();
  assert.strictEqual(check.fpcalc.hidden, true);
  assert.strictEqual(check.ffmpeg.hidden, false);
  assert.strictEqual(check.fpcalc.feature, 'Music ID');

  // A hand-edited file that tries to hide ffmpeg changes nothing.
  fs.writeFileSync(process.env.VAULT_SETTINGS_FILE, JSON.stringify({ hiddenSetupNotices: ['ffmpeg', 'fpcalc'] }));
  check = await (await fetch(`${base}/api/setup-check`)).json();
  assert.strictEqual(check.ffmpeg.hidden, false);

  vault.bootLocked();
  try {
    assert.strictEqual((await post({ tool: 'fpcalc', hidden: false })).status, 423);
    assert.strictEqual((await fetch(`${base}/api/setup-check`)).status, 423);
  } finally { vault._locked = false; }

  r = await post({ tool: 'fpcalc', hidden: false });
  assert.deepStrictEqual((await r.json()).hidden, []);
  check = await (await fetch(`${base}/api/setup-check`)).json();
  assert.strictEqual(check.fpcalc.hidden, false);
});
