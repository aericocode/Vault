/**
 * Play on Stage in the preview pane (player-lib/dock.js): a video can go
 * straight to Stage from the pane. The button is there only when Stage is
 * (StageControl loaded) and only for videos, the kind both Stages play; the
 * CSS hides it while anything plays (css/dock.css). A press opens Stage the
 * way the player's Stage button does (StageControl.openStage, which picks
 * mpv or Basic Stage) and then plays the pick there.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'player-lib');

function load({ stage = true } = {}) {
  const calls = [];
  const ctx = {
    console, Math, Number, String, Array, Object, JSON, Map, Set, Promise, Date,
    window: { innerWidth: 1600, addEventListener() {} },
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelector: () => null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    formatFileSize: (b) => `${b} B`,
    formatDuration: (s) => `${s}s`,
    vaultTypeIcon: (t) => `[${t}]`,
    vaultIconSwap: (e, n) => `<span class="vi-c">${e}</span><svg class="vi vi-${n}"></svg>`,
    vaultIcon: (n) => `<svg class="vi vi-${n}"></svg>`,
    thumbImgAttrs: () => 'src="x"',
    calls,
  };
  if (stage) ctx.StageControl = { openStage: (opts) => { calls.push(['openStage']); opts.then(); } };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(LIB, 'dock.js'), 'utf8')}
    // What Play does from the pane: recorded, not played.
    dockPlayPick = (id) => calls.push(['play', id]);
    globalThis.__d = { dockPartsHtml, dockPlayOnStage };`, ctx);
  return { ...ctx.__d, calls };
}

const VIDEO = { id: 7, filename: 'a.mp4', filepath: 'D:\\a.mp4', media_type: 'video', duration_seconds: 60 };
const part = (D, m, key) => D.dockPartsHtml(m).find(([k]) => k === key)[1];

test('a video in the pane has Play on Stage, on its picture (the row of buttons has no room)', () => {
  const D = load();
  const html = part(D, VIDEO, 'thumb');
  assert.ok(html.includes('class="dock-btn dock-stage-play" onclick="event.stopPropagation(); dockPlayOnStage(7)"'));
  assert.ok(html.includes('ondblclick="event.stopPropagation()"'), 'a double click on it does not play here');
  assert.ok(html.includes('<svg class="vi vi-stage"></svg>Play on Stage</button>'), 'Modern icon, Classic emoji');
  assert.doesNotMatch(part(D, VIDEO, 'actions'), /dock-stage-play/, 'not in the row of buttons');
  assert.ok(!html.includes('—'), 'no em dash');
});

test('no Play on Stage for a picture, a sound or a document, or with no Stage at all', () => {
  const D = load();
  for (const media_type of ['image', 'gif', 'audio', 'document', 'mix']) {
    assert.doesNotMatch(part(D, { ...VIDEO, media_type }, 'thumb'), /dock-stage-play/, media_type);
  }
  assert.doesNotMatch(part(load({ stage: false }), VIDEO, 'thumb'), /dock-stage-play/);
});

test('a press opens Stage, then plays the pick there', () => {
  const D = load();
  D.dockPlayOnStage(7);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(D.calls)), [['openStage'], ['play', 7]]);
});

test('the CSS hides it while anything plays: the player, the mini player, either Stage', () => {
  const css = fs.readFileSync(path.join(ROOT, 'css', 'dock.css'), 'utf8');
  for (const sel of ['body.stage-open .dock-stage-play', 'body.stage-basic .dock-stage-play',
    'body:has(#miniPlayer.active) .dock-stage-play', 'body:has(#mediaPlayerOverlay.active) .dock-stage-play']) {
    assert.ok(css.includes(sel), sel);
  }
});
