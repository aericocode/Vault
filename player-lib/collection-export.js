/* =========================================================================
   COLLECTION EXPORT - save an open collection as an M3U8 playlist
   (PLAYLISTS_SPEC, build step 2; Modern UI review items 2 and 11)

   Export exists so VLC / PotPlayer can play a collection. The collection
   bar's Export… button opens a small dialog with one choice, how each file is
   written: Full path, Relative to the playlist, or Through Vault. Save
   playlist calls POST /api/collections/:id/export/save, which opens the
   native Save As window on the server and writes the file there. The path
   only ever comes from that window.

   In an encrypted library all three are offered, Through Vault preselected.
   Full path or Relative shows a warning (the playlist is a plain file that
   says where the files are) and Save stays off until "I understand" is
   ticked; only then does the request carry allowPaths: true. The server
   refuses those two without it (403 FILES_ENCRYPTED), whatever this page
   does. The last choice is remembered in localStorage.

   Same dialog in both looks (it reuses the vault-modal styles).
   ========================================================================= */

const COLL_EXPORT_PREFS_KEY = 'collExportPrefs';
const COLL_EXPORT_LINKS = ['full', 'relative', 'vault'];

function _collExportPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(COLL_EXPORT_PREFS_KEY) || '{}') || {};
    return { links: COLL_EXPORT_LINKS.includes(p.links) ? p.links : 'full' };
  } catch {
    return { links: 'full' };
  }
}

function _saveCollExportPrefs(prefs) {
  try { localStorage.setItem(COLL_EXPORT_PREFS_KEY, JSON.stringify(prefs)); } catch {}
}

/** Is the library encrypted? Asked fresh each time the dialog opens. */
async function _collExportEncrypted() {
  try {
    const r = await fetch('/api/vault/status');
    if (!r.ok) return true;          // unknown: offer only the safe choice
    return !!(await r.json()).encrypted;
  } catch {
    return true;
  }
}

/** "1 file" / "3 files" */
const _collExportFiles = (n) => `${n} file${n === 1 ? '' : 's'}`;

/** The toast after a save, from the server's answer. */
function collExportSavedText(data) {
  let msg = `Saved playlist to ${data.path}.`;
  const left = Number(data.skipped) || 0;
  const full = Number(data.fullPathCount) || 0;
  if (left > 0) msg += ` ${_collExportFiles(left)} left out.`;
  // Usually files on another drive or share, but not only, so no reason given.
  if (full > 0) msg += full === 1 ? ' 1 file uses a full path instead.' : ` ${full} files use a full path instead.`;
  return msg;
}

function _collExportChoice(name, value, label, hint, { checked, disabled, extra } = {}) {
  return `
    <label class="coll-export-choice${disabled ? ' is-disabled' : ''}">
      <input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
      <span class="coll-export-text">
        <b>${label}</b>
        <span class="coll-export-hint">${hint}</span>
        ${extra ? `<span class="coll-export-hint coll-export-note">${extra}</span>` : ''}
      </span>
    </label>`;
}

function closeCollectionExport() {
  const ov = document.getElementById('collExportModal');
  if (!ov || ov.dataset.busy === '1') return;
  ov.remove();
  document.removeEventListener('keydown', _collExportKey, true);
}

function _collExportKey(e) {
  if (e.key === 'Escape' && document.getElementById('collExportModal')) {
    e.stopPropagation();
    e.preventDefault();
    closeCollectionExport();
  }
}

async function openCollectionExport(id) {
  const c = typeof getCollectionById === 'function' ? getCollectionById(id) : null;
  if (!c || document.getElementById('collExportModal')) return;
  const encrypted = await _collExportEncrypted();
  const prefs = _collExportPrefs();
  if (encrypted) prefs.links = 'vault';

  const ov = document.createElement('div');
  ov.id = 'collExportModal';
  ov.className = 'vault-modal-overlay';
  ov.innerHTML = `
    <div class="vault-modal coll-export-modal" role="dialog" aria-modal="true" aria-labelledby="collExportTitle">
      <h3 id="collExportTitle"></h3>
      <fieldset class="coll-export-group">
        <legend>How each file is written in the playlist</legend>
        ${_collExportChoice('collExportLinks', 'full', 'Full path', 'Works from anywhere on this PC.',
          { checked: prefs.links === 'full' })}
        ${_collExportChoice('collExportLinks', 'relative', 'Relative to the playlist',
          'Keeps working if you move the playlist and the files together, for example to another drive or PC.',
          { checked: prefs.links === 'relative' })}
        ${_collExportChoice('collExportLinks', 'vault', 'Through Vault', 'Plays through Vault, so Vault must be open and unlocked.', {
          checked: prefs.links === 'vault',
          extra: encrypted ? 'The playlist file itself is not encrypted. It lists file names.' : '',
        })}
      </fieldset>
      ${encrypted ? `
      <div class="coll-export-warn" id="collExportWarn" role="alert" hidden>
        <p>${COLL_EXPORT_PATHS_WARNING}</p>
        <label class="coll-export-ack">
          <input type="checkbox" id="collExportAck">
          <span>I understand</span>
        </label>
      </div>` : ''}
      <div class="vault-modal-actions">
        <button type="button" class="vault-btn" id="collExportCancel">Cancel</button>
        <button type="button" class="vault-btn vault-btn-primary" id="collExportSave">Save playlist</button>
      </div>
    </div>`;
  // The name goes in as text, never as markup.
  ov.querySelector('#collExportTitle').textContent = `Export “${c.name}”`;
  document.body.appendChild(ov);

  ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeCollectionExport(); });
  ov.querySelector('#collExportCancel').addEventListener('click', closeCollectionExport);
  ov.querySelector('#collExportSave').addEventListener('click', () => _collExportSave(id, ov));
  if (encrypted) {
    ov.dataset.encrypted = '1';
    ov.querySelector('.coll-export-group').addEventListener('change', () => _collExportSyncWarning(ov));
    ov.querySelector('#collExportAck').addEventListener('change', () => _collExportSyncWarning(ov));
    _collExportSyncWarning(ov);
  }
  document.addEventListener('keydown', _collExportKey, true);
  ov.querySelector('#collExportSave').focus();
}

