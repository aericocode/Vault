'use strict';
/**
 * The 7-Zip programs shipped with Vault (vendor/7zip/, see its README.md):
 * read SHA256SUMS and check the files against it. Used by build-app.js (which
 * refuses to build on a mismatch) and test/share-vendor.test.js.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VENDOR_DIR = path.resolve(__dirname, '..', '..', 'vendor', '7zip');

/** { 'win-x64/7za.exe': '<sha256 hex>', ... } from SHA256SUMS. */
function readSums(dir = VENDOR_DIR) {
  const out = {};
  const text = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *]([A-Za-z0-9._/-]+)$/.exec(line);
    if (!m) throw new Error('vendor/7zip/SHA256SUMS: bad line: ' + JSON.stringify(line));
    if (m[2].split('/').includes('..')) throw new Error('vendor/7zip/SHA256SUMS: bad path: ' + m[2]);
    out[m[2]] = m[1];
  }
  return out;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * Check one listed file (rel like 'linux-x64/7zzs'), or all of them.
 * @returns {{rel:string, expected:string, actual:string|null, ok:boolean}[]}
 */
function verify(rels = null, dir = VENDOR_DIR) {
  const sums = readSums(dir);
  const list = rels || Object.keys(sums);
  return list.map((rel) => {
    const expected = sums[rel] || null;
    let actual = null;
    try { actual = sha256File(path.join(dir, rel)); } catch { /* missing */ }
    return { rel, expected, actual, ok: !!expected && actual === expected };
  });
}

module.exports = { VENDOR_DIR, readSums, sha256File, verify };
