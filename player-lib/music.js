/* =========================================================================
   MUSIC ID (client) — songs data layer, fingerprint queue, sidebar section.

   Fingerprinting is strictly opt-in per file: the selection bar's 🎵 button
   or the player sidebar's section. After a file is fingerprinted the server
   immediately scans it against known songs AND other fingerprinted files
   (auto-links carry an `auto` badge and are one-click editable/removable).
   ========================================================================= */

/* ── State ─────────────────────────────────────────────────────────────── */

let musicSongs = [];        // [{id,title,artist,source,media_count,ref_count,...}]
let musicLinksMap = {};     // media_id → [song_id, ...]
let musicTools = null;      // { ok, fpcalcVersion, ffmpegVersion, errors }
let musicStats = null;
let _musicPollTimer = null;
let _musicSeenJobs = new Set(); // media_ids whose completion we already toasted

function mediaSongIds(mediaId) {
  return musicLinksMap[mediaId] || [];
}

function musicSongById(id) {
  return musicSongs.find(s => s.id === id);
}

function musicSongLabel(s) {
  if (!s) return '?';
  return `${s.artist} – ${s.title}${s.remix_label ? ` (${s.remix_label})` : ''}`;
}

function musicFmtTime(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '--:--';
  sec = Math.max(0, Math.floor(Number(sec)));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function musicParseTime(str) {
  if (str == null || str === '') return null;
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some(n => Number.isNaN(n))) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/* ── Data loading ──────────────────────────────────────────────────────── */

async function loadMusicData({ rerender = true } = {}) {
  try {
    const [songs, map] = await Promise.all([
      fetch('/api/music/songs').then(r => r.json()),
      fetch('/api/music/links-map').then(r => r.json()),
    ]);
    musicSongs = Array.isArray(songs) ? songs : [];
    musicLinksMap = {};
    for (const [k, v] of Object.entries(map || {})) musicLinksMap[Number(k)] = v;
  } catch {
    musicSongs = [];
    musicLinksMap = {};
  }
  renderSongFilterOptions();
  if (rerender && typeof renderResults === 'function') renderResults();
  if (typeof window.editorOnMusicData === 'function') window.editorOnMusicData();
}

async function loadMusicStatus() {
  try {
    const st = await fetch('/api/music/status').then(r => r.json());
    musicTools = st.tools;
    musicStats = st.stats;
    if (st.queue && (st.queue.active || st.queue.queued.length)) startMusicQueuePolling();
    return st;
  } catch { return null; }
}

/** Populate the Library filter panel's 🎵 Song dropdown. */
function renderSongFilterOptions() {
  const sel = document.getElementById('filterSong');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Songs</option>' +
    musicSongs.map(s =>
      `<option value="${s.id}">${escapeHtml(musicSongLabel(s))} (${s.media_count})</option>`
    ).join('');
  if (cur && sel.querySelector(`option[value="${cur}"]`)) sel.value = cur;
}

/* ── Fingerprint queue ─────────────────────────────────────────────────── */

async function musicEnqueue(ids, { force = false } = {}) {
  const resp = await fetch('/api/music/fingerprint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, force }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    showToast('⚠ ' + (err.error || 'Fingerprint request failed'));
    return null;
  }
  const result = await resp.json();
  startMusicQueuePolling();
  return result;
}

/** Selection-bar action: queue every selected video/audio file. */
async function fingerprintSelected() {
  const ids = [...selectedIds].map(getMediaById)
    .filter(m => m && ['video', 'audio'].includes(m.media_type))
    .map(m => m.id);
  if (!ids.length) { showToast('Select video or audio files first'); return; }
  const r = await musicEnqueue(ids);
  if (r) {
    showToast(`🎵 ${r.queued} queued for fingerprinting` +
      (r.skipped ? ` (${r.skipped} skipped — already done or not A/V)` : ''));
  }
}

function startMusicQueuePolling() {
  if (_musicPollTimer) return;
  const tick = async () => {
    let q;
    try { q = await fetch('/api/music/queue').then(r => r.json()); }
    catch { return; }

    const pending = (q.active ? 1 : 0) + q.queued.length;
    updateEditorTabBadge(pending);

    // Toast + refresh for jobs that just finished
    for (const j of q.recent || []) {
      if (_musicSeenJobs.has(j.media_id)) continue;
      _musicSeenJobs.add(j.media_id);
      if (j.state === 'done') {
        const foundTxt = j.found?.length
          ? ` → ${j.found.map(f => `${f.artist} – ${f.title}`).join('; ')}`
          : ' — no known songs matched yet';
        showToast(`🎵 ${j.filename}: ${j.chunks} chunks${foundTxt}`);
      } else if (j.state === 'error') {
        showToast(`⚠ Fingerprint failed for ${j.filename}: ${j.error}`);
      }
      loadMusicData();
      musicReloadSidebar(j.media_id);
    }

    if (typeof window.editorOnQueueUpdate === 'function') window.editorOnQueueUpdate(q);

    // Live-refresh the sidebar progress for the active job
    if (q.active) musicSidebarProgress(q.active);

    if (pending === 0) {
      clearInterval(_musicPollTimer);
      _musicPollTimer = null;
      updateEditorTabBadge(0);
    }
  };
  _musicPollTimer = setInterval(tick, 1500);
  tick();
}

function updateEditorTabBadge(n) {
  const b = document.getElementById('editorTabBadge');
  if (!b) return;
  b.style.display = n > 0 ? 'inline-flex' : 'none';
  b.textContent = n > 0 ? n : '';
  b.title = n > 0 ? `${n} file(s) in the fingerprint queue` : '';
}

/* ── Selection bar → Editor ────────────────────────────────────────────── */

function selectedVideoIds() {
  return [...selectedIds].map(getMediaById)
    .filter(m => m && m.media_type === 'video')
    .map(m => m.id);
}

function openEditorWithSelection(layout) {
  const ids = selectedVideoIds();
  // No hard cap — the Editor warns above 4 (concurrent decode is drive-bound)
  if (ids.length < 2) { showToast('Select at least 2 videos'); return; }
  switchTab('editor');
  if (typeof editorOpenMix === 'function') editorOpenMix(ids, layout);
}

/* ── Player sidebar section ────────────────────────────────────────────── */

/** Synchronous shell — async content fills in via loadMusicSidebar. */
function renderMusicSidebarSection(media) {
  if (!media || !['video', 'audio'].includes(media.media_type)) return '';
  // Kick the async load on next tick (after the sidebar HTML lands in the DOM)
  setTimeout(() => loadMusicSidebar(media.id), 0);
  return `
    <div class="detail-section music-section" data-media-id="${media.id}">
      <h3>🎵 Music ID</h3>
      <div class="field-content music-sidebar-body" data-music-box="${media.id}">
        <span class="music-hint">Loading…</span>
      </div>
    </div>
  `;
}

/**
 * A data attribute, not an id: the player sidebar and the library modal render
 * the same section, and both can be in the DOM at once (trashing a duplicate
 * from the sidebar opens the modal). Two nodes then shared one id, so
 * getElementById picked whichever came first in document order — the modal —
 * and the sidebar's box sat on "Loading…" for good. Filling every match instead
 * makes the number of open surfaces irrelevant.
 */
function musicBoxes(mediaId) {
  return document.querySelectorAll(`[data-music-box="${mediaId}"]`);
}

async function loadMusicSidebar(mediaId) {
  const boxes = musicBoxes(mediaId);
  if (!boxes.length) return;
  let info;
  try { info = await fetch(`/api/music/media/${mediaId}`).then(r => r.json()); }
  catch {
    boxes.forEach(b => { b.innerHTML = '<span class="music-hint">Music ID unavailable</span>'; });
    return;
  }
  // Same rule as the server route: never trust a cached NEGATIVE. The setup
  // banner can install fpcalc mid-session, and this sidebar's warning has to
  // notice on its next open rather than after a reload.
  if (!musicTools || !musicTools.ok) await loadMusicStatus();
  const html = musicSidebarHtml(mediaId, info);
  // Re-query: loadMusicStatus() awaited, so a surface may have opened or closed.
  musicBoxes(mediaId).forEach(b => { b.innerHTML = html; });
}

function musicSidebarHtml(mediaId, info) {
  const parts = [];

  // Fingerprint state / actions
  if (!info.fingerprinted) {
    if (musicTools && !musicTools.ok) {
      parts.push(`<div class="music-hint music-warn">⚠ ${escapeHtml(musicTools.errors[0] || 'fpcalc/ffmpeg missing')}</div>`);
    } else {
      parts.push(`
        <div class="music-fp-cta">
          <button class="music-btn music-btn-primary" onclick="musicFingerprintOne(${mediaId})">🎵 Fingerprint &amp; scan</button>
          <span class="music-hint">One-time (~5–15s per 5 min) — then this file auto-matches songs across the library</span>
        </div>
        <div class="music-progress" id="musicProgress-${mediaId}" style="display:none;">
          <div class="music-progress-fill"></div><span class="music-progress-label">queued…</span>
        </div>
      `);
    }
  } else {
    parts.push(`
      <div class="music-fp-status">
        <span class="music-chunkcount" title="Fingerprint chunks stored (30s windows, silence skipped)">${info.chunks} chunks</span>
        <button class="music-btn" onclick="musicOpenSections(${mediaId})" title="Chunk-level timeline — see which sections matched what, drag-select to tag songs">🧬 Sections</button>
        <button class="music-btn" onclick="musicRescanOne(${mediaId}, this)" title="Re-match against known songs and other fingerprinted files">🔄 Rescan</button>
        ${info.songs.length ? `<button class="music-btn" onclick="startAudioSimilarity(${mediaId})" title="Rank the library by songs shared with this file">≈ Similar</button>` : ''}
        <button class="music-btn music-btn-danger" onclick="musicRemoveFingerprints(${mediaId}, this)" title="Delete this file's fingerprints and auto-detected songs (manual tags survive)">✕ Remove</button>
      </div>
      <div class="music-progress" id="musicProgress-${mediaId}" style="display:none;">
        <div class="music-progress-fill"></div><span class="music-progress-label"></span>
      </div>
    `);
  }

  // Songs in this file
  if (info.songs.length) {
    parts.push(`<div class="music-song-list">` + info.songs.map(l => {
      const unknown = l.source === 'auto-cluster' && l.title.startsWith('Unknown Song');
      const badge = l.method === 'manual'
        ? '<span class="music-badge music-badge-manual" title="Tagged by hand — used as a reference">manual</span>'
        : `<span class="music-badge music-badge-auto" title="Auto-detected by fingerprint match — click ✎ to correct">auto${l.confidence ? ` ${Math.round(l.confidence * 100)}%` : ''}</span>`;
      return `
        <div class="music-song-row">
          <button class="music-time" onclick="musicSeekTo(${l.start_sec ?? 0}, ${mediaId})" title="Jump to ${musicFmtTime(l.start_sec)}">${musicFmtTime(l.start_sec)}–${musicFmtTime(l.end_sec)}</button>
          <div class="music-song-info" title="${escapeHtml(l.artist)} – ${escapeHtml(l.title)}">
            <div class="music-song-title">${unknown ? '❓ ' : ''}${escapeHtml(l.title)}</div>
            <div class="music-song-artist">${escapeHtml(l.artist)}</div>
          </div>
          ${badge}
          <button class="music-icon-btn" onclick="musicEditLink(${l.link_id}, ${mediaId})" title="Edit — swap song or adjust times">✎</button>
          <button class="music-icon-btn music-icon-danger" onclick="musicRemoveLink(${l.link_id}, ${mediaId}, this)" title="Remove this song from the file">×</button>
        </div>`;
    }).join('') + `</div>`);
  } else if (info.fingerprinted) {
    parts.push('<div class="music-hint">No songs matched yet — tag one below to teach the matcher.</div>');
  }

  // Manual tag form (collapsed)
  parts.push(`
    <button class="music-btn music-add-toggle" onclick="musicToggleAddForm(${mediaId})">＋ Tag a song</button>
    <div class="music-add-form" id="musicAddForm-${mediaId}" style="display:none;">
      <div class="music-form-row">
        <input type="text" class="music-input" id="musicAddArtist-${mediaId}" placeholder="Artist" autocomplete="off">
        <input type="text" class="music-input" id="musicAddTitle-${mediaId}" placeholder="Title" autocomplete="off">
      </div>
      <div class="music-ac-panel" id="musicAddAc-${mediaId}" style="display:none;"></div>
      <div class="music-form-row">
        <label class="music-time-field">start
          <input type="text" class="music-input music-input-time" id="musicAddStart-${mediaId}" placeholder="0:00">
          <button class="music-icon-btn" onclick="musicGrabTime('musicAddStart-${mediaId}')" title="Use the current player position — needs the file playing">⏱</button>
        </label>
        <label class="music-time-field">end
          <input type="text" class="music-input music-input-time" id="musicAddEnd-${mediaId}" placeholder="3:45">
          <button class="music-icon-btn" onclick="musicGrabTime('musicAddEnd-${mediaId}')" title="Use the current player position — needs the file playing">⏱</button>
        </label>
        <button class="music-btn music-btn-primary" onclick="musicSaveManualTag(${mediaId}, this)">Save</button>
      </div>
      <div class="music-hint">Give it a start AND end (≥ 8s) — the segment becomes a reference that finds this song in every other fingerprinted file.</div>
    </div>
  `);

  return parts.join('');
}

/** Refresh the section if the sidebar is showing this media. */
function musicReloadSidebar(mediaId) {
  if (musicBoxes(mediaId).length) loadMusicSidebar(mediaId);
}

/** Paint fingerprint progress into the sidebar while a job runs. */
function musicSidebarProgress(job) {
  const el = document.getElementById(`musicProgress-${job.media_id}`);
  if (!el) return;
  el.style.display = 'flex';
  const fill = el.querySelector('.music-progress-fill');
  const label = el.querySelector('.music-progress-label');
  const pct = Math.round((job.progress || 0) * 100);
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = job.state === 'fingerprinting' ? `fingerprinting ${pct}%` : job.state;
  // Hide the CTA button while running
  const cta = el.parentElement?.querySelector('.music-fp-cta .music-btn-primary');
  if (cta) cta.disabled = true;
}

/* ── Sidebar actions ───────────────────────────────────────────────────── */

async function musicFingerprintOne(mediaId) {
  const r = await musicEnqueue([mediaId]);
  if (r) {
    if (r.queued) showToast('🎵 Queued for fingerprinting');
    else showToast('Already fingerprinted (use Rescan to re-match)');
    const el = document.getElementById(`musicProgress-${mediaId}`);
    if (el && r.queued) { el.style.display = 'flex'; el.querySelector('.music-progress-label').textContent = 'queued…'; }
  }
}

async function musicRescanOne(mediaId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '🔄 Scanning…'; }
  try {
    const r = await fetch(`/api/music/media/${mediaId}/scan`, { method: 'POST' }).then(x => x.json());
    if (r.error) showToast('⚠ ' + r.error);
    else showToast(r.found?.length
      ? `🎵 Found: ${r.found.map(f => `${f.artist} – ${f.title}`).join('; ')}`
      : 'No new matches');
  } finally {
    loadMusicData();
    musicReloadSidebar(mediaId);
  }
}