/** The warning shown before a plain file lists where an encrypted library's files are. */
const COLL_EXPORT_PATHS_WARNING = 'This playlist will list where your files are, in a plain file anyone can open. Keep it somewhere safe.';

/** The links chosen, and whether they write paths from an encrypted library. */
function _collExportChosen(ov) {
  const links = ov.querySelector('input[name="collExportLinks"]:checked')?.value || 'vault';
  const pathsFromEncrypted = ov.dataset.encrypted === '1' && links !== 'vault';
  const ack = ov.querySelector('#collExportAck');
  return { links, pathsFromEncrypted, acknowledged: !!(ack && ack.checked) };
}

/**
 * Encrypted library: Full path or Relative shows the warning, and Save stays
 * off until "I understand" is ticked. Changing the choice clears the tick.
 */
function _collExportSyncWarning(ov) {
  const warn = ov.querySelector('#collExportWarn');
  const ack = ov.querySelector('#collExportAck');
  const save = ov.querySelector('#collExportSave');
  if (!warn || !ack || !save || ov.dataset.busy === '1') return;
  const { links, pathsFromEncrypted } = _collExportChosen(ov);
  if (ov.dataset.warnFor !== links) { ack.checked = false; ov.dataset.warnFor = links; }
  warn.hidden = !pathsFromEncrypted;
  save.disabled = pathsFromEncrypted && !ack.checked;
}

async function _collExportSave(id, ov) {
  if (ov.dataset.busy === '1') return;
  const { links, pathsFromEncrypted, acknowledged } = _collExportChosen(ov);
  if (pathsFromEncrypted && !acknowledged) return;
  _saveCollExportPrefs({ links });

  const saveBtn = ov.querySelector('#collExportSave');
  const cancelBtn = ov.querySelector('#collExportCancel');
  const exportBtn = document.getElementById('collExportBtn');
  ov.dataset.busy = '1';
  saveBtn.disabled = true;
  cancelBtn.disabled = true;
  saveBtn.textContent = 'Choose where to save…';
  if (exportBtn) exportBtn.disabled = true;

  let resp = null;
  let data = {};
  let netErr = null;
  try {
    resp = await fetch(`/api/collections/${id}/export/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // allowPaths only after the warning was acknowledged (checked above).
      body: JSON.stringify(pathsFromEncrypted ? { links, allowPaths: true } : { links }),
    });
    data = await resp.json().catch(() => ({}));
  } catch (err) {
    resp = null;
    netErr = err;
  }

  delete ov.dataset.busy;
  if (exportBtn && exportBtn.isConnected) exportBtn.disabled = false;

  if (resp && resp.ok && data.canceled) {
    closeCollectionExport();
    return;
  }
  if (resp && resp.ok && data.path) {
    closeCollectionExport();
    showToast(collExportSavedText(data));
    return;
  }
  // Still open, so the user can try again or cancel.
  saveBtn.disabled = false;
  cancelBtn.disabled = false;
  saveBtn.textContent = 'Save playlist';
  _collExportSyncWarning(ov);
  if (resp && resp.status === 423) return;   // the lock screen takes over
  // The collections error toast (collections.js): the server's own sentence
  // when it has one (a picker already open), else plain words.
  let err = netErr;
  if (resp) {
    err = new Error(data.error || `Server returned ${resp.status}`);
    err.status = resp.status;
    err.code = data.code;
    if (!data.error) err.name = 'HttpError';
  }
  collErrorToast(err, 'saving the playlist');
}
