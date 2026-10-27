'use strict';
// Version compare for the update check: is `latest` newer than `current`?
//
// Numeric segments compare as numbers (3.10.0 is newer than 3.9.0). A
// pre-release suffix (3.10.0-beta.1) sorts before its release, so someone on
// 3.10.0-beta.1 is told when 3.10.0 is out, and betas compare by their number
// (beta.2 is newer than beta.1). Anything that isn't a version never counts as
// newer, so a garbage tag can't masquerade as an upgrade.

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parseVersion(s) {
  const m = VERSION_RE.exec(String(s ?? '').trim());
  if (!m) return null;
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : null };
}

// Pre-release identifiers, semver style: numbers by value, numbers before
// words, words by text, and a longer list wins when the shorter is its prefix.
function comparePre(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;     // a release is newer than any of its pre-releases
  if (!b) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]), bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i]);
      if (d) return Math.sign(d);
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  }
  return comparePre(a.pre, b.pre) > 0;
}

module.exports = { isNewer, parseVersion };
