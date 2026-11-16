/**
 * Settings › Stage as tabs (player-lib/stage-settings-ui.js), run in a VM:
 * Window, On screen, Sound and Flow order in both looks, every row drawn on
 * its tab (the others [hidden]), the last tab remembered per browser,
 * Countdown and warnings as one row whose three rows open in place, the
 * summary it shows when closed, the short Player line when mpv is fine, and
 * Settings search picking the tab a row is on.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function load({ modern = true, store = {}, throwing = false } = {}) {
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp,
    localStorage: throwing
      ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
      : { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  };
  ctx.window = ctx;
  ctx.isModernLayout = () => modern;
  vm.createContext(ctx);
  vm.runInContext(`${read('player-lib/settings-kit.js')}\n${read('player-lib/stage-countdown.js')}\n${read('player-lib/stage-settings-ui.js')}
${read('player-lib/stream-tags-settings.js')}
    ;globalThis.__t = {
      html: () => stageSettingsHtml(),
      set: (s) => { _stageSettings = { ...STAGE_SETTINGS_DEFAULTS, ...s }; },
      mpv: (m) => { _stageMpv = m; },
      mpvHtml: () => _stageMpvHtml(),
      summary: (s) => _stageCountdownSummary({ ...STAGE_SETTINGS_DEFAULTS, ...s }),
      tabs: STAGE_TABS, key: STAGE_TAB_KEY,
    };`, ctx);
  return ctx.__t;
}

/** Each tab panel's markup, by tab id, with whether it is hidden. */
function panels(html) {
  const out = {};
  const re = /<div class="stage-tab-panel" role="tabpanel" id="stageTabPanel-(\w+)" data-stage-panel="\w+" aria-labelledby="stageTab-\w+"( hidden)?>/g;
  const marks = [...html.matchAll(re)];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : html.indexOf('data-sfind="stageLanes"') > 0 ? html.indexOf('data-sfind="stageLanes"') : html.length;
    out[m[1]] = { hidden: !!m[2], html: html.slice(m.index, end) };
  });
  return out;
}

const sfinds = (s) => [...s.matchAll(/data-sfind="([^"]+)"/g)].map(m => m[1]);

const WANT = {
  window: ['stagePlayer', 'stageOpenSize', 'stageWindowName', 'stageHwDecoding', 'stageSetLog', 'stageTips'],
  screen: ['stageShowName', 'stageProgressAlways', 'stageImageSeconds', 'stageCursor', 'stageWarnings', 'stageCountdown', 'stageCountdownLook'],
  sound: ['stageMuteVault', 'stageEvenLoudness'],
  flow: ['stageFlowMeasure', 'stageFlowEdges', 'stageFlowShuffle'],
};

for (const modern of [true, false]) {
  const look = modern ? 'Modern' : 'Classic';

  test(`${look}: four tabs, each row on its own tab, the others hidden, Lanes below them all`, () => {
    const t = load({ modern });
    const html = t.html();
    assert.match(html, /<div class="settings-seg stage-tabs" role="tablist" aria-label="Stage settings">/);
    const tabs = [...html.matchAll(/role="tab" id="stageTab-(\w+)"[^>]*aria-controls="stageTabPanel-\1" aria-selected="(true|false)" tabindex="(0|-1)">([^<]+)</g)];
    assert.deepStrictEqual(tabs.map(m => m[4]), ['Window', 'On screen', 'Sound', 'Flow order']);
    assert.deepStrictEqual(tabs.map(m => m[2]), ['true', 'false', 'false', 'false'], 'Window first');
    assert.deepStrictEqual(tabs.map(m => m[3]), ['0', '-1', '-1', '-1'], 'one tab in the Tab order');
    const p = panels(html);
    assert.deepStrictEqual(Object.keys(p), ['window', 'screen', 'sound', 'flow']);
    for (const [id, want] of Object.entries(WANT)) {
      assert.deepStrictEqual(sfinds(p[id].html), want, `${id}: its rows, in order`);
      assert.strictEqual(p[id].hidden, id !== 'window', `${id}: hidden unless picked`);
    }
    // The XWayland row's place (filled in later by _stageMpvPaint) is on Window.
    assert.ok(p.window.html.includes('data-stage-xwayland-row'));
    // Every Stage anchor in Settings search is drawn (XWayland only on Linux Wayland).
    const search = [...read('player-lib/settings-search.js').matchAll(/page: 'stage', id: '(\w+)'/g)].map(m => m[1]);
    for (const id of search) assert.ok(sfinds(html).includes(id), `${id} on the page`);
    // Lanes and stream tags come after the tabs, outside them.
    assert.ok(html.indexOf('data-sfind="stageLanes"') > html.indexOf('id="stageTabPanel-flow"'));
    if (modern) assert.match(html, /<section class="settings-card stage-set-card" data-sfind="stage">/);
    else assert.match(html, /<h3 class="settings-h" data-sfind="stage">/);
  });

  test(`${look}: Countdown and warnings is one row; Set up opens its three rows, closed at first`, () => {
    const t = load({ modern });
    t.set({ countdownOn: true, countdownMinutes: 10, warnOn: true, warnMinutes: [30, 15, 10] });
    const html = panels(t.html()).screen.html;
    assert.match(html, /<span class="settings-toggle-title">Countdown and warnings<\/span>/);
    assert.match(html, /A clock and “10 minutes left” messages near the end of the list\./);
    assert.match(html, /<button type="button" class="settings-btn settings-btn-quiet" data-stage-cd-toggle aria-controls="stageCdMore" aria-expanded="false">Set up<\/button>/);
    assert.match(html, /data-stage-cd-sum>Countdown for the last 10 min, warnings at 30, 15, 10 min</);
    const more = html.slice(html.indexOf('id="stageCdMore"'));
    assert.match(more, /^id="stageCdMore" data-stage-cd-more hidden>/);
    assert.deepStrictEqual(sfinds(more), ['stageWarnings', 'stageCountdown', 'stageCountdownLook']);
    // Each keeps its own switch and the warnings keep their error line.
    for (const k of ['warnOn', 'countdownOn']) assert.ok(more.includes(`data-stage-setting="${k}"`), k);
    assert.ok(more.includes('data-stage-warn-err role="alert" hidden'));
    assert.ok(!/data-stage-setting="(countdown|warnings)Enabled"|data-stage-cd-switch/.test(html), 'no made-up master switch');
  });
}

