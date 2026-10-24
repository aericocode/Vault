/**
 * player-lib/setup-check.js wording (UI audit F2): the server's labels are
 * "Video tools (ffmpeg)" / "Music ID helper (fpcalc)"; the banner leads with
 * the plain name ("Video tools are missing"), keeps the program's name for the
 * install fold, and offers one "Download (N MB)" button.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function renderBanner(tools) {
  const inserted = [];
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Object, Array, String, URL,
    sessionStorage: { getItem: () => null, setItem: () => {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => tools }),
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
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
  await new Promise(r => setTimeout(r, 10));
  return inserted[0] ? inserted[0].innerHTML : '';
}

const FFMPEG = {
  ok: false, required: true, label: 'Video tools (ffmpeg)', needed: 'scanning and thumbnails',
  install: { winget: 'winget install ffmpeg', url: 'https://www.gyan.dev/ffmpeg/builds/' }, downloadable: true, sizeMB: 90,
};
const FPCALC = {
  ok: false, required: false, label: 'Music ID helper (fpcalc)', needed: 'Music ID',
  install: { winget: null, url: 'https://acoustid.org/chromaprint' }, downloadable: true, sizeMB: 1,
};

test('titles use the plain name with the right verb; the program name stays in the fold', async () => {
  const html = await renderBanner({ ffmpeg: FFMPEG, fpcalc: FPCALC });
  assert.match(html, /setup-banner-title">Video tools are missing</);
  assert.match(html, /setup-banner-title">Music ID helper is missing <span class="setup-banner-tag">Optional/);
  assert.doesNotMatch(html, /not found/);
  assert.match(html, /Download \(90 MB\)/);
  assert.match(html, /Other ways to install/);
  assert.match(html, /Or download ffmpeg yourself from/);
  assert.match(html, /Download fpcalc yourself from/, 'no winget: the link is the only manual way');
  assert.match(html, />gyan\.dev<\/a>/, 'the link shows the site, not the whole URL');
  assert.doesNotMatch(html, /—/, 'no em dashes');
});

test('an older server label without a program name is used as it is', async () => {
  const html = await renderBanner({ ffmpeg: { ...FFMPEG, label: 'ffmpeg / ffprobe' } });
  assert.match(html, /setup-banner-title">ffmpeg \/ ffprobe is missing</);
});
