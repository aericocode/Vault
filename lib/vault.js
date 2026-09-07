/**
 * Vault — database lock/encryption manager.
 *
 * Encryption is SQLite-level via better-sqlite3-multiple-ciphers (ChaCha20-
 * Poly1305 by default — AES-256-class security), applied in place with
 * PRAGMA rekey. "Locked" means the server's DB connection is closed and the
 * key is gone from memory; every data endpoint then answers 423 until
 * unlock() reopens the file with the passphrase.
 *
 * Scope: the password protects the METADATA (descriptions, tags, notes,
 * transcripts, heatmaps, trash mapping). Media files themselves live on disk
 * unencrypted — full at-rest protection needs volume-level encryption.
 *
 * Autolock: after config.security.autolockMinutes without API activity the
 * vault locks itself. A running scan counts as activity — autolock never
 * interrupts one; only a manual lock({force:true}) does.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const database = require('./database');
const secureAssets = require('./secure-assets');

// Every plaintext SQLite file starts with these 16 bytes; an encrypted one
// (any cipher) does not. Reading the header is the one reliable way to know
// whether the file needs a key without guessing at pragmas.
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

const esc = (p) => String(p).replace(/'/g, "''");

const vault = {
  _locked: false,
  _lastActivity: Date.now(),
  _scanProbe: () => false,
  _listeners: [],
  _timer: null,
  // Consecutive wrong "current password" entries in changePassword(). Reset on
  // a correct entry and on unlock(); a 3rd miss force-locks the vault.
  _changeFailures: 0,
  CHANGE_FAIL_LIMIT: 3,

  /* ── State inspection ─────────────────────────────────────────────────── */

  /** Header check: is the DB file on disk encrypted? (missing file = no) */
  isFileEncrypted(dbPath = config.paths.database) {
    let fd = null;
    try {
      fd = fs.openSync(path.resolve(dbPath), 'r');
      const buf = Buffer.alloc(16);
      const n = fs.readSync(fd, buf, 0, 16, 0);
      if (n < 16) return false;                // new/empty file — plaintext
      return !buf.equals(SQLITE_MAGIC);
    } catch {
      return false;                            // absent file — nothing to lock
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    }
  },

  isEncrypted() { return this.isFileEncrypted(); },
  isLocked() { return this._locked; },
  scanActive() { try { return !!this._scanProbe(); } catch { return false; } },

  status() {
    return {
      encrypted: this.isEncrypted(),
      locked: this._locked,
      scanActive: this.scanActive(),
      autolockMinutes: config.security.autolockMinutes,
    };
  },

  /* ── Wiring ───────────────────────────────────────────────────────────── */

  /** Server start found an encrypted DB and no valid password — begin locked. */
  bootLocked() {
    this._locked = true;
  },

  /** fn() → true while any scan (import queue / rescan) is running. */
  registerScanProbe(fn) { this._scanProbe = fn; },

  /** cb('encrypted'|'locked'|'unlocked') — queue pause/resume, deferred boot. */
  onChange(cb) { this._listeners.push(cb); },

  _notify(event) {
    for (const cb of this._listeners) { try { cb(event); } catch {} }
  },

  /** Any authenticated API activity — resets the autolock idle clock. */
  touch() { this._lastActivity = Date.now(); },

  /* ── Transitions ──────────────────────────────────────────────────────── */

  /**
   * Encrypt the DB in place (initial password, or change while unlocked).
   * Refused while a scan is running — rekey rewrites every page and must not
   * race concurrent writes.
   */
  async setPassword(pass) {
    if (this._locked) { const e = new Error('vault is locked'); e.code = 'VAULT_LOCKED'; throw e; }
    if (typeof pass !== 'string' || pass.length < 4) {
      const e = new Error('password must be at least 4 characters'); e.code = 'VAULT_BAD_PASS'; throw e;
    }
    if (this.scanActive()) {
      const e = new Error('a scan is running — wait for it to finish before encrypting');
      e.code = 'VAULT_SCAN_ACTIVE'; throw e;
    }
    const db = database.get();
    if (typeof db.pragma !== 'function') {
      const e = new Error('encrypted SQLite module unavailable'); e.code = 'VAULT_NO_CIPHER'; throw e;
    }
    // Every remux producer stops, and is CONFIRMED stopped, before the rekey:
    // an FFmpeg child outliving this call keeps ingesting plaintext segments,
    // and anything it ingests after the purge below survives as a stream_cache
    // row pointing at bytes the vault was supposed to have removed.
    try { await require('./stream/session').stopAll(); } catch (e) {
      console.warn(`[Vault] stream producers did not stop cleanly: ${e.message}`);
    }
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    db.pragma(`rekey='${esc(pass)}'`);
    if (!this.isFileEncrypted()) {
      const e = new Error('encryption did not take effect (is better-sqlite3-multiple-ciphers installed?)');
      e.code = 'VAULT_NO_CIPHER'; throw e;
    }
    // Rekey the derived-artifact store to the same passphrase, then sweep any
    // plaintext artifacts written before the vault was enabled into it. Keeps
    // the two DBs in lock-step (both open under the new key from here on).
    secureAssets.rekey(pass);
    // NOT gated on the server's startup adoption pass (server/index.js
    // slowDirsAdopted) — by the time a human has typed a password that pass is
    // long done, and losing the race is harmless anyway: guardSweep skips with
    // a warning and the next migrate call picks the artifacts up.
    try { secureAssets.migrateFromDisk(); } catch (e) { console.warn(`[Vault] secure-assets migration skipped: ${e.message}`); }
    // Cached HLS segments written while the library was plaintext are DELETED,
    // not imported. They are pure derived data that regenerates on the next
    // play, so moving gigabytes of them into the encrypted store would cost far
    // more than it saves; leaving them on disk would defeat the vault.
    try {
      const purged = require('./stream/store').purgePlaintext();
      if (!purged.ok) console.warn(`[Vault] stream cache purge refused: ${purged.error}`);
      database.clearStreamCacheRows();
    } catch (e) { console.warn(`[Vault] stream cache purge skipped: ${e.message}`); }
    this.touch();
    this._notify('encrypted');
    return this.status();
  },

  /**
   * Change an existing passphrase: re-confirm the CURRENT one, then rekey to
   * `next`. Wrong-current attempts are counted across calls; the Nth
   * (CHANGE_FAIL_LIMIT) force-locks the vault immediately — the caller who
   * can't prove the current password shouldn't keep an unlocked session.
   *
   * @throws VAULT_LOCKED / VAULT_PLAINTEXT / VAULT_SCAN_ACTIVE / VAULT_BAD_PASS
   *         VAULT_WRONG_CURRENT (with .attemptsLeft) / VAULT_LOCKED_OUT
   */
  async changePassword(current, next) {
    if (this._locked) { const e = new Error('vault is locked'); e.code = 'VAULT_LOCKED'; throw e; }
    if (!this.isEncrypted()) {
      const e = new Error('no password set yet — create one first'); e.code = 'VAULT_PLAINTEXT'; throw e;
    }
    if (this.scanActive()) {
      const e = new Error('a scan is running — wait for it to finish before changing the password');
      e.code = 'VAULT_SCAN_ACTIVE'; throw e;
    }
    // Validate the NEW password before spending a current-password attempt, so
    // a typo in the new field never burns a strike against the lockout.
    if (typeof next !== 'string' || next.length < 4) {
      const e = new Error('new password must be at least 4 characters'); e.code = 'VAULT_BAD_PASS'; throw e;
    }

    if (!database.verifyPassword(current)) {
      this._changeFailures++;
      if (this._changeFailures >= this.CHANGE_FAIL_LIMIT) {
        this._changeFailures = 0;
        await this.lock({ force: true });  // seal it — every queue aborts on 'locking'
        const e = new Error('vault locked'); e.code = 'VAULT_LOCKED_OUT'; throw e;
      }
      const e = new Error('current password is incorrect'); e.code = 'VAULT_WRONG_CURRENT';
      e.attemptsLeft = this.CHANGE_FAIL_LIMIT - this._changeFailures;
      throw e;
    }

    this._changeFailures = 0;
    // Reuse the rekey path (PRAGMA rekey on both stores). Stays UNLOCKED — a
    // password change isn't a lock; the connection carries on under the new key.
    return await this.setPassword(next);
  },

  /**
   * Close the DB — the vault is sealed until unlock(). Plaintext DBs can't
   * lock (the file would still be readable — set a password first).
   * @param {boolean} force - interrupt a running scan (it re-queues)
   */
  async lock({ force = false } = {}) {
    if (this._locked) return this.status();
    if (!this.isEncrypted()) {
      const e = new Error('no password set — the database is not encrypted'); e.code = 'VAULT_PLAINTEXT'; throw e;
    }
    if (this.scanActive() && !force) {
      const e = new Error('a scan is running — locking will interrupt it'); e.code = 'VAULT_SCAN_ACTIVE'; throw e;
    }
    this._locked = true;          // gate closes first — workers see it before the handle dies
    this._notify('locking');      // queues abort/requeue their in-flight item
    // Kill every remux producer BEFORE the DB handles close: each one is an
    // FFmpeg child writing plaintext segments into a temp dir, and a locked
    // vault must leave neither the process nor the bytes behind.
    // AWAITED: database.close() and secureAssets.close() must not run while a
    // child is still exiting, or a segment finishing a millisecond later gets
    // ingested through a handle the lock has already sealed.
    try { await require('./stream/session').stopAll(); } catch {}
    // finally, not a plain sequence: if closing the main DB throws, the derived
    // -artifact store would otherwise stay open on a vault that reports itself
    // locked, and nothing listening for 'locked' would ever hear it. The error
    // still propagates once both have run.
    try {
      database.close();
    } finally {
      secureAssets.close();       // seal the derived-artifact store alongside the main DB
      this._notify('locked');
    }
    return this.status();
  },

  /** Reopen the DB with the passphrase. Wrong password → VAULT_WRONG_PASS. */
  unlock(pass) {
    if (!this._locked) return this.status();
    try {
      database.init(config.paths.database, pass);
    } catch (err) {
      if (err.code === 'DB_ENCRYPTED') {
        const e = new Error('wrong password'); e.code = 'VAULT_WRONG_PASS'; throw e;
      }
      throw err;
    }
    // Reopen the derived-artifact store with the same passphrase (same file the
    // main DB just opened with — a mismatch here would be a bug, not user error).
    try {
      secureAssets.unlock(pass);
    } catch (err) {
      if (err.code === 'DB_ENCRYPTED') {
        const e = new Error('wrong password'); e.code = 'VAULT_WRONG_PASS'; throw e;
      }
      throw err;
    }
    this._locked = false;
    this._changeFailures = 0;     // fresh session proves the real password is known
    this.touch();
    this._notify('unlocked');
    return this.status();
  },

  /* ── Autolock ─────────────────────────────────────────────────────────── */

  /** One autolock check — returns true when it locked. (Exposed for tests.) */
  async _autolockTick() {
    const mins = config.security.autolockMinutes;
    try {
      if (!(mins > 0) || this._locked || !this.isEncrypted()) return false;
      if (this.scanActive()) { this.touch(); return false; }   // scans keep the vault open
      if (Date.now() - this._lastActivity >= mins * 60 * 1000) {
        console.log(`[Vault] auto-locked after ${mins} min of inactivity`);
        await this.lock({ force: false });
        return true;
      }
    } catch { /* scan started between checks — skip this tick */ }
    return false;
  },

  startAutolock() {
    clearInterval(this._timer);
    if (!(config.security.autolockMinutes > 0)) return;
    this._timer = setInterval(() => {
      this._autolockTick().catch(err => console.warn(`[Vault] autolock failed: ${err.message}`));
    }, 60 * 1000);
    if (this._timer.unref) this._timer.unref();
  },

  /**
   * Change the idle timeout at runtime (the Settings modal). 0 turns autolock
   * off entirely. The idle clock is reset on the way in so raising the timeout
   * can't lock the vault the instant it's applied, and the timer is rebuilt
   * because startAutolock() refuses to run one when the value is 0.
   */
  setAutolockMinutes(mins) {
    const n = Math.max(0, Math.min(1440, Math.trunc(Number(mins) || 0)));
    config.security.autolockMinutes = n;
    this.touch();
    this.startAutolock();
    console.log(`[Vault] autolock ${n > 0 ? `set to ${n} min` : 'disabled'}`);
    return n;
  },

  getAutolockMinutes() {
    return config.security.autolockMinutes;
  },
};

module.exports = vault;
