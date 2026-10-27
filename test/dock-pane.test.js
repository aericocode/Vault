/**
 * The preview pane's trimmed layout (player-lib/dock.js, notes.js) in a VM:
 * the meta line under the name, the length on the picture, the one action
 * row with icon-only Details / Flag / Copy path, the compact heart + stars,
 * and "File info and path" folded away with its state remembered.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'player-lib');
const plain = (x) => JSON.parse(JSON.stringify(x));

function makeStorage({ broken = false } = {}) {
  const m = new Map();
  return {
    getItem: (k) => { if (broken) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (broken) throw new Error('blocked'); m.set(k, String(v)); },
    removeItem: (k) => { if (broken) throw new Error('blocked'); m.delete(k); },
    _m: m,
  };
}

function load(opts = {}) {
  const ctx = {
    console, Math, Number, String, Array, Object, JSON, Map, Set, Promise, Date,
    window: { innerWidth: 1600, addEventListener() {} },
    // 'loading': dock.js waits for DOMContentLoaded, which never comes here.
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelector: () => null },
    localStorage: makeStorage(opts),
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    formatFileSize: (b) => `${Math.round(b / 1048576)} MB`,
    formatDuration: (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`,
    vaultTypeIcon: (t) => `[${t}]`,
    vaultIconSwap: (e, n) => `<span class="vi-c">${e}</span><svg class="vi vi-${n}"></svg>`,
    vaultIcon: (n) => `<svg class="vi vi-${n}"></svg>`,
    thumbImgAttrs: () => 'src="x"',
    UpNext: {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(LIB, 'notes.js'), 'utf8'), ctx);
  vm.runInContext(`${fs.readFileSync(path.join(LIB, 'dock.js'), 'utf8')}\nglobalThis.__d = { dockMetaParts, dockPartsHtml, dockInfoToggled, dockInfoOpen, renderStarRatingSection };`, ctx);
  return { ...ctx.__d, storage: ctx.localStorage };
}

const FILE = {
  id: 7, filename: 'Night Drive.mp4', filepath: 'D:\\Media\\Night Drive.mp4', media_type: 'video',
  duration_seconds: 402, width: 1920, height: 1080, filesize_bytes: 412 * 1048576, view_count: 3,
  processed_at: '2026-10-20T10:00:00', user_rating: 0, user_starred: 0,
};

test('meta line: type, picture size, file size, views; only what the file has', () => {
  const D = load();
  assert.deepStrictEqual(plain(D.dockMetaParts(FILE)), ['Video', '1920×1080', '412 MB', '3 views']);
  assert.deepStrictEqual(plain(D.dockMetaParts({ ...FILE, view_count: 1 })).at(-1), '1 view');
  assert.deepStrictEqual(plain(D.dockMetaParts({ media_type: 'audio', view_count: 0 })), ['Audio'], 'no size, no views: left out');
  assert.deepStrictEqual(plain(D.dockMetaParts({ ...FILE, view_count: 1234 })).at(-1), (1234).toLocaleString() + ' views');
  assert.deepStrictEqual(plain(D.dockMetaParts({})), []);
  assert.deepStrictEqual(plain(D.dockMetaParts(null)), []);
});

test('parts: meta right under the name, info last, no loose facts or path', () => {
  const D = load();
  const keys = D.dockPartsHtml(FILE).map(([k]) => k);
  assert.strictEqual(keys[keys.indexOf('name') + 1], 'meta');
  assert.deepStrictEqual(plain(keys.slice(0, 5)), ['thumb', 'name', 'meta', 'actions', 'rating']);
  assert.strictEqual(keys.at(-1), 'info');
  assert.ok(!keys.includes('facts') && !keys.includes('path'));
  // Every part carries its own data-dock-part (dockPatchParts finds them by it).
  for (const [k, html] of D.dockPartsHtml(FILE)) assert.match(html, new RegExp(`data-dock-part="${k}"`), k);
});

test('the length sits on the picture, and only when there is one', () => {
  const D = load();
  const thumb = (m) => D.dockPartsHtml(m).find(([k]) => k === 'thumb')[1];
  assert.match(thumb(FILE), /<span class="tile-duration dock-len">6:42<\/span>/);
  assert.match(thumb(FILE), /ondblclick="dockPlayPick\(7\)"/, 'double click still plays');
  assert.doesNotMatch(thumb({ ...FILE, duration_seconds: 0 }), /dock-len/);
});

test('actions: Play, Play next, + Up next with labels, then icon buttons with names', () => {
  const D = load();
  const html = D.dockPartsHtml(FILE).find(([k]) => k === 'actions')[1];
  assert.match(html, /Play<\/button>/);
  assert.match(html, />Play next<\/button>/);
  assert.match(html, /title="Play this file after the one playing now/);
  assert.match(html, />\+ Up next<\/button>/);
  for (const [label, icon] of [['Details', 'info'], ['Flag this file', 'flag'], ['Copy path', 'copy']]) {
    const re = new RegExp(`<button class="dock-btn dock-btn-icon[^"]*"[^>]*aria-label="${label}"[^>]*>[^<]*<span class="vi-c">[^<]*</span><svg class="vi vi-${icon}"></svg></button>`);
    assert.match(html, re, label);
  }
  assert.doesNotMatch(html, />Details<\/button>|Copy path<\/button>/, 'no words on the icon buttons');
  assert.match(D.dockPartsHtml({ ...FILE, user_flagged_delete: 1 }).find(([k]) => k === 'actions')[1], /dock-btn-icon is-on"[^>]*title="Unflag"/);
  // The path is escaped for the inline handler.
  assert.match(html, /copyPath\('D:\\\\Media\\\\Night Drive\.mp4'\)/);
});

test('rating: the pane gets the compact heart + stars, Details keeps the big button', () => {
  const D = load();
  const html = D.dockPartsHtml(FILE).find(([k]) => k === 'rating')[1];
  assert.match(html, /star-rating-compact/);
  assert.match(html, /title="Favorite" aria-label="Favorite" aria-pressed="false"/);
  assert.doesNotMatch(html, /star-label|Rating:/);
  assert.strictEqual((html.match(/class="rating-star /g) || []).length, 5, 'five stars, still clickable');
  const faved = D.renderStarRatingSection({ ...FILE, user_starred: 1, user_rating: 4 }, { compact: true });
  assert.match(faved, /class="star-btn starred"[^>]*title="Unfavorite"[^>]*aria-pressed="true"/);
  assert.match(faved, /4\/5/);
  const full = D.renderStarRatingSection(FILE);
  assert.doesNotMatch(full, /star-rating-compact/);
  assert.match(full, /<span class="star-label">Favorite<\/span>/);
  assert.match(full, /Rating:/);
});

test('File info and path: closed at first, remembered once toggled, every fact inside', () => {
  const D = load();
  const info = () => D.dockPartsHtml(FILE).find(([k]) => k === 'info')[1];
  assert.match(info(), /<details class="dock-info" data-dock-part="info" ontoggle=/);
  assert.match(info(), /<summary>File info and path<\/summary>/);
  for (const k of ['Type', 'Length', 'Size', 'File', 'Views', 'Added']) assert.match(info(), new RegExp(`<dt>${k}</dt>`), k);
  assert.match(info(), /<dd>2026-10-20<\/dd>/);
  assert.match(info(), /class="detail-path dock-path">D:\\Media\\Night Drive\.mp4</, 'the path keeps detail-path (privacy blur)');
  D.dockInfoToggled({ open: true });
  assert.strictEqual(D.dockInfoOpen(), true);
  assert.match(info(), /data-dock-part="info" open ontoggle=/);
  D.dockInfoToggled({ open: false });
  assert.strictEqual(D.dockInfoOpen(), false);
  assert.doesNotMatch(info(), / open /);
});

test('File info and path: storage that throws is closed, and toggling does not throw', () => {
  const D = load({ broken: true });
  assert.strictEqual(D.dockInfoOpen(), false);
  assert.doesNotThrow(() => D.dockInfoToggled({ open: true }));
  assert.doesNotMatch(D.dockPartsHtml(FILE).find(([k]) => k === 'info')[1], / open /);
});

test('File info and path: a toggle keeps the saved HTML in step, so a same-file update leaves it alone', () => {
  const D = load();
  const html = D.dockPartsHtml(FILE).find(([k]) => k === 'info')[1];
  const el = { open: true, _dockHtml: html };
  D.dockInfoToggled(el);
  assert.strictEqual(el._dockHtml, D.dockPartsHtml(FILE).find(([k]) => k === 'info')[1], 'opened: matches what a repaint would make');
  el.open = false;
  D.dockInfoToggled(el);
  assert.strictEqual(el._dockHtml, html, 'closed again: back to the closed HTML');
});