async function musicRemoveFingerprints(mediaId, btn) {
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Really remove?';
    setTimeout(() => {
      if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = '✕ Remove'; }
    }, 3500);
    return;
  }
  await fetch(`/api/music/media/${mediaId}/fingerprints`, { method: 'DELETE' });
  showToast('Fingerprints removed — manual tags kept');
  loadMusicData();
  musicReloadSidebar(mediaId);
}

async function musicRemoveLink(linkId, mediaId, btn) {
  if (btn && !btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.classList.remove('armed'); } }, 3000);
    return;
  }
  await fetch(`/api/music/links/${linkId}`, { method: 'DELETE' });
  showToast('Song removed from file');
  loadMusicData();
  musicReloadSidebar(mediaId);
  if (typeof window.editorOnMusicData === 'function') window.editorOnMusicData();
}

/** Jump to a song's start. From the library modal nothing is playing yet, so
    detailSeekTo opens the file first (mediaId is optional for old callers). */
function musicSeekTo(sec, mediaId) {
  if (mediaId != null && typeof detailSeekTo === 'function') {
    if (detailSeekTo(mediaId, sec)) return;
  }
  const el = document.querySelector('#mediaPlayerContent video, #mediaPlayerContent audio');
  if (el && Number.isFinite(sec)) el.currentTime = Math.max(0, sec);
}

