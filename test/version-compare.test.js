'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isNewer } = require('../lib/version-compare');

test('plain releases compare by number, not text', () => {
  assert.strictEqual(isNewer('3.10.0', '3.9.0'), true);
  assert.strictEqual(isNewer('3.9.0', '3.10.0'), false);
  assert.strictEqual(isNewer('3.9.1', '3.9.0'), true);
  assert.strictEqual(isNewer('4.0.0', '3.99.99'), true);
  assert.strictEqual(isNewer('3.9.0', '3.9.0'), false);
  assert.strictEqual(isNewer('v3.10.0', '3.9.0'), true);
});

test('a pre-release user hears about the release, never about the stable before it', () => {
  assert.strictEqual(isNewer('3.10.0', '3.10.0-beta.1'), true);
  assert.strictEqual(isNewer('3.9.0', '3.10.0-beta.1'), false);
  assert.strictEqual(isNewer('3.10.0-beta.1', '3.10.0'), false);
  assert.strictEqual(isNewer('3.10.1', '3.10.0-beta.1'), true);
});

test('pre-releases compare by their number', () => {
  assert.strictEqual(isNewer('3.10.0-beta.2', '3.10.0-beta.1'), true);
  assert.strictEqual(isNewer('3.10.0-beta.10', '3.10.0-beta.9'), true);
  assert.strictEqual(isNewer('3.10.0-beta.1', '3.10.0-beta.2'), false);
  assert.strictEqual(isNewer('3.10.0-rc.1', '3.10.0-beta.3'), true);
  assert.strictEqual(isNewer('3.10.0-beta.1.1', '3.10.0-beta.1'), true);
  assert.strictEqual(isNewer('3.10.0-beta.1', '3.10.0-beta.1'), false);
  // A stable user is told about a newer pre-release only if one is ever
  // served as the latest release (GitHub's latest skips pre-releases).
  assert.strictEqual(isNewer('3.10.0-beta.1', '3.9.0'), true);
});

test('anything that is not a version never counts as newer', () => {
  for (const junk of ['', null, undefined, 'latest', '3.10', '3.10.0.1', 'v3.x.0', '3.10.0-', '3.10.0-beta..1x!']) {
    assert.strictEqual(isNewer(junk, '3.9.0'), false, String(junk));
    assert.strictEqual(isNewer('3.10.0', junk), false, String(junk));
  }
});
