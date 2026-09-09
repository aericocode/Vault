/* =========================================================================
   VAULT UI — the header padlock IS the lock control.

   Unlocked: shackle drawn open; click → lock. If the DB has no password
   yet, the click first opens a create-password modal (with confirm) and
   encrypts — the session then STAYS UNLOCKED (encryption at rest is already
   in force; autolock handles locking later). If a scan is running, the first
   click arms an orange warning state ("locking interrupts the scan") and only
   a second click within 6s force-locks.

   Locked: an opaque full-screen lock covers the app (client data wiped);
   click the big padlock to reveal the password prompt — or press and hold it,
   if unlockHoldSeconds is set above its 0 default. Unlock reloads the page
   fresh.

   Autolock (server-side, config.security.autolockMinutes) is detected by a
   status poll + a fetch wrapper that watches for 423 responses. Real user
   input feeds the server's idle clock via a throttled /api/vault/touch.
   ========================================================================= */
(function () {
  let _status = { encrypted: false, locked: false, scanActive: false };
  let _armedInterrupt = false;   // scan-warning two-click state
  let _armTimer = null;

  const LOCK_SVG = `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path class="lock-shackle" d="M32 48 V38 C32 22 68 22 68 38 V48" fill="none" stroke="#1e1f22" stroke-width="11" stroke-linecap="round"/>
      <path class="lock-shackle" d="M32 48 V38 C32 22 68 22 68 38 V48" fill="none" style="stroke: var(--brand);" stroke-width="8" stroke-linecap="round"/>
      <rect x="22.5" y="44.5" width="55" height="45" rx="9" fill="#1e1f22"/>
      <rect x="24" y="46" width="52" height="42" rx="8" style="fill: var(--brand);"/>
      <path d="M36 58 L48 67 L36 76 Z" fill="#1e1f22"/>
      <path d="M52 58 L64 67 L52 76 Z" fill="#1e1f22"/>
    </svg>`;

  const $logo = () => document.getElementById('vaultLogo');
  const $keyBtn = () => document.getElementById('vaultChangePass');

  /* ── Status + logo rendering ─────────────────────────────────────────── */

  async function refreshStatus() {
    try {
      const s = await fetch('/api/vault/status').then(r => r.json());
      const wasLocked = _status.locked;
      _status = s;
      // The browser may only cache thumbnails while the library is plaintext;
      // see player-lib/thumbs.js.
      if (typeof setThumbsEncrypted === 'function') setThumbsEncrypted(!!s.encrypted && !s.locked);
      renderLogo();
      if (s.locked && !wasLocked) enterLockedUi();   // autolock fired while idle
      else if (s.locked) showLockOverlay();          // booted locked
    } catch { /* server unreachable — leave the UI as-is */ }
  }

  function renderLogo() {
    const el = $logo();
    if (!el) return;
    el.classList.toggle('vault-open', !_status.locked);
    el.classList.toggle('vault-warn', _armedInterrupt);
    el.title = _status.locked ? 'Vault locked'
      : _armedInterrupt ? 'A scan is running — locking now interrupts it. Click again to lock anyway.'
      : _status.encrypted ? 'Vault unlocked — click to lock'
      : 'Click to create a vault password (encrypts the library database)';
    // The 🔑 change-password affordance only makes sense on an encrypted,
    // unlocked vault — hidden while plaintext or locked.
    const key = $keyBtn();
    if (key) key.style.display = (_status.encrypted && !_status.locked) ? '' : 'none';
  }

  /* ── Lock flow (logo click while unlocked) ───────────────────────────── */

  function onLogoClick() {
    if (_status.locked) return;                    // overlay owns locked-state input
    if (!_status.encrypted) { openCreatePassModal(); return; }
    doLock(_armedInterrupt);
  }

  async function doLock(force) {
    try {
      const resp = await fetch('/api/vault/lock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: !!force }),
      });
      const data = await resp.json();
      if (resp.status === 409 && data.code === 'VAULT_SCAN_ACTIVE') {
        // First click while scanning: arm the warning, require a second click
        _armedInterrupt = true;
        renderLogo();
        showToast('⚠ A scan is running — click the lock again to interrupt it and lock');
        clearTimeout(_armTimer);
        _armTimer = setTimeout(() => { _armedInterrupt = false; renderLogo(); }, 6000);
        return;
      }
      if (!resp.ok) { showToast('⚠ ' + (data.error || 'lock failed')); return; }
      _armedInterrupt = false;
      clearTimeout(_armTimer);
      _status = data;
      enterLockedUi();
    } catch (err) {
      showToast('⚠ ' + err.message);
    }
  }

  /** Hard-stop every playback subsystem the moment the vault locks. Runs on
   *  manual lock, autolock, AND cross-window lock (all funnel through
   *  enterLockedUi). Each call is guarded so a missing/erroring subsystem never
   *  blocks the rest — nothing should keep emitting behind the lock screen. */
  function haltAllPlayback() {
    // Vibe FIRST — it's a physical device; stop it the instant we lock.
    try { window.LovenseSync?.lockStop?.(); } catch {}
    // Active game → pause (also persists its save).
    try { if (typeof gamesPauseIfActive === 'function') gamesPauseIfActive(); } catch {}
    // Editor mix preview (the stack/grid stage) — lock never closes the editor,
    // so its videos play on unless we tear the mix down explicitly.
    try { if (typeof editorCloseMix === 'function') editorCloseMix({ silent: true }); } catch {}
    // Main player (also stops its own custom mix via stopMixPlayer) + mini player.
    try { if (typeof closeMediaPlayer === 'function') closeMediaPlayer(); } catch {}
    try { if (typeof closeMiniPlayer === 'function') closeMiniPlayer(); } catch {}
    try { if (typeof stopMixPlayer === 'function') stopMixPlayer(); } catch {}
    // Safety net: pause + mute any <video>/<audio> still alive (detached
    // previews, beatbar, anything future). Unlock reloads the page, so muting
    // has no lasting effect — it just guarantees silence while locked.
    try {
      document.querySelectorAll('video, audio').forEach(el => {
        try { el.pause(); el.muted = true; } catch {}
      });
    } catch {}
  }

  /** Wipe client-side state and cover the app with the lock screen. */
  function enterLockedUi() {
    _status.locked = true;
    haltAllPlayback();
    // Decrypted thumbnails are held as object URLs in this tab. Locking the
    // vault has to take them with it, not just hide the grid.
    try { if (typeof revokeThumbBlobs === 'function') revokeThumbBlobs(); } catch {}
    try {
      allMedia = [];
      filteredMedia = [];
      if (typeof invalidateFuse === 'function') invalidateFuse();
      if (typeof renderResults === 'function') renderResults();
    } catch {}
    renderLogo();
    showLockOverlay();
  }

  /* ── Create-password modal (first lock on a plaintext DB) ────────────── */

  function openCreatePassModal() {
    document.getElementById('vaultPassModal')?.remove();
    const ov = document.createElement('div');
    ov.id = 'vaultPassModal';
    ov.className = 'vault-modal-overlay';
    ov.innerHTML = `
      <div class="vault-modal" role="dialog" aria-label="Create vault password">
        <h3>🔐 Create vault password</h3>
        <p class="vault-modal-hint">
          Encrypts the library database in place (ChaCha20-Poly1305 — AES-256-class).
          Protects all metadata, notes, transcripts and history. Media files themselves
          stay as-is on disk. <b>No recovery exists — a lost password loses the data.</b>
        </p>
        <input type="password" id="vaultPass1" class="vault-input" placeholder="Password (min 4 characters)" autocomplete="new-password">
        <input type="password" id="vaultPass2" class="vault-input" placeholder="Confirm password" autocomplete="new-password">
        <div class="vault-modal-err" id="vaultPassErr"></div>
        <div class="vault-modal-actions">
          <button class="vault-btn" id="vaultPassCancel" type="button">Cancel</button>
          <button class="vault-btn vault-btn-primary" id="vaultPassOk" type="button">Encrypt library</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const q = (sel) => ov.querySelector(sel);
    const err = (m) => { q('#vaultPassErr').textContent = m || ''; };

    q('#vaultPassCancel').onclick = () => ov.remove();
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove(); });
    ov.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') ov.remove();
      if (e.key === 'Enter') submit();
    });

    async function submit() {
      const p1 = q('#vaultPass1').value, p2 = q('#vaultPass2').value;
      if (p1.length < 4) return err('Password must be at least 4 characters');
      if (p1 !== p2) return err('Passwords do not match');
      const btn = q('#vaultPassOk');
      btn.disabled = true; btn.textContent = 'Encrypting…';
      try {
        const resp = await fetch('/api/vault/setpass', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pass: p1 }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          err(data.error || 'encryption failed');
          btn.disabled = false; btn.textContent = 'Encrypt library';
          return;
        }
        ov.remove();
        // Deliberately NO lock here. Setting the password encrypts the file in
        // place; the session that just created it carries on unlocked (the
        // server never locked either — setPassword only rekeys). Sending the
        // user to the lock screen to retype a password they typed twice a
        // second ago was the old behaviour and it read as a bug.
        _status = data;                 // {encrypted:true, locked:false}
        // Thumbnails become uncacheable the moment the library is encrypted.
        if (typeof setThumbsEncrypted === 'function') setThumbsEncrypted(true);
        if (typeof renderResults === 'function') renderResults();
        renderLogo();                   // padlock → open + 🔑 appears, no reload
        showToast('🔐 Library encrypted — it stays open while you use it');
      } catch (e2) {
        err(e2.message);
        btn.disabled = false; btn.textContent = 'Encrypt library';
      }
    }
    q('#vaultPassOk').onclick = submit;
    q('#vaultPass1').focus();
  }

  /* ── Change-password modal (🔑, encrypted + unlocked) ────────────────── */

  function openChangePassModal() {
    if (!_status.encrypted || _status.locked) return;
    document.getElementById('vaultPassModal')?.remove();
    const ov = document.createElement('div');
    ov.id = 'vaultPassModal';
    ov.className = 'vault-modal-overlay';
    ov.innerHTML = `
      <div class="vault-modal" role="dialog" aria-label="Change vault password">
        <h3>🔑 Change vault password</h3>
        <p class="vault-modal-hint">
          Confirm your current password, then set a new one. The library is re-encrypted
          in place — nothing is exported or re-scanned.
          <b>No recovery exists — a lost password loses the data.</b>
        </p>
        <input type="password" id="vaultCur" class="vault-input" placeholder="Current password" autocomplete="current-password">
        <input type="password" id="vaultNew1" class="vault-input" placeholder="New password (min 4 characters)" autocomplete="new-password">
        <input type="password" id="vaultNew2" class="vault-input" placeholder="Confirm new password" autocomplete="new-password">
        <div class="vault-modal-err" id="vaultPassErr"></div>
        <div class="vault-modal-actions">
          <button class="vault-btn" id="vaultPassCancel" type="button">Cancel</button>
          <button class="vault-btn vault-btn-primary" id="vaultPassOk" type="button">Change password</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const q = (sel) => ov.querySelector(sel);
    const err = (m) => { q('#vaultPassErr').textContent = m || ''; };

    q('#vaultPassCancel').onclick = () => ov.remove();
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove(); });
    ov.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') ov.remove();
      if (e.key === 'Enter') submit();
    });

    async function submit() {
      const cur = q('#vaultCur').value;
      const n1 = q('#vaultNew1').value, n2 = q('#vaultNew2').value;
      if (!cur) return err('Enter your current password');
      if (n1.length < 4) return err('New password must be at least 4 characters');
      if (n1 !== n2) return err('New passwords do not match');
      if (n1 === cur) return err('New password must be different from the current one');
      const btn = q('#vaultPassOk');
      btn.disabled = true; btn.textContent = 'Changing…';
      try {
        const resp = await fetch('/api/vault/changepass', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current: cur, next: n1 }),
        });
        const data = await resp.json().catch(() => ({}));

        // Lockout: the vault sealed itself. Drop the modal and let the lock
        // screen take over — no explanation of the mechanism.
        if (resp.status === 423 || data.locked) {
          ov.remove();
          if (!_status.locked) enterLockedUi();
          return;
        }
        if (!resp.ok) {
          // Wrong current password (or scan-running etc.) — generic message,
          // re-focus the field they need to fix.
          err(data.error || 'could not change password');
          btn.disabled = false; btn.textContent = 'Change password';
          if (data.code === 'VAULT_WRONG_CURRENT') {
            const c = q('#vaultCur');
            c.value = '';
            c.classList.remove('vault-shake'); void c.offsetWidth; c.classList.add('vault-shake');
            c.focus();
          }
          return;
        }
        ov.remove();
        showToast('🔑 Vault password changed');
        _status = data;               // stays unlocked; renderLogo keeps 🔑 visible
        renderLogo();
      } catch (e2) {
        err(e2.message);
        btn.disabled = false; btn.textContent = 'Change password';
      }
    }
    q('#vaultPassOk').onclick = submit;
    q('#vaultCur').focus();
  }

  /* ── Lock screen (opaque overlay + click / optional hold to unlock) ──── */

  /**
   * How long the lock must be held before the password box appears.
   * Default 0 = a plain click. The hold gesture itself is still fully wired
   * (0–10s) and honours a stored unlockHoldSeconds, but no Settings row
   * renders for it any more — see player-lib/settings.js.
   */
  function holdSeconds() {
    const raw = typeof window.vaultSetting === 'function' ? window.vaultSetting('unlockHoldSeconds') : 0;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(10, Math.round(n)));
  }

  function showLockOverlay() {
    if (document.getElementById('vaultLockScreen')) return;
    const secs = holdSeconds();
    const label = secs === 0
      ? 'Click the lock to unlock'
      : `Press and hold the lock for ${secs} second${secs === 1 ? '' : 's'}`;
    const ov = document.createElement('div');
    ov.id = 'vaultLockScreen';
    ov.innerHTML = `
      <div class="vault-lock-center">
        <div class="vault-lock-logo" id="vaultHoldTarget" title="${label}"
             style="--vault-hold-ms:${secs * 1000}ms">
          ${LOCK_SVG}
          <svg class="vault-hold-ring" viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r="54" fill="none" stroke-width="5"/>
          </svg>
        </div>
        <div class="vault-lock-title">Vault locked</div>
        <div class="vault-lock-hint" id="vaultLockHint">${label}</div>
        <form id="vaultUnlockForm" class="vault-unlock-form" style="display:none">
          <input type="password" id="vaultUnlockPass" class="vault-input" placeholder="Password" autocomplete="current-password">
          <button class="vault-btn vault-btn-primary" type="submit">Unlock</button>
        </form>
      </div>`;
    document.body.appendChild(ov);
    bindHoldToUnlock(ov);
  }

  function bindHoldToUnlock(ov) {
    const target = ov.querySelector('#vaultHoldTarget');
    const form = ov.querySelector('#vaultUnlockForm');
    const hint = ov.querySelector('#vaultLockHint');
    let holdTimer = null;

    const secs = holdSeconds();

    const reveal = () => {
      target.classList.remove('holding');
      form.style.display = '';
      hint.textContent = 'Enter the vault password';
      form.querySelector('#vaultUnlockPass').focus();
    };
    const cancelHold = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      target.classList.remove('holding');
    };
    target.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (form.style.display !== 'none') return;      // prompt already revealed
      // 0 = the deliberate-gesture guard is off; a click is enough.
      if (secs === 0) { reveal(); return; }
      target.classList.add('holding');                // CSS ring fills over `secs`
      holdTimer = setTimeout(reveal, secs * 1000);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
      target.addEventListener(ev, cancelHold);
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('#vaultUnlockPass');
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const resp = await fetch('/api/vault/unlock', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pass: input.value }),
        });
        if (resp.ok) {
          hint.textContent = 'Unlocked — loading…';
          location.reload();                          // fresh boot with data
          return;
        }
        const data = await resp.json().catch(() => ({}));
        hint.textContent = '⚠ ' + (data.error || 'unlock failed');
        input.value = '';
        input.classList.remove('vault-shake');
        void input.offsetWidth;                       // restart the animation
        input.classList.add('vault-shake');
        input.focus();
      } catch (e2) {
        hint.textContent = '⚠ ' + e2.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* ── Autolock detection + idle feeding ───────────────────────────────── */

  // Any data endpoint answering 423 means the server locked (autolock or a
  // second window) — swap to the lock screen immediately.
  const _origFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await _origFetch.apply(this, args);
    if (resp.status === 423 && !_status.locked) enterLockedUi();
    return resp;
  };

  // Real user input resets the server's idle clock (throttled to 1/min).
  // The status poll deliberately does NOT count (server-side exclusion is
  // implicit: only this touch call and real data traffic reset it).
  let _lastTouch = 0;
  function touchActivity() {
    if (_status.locked || !_status.encrypted) return;
    const now = Date.now();
    if (now - _lastTouch < 60 * 1000) return;
    _lastTouch = now;
    _origFetch('/api/vault/touch', { method: 'POST' }).catch(() => {});
  }

  /* ── Boot ─────────────────────────────────────────────────────────────── */

  /** Inject the small 🔑 change-password button beside the header logo. */
  function installKeyButton() {
    const logo = $logo();
    if (!logo || $keyBtn()) return;
    const btn = document.createElement('button');
    btn.id = 'vaultChangePass';
    btn.type = 'button';
    btn.className = 'vault-key-btn';
    btn.textContent = '🔑';
    btn.title = 'Change vault password';
    btn.style.display = 'none';                     // renderLogo() reveals it when apt
    btn.addEventListener('click', openChangePassModal);
    logo.insertAdjacentElement('afterend', btn);
  }

  /* ── First-launch: offer to set a password ────────────────────────────────
     Without one the database is a plain SQLite file — AI descriptions, notes,
     view counts, finishes and the Obsession history are all readable by anyone
     who opens the folder. That's the honest reason to ask, and asking once at
     the start is far more effective than making individual features opt-in to
     work around it.

     Asked ONCE: the answer lives server-side (vault-settings.json via
     /api/settings/app), so a different browser profile doesn't re-nag someone
     who already said no. Declining is a real choice, not a deferral. */

  async function maybeOfferPassword() {
    let s;
    try {
      const resp = await fetch('/api/settings/app');
      if (!resp.ok) return;                       // locked or older server
      s = await resp.json();
    } catch { return; }
    if (s.encrypted || s.passwordPromptSeen) return;

    const remember = () => fetch('/api/settings/app', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passwordPromptSeen: true }),
    }).catch(() => {});

    const ov = document.createElement('div');
    ov.id = 'vaultFirstRunModal';
    ov.className = 'vault-modal-overlay';
    ov.innerHTML = `
      <div class="vault-modal" role="dialog" aria-label="Protect your library">
        <h3>🔐 Protect your library?</h3>
        <p class="vault-modal-hint">
          Vault stores everything in one database next to the app: AI descriptions
          and tags, your notes, ratings, watch counts and history. <b>Without a
          password that file is readable by anyone with access to this computer.</b>
        </p>
        <p class="vault-modal-hint">
          Setting one encrypts the whole database at rest. You can still leave
          auto-lock off (Settings → <b>Auto-lock after: 0</b>) so it never locks
          while you're using it — the encryption applies either way.
        </p>
        <p class="vault-modal-hint">
          <b>There is no recovery.</b> Lose the password and the library is gone,
          so use something you'll remember or store it in a password manager.
        </p>
        <div class="vault-modal-actions">
          <button class="vault-btn" id="vaultFirstRunSkip">Not now</button>
          <button class="vault-btn vault-btn-primary" id="vaultFirstRunSet">Set a password</button>
        </div>
      </div>`;
    document.body.appendChild(ov);

    ov.querySelector('#vaultFirstRunSkip').addEventListener('click', () => {
      remember();
      ov.remove();
    });
    ov.querySelector('#vaultFirstRunSet').addEventListener('click', () => {
      remember();
      ov.remove();
      openCreatePassModal();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    $logo()?.addEventListener('click', onLogoClick);
    installKeyButton();
    document.addEventListener('pointerdown', touchActivity, true);
    document.addEventListener('keydown', touchActivity, true);
    // Watching counts as being there: a video or audio file playing in the
    // main player or the mini player keeps the vault open, hands off the
    // keyboard or not. Paused, ended, or still loading does not count, so a
    // player left on a paused frame still locks on schedule. Native playback
    // of a fully buffered file makes no requests at all, which is why this
    // cannot rely on data traffic the way scans and remux segments do.
    setInterval(() => {
      const playing = [...document.querySelectorAll(
        '#mediaPlayerContent video, #mediaPlayerContent audio, #miniPlayerMedia video, #miniPlayerMedia audio'
      )].some(el => !el.paused && !el.ended && el.readyState >= 2);
      if (playing) touchActivity();
    }, 30 * 1000);
    refreshStatus();
    setInterval(refreshStatus, 45 * 1000);
    // After the setup-tools banner has had its moment — one prompt at a time.
    setTimeout(maybeOfferPassword, 1200);
  });
})();