function musicPlayerTime() {
  const el = document.querySelector('#mediaPlayerContent video, #mediaPlayerContent audio');
  return el ? el.currentTime : null;
}

function musicGrabTime(inputId) {
  const t = musicPlayerTime();
  // No playhead to read from the library modal — refuse rather than stamp 0:00.
  if (t == null) { showToast('⏱ Needs playback — play this file, then grab the position'); return; }
  const input = document.getElementById(inputId);
  if (input) input.value = musicFmtTime(t);
}

/* ── Manual tag form ───────────────────────────────────────────────────── */

function musicToggleAddForm(mediaId) {
  const form = document.getElementById(`musicAddForm-${mediaId}`);
  if (!form) return;
  const show = form.style.display === 'none';
  form.style.display = show ? '' : 'none';
  if (show) {
    musicWireAutocomplete(mediaId);
    document.getElementById(`musicAddArtist-${mediaId}`)?.focus();
  }
}

/**
 * Server-backed song picker: existing songs (🔗 = fingerprinted/auto-matchable,
 * 🎵 = known but no reference yet, ❓ = unnamed cluster) plus the seed catalog
 * (📇 — artist/title names only, no audio yet). Focusing an empty field shows
 * the top entries, so it works as a picker, not just typed autocomplete.
 */