test('the remembered tab opens; a stored value that is no tab, or storage that throws, opens Window', () => {
  const store = { vault_stage_settings_tab: 'sound' };
  let p = panels(load({ store }).html());
  assert.strictEqual(p.sound.hidden, false);
  assert.strictEqual(p.window.hidden, true);
  assert.match(load({ store, modern: false }).html(), /id="stageTab-sound"[^>]*aria-selected="true"/);
  p = panels(load({ store: { vault_stage_settings_tab: 'nope' } }).html());
  assert.strictEqual(p.window.hidden, false);
  p = panels(load({ throwing: true }).html());
  assert.strictEqual(p.window.hidden, false);
  assert.strictEqual(load().key, 'vault_stage_settings_tab');
});

test('the countdown summary says what is on', () => {
  const t = load();
  assert.strictEqual(t.summary({}), 'Off');
  assert.strictEqual(t.summary({ countdownOn: true, countdownMinutes: 5 }), 'Countdown for the last 5 min. Warnings off');
  assert.strictEqual(t.summary({ warnOn: true, warnMinutes: [30, 15, 10] }), 'Warnings at 30, 15, 10 min. Countdown off');
  assert.strictEqual(t.summary({ warnOn: true, warnMinutes: [10], countdownOn: true, countdownMinutes: 3 }), 'Countdown for the last 3 min, warnings at 10 min');
});

test('Player: one short line when mpv is fine; the full words when it is missing, chosen wrong, Basic, or the desktop places Stage', () => {
  const t = load();
  t.mpv({ found: true, path: 'C:\\Program Files\\mpv\\mpv.exe', version: 'v0.41.0', source: 'found', choice: 'mpv', platform: 'win32' });
  const ok = t.mpvHtml();
  assert.match(ok, /mpv v0\.41\.0 found\. Stage uses mpv, its own window \(the full Stage\)\./);
  assert.match(ok, /class="stage-mpv-line stage-mpv-where" title="C:\\Program Files\\mpv\\mpv\.exe">/);
  assert.ok(!ok.includes('mpv found: '));
  t.mpv({ found: false, platform: 'win32', choice: 'basic' });
  assert.match(t.mpvHtml(), /mpv was not found\.[\s\S]*Stage uses: Basic \(picture-in-picture\)[\s\S]*from mpv\.io/);
  t.mpv({ found: true, path: '/usr/bin/mpv', version: '0.37', chosenProblem: 'it is not mpv', choice: 'mpv', platform: 'linux' });
  assert.match(t.mpvHtml(), /mpv found: [\s\S]*The mpv you chose can’t be used: it is not mpv/);
  t.mpv({ found: true, path: '/usr/bin/mpv', choice: 'basic', platform: 'linux' });
  assert.match(t.mpvHtml(), /mpv found: [\s\S]*Stage uses: Basic/);
  t.mpv({ found: true, path: '/usr/bin/mpv', choice: 'mpv', platform: 'linux', display: { wayland: true, placement: false } });
  assert.match(t.mpvHtml(), /mpv found: [\s\S]*may not open where you last left it/);
});

test('short help keeps what you need to act, the full sentence is the tooltip; no em dashes', () => {
  const html = load().html();
  assert.match(html, /title="The graphics card decodes videos[^"]*Takes effect the next time Stage opens\."[\s\S]*Turn it off if the picture looks wrong\. mpv Stage only\. Takes effect the next time Stage opens\./);
  assert.match(html, /Quiet files up, loud files down\. mpv Stage only\./);
  assert.match(html, /Only times show, never a name\. mpv Stage only: Basic shows the time left on its bar\./);
  assert.ok(!read('player-lib/stage-settings-ui.js').includes('—'));
});

test('Settings search: a row on a tab that is not picked picks that tab, then unfolds the countdown rows', () => {
  const src = read('player-lib/settings-search.js');
  const at = src.indexOf("el.closest('[role=\"tabpanel\"][hidden][id]')");
  assert.ok(at > 0, 'reveal looks for a hidden tab panel');
  assert.ok(src.indexOf('[role="tab"][aria-controls="${panel.id}"]') > at, 'and clicks its tab');
  assert.ok(at < src.indexOf("el.closest('[hidden][id]')"), 'before the fold, so the countdown rows open next');
  const ui = read('player-lib/stage-settings-ui.js');
  // The fold's opener is the Set up button: [aria-controls=id][aria-expanded=false].
  assert.match(ui, /data-stage-cd-toggle aria-controls="stageCdMore" aria-expanded=/);
  assert.match(ui, /if \(tab\) \{ _stageTabSelect\(root, tab\.dataset\.stageTab, false\); return; \}/);
});
