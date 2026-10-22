/**
 * Folder watchers: the quick fingerprint. SHA-1 of the first and last 64 KB
 * of a file plus its size, as 24 hex characters. Two reads per file, so it is
 * cheap enough to take for every file a watcher adds and to backfill slowly
 * for files already in the library.
 *
 * It is what lets a file that turns up again take back a Missing row: same
 * size and modified time is not proof (two different photos saved in the
 * same second have both), the same first and last 64 KB almost always is.
 * Byte-identical copies share a fingerprint; one of them taking the row is
 * accepted (WATCHERS_SPEC, verifier round 2).
 */

const fsp = require('fs').promises;
const crypto = require('crypto');

const EDGE = 64 * 1024;

/**
 * @param {string} file
 * @param {object} [o]
 * @param {number} [o.size] known size (skips a stat)
 * @param {object} [o.fs]   fs.promises shape (tests)
 * @returns {Promise<string|null>} null when the file cannot be read
 */
async function quickHash(file, { size = null, fs = fsp } = {}) {
  let fh = null;
  try {
    fh = await fs.open(file, 'r');
    const total = Number.isFinite(size) ? size : (await fh.stat()).size;
    const h = crypto.createHash('sha1');
    h.update(String(total));
    const head = Buffer.alloc(Math.min(EDGE, total));
    if (head.length) {
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      h.update(head.subarray(0, bytesRead));
    }
    if (total > EDGE) {
      const len = Math.min(EDGE, total - EDGE);
      const tail = Buffer.alloc(len);
      const { bytesRead } = await fh.read(tail, 0, len, total - len);
      h.update(tail.subarray(0, bytesRead));
    }
    return h.digest('hex').slice(0, 24);
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * The fingerprint together with the size and modified time of the very copy
 * it was read from (the open handle's stat, before and after the reads). A
 * file that changed while it was read gives null. Stored fingerprints are
 * only ever written next to these exact values (store.setQuickHash), so a
 * fingerprint read from an older copy can never land on a newer one.
 * @returns {Promise<{hash, size, mtimeMs}|null>}
 */
async function quickHashStat(file, { fs = fsp } = {}) {
  let fh = null;
  try {
    fh = await fs.open(file, 'r');
    const before = await fh.stat();
    const h = crypto.createHash('sha1');
    const total = before.size;
    h.update(String(total));
    const head = Buffer.alloc(Math.min(EDGE, total));
    if (head.length) {
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      h.update(head.subarray(0, bytesRead));
    }
    if (total > EDGE) {
      const len = Math.min(EDGE, total - EDGE);
      const tail = Buffer.alloc(len);
      const { bytesRead } = await fh.read(tail, 0, len, total - len);
      h.update(tail.subarray(0, bytesRead));
    }
    const after = await fh.stat();
    if (after.size !== before.size || Math.trunc(after.mtimeMs) !== Math.trunc(before.mtimeMs)) return null;
    return { hash: h.digest('hex').slice(0, 24), size: total, mtimeMs: Math.trunc(before.mtimeMs) };
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** Fingerprints for many files, `concurrency` at a time. Map path -> hash|null. */
async function quickHashAll(items, { concurrency = 8, fs = fsp } = {}) {
  const out = new Map();
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const hs = await Promise.all(slice.map(it => quickHash(it.path, { size: it.size, fs })));
    slice.forEach((it, k) => out.set(it.path, hs[k]));
  }
  return out;
}

module.exports = { quickHash, quickHashStat, quickHashAll, EDGE };