function musicWireSuggest(artistInput, titleInput, panel) {
  if (!artistInput || !titleInput || !panel || artistInput._acWired) return;
  artistInput._acWired = true;

  let timer = null;
  const render = (items) => {
    if (!items.length) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    panel.innerHTML = items.map(it => {
      const icon = it.kind === 'seed' ? '📇' : (it.fingerprinted ? '🔗' : (it.unknown ? '❓' : '🎵'));
      const iconTitle = it.kind === 'seed' ? 'From the seed catalog — no fingerprint yet'
        : it.fingerprinted ? 'Fingerprinted — videos auto-match this song'
        : it.unknown ? 'Unnamed cluster' : 'Known song (no reference fingerprint yet)';
      const meta = it.kind === 'seed'
        ? '<span class="music-ac-count">seed</span>'
        : `<span class="music-ac-count">${it.media_count} file${it.media_count === 1 ? '' : 's'}</span>`;
      return `
        <div class="music-ac-item" data-artist="${escapeHtml(it.artist)}" data-title="${escapeHtml(it.title)}">
          <span class="music-ac-icon" title="${iconTitle}">${icon}</span>
          <span class="music-ac-label">${escapeHtml(it.artist)} – ${escapeHtml(it.title)}</span>
          ${meta}
        </div>`;
    }).join('');
    panel.querySelectorAll('.music-ac-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        artistInput.value = el.dataset.artist;
        titleInput.value = el.dataset.title;
        panel.style.display = 'none';
      });
    });
  };

  const update = () => {
    const q = (artistInput.value + ' ' + titleInput.value).trim();
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        render(await fetch('/api/music/song-suggest?q=' + encodeURIComponent(q)).then(r => r.json()));
      } catch { panel.style.display = 'none'; }
    }, 180);
  };

  [artistInput, titleInput].forEach(el => {
    el.addEventListener('input', update);
    el.addEventListener('focus', update);
    el.addEventListener('blur', () => setTimeout(() => { panel.style.display = 'none'; }, 150));
  });
}

function musicWireAutocomplete(mediaId) {
  musicWireSuggest(
    document.getElementById(`musicAddArtist-${mediaId}`),
    document.getElementById(`musicAddTitle-${mediaId}`),
    document.getElementById(`musicAddAc-${mediaId}`)
  );
}

async function musicSaveManualTag(mediaId, btn) {
  const artist = document.getElementById(`musicAddArtist-${mediaId}`)?.value.trim();
  const title = document.getElementById(`musicAddTitle-${mediaId}`)?.value.trim();
  const start = musicParseTime(document.getElementById(`musicAddStart-${mediaId}`)?.value);
  const end = musicParseTime(document.getElementById(`musicAddEnd-${mediaId}`)?.value);

  if (!artist || !title) { showToast('Artist and title are required'); return; }
  if (start == null) { showToast('Set a start time (⏱ grabs the player position)'); return; }

  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const { id: songId } = await fetch('/api/music/songs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, artist }),
    }).then(r => r.json());

    const { id: linkId } = await fetch('/api/music/links', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_id: mediaId, song_id: songId, start_sec: start, end_sec: end, method: 'manual' }),
    }).then(r => r.json());

    // With a proper segment, build the reference + hunt the song everywhere
    if (end != null && end - start >= 8) {
      btn.textContent = 'Building reference…';
      const r = await fetch(`/api/music/links/${linkId}/reference`, { method: 'POST' }).then(x => x.json());
      if (r.error) showToast('⚠ Reference: ' + r.error);
      else showToast(r.matched?.length
        ? `🎵 Tagged — also found in ${r.matched.length} other file(s)!`
        : '🎵 Tagged — reference saved for future scans');
    } else {
      showToast('🎵 Tagged (add an end time ≥ 8s after start to enable auto-matching)');
    }
  } catch (e) {
    showToast('⚠ Tag failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
    loadMusicData();
    musicReloadSidebar(mediaId);
  }
}

/* ── Section Identifier: chunk-level timeline + tagging ─────────────────
   MUSICID_SECTIONS_SPEC.md — every stored chunk colored by its best match,
   drag-select a section, tag it; the selected chunks' stored fingerprints
   become the song's references instantly (no ffmpeg re-run). */

let _msec = null; // { mediaId, data, selStart, selEnd, body }

function msecColorClass(songId) { return `msec-c${songId % 8}`; }

/** Server stride-2+last pick count (label preview; dedup may create fewer). */
function msecRefCount(n) {
  if (n <= 0) return 0;
  const evens = Math.ceil(n / 2);
  return (n > 1 && (n - 1) % 2 !== 0) ? evens + 1 : evens;
}

