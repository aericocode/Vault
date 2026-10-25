/**
 * player-lib/vault-ui.js, run in a VM with a stub window and document:
 * the tab title while locked ("Locked: Name", no emoji), and the fetch
 * wrapper's vault:offline / vault:online events (only for requests to this
 * server, only for network failures, once per outage).
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load({ fetchImpl }) {
  const noop = () => {};
  const events = [];
  const window = {
    fetch: fetchImpl,
    addEventListener: noop,
    dispatchEvent: (e) => { events.push(e.type); return true; },
  };
  const document = {
    title: '',
    readyState: 'loading',
    addEventListener: noop,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { children: [] },
  };
  class CustomEvent { constructor(type) { this.type = type; } }
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, URL, JSON, Math, Date, Error, TypeError,
    String, Number, Array, Object, Boolean,
    window, document, CustomEvent,
    location: new URL('http://127.0.0.1:8804/'),
    showToast: noop,
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'vault-ui.js'), 'utf8');
  vm.runInContext(src, ctx);
  return { window, document, events };
}

test('tab title: the instance name, "Locked: " only while locked, never an emoji', () => {
  const { window, document } = load({ fetchImpl: async () => ({ status: 200 }) });
  window.vaultApplyInstanceName('Studio PC');
  assert.strictEqual(document.title, 'Studio PC');
  window.vaultApplyInstanceName('  ');
  assert.strictEqual(document.title, 'Vault');
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'vault-ui.js'), 'utf8');
  assert.match(src, /'Locked: '/);
  assert.doesNotMatch(src, /'🔒 '/);
});

test('the password dialogs are exposed for Settings', () => {
  const { window } = load({ fetchImpl: async () => ({ status: 200 }) });
  assert.strictEqual(typeof window.vaultOpenSetPassword, 'function');
  assert.strictEqual(typeof window.vaultOpenChangePassword, 'function');
});

test('fetch wrapper: vault:offline once on a network failure to this server, vault:online on the next answer', async () => {
  let fail = true;
  const { window, events } = load({
    fetchImpl: async () => {
      if (fail) throw new TypeError('Failed to fetch');
      return { status: 200 };
    },
  });
  await assert.rejects(window.fetch('/api/library'), TypeError);
  await assert.rejects(window.fetch('http://127.0.0.1:8804/api/vault/status'), TypeError);
  assert.deepStrictEqual(events, ['vault:offline']);
  fail = false;
  await window.fetch('/api/vault/status');
  await window.fetch('/api/vault/status');
  assert.deepStrictEqual(events, ['vault:offline', 'vault:online']);
});

test('fetch wrapper: other sites and aborted requests do not count as Vault being offline', async () => {
  const { window, events } = load({
    fetchImpl: async (u) => {
      if (String(u).includes('abort')) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(window.fetch('https://example.com/x'), TypeError);
  await assert.rejects(window.fetch('/api/abort'), /aborted/);
  assert.deepStrictEqual(events, []);
});
