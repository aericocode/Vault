/**
 * The WebView2 SDK files the Stage host loads (PLAYLISTS_SPEC 5, the user's
 * WebView2 choice of 2026-10-25).
 *
 * Three redistributable files from Microsoft's WebView2 SDK (NuGet package
 * Microsoft.Web.WebView2, BSD-style licence, see player-lib/THIRD-PARTY.txt).
 * The browser engine itself is the WebView2 Runtime that Windows 10 and 11
 * already have; nothing is installed.
 *
 * Where they live: runtime/webview2/ next to Vault.exe (the release build
 * copies them there, tools/sea/build-app.js), never loose in the install root.
 * In a dev checkout that is <repo>/runtime/webview2/ (git-ignored).
 * VAULT_WEBVIEW2_SDK points somewhere else.
 *
 * Every file is checked against the pinned SHA-256 below before the host is
 * started, so a different or damaged DLL in that folder is never loaded.
 * A new SDK version means new pins here (and a new folder copy).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT } = require('../approot');

const SDK_VERSION = '1.0.3240.44';

/** name -> SHA-256 (uppercase hex) of the Microsoft-signed x64 files, SDK 1.0.3240.44. */
const SDK_FILES = Object.freeze({
  'Microsoft.Web.WebView2.Core.dll': '7C269AF2B6FF690BCB65D7812DB82843112B9BC0DCDF5B304E99255996A8C1B4',
  'Microsoft.Web.WebView2.WinForms.dll': '4F5D619636A3121BF5F35CC5D1111196BE62AE2EF568318CD07B9C02C3F7A3B9',
  'WebView2Loader.dll': '1F278B330448CEFCCFBC2691FAE525B9DFD47E4768F1286857E45EA0DF07FF3F',
});

/** The folder the SDK files are read from. */
function sdkDir(env = process.env, root = ROOT) {
  return env.VAULT_WEBVIEW2_SDK ? path.resolve(env.VAULT_WEBVIEW2_SDK) : path.join(root, 'runtime', 'webview2');
}

const _looks = new Map();   // dir -> { at, result }: looksPresent() only

/**
 * Are all three files there and exactly the pinned ones? Read and hashed
 * every time, never cached: this is the check that stands before a launch
 * (and the helper checks the bytes again itself, lib/stage/host-script.js).
 * @returns {{ ok: boolean, dir: string, missing: string[], mismatched: string[] }}
 */
function verify(dir = sdkDir(), { files = SDK_FILES } = {}) {
  const missing = [];
  const mismatched = [];
  for (const [name, want] of Object.entries(files)) {
    let buf;
    try { buf = fs.readFileSync(path.join(dir, name)); } catch { missing.push(name); continue; }
    const got = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
    if (got !== want) mismatched.push(name);
  }
  return { ok: !missing.length && !mismatched.length, dir, missing, mismatched };
}

/**
 * For what the remote shows only (which way Stage opens): the full check,
 * remembered for a minute so polling the state does not hash 0.8 MB each
 * time. Never used to decide what gets loaded.
 */
function looksPresent(dir = sdkDir()) {
  const c = _looks.get(dir);
  if (c && Date.now() - c.at < 60000) return c.result;
  const result = verify(dir);
  _looks.set(dir, { at: Date.now(), result });
  return result;
}

/** The pins as the helper takes them (environment, never the script text): "name=SHA256;...". */
function pinsEnv(files = SDK_FILES) {
  return Object.entries(files).map(([n, h]) => `${n}=${h}`).join(';');
}

module.exports = { SDK_VERSION, SDK_FILES, sdkDir, verify, looksPresent, pinsEnv };