function msecContained() {
  const { data, selStart, selEnd } = _msec;
  if (selStart == null || selEnd == null) return [];
  return data.chunks.filter(c => c.start_sec >= selStart - 0.5 && c.end_sec <= selEnd + 0.5);
}

async function musicOpenSections(mediaId) {
  let data;
  try { data = await fetch(`/api/music/media/${mediaId}/sections`).then(r => r.json()); }
  catch { showToast('⚠ Sections view unavailable'); return; }
  if (data.error) { showToast('⚠ ' + data.error); return; }
  if (!data.chunks.length) { showToast('Fingerprint this file first'); return; }

  const m = getMediaById(mediaId);
  const { overlay, body } = musicModal(
    `🧬 Sections — ${escapeHtml(m?.filename || `#${mediaId}`)} · ${musicFmtTime(data.duration_seconds)} · ${data.chunks.length} chunks`,
    `
    <div class="msec-wrap">
      <div class="msec-links" id="msecLinks" title="Existing song spans — click to select & pre-fill"></div>
      <div class="msec-track" id="msecTrack">
        <div id="msecChunks"></div>
        <div class="msec-sel" id="msecSel" style="display:none;"></div>
      </div>
      <div class="msec-ruler" id="msecRuler"></div>
      <div class="msec-info" id="msecInfo">Drag across the timeline to select a section — chunks fully inside it teach the matcher. Click a chunk to preview.</div>
      <div class="msec-form">
        <div class="music-form-row">
          <input type="text" class="music-input" id="msecArtist" placeholder="Artist" autocomplete="off">
          <input type="text" class="music-input" id="msecTitle" placeholder="Title" autocomplete="off">
        </div>
        <div class="music-ac-panel" id="msecAc" style="display:none;"></div>
        <div class="music-form-row">
          <label class="msec-check" title="Auto-detected spans of OTHER songs overlapping the selection are removed/trimmed/split — manual tags are never touched">
            <input type="checkbox" id="msecReplace" checked> replace overlapping auto-detections
          </label>
          <button class="music-btn" id="msecPlay" title="Play / pause the player behind this modal">▶</button>
          <button class="music-btn" id="msecPreview" disabled title="Seek the player to the selection start">⏮ Selection</button>
          <button class="music-btn music-btn-primary" id="msecTag" disabled>Tag section + teach matcher</button>
        </div>
      </div>
      <div class="msec-legend" id="msecLegend"></div>
    </div>`
  );
  overlay.querySelector('.music-modal').classList.add('music-modal-wide');
  _msec = { mediaId, data, selStart: null, selEnd: null, body };

  musicWireSuggest(body.querySelector('#msecArtist'), body.querySelector('#msecTitle'), body.querySelector('#msecAc'));
  msecRenderTimeline();
  msecWireTrack();

  body.querySelector('#msecPreview').addEventListener('click', () => {
    if (_msec?.selStart != null) { musicSeekTo(_msec.selStart); msecPlay(); }
  });
  body.querySelector('#msecTag').addEventListener('click', () => msecSubmit());
  msecWirePlayButton(body);
}

/** The <video>/<audio> playing behind the modal (null if the player is closed). */
function msecPlayerEl() {
  return document.querySelector('#mediaPlayerContent video, #mediaPlayerContent audio');
}

function msecPlay() {
  msecPlayerEl()?.play?.().catch(() => {});
}

/** Basic play/pause on the modal; icon stays in sync with the real player. */
function msecWirePlayButton(body) {
  const btn = body.querySelector('#msecPlay');
  const el = msecPlayerEl();
  if (!el) { btn.disabled = true; btn.title = 'Open the file in the player to control playback'; return; }

  const sync = () => { btn.textContent = el.paused ? '▶' : '⏸'; };
  // Self-removing listeners: once the modal is gone, unhook from the element
  const onState = () => {
    if (!btn.isConnected) {
      el.removeEventListener('play', onState);
      el.removeEventListener('pause', onState);
      return;
    }
    sync();
  };
  el.addEventListener('play', onState);
  el.addEventListener('pause', onState);
  sync();

  btn.addEventListener('click', () => {
    if (el.paused) el.play().catch(() => {}); else el.pause();
  });
}

