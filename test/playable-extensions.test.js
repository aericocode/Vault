/**
 * The "★ safe" filter now runs on the server (lib/playable-extensions.js)
 * while the play stars still run in the browser (player-lib/filters.js). Both
 * read their own copy of BROWSER_PLAYABLE_EXTENSIONS; this test parses the
 * browser file and fails when the two lists drift apart.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { BROWSER_PLAYABLE_EXTENSIONS } = require('../lib/playable-extensions');

function browserList() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'filters.js'), 'utf8');
  const m = src.match(/const BROWSER_PLAYABLE_EXTENSIONS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'player-lib/filters.js still defines BROWSER_PLAYABLE_EXTENSIONS as a Set literal');
  const body = m[1].replace(/\/\/.*$/gm, '');
  return new Set([...body.matchAll(/'([^']*)'/g)].map(x => x[1]));
}

test('the server list of browser-playable extensions matches the browser one', () => {
  const browser = browserList();
  assert.ok(browser.size > 20, 'parsed a plausible list');
  assert.deepStrictEqual([...BROWSER_PLAYABLE_EXTENSIONS].sort(), [...browser].sort());
});
