/**
 * player-lib/shortcuts.js is the list the Settings shortcuts page will render;
 * SETUP.md's "Keyboard shortcuts" section is the same list for people reading
 * the docs. This fails when one gains a group or a row the other lacks.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function shortcuts() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'player-lib', 'shortcuts.js'), 'utf8')
    + '\nthis.list = VAULT_SHORTCUTS;', ctx);
  return ctx.list;
}

function docsSection() {
  const md = fs.readFileSync(path.join(ROOT, 'SETUP.md'), 'utf8').replace(/\r\n/g, '\n');
  const start = md.indexOf('## 7. Keyboard shortcuts');
  assert.ok(start >= 0, 'SETUP.md has a "7. Keyboard shortcuts" section');
  const next = md.indexOf('\n## ', start + 1);
  return md.slice(start, next < 0 ? undefined : next);
}

test('every shortcut group and action is in SETUP.md', () => {
  const docs = docsSection();
  const list = shortcuts();
  assert.ok(list.length > 5);
  for (const g of list) {
    assert.ok(docs.includes(`### ${g.group}\n`), `SETUP.md has a "${g.group}" heading`);
    for (const it of g.items) {
      assert.ok(Array.isArray(it.keys) && it.keys.length, `${it.action} has keys`);
      assert.ok(docs.includes(`| ${it.action} |`), `SETUP.md lists "${it.action}"`);
    }
  }
  const rows = docs.split('\n').filter(l => l.startsWith('| <kbd>')).length;
  assert.strictEqual(rows, list.reduce((n, g) => n + g.items.length, 0), 'no extra rows in SETUP.md');
});

const EM_DASH = String.fromCharCode(0x2014);

test('no em dashes in the shortcut list or its docs', () => {
  assert.ok(!docsSection().includes(EM_DASH));
  assert.ok(!JSON.stringify(shortcuts()).includes(EM_DASH));
});