function msecRenderTimeline() {
  const { data, body } = _msec;
  const dur = Math.max(1, data.duration_seconds);
  const pct = (t) => (Math.max(0, Math.min(dur, t)) / dur * 100).toFixed(3) + '%';

  // Existing link spans (manual = solid border; ❓ = unnamed cluster)
  body.querySelector('#msecLinks').innerHTML = data.links.map(l => {
    const s = l.start_sec ?? 0, e = l.end_sec ?? dur;
    const unknown = l.source === 'auto-cluster' && l.title.startsWith('Unknown Song');
    const label = `${unknown ? '❓ ' : ''}${escapeHtml(l.title)}`;
    const tip = `${escapeHtml(l.artist)} – ${escapeHtml(l.title)} · ${musicFmtTime(s)}–${musicFmtTime(e)} · ${l.method}${l.confidence ? ` ${Math.round(l.confidence * 100)}%` : ''}`;
    return `<div class="msec-link ${msecColorClass(l.song_id)} ${l.method === 'manual' ? 'msec-manual' : ''}"
      style="left:${pct(s)};width:${pct(e - s)};" title="${tip}"
      data-start="${s}" data-end="${e}" data-song="${l.song_id}" data-link="${l.link_id}">${label}</div>`;
  }).join('');

  // Chunk cells on the hop grid (each cell = a chunk's first hop; last runs out)
  const hop = data.chunk_hop;
  const cells = data.chunks.map((c, i) => {
    const last = i === data.chunks.length - 1;
    const w = last ? c.end_sec - c.start_sec : Math.min(hop, c.end_sec - c.start_sec);
    let cls = 'msec-none', tip = `${musicFmtTime(c.start_sec)}–${musicFmtTime(c.end_sec)} · no match`;
    if (c.match) {
      const song = data.songs[c.match.song_id];
      const weak = c.match.ber > data.scan_threshold;
      cls = msecColorClass(c.match.song_id) + (weak ? ' msec-weak' : '');
      tip = `${musicFmtTime(c.start_sec)}–${musicFmtTime(c.end_sec)} · ${song ? `${song.artist} – ${song.title}` : `song #${c.match.song_id}`}`
        + ` · BER ${(c.match.ber * 100).toFixed(1)}%${weak ? ' (weak)' : ''}`;
    }
    return `<div class="msec-chunk ${cls}" style="left:${pct(c.start_sec)};width:${pct(w)};"
      title="${escapeHtml(tip)}" data-start="${c.start_sec}"></div>`;
  });
  const gapCells = data.gaps.map(g =>
    `<div class="msec-chunk msec-silent" style="left:${pct(g.start_sec)};width:${pct(Math.min(hop, g.end_sec - g.start_sec))};"
      title="${musicFmtTime(g.start_sec)} · silence (not fingerprinted)"></div>`);
  body.querySelector('#msecChunks').innerHTML = cells.join('') + gapCells.join('');

  // Ruler
  const interval = dur <= 60 ? 10 : dur <= 300 ? 30 : dur <= 900 ? 60 : dur <= 3600 ? 300 : 600;
  let marks = '';
  for (let t = 0; t <= dur; t += interval) {
    marks += `<span class="msec-mark" style="left:${pct(t)}">${musicFmtTime(t)}</span>`;
  }
  body.querySelector('#msecRuler').innerHTML = marks;

  // Legend: every song present in chunks or links
  body.querySelector('#msecLegend').innerHTML = Object.entries(data.songs).map(([sid, s]) =>
    `<span><span class="msec-legend-swatch ${msecColorClass(Number(sid))}"></span>${s.source === 'auto-cluster' && s.title.startsWith('Unknown Song') ? '❓ ' : ''}${escapeHtml(s.artist)} – ${escapeHtml(s.title)}</span>`
  ).join('') + `<span><span class="msec-legend-swatch msec-none"></span>unmatched</span>
    <span><span class="msec-legend-swatch msec-silent"></span>silence</span>`;

  // Link click → select its range + pre-fill the song (✎ rename for Unknowns)
  body.querySelectorAll('.msec-link').forEach(el => {
    el.addEventListener('click', () => {
      const songId = Number(el.dataset.song);
      const song = data.songs[songId];
      msecSetSelection(Number(el.dataset.start), Number(el.dataset.end));
      if (song) {
        body.querySelector('#msecArtist').value = song.artist;
        body.querySelector('#msecTitle').value = song.title;
        if (song.source === 'auto-cluster') {
          musicEditSong(songId, () => msecRefresh());
        }
      }
    });
  });
}

function msecSetSelection(startSec, endSec) {
  const { data, body } = _msec;
  const hop = data.chunk_hop, dur = data.duration_seconds;
  // Snap to the hop grid: start down, end up
  let s = Math.max(0, Math.floor(startSec / hop) * hop);
  let e = Math.min(dur, Math.ceil(endSec / hop) * hop);
  if (e - s < 1) { _msec.selStart = _msec.selEnd = null; }
  else { _msec.selStart = s; _msec.selEnd = e; }

  const sel = body.querySelector('#msecSel');
  const info = body.querySelector('#msecInfo');
  const canTag = _msec.selStart != null && (_msec.selEnd - _msec.selStart) >= 8;
  body.querySelector('#msecTag').disabled = !canTag;
  body.querySelector('#msecPreview').disabled = _msec.selStart == null;

  if (_msec.selStart == null) {
    sel.style.display = 'none';
    info.textContent = 'Drag across the timeline to select a section.';
    return;
  }
  sel.style.display = '';
  sel.style.left = (s / dur * 100) + '%';
  sel.style.width = ((e - s) / dur * 100) + '%';
  const n = msecContained().length;
  info.innerHTML = `<strong>${musicFmtTime(s)} – ${musicFmtTime(e)}</strong> · ${n} chunk${n === 1 ? '' : 's'} contained`
    + (n ? ` → ≈ ${msecRefCount(n)} reference${msecRefCount(n) === 1 ? '' : 's'}` : ' — too short to teach from chunks (will fingerprint the segment instead)')
    + (canTag ? '' : ' · <em>selection must be ≥ 8s</em>');
}

function msecWireTrack() {
  const { body } = _msec;
  const track = body.querySelector('#msecTrack');
  let drag = null; // { x0, t0, moved }

  const tAt = (clientX) => {
    const r = track.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return f * _msec.data.duration_seconds;
  };

  track.addEventListener('pointerdown', (e) => {
    drag = { x0: e.clientX, t0: tAt(e.clientX), moved: false };
    try { track.setPointerCapture(e.pointerId); } catch {}
  });
  track.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x0) > 4) drag.moved = true;
    if (drag.moved) {
      const t1 = tAt(e.clientX);
      msecSetSelection(Math.min(drag.t0, t1), Math.max(drag.t0, t1));
    }
  });
  track.addEventListener('pointerup', (e) => {
    if (!drag) return;
    if (!drag.moved) {
      // Plain click → seek the player to that chunk for audible verification
      const cell = e.target.closest('.msec-chunk');
      musicSeekTo(cell ? Number(cell.dataset.start) : drag.t0);
    } else if (_msec?.selStart != null) {
      // Drag finished → audition the selection from its (snapped) start
      musicSeekTo(_msec.selStart);
      msecPlay();
    }
    drag = null;
  });
  track.addEventListener('pointercancel', () => { drag = null; });
}

