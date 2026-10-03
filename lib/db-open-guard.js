/**
 * Hot-journal guard: decide whether a key may open a SQLite file READ-WRITE.
 *
 * Why this exists. Vault runs SQLite in rollback-journal mode. When a process
 * dies mid-write it leaves `<db>-journal` behind ("hot"), and the FIRST
 * read-write connection that reads the file plays that journal back and
 * deletes it, whatever key that connection holds. With an encrypted file
 * (better-sqlite3-multiple-ciphers) the journal pages are encrypted with the
 * key the database had when the transaction started. A connection without that
 * key cannot decrypt them: the page checksums fail, SQLite takes that as the
 * end of the journal, truncates the file and deletes the journal, and the
 * pages the dead transaction had already written stay in place. The library is
 * corrupt and the journal that could have repaired it is gone. A connection
 * with a WRONG key gets as far as the truncation before the cipher's MAC check
 * stops it.
 *
 * So no read-write connection may be opened on an existing file until the key
 * it carries is known to be the one the rollback needs. This module answers
 * that question without ever letting SQLite write:
 *
 *   - What the rollback needs is decided by the PRE-TRANSACTION page 1: the
 *     copy of page 1 saved in the hot journal when the dead transaction first
 *     changed it, or (if it never did) page 1 of the database file. A
 *     plaintext image starts with "SQLite format 3\0"; an encrypted one does
 *     not (the cipher puts its KDF salt in those bytes). Read with plain fs.
 *   - Plaintext pre-state: only a keyless connection is correct. A keyed one is
 *     refused (it could not read the file anyway).
 *   - Encrypted pre-state, no key: refused without opening the file at all.
 *   - Encrypted pre-state, candidate key:
 *       no hot journal -> a READ-ONLY connection with the key reads the schema.
 *         A read-only connection cannot roll a journal back; if one turns up
 *         after all, SQLite answers SQLITE_READONLY_ROLLBACK and nothing is
 *         written, and we fall through to the next case.
 *       hot journal -> the pre-transaction page-1 image is copied into a
 *         private temp file and a read-only connection with the key decrypts
 *         it (the cipher authenticates every page, so a wrong key fails with
 *         SQLITE_NOTADB). The real file and its journal are only ever read.
 *
 * Nothing here deletes, moves, renames or truncates the database or any
 * -journal / -wal / -shm sidecar. The only file it removes is its own temp
 * probe copy. The key is passed to SQLite only through PRAGMA key on a
 * connection, never logged, never put in an error message, argv or the env.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
// Largest page SQLite supports. A database prefix this long always holds page 1.
const MAX_PAGE = 65536;

const esc = (p) => String(p).replace(/'/g, "''");

function _readAt(fd, len, pos) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return n === len ? buf : buf.subarray(0, n);
}

function _size(p) {
  try { return fs.statSync(p).size; } catch { return -1; }
}

const _pow2 = (n, lo, hi) => n >= lo && n <= hi && (n & (n - 1)) === 0;

/**
 * Page 1 as it was when the transaction recorded in a hot journal began, or
 * null when the journal holds no copy of page 1 (the transaction never changed
 * it, so the database file's own page 1 is still the original). Walks the
 * journal format exactly as SQLite's playback does (segment headers, record
 * counts, sector alignment) and only within the records SQLite would replay.
 * Reads; never writes.
 */
