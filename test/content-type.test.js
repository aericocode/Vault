/**
 * content_type from the AI: the scan keeps only the choices the prompt
 * offered (lib/content-type.js, applied in db.saveMedia), and the viewer
 * escapes every content_type and quality_flag it shows, so a value already in
 * a library (or typed by the owner) can never become markup.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-ctype-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const { normalizeContentType } = require('../lib/content-type');
const { CONTENT_TYPES, DOCUMENT_TYPES } = require('../config/prompts');
const db = require('../lib/database');

test.before(() => db.init());
test.after(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const XSS = '<img src=x onerror=alert(1)>';

test('normalizer: every choice the prompts offer is kept', () => {
  for (const t of [...CONTENT_TYPES, ...DOCUMENT_TYPES]) assert.strictEqual(normalizeContentType(t), t);
  // The processors' own fallbacks
  for (const t of ['audio', 'document', 'unknown']) assert.strictEqual(normalizeContentType(t), t);
});

test('normalizer: spelling is forgiven, anything else becomes other', () => {
  assert.strictEqual(normalizeContentType('Live Action'), 'live_action');
  assert.strictEqual(normalizeContentType(' live-action '), 'live_action');
  assert.strictEqual(normalizeContentType('ANIME'), 'anime');
  assert.strictEqual(normalizeContentType(XSS), 'other');
  assert.strictEqual(normalizeContentType('a cooking video filmed in a kitchen'), 'other');
  assert.strictEqual(normalizeContentType('anime<script>'), 'other');
  assert.strictEqual(normalizeContentType(['anime']), 'other');
  assert.strictEqual(normalizeContentType({ toString: () => 'anime' }), 'other');
  assert.strictEqual(normalizeContentType(42), 'other');
});

test('normalizer: no answer is unknown, as before', () => {
  assert.strictEqual(normalizeContentType(undefined), 'unknown');
  assert.strictEqual(normalizeContentType(null), 'unknown');
  assert.strictEqual(normalizeContentType(''), 'unknown');
  assert.strictEqual(normalizeContentType('   '), 'unknown');
});

test('saveMedia stores the checked value, not the model\'s', () => {
  const save = (name, contentType) => {
    const filepath = path.join(tmp, name);
    db.saveMedia({ filepath, filename: name, mediaType: 'image', contentType, framesAnalyzed: 0 });
    return db.getByPath(filepath).content_type;
  };
  assert.strictEqual(save('a.jpg', XSS), 'other');
  assert.strictEqual(save('b.jpg', 'Photo'), 'photo');
  assert.strictEqual(save('c.jpg', undefined), 'unknown');
  assert.strictEqual(save('d.txt', 'spreadsheet'), 'spreadsheet');
});

/* ── The viewer ─────────────────────────────────────────────────────────── */

function loadCards() {
  const noop = () => {};
  const ctx = {
    console,
    document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}) },
    addEventListener: noop,
    localStorage: { getItem: () => null, setItem: noop },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'cards.js'), 'utf8'), ctx);
  // The helpers cards.js borrows from utils.js / icons.js, as plain functions
  Object.assign(ctx, {
    escapeHtml: (x) => (!x ? '' : String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')),
    safeParseJSON: (s, fb) => { try { return JSON.parse(s) ?? fb; } catch { return fb; } },
    vaultIconSwap: (e) => e,
    vaultEmojiLabel: (x) => x,
    formatFileSize: () => '1 MB',
    tileDurationText: () => '1:00',
    formatDuration: () => '1:00',
    truncatePath: (p) => p,
    errorTooltip: (e) => e,
  });
  return ctx;
}

test('tile popover and the old card escape content_type and quality_flag', () => {
  const ctx = loadCards();
  ctx.m = {
    id: 1, filename: 'a.mp4', filepath: 'C:\\media\\a.mp4', media_type: 'video', filesize_bytes: 10,
    content_type: XSS, quality_flag: '<b onmouseover=alert(2)>hd</b>', tags: '[]', themes: '[]',
  };
  for (const fn of ['buildPopoverHtml', 'renderCard']) {
    const html = vm.runInContext(`${fn}(m)`, ctx);
    assert.ok(!html.includes('<img'), `${fn}: content_type is text`);
    assert.ok(!html.includes('<b '), `${fn}: quality_flag is text`);
    assert.ok(html.includes('&lt;b onmouseover=alert(2)&gt;hd&lt;/b&gt;'), `${fn}: quality_flag still shown`);
  }
  assert.ok(vm.runInContext('buildPopoverHtml(m)', ctx).includes('&lt;img src=x onerror=alert(1)&gt;'));
});