async function msecSubmit() {
  const { mediaId, body, selStart, selEnd } = _msec;
  const artist = body.querySelector('#msecArtist').value.trim();
  const title = body.querySelector('#msecTitle').value.trim();
  if (!artist || !title) { showToast('Artist and title are required'); return; }
  if (selStart == null) { showToast('Select a section first'); return; }

  const btn = body.querySelector('#msecTag');
  btn.disabled = true;
  btn.textContent = 'Teaching…';
  try {
    const r = await fetch(`/api/music/media/${mediaId}/tag-section`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start_sec: selStart, end_sec: selEnd,
        song: { artist, title },
        replace_overlapping_auto: body.querySelector('#msecReplace').checked,
      }),
    }).then(x => x.json());
    if (r.error) { showToast('⚠ ' + r.error); return; }

    let msg = `🧬 Tagged — ${r.refs_created} reference${r.refs_created === 1 ? '' : 's'}`;
    if (r.matched?.length) msg += `, found in ${r.matched.length} other file${r.matched.length === 1 ? '' : 's'}!`;
    showToast(msg);
    if (r.conflicts?.length) {
      setTimeout(() => showToast(`⚠ Overlaps ${r.conflicts.length} manual tag(s) — left untouched`), 1200);
    }
    await msecRefresh();
    loadMusicData();
    musicReloadSidebar(mediaId);
  } catch (e) {
    showToast('⚠ Tag failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Tag section + teach matcher';
  }
}

/** Re-fetch sections and re-render in place (after a tag or song rename). */
async function msecRefresh() {
  if (!_msec) return;
  try {
    const data = await fetch(`/api/music/media/${_msec.mediaId}/sections`).then(r => r.json());
    if (!data.error) { _msec.data = data; msecRenderTimeline(); msecSetSelection(_msec.selStart ?? 0, _msec.selEnd ?? 0); }
  } catch {}
}

/* ── Audio similarity: rank the library by shared songs ────────────────── */
// Two files that contain the same songs sound "alike" — the metric is a
// rarity-weighted Jaccard over each file's song sets (a song found in 2
// files says far more than one found in 40). Computed entirely client-side
// from musicLinksMap; only files sharing ≥1 song score at all.

let audioSimAnchorId = null;
let audioSimScores = null; // Map media_id → 0..1

function computeAudioSimilarity(anchorId) {
  const anchorSongs = new Set(mediaSongIds(anchorId));
  if (!anchorSongs.size) return null;

  const usage = new Map(musicSongs.map(s => [s.id, Math.max(2, s.media_count || 2)]));
  const w = (sid) => 1 / Math.log2(1 + (usage.get(sid) || 2)); // rarity weight

  const anchorWeight = [...anchorSongs].reduce((a, s) => a + w(s), 0);
  const scores = new Map();
  for (const [midStr, songIds] of Object.entries(musicLinksMap)) {
    const mid = Number(midStr);
    if (mid === anchorId) continue;
    let shared = 0;
    let unionW = anchorWeight;
    for (const sid of new Set(songIds)) {
      if (anchorSongs.has(sid)) shared += w(sid);
      else unionW += w(sid);
    }
    if (shared > 0) scores.set(mid, shared / unionW); // weighted Jaccard
  }
  return scores;
}

function startAudioSimilarity(anchorId) {
  const scores = computeAudioSimilarity(anchorId);
  if (!scores || scores.size === 0) {
    showToast('No other file shares a song with this one yet — fingerprint more files');
    return;
  }
  audioSimAnchorId = anchorId;
  audioSimScores = scores;
  if (typeof hideTilePopover === 'function') hideTilePopover();
  if (typeof closeMediaPlayer === 'function' &&
      document.getElementById('mediaPlayerOverlay')?.classList.contains('active')) {
    closeMediaPlayer();
  }
  if (typeof switchTab === 'function') switchTab('library');
  renderAudioSimBar();
  applyFilters();
  const m = getMediaById(anchorId);
  showToast(`≈ ${scores.size} file(s) share audio with ${m?.filename || 'this file'}`);
}

function clearAudioSimilarity() {
  audioSimAnchorId = null;
  audioSimScores = null;
  renderAudioSimBar();
  applyFilters();
}

/** Strip above the grid while similarity ranking is active. */
function renderAudioSimBar() {
  let bar = document.getElementById('audioSimBar');
  if (!bar) {
    const grid = document.getElementById('resultsGrid');
    if (!grid) return;
    bar = document.createElement('div');
    bar.id = 'audioSimBar';
    bar.className = 'audiosim-bar';
    grid.parentElement.insertBefore(bar, grid);
  }
  if (!audioSimScores) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  const m = getMediaById(audioSimAnchorId);
  bar.style.display = 'flex';
  bar.innerHTML = `
    <span class="audiosim-label">≈ <strong>Audio similarity</strong> — ranked by songs shared with
      <strong>${escapeHtml(m?.filename || `#${audioSimAnchorId}`)}</strong>
      · ${audioSimScores.size} match${audioSimScores.size === 1 ? '' : 'es'}</span>
    <button class="music-btn" onclick="clearAudioSimilarity()">✕ Clear</button>
  `;
}

/* ── Lightweight modal + link/song editors ─────────────────────────────── */

function musicModal(title, bodyHtml) {
  document.getElementById('musicModal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'musicModal';
  overlay.className = 'music-modal-overlay';
  overlay.innerHTML = `
    <div class="music-modal">
      <div class="music-modal-head">
        <span>${title}</span>
        <button class="music-modal-close" title="Close">✕</button>
      </div>
      <div class="music-modal-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.music-modal-close').addEventListener('click', close);
  return { overlay, body: overlay.querySelector('.music-modal-body'), close };
}