function journalPage1(journalPath) {
  let fd = null;
  try {
    fd = fs.openSync(journalPath, 'r');
    const size = fs.fstatSync(fd).size;
    let off = 0;
    let pageSize = 0;
    let sector = 0;
    while (off + 28 <= size) {
      const h = _readAt(fd, 28, off);
      if (h.length < 28 || !h.subarray(0, 8).equals(JOURNAL_MAGIC)) break;
      let nRec = h.readUInt32BE(8);
      if (!pageSize) {
        // Only the first header carries meaningful sizes (SQLite ignores the rest).
        sector = h.readUInt32BE(20);
        pageSize = h.readUInt32BE(24);
        if (!_pow2(pageSize, 512, 65536) || !_pow2(sector, 32, 65536)) return null;
      }
      const recSize = pageSize + 8;           // pgno(4) + page + checksum(4)
      const recStart = off + sector;
      if (nRec === 0xffffffff) nRec = Math.floor(Math.max(0, size - recStart) / recSize);
      for (let i = 0; i < nRec; i++) {
        const r = recStart + i * recSize;
        if (r + 4 + pageSize > size) return null;     // short read: playback ends here
        const pgno = _readAt(fd, 4, r).readUInt32BE(0);
        if (pgno === 0) return null;                   // SQLite stops playback at pgno 0
        if (pgno === 1) return _readAt(fd, pageSize, r + 4);
      }
      const end = recStart + nRec * recSize;
      off = Math.ceil(end / sector) * sector;
      if (off <= recStart - sector) break;             // no progress (defensive)
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * Read-only description of a database file and its rollback journal.
 * @returns {{exists: boolean, journalHot: boolean, page1: Buffer|null, preEncrypted: boolean}}
 *   journalHot: a non-empty journal whose first byte is not zero (SQLite's own
 *     test; it also checks locks, so this errs on the side of "hot").
 *   page1: the pre-transaction page-1 image (journal copy, else up to 64 KiB of
 *     the database file).
 *   preEncrypted: that image does not start with the plaintext SQLite magic.
 */
function inspect(dbPath) {
  const abs = path.resolve(dbPath);
  const size = _size(abs);
  if (size < SQLITE_MAGIC.length) {
    // Absent or a brand-new/empty file: nothing to decrypt, nothing to roll back
    // into. SQLite creates/initialises it as today.
    return { exists: size >= 0, journalHot: false, page1: null, preEncrypted: false };
  }
  const jPath = abs + '-journal';
  let journalHot = false;
  let fd = null;
  try {
    if (_size(jPath) > 0) {
      fd = fs.openSync(jPath, 'r');
      journalHot = _readAt(fd, 1, 0)[0] !== 0;
    }
  } catch { /* unreadable journal: SQLite will report it; treat as not hot */ }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }

  let page1 = journalHot ? journalPage1(jPath) : null;
  if (!page1) {
    let dfd = null;
    try {
      dfd = fs.openSync(abs, 'r');
      page1 = _readAt(dfd, Math.min(size, MAX_PAGE), 0);
    } finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch {} } }
  }
  const preEncrypted = !(page1.length >= 16 && page1.subarray(0, 16).equals(SQLITE_MAGIC));
  return { exists: true, journalHot, page1, preEncrypted };
}

/**
 * Decrypt a page-1 image with `key` in a private temp file through a READ-ONLY
 * connection. True iff the key authenticates and decrypts it to a SQLite
 * header. The copy is shorter than the size its header records, which SQLite
 * reports as corruption; writable_schema (which better-sqlite3 only honours
 * outside its default defensive mode, hence unsafeMode) makes it use the real
 * file length instead. Both apply to this read-only scratch connection only.
 */
function _probeImage(Database, page1, key) {
  let dir = null;
  let db = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-keyprobe-'));
    const f = path.join(dir, 'p.db');
    fs.writeFileSync(f, page1, { mode: 0o600 });
    db = new Database(f, { readonly: true, fileMustExist: true });
    db.pragma(`key='${esc(key)}'`);
    db.unsafeMode(true);
    db.pragma('writable_schema=ON');
    db.pragma('user_version', { simple: true });   // forces page 1 to be read and decrypted
    return true;
  } catch {
    return false;
  } finally {
    if (db) { try { db.close(); } catch {} }
    // Our own scratch copy only: never a database or sidecar of the library.
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
}

/**
 * May a READ-WRITE connection keyed with `key` (falsy = keyless) open `dbPath`?
 * True only when that connection is the right one to roll back any hot journal
 * and to read the file. Never writes to the database or its sidecars.
 *
 * @param {Function} Database  the better-sqlite3(-multiple-ciphers) constructor
 * @param {string}   dbPath
 * @param {string|null} key
 * @param {{hasCipher?: boolean}} [opts] false when Database is plain better-sqlite3
 */
function keyFits(Database, dbPath, key, { hasCipher = true } = {}) {
  let st = inspect(dbPath);
  if (!st.exists || !st.page1) return true;          // new file: created as today
  if (!st.preEncrypted) return !key;                 // plaintext: keyless only
  if (!key || !hasCipher) return false;              // encrypted: needs the key

  if (!st.journalHot) {
    let db = null;
    try {
      db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
      db.pragma(`key='${esc(key)}'`);
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      return true;
    } catch (err) {
      // A hot journal appeared between inspect() and the read. The read-only
      // connection refused to roll it back, so nothing was written; judge the
      // key against the journal's pre-transaction page 1 instead.
      if (err && err.code === 'SQLITE_READONLY_ROLLBACK') {
        st = inspect(dbPath);
        if (!st.page1) return false;
        if (!st.preEncrypted) return false;
      } else {
        return false;
      }
    } finally {
      if (db) { try { db.close(); } catch {} }
    }
  }
  return _probeImage(Database, st.page1, key);
}

module.exports = { keyFits, inspect, journalPage1, SQLITE_MAGIC };
