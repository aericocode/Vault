/**
 * What POST /api/ai/endpoints accepts, and what it turns it into.
 *
 * The point of the normaliser is that a user may paste whatever LM Studio's
 * own UI showed them (an origin, a `/v1`, a full route) and get a working
 * server either way, while a genuine typo comes back as a sentence the panel
 * can show without rewording.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.VAULT_SETTINGS_FILE = path.join(os.tmpdir(), `vault-test-endpoints-${process.pid}.json`);

const { normalizeEndpoint, normalizeEndpoints } = require('../lib/ai-slots');

test('a bare origin gains the whole route', () => {
  for (const input of ['localhost:1234', 'http://localhost:1234', 'http://localhost:1234/']) {
    assert.strictEqual(normalizeEndpoint(input).url, 'http://localhost:1234/v1/chat/completions', input);
  }
});

test('a partial path only gains what it is missing', () => {
  assert.strictEqual(normalizeEndpoint('http://localhost:1234/v1').url,
    'http://localhost:1234/v1/chat/completions');
  assert.strictEqual(normalizeEndpoint('http://localhost:1234/v1/').url,
    'http://localhost:1234/v1/chat/completions');
  assert.strictEqual(normalizeEndpoint('http://box.lan:8000/openai/v1').url,
    'http://box.lan:8000/openai/v1/chat/completions');
});

test('a complete URL is left alone, https included', () => {
  assert.strictEqual(normalizeEndpoint('https://gpu.lan/v1/chat/completions').url,
    'https://gpu.lan/v1/chat/completions');
  assert.strictEqual(normalizeEndpoint('  http://localhost:1235/v1/chat/completions  ').url,
    'http://localhost:1235/v1/chat/completions');
});

test('query strings and fragments are dropped', () => {
  assert.strictEqual(normalizeEndpoint('http://localhost:1234/v1?key=abc#x').url,
    'http://localhost:1234/v1/chat/completions');
});

test('junk is refused with a message, not an exception', () => {
  assert.strictEqual(normalizeEndpoint('').url, null);
  assert.ok(normalizeEndpoint('').error);
  assert.strictEqual(normalizeEndpoint('   ').url, null);
  assert.strictEqual(normalizeEndpoint(undefined).url, null);
  const ftp = normalizeEndpoint('ftp://localhost:1234');
  assert.strictEqual(ftp.url, null);
  assert.match(ftp.error, /http/);
});

test('no error message contains an em dash', () => {
  for (const bad of ['', 'ftp://x', 'http://']) {
    const { error } = normalizeEndpoint(bad);
    if (error) assert.ok(!error.includes('—'), error);
  }
});

test('a list is deduped, order preserved', () => {
  const { urls, error } = normalizeEndpoints([
    'localhost:1234',
    'http://localhost:1234/v1',
    'http://localhost:1235',
  ]);
  assert.strictEqual(error, null);
  assert.deepStrictEqual(urls, [
    'http://localhost:1234/v1/chat/completions',
    'http://localhost:1235/v1/chat/completions',
  ]);
});

test('an empty list is refused', () => {
  assert.ok(normalizeEndpoints([]).error);
  assert.ok(normalizeEndpoints(null).error);
  assert.ok(normalizeEndpoints('http://localhost:1234').error, 'a bare string is not a list');
});

test('one bad entry rejects the whole list', () => {
  const { urls, error } = normalizeEndpoints(['http://localhost:1234', 'ftp://nope']);
  assert.strictEqual(urls, null);
  assert.ok(error);
});