/** Edit a media↔song link: swap the song, fix times. Editing an auto match
 *  converts it to manual (it becomes reference-eligible). */
async function musicEditLink(linkId, mediaId) {
  const info = await fetch(`/api/music/media/${mediaId}`).then(r => r.json());
  const link = info.songs.find(l => l.link_id === linkId);
  if (!link) { showToast('Link not found'); return; }

  const { body, close } = musicModal('✎ Edit song match', `
    <div class="music-form-row">
      <input type="text" class="music-input" id="mel-artist" placeholder="Artist" value="${escapeHtml(link.artist)}" autocomplete="off">
      <input type="text" class="music-input" id="mel-title" placeholder="Title" value="${escapeHtml(link.title)}" autocomplete="off">
    </div>
    <div class="music-ac-panel" id="mel-ac" style="display:none;"></div>
    <div class="music-form-row">
      <label class="music-time-field">start
        <input type="text" class="music-input music-input-time" id="mel-start" value="${link.start_sec != null ? musicFmtTime(link.start_sec) : ''}">
        <button class="music-icon-btn" id="mel-start-grab" title="Use the current player position — needs the file playing">⏱</button>
      </label>
      <label class="music-time-field">end
        <input type="text" class="music-input music-input-time" id="mel-end" value="${link.end_sec != null ? musicFmtTime(link.end_sec) : ''}">
        <button class="music-icon-btn" id="mel-end-grab" title="Use the current player position — needs the file playing">⏱</button>
      </label>
    </div>
    <div class="music-hint">${link.method !== 'manual' ? 'Saving converts this auto match to a manual tag (trusted as a reference).' : ''}</div>
    <div class="music-form-row music-form-actions">
      <button class="music-btn music-btn-primary" id="mel-save">Save</button>
      <button class="music-btn" id="mel-cancel">Cancel</button>
    </div>
  `);

  const artistIn = body.querySelector('#mel-artist');
  const titleIn = body.querySelector('#mel-title');
  const acPanel = body.querySelector('#mel-ac');
  musicWireSuggest(artistIn, titleIn, acPanel);

  body.querySelector('#mel-start-grab').addEventListener('click', () => {
    const t = musicPlayerTime();
    if (t != null) body.querySelector('#mel-start').value = musicFmtTime(t);
  });
  body.querySelector('#mel-end-grab').addEventListener('click', () => {
    const t = musicPlayerTime();
    if (t != null) body.querySelector('#mel-end').value = musicFmtTime(t);
  });
  body.querySelector('#mel-cancel').addEventListener('click', close);

  body.querySelector('#mel-save').addEventListener('click', async () => {
    const artist = artistIn.value.trim();
    const title = titleIn.value.trim();
    if (!artist || !title) { showToast('Artist and title are required'); return; }
    const start = musicParseTime(body.querySelector('#mel-start').value);
    const end = musicParseTime(body.querySelector('#mel-end').value);

    let songId = link.song_id;
    if (artist !== link.artist || title !== link.title) {
      const r = await fetch('/api/music/songs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, artist }),
      }).then(x => x.json());
      songId = r.id;
    }
    await fetch(`/api/music/links/${linkId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song_id: songId, start_sec: start, end_sec: end, method: 'manual' }),
    });
    close();
    showToast('🎵 Match updated');
    loadMusicData();
    musicReloadSidebar(mediaId);
    if (typeof window.editorOnMusicData === 'function') window.editorOnMusicData();
  });
}

/** Rename/identify a song (fixes every linked file at once). Used by the
 *  Editor songs panel; renaming an Unknown clears its ❓ badge. */
function musicEditSong(songId, onDone) {
  const s = musicSongById(songId);
  if (!s) return;
  const { body, close } = musicModal('✎ Edit song', `
    <div class="music-form-row">
      <input type="text" class="music-input" id="mes-artist" placeholder="Artist" value="${escapeHtml(s.artist)}">
      <input type="text" class="music-input" id="mes-title" placeholder="Title" value="${escapeHtml(s.title)}">
    </div>
    <div class="music-form-row">
      <input type="text" class="music-input" id="mes-remix" placeholder="Remix label (optional)" value="${escapeHtml(s.remix_label || '')}">
    </div>
    ${s.source === 'auto-cluster' ? '<div class="music-hint">❓ Auto-clustered placeholder — naming it identifies the track in every linked file.</div>' : ''}
    <div class="music-form-row music-form-actions">
      <button class="music-btn music-btn-primary" id="mes-save">Save</button>
      <button class="music-btn" id="mes-cancel">Cancel</button>
    </div>
  `);
  body.querySelector('#mes-cancel').addEventListener('click', close);
  body.querySelector('#mes-save').addEventListener('click', async () => {
    const artist = body.querySelector('#mes-artist').value.trim();
    const title = body.querySelector('#mes-title').value.trim();
    const remix = body.querySelector('#mes-remix').value.trim();
    if (!artist || !title) { showToast('Artist and title are required'); return; }
    await fetch(`/api/music/songs/${songId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artist, title, remix_label: remix, is_remix: remix ? 1 : 0 }),
    });
    close();
    showToast('🎵 Song updated everywhere it appears');
    await loadMusicData();
    if (onDone) onDone();
  });
}

/* ── Boot ──────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  loadMusicData({ rerender: false });
  loadMusicStatus();
  // Song filter dropdown participates in filtering like the other selects
  document.getElementById('filterSong')?.addEventListener('change', () => {
    if (typeof applyFilters === 'function') applyFilters();
  });
});
