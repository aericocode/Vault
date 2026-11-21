/**
 * Share privately keeps packing and uploading while something plays: none
 * of its code waits on, or is paused by, what playback holds back (the
 * playback activity signal, the AI slots and scan mode, the process
 * priority helper). A source check: no file in lib/share/ and not
 * server/share-routes.js requires any of them, by any relative path.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FORBIDDEN = ['lib/playback-activity', 'lib/ai-slots', 'lib/ai-scan-mode', 'lib/proc']
  .map(p => path.join(ROOT, p));

/** Every require('...') in a file, resolved to a path under the repo (bare package names are left out). */
function localRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(/require\(\s*(['"`])([^'"`]+)\1\s*\)/g)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    out.push({ spec, abs: path.resolve(path.dirname(file), spec).replace(/\.js$/, '') });
  }
  return out;
}

test('Share privately does not depend on playback: lib/share/ and server/share-routes.js require none of the playback-throttling modules', () => {
  const shareDir = path.join(ROOT, 'lib', 'share');
  const files = fs.readdirSync(shareDir).filter(f => f.endsWith('.js')).map(f => path.join(shareDir, f));
  files.push(path.join(ROOT, 'server', 'share-routes.js'));
  assert.ok(files.length >= 5, 'the share files are there');
  for (const f of FORBIDDEN) assert.ok(fs.existsSync(`${f}.js`), `${path.relative(ROOT, f)}.js still exists (the check would be empty otherwise)`);
  const bad = [];
  for (const file of files) {
    for (const r of localRequires(file)) {
      const target = r.abs.replace(/[\\/]index$/, '');
      if (FORBIDDEN.includes(target)) bad.push(`${path.relative(ROOT, file)} requires ${r.spec}`);
    }
  }
  assert.deepStrictEqual(bad, []);
});

test('the check itself finds such a require (it is not vacuous)', () => {
  const sample = path.join(ROOT, 'lib', 'share', 'x.js');
  const found = (spec) => path.resolve(path.dirname(sample), spec).replace(/\.js$/, '');
  assert.ok(FORBIDDEN.includes(found('../playback-activity')));
  assert.ok(FORBIDDEN.includes(found('../ai-slots.js')));
  assert.ok(FORBIDDEN.includes(path.resolve(path.join(ROOT, 'server'), '../lib/proc')));
});
