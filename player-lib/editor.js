/* =========================================================================
   EDITOR - Stack/Grid synced playback, layering effects, mixes, exports.

   Two modes inside #editorContainer:
     HOME  — songs browser (search artist/title), Music ID status + queue,
             saved mixes, export jobs.
     MIX   — the synced player (port of the samples' sync stage): any number
             of videos stacked or gridded (no hard cap — concurrent decode is
             drive-bound, warned above 4), one master clock + drift
             correction, per-layer opacity/effects/volume, sync nudges,
             presets, ffmpeg export. Beat bar rides the master video.

   Playback alignment: if every file in the mix shares a song, each track
   auto-seeks to that song's start in that file (offsets come free from the
   fingerprint matcher); otherwise tracks auto-snap to the master on load via
   pairwise fingerprint fine-alignment (similar-audio stacks), with nudge
   buttons / draggable sync rows for manual touch-up.
   ========================================================================= */

/* ── Effects (per-tile alpha / blend) — mirrors lib/musicid/effects.js ─── */

const EDITOR_EFFECT_TYPES = ['uniform', 'linear-gradient', 'soft-fade', 'radial', 'wipe-split', 'blend'];
const EDITOR_BLEND_MODES = ['screen', 'multiply', 'difference', 'overlay', 'darken', 'lighten'];

function editorClamp01(n) { n = Number(n); if (!Number.isFinite(n)) return 1; return Math.max(0, Math.min(1, n)); }

// NOTE: layer opacity is SEPARATE from the mask/blend effect — the op slider
// and the Balanced/All-100% helpers only touch opacity, never the effect.
function editorEffectToCss(effect) {
  const e = effect || { type: 'uniform' };
  switch (e.type) {
    case 'uniform':
      return { opacity: 1, maskImage: '', mixBlendMode: '' };
    case 'linear-gradient': {
      const dir = `${(e.angle ?? 90).toFixed(1)}deg`;
      const s0 = `${Math.round(editorClamp01(e.stop0 ?? 0) * 100)}%`;
      const s1 = `${Math.round(editorClamp01(e.stop1 ?? 1) * 100)}%`;
      return {
        opacity: 1,
        maskImage: `linear-gradient(${dir}, rgba(0,0,0,${(e.alpha0 ?? 0).toFixed(3)}) ${s0}, rgba(0,0,0,${(e.alpha1 ?? 1).toFixed(3)}) ${s1})`,
        mixBlendMode: '',
      };
    }
    case 'soft-fade': {
      const dir = `${(e.angle ?? 90).toFixed(1)}deg`;
      return {
        opacity: 1,
        maskImage: `linear-gradient(${dir}, rgba(0,0,0,${(e.alpha0 ?? 0).toFixed(3)}) 0%, rgba(0,0,0,${(e.alpha1 ?? 1).toFixed(3)}) 100%)`,
        mixBlendMode: '',
      };
    }
    case 'radial': {
      const cx = `${Math.round(editorClamp01(e.cx ?? 0.5) * 100)}%`;
      const cy = `${Math.round(editorClamp01(e.cy ?? 0.5) * 100)}%`;
      const inner = `${Math.round(editorClamp01(e.inner ?? 0.3) * 100)}%`;
      const outer = `${Math.round(editorClamp01(e.outer ?? 0.7) * 100)}%`;
      return {
        opacity: 1,
        maskImage: `radial-gradient(circle at ${cx} ${cy}, rgba(0,0,0,${(e.alpha_in ?? 1).toFixed(3)}) ${inner}, rgba(0,0,0,${(e.alpha_out ?? 0).toFixed(3)}) ${outer})`,
        mixBlendMode: '',
      };
    }
    case 'wipe-split': {
      const dir = `${(e.angle ?? 90).toFixed(1)}deg`;
      const pos = `${Math.round(editorClamp01(e.position ?? 0.5) * 100)}%`;
      return {
        opacity: 1,
        maskImage: `linear-gradient(${dir}, rgba(0,0,0,${(e.alpha0 ?? 1).toFixed(3)}) ${pos}, rgba(0,0,0,${(e.alpha1 ?? 0).toFixed(3)}) ${pos})`,
        mixBlendMode: '',
      };
    }
    case 'blend':
      return {
        opacity: 1,
        maskImage: '',
        mixBlendMode: EDITOR_BLEND_MODES.includes(e.mode) ? e.mode : 'screen',
      };
    default:
      return { opacity: 1, maskImage: '', mixBlendMode: '' };
  }
}

function editorApplyEffectToTile(tileEl, effect, layerOpacity = 1) {
  const css = editorEffectToCss(effect);
  const videoEl = tileEl?.querySelector('video');
  if (!videoEl) return;
  videoEl.style.opacity = String(editorClamp01(layerOpacity));
  videoEl.style.webkitMaskImage = css.maskImage;
  videoEl.style.maskImage = css.maskImage;
  videoEl.style.mixBlendMode = css.mixBlendMode;
}

/**
 * Merge a track's layer opacity into its effect for the ffmpeg exporter
 * (the server-side schema keeps opacity inside the effect object).
 */
function editorExportEffect(effect, layerOpacity = 1) {
  const op = editorClamp01(layerOpacity);
  const e = effect || { type: 'uniform' };
  if (!e.type || e.type === 'uniform') return { type: 'uniform', opacity: op };
  if (e.type === 'blend') return { ...e, opacity: op };
  const scaled = { ...e };
  for (const k of ['alpha0', 'alpha1', 'alpha_in', 'alpha_out']) {
    if (scaled[k] != null) scaled[k] = editorClamp01(scaled[k]) * op;
  }
  return scaled;
}

/* ── Editor state ──────────────────────────────────────────────────────── */

let editorMix = null;          // active mix context (null = home)
let editorSubTab = 'mix';      // 'mix' (stack editor) | 'pmv' (PMV Studio)
let _editorHomeSongsQ = '';
let _editorHomeSource = '';
let _editorExportPoll = null;

function editorEl() { return document.getElementById('editorContainer'); }

/** Tab entry point. */
function renderEditor() {
  if (editorMix) return;       // mix DOM persists; nothing to rebuild
  if (editorSubTab === 'pmv' && typeof renderPmvHome === 'function') {
    renderPmvHome();
    return;
  }
  renderEditorHome();
}

/** Pause the mix (without tearing it down) when the user leaves the tab. */
function editorPauseIfActive() {
  if (editorMix?.pauseAll) editorMix.pauseAll();
  // PMV jobs run server-side; just stop the UI poll while away
  if (typeof pmvPauseIfActive === 'function') pmvPauseIfActive();
}

/* =========================================================================
   HOME — song cards (video-thumb mosaics) → open a song → pick videos
   ========================================================================= */

let _editorOpenSongId = null;

function renderEditorHome() {
  const root = editorEl();
  if (!root) return;
  root.innerHTML = `
    ${typeof editorSubTabsHtml === 'function' ? editorSubTabsHtml('mix') : ''}
    <div class="editor-home">
      <section class="editor-panel editor-songs-panel">
        <div class="editor-panel-head">
          <h2>🎵 Songs</h2>
          <input type="text" class="music-input editor-song-search" id="editorSongSearch"
            placeholder="Search artist or title…" value="${escapeHtml(_editorHomeSongsQ)}" autocomplete="off">
          <select class="editor-select" id="editorSongSource">
            <option value="">All</option>
            <option value="unknown" ${_editorHomeSource === 'unknown' ? 'selected' : ''}>❓ Unknown only</option>
            <option value="identified" ${_editorHomeSource === 'identified' ? 'selected' : ''}>Identified</option>
          </select>
          <button class="music-btn" onclick="editorOpenSeedPacks()"
            title="Import/export song seed packs — reference fingerprints that identify songs without needing the audio files">📦 Seed packs</button>
        </div>
        <div id="editorSongsBody"><span class="music-hint">Loading…</span></div>
      </section>
      <aside class="editor-side">
        <section class="editor-panel" id="editorStatusPanel"></section>
        <section class="editor-panel">
          <h3>💾 Saved mixes</h3>
          <div id="editorPresetList" class="editor-mini-list"><span class="music-hint">Loading…</span></div>
        </section>
        <section class="editor-panel">
          <h3>📤 Exports</h3>
          <div id="editorExportList" class="editor-mini-list"><span class="music-hint">Loading…</span></div>
        </section>
      </aside>
    </div>
  `;

  const search = document.getElementById('editorSongSearch');
  let t = null;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      _editorHomeSongsQ = search.value.trim();
      _editorOpenSongId = null;             // searching returns to the card grid
      renderEditorSongList();
    }, 250);
  });
  document.getElementById('editorSongSource').addEventListener('change', (e) => {
    _editorHomeSource = e.target.value;
    _editorOpenSongId = null;
    renderEditorSongList();
  });

  renderEditorSongList();
  renderEditorStatusPanel();
  renderEditorPresetList();
  renderEditorExportList();
}

/* ── Seed packs: song fingerprints without the audio files ─────────────── */

function editorOpenSeedPacks() {
  const { body, close } = musicModal('📦 Song seed packs', `
    <div class="music-hint">A seed pack (<b>vault-songseed.json</b>) carries song <b>reference fingerprints</b> —
      no audio files. Import one and your fingerprinted library is rescanned for matches,
      so new songs can identify themselves in videos you already have.
      Nothing is ever downloaded automatically: you pick the file.</div>
    <div class="music-form-row music-form-actions">
      <button class="music-btn music-btn-primary" id="seedpack-import">⬆ Import pack…</button>
      <a class="music-btn" href="/api/music/seedpack/export" download title="Your songs + reference fingerprints as a shareable pack (no audio)">⬇ Export my songs</a>
      <button class="music-btn" id="seedpack-close">Close</button>
    </div>
    <div class="music-hint" id="seedpack-status" style="display:none"></div>
    <input type="file" id="seedpack-file" accept=".json,application/json" style="display:none">
  `);
  const status = body.querySelector('#seedpack-status');
  const fileInput = body.querySelector('#seedpack-file');
  body.querySelector('#seedpack-close').addEventListener('click', close);
  body.querySelector('#seedpack-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) editorImportSeedPack(fileInput.files[0], status, body.querySelector('#seedpack-import'));
  });
}

async function editorImportSeedPack(file, statusEl, btn) {
  const say = (msg) => { statusEl.style.display = ''; statusEl.innerHTML = msg; };
  btn.disabled = true;
  try {
    say(`Reading ${escapeHtml(file.name)}…`);
    const text = await file.text();
    say('Importing…');
    const r = await fetch('/api/music/seedpack/import', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: text,
    }).then(resp => resp.json());
    if (r.error) throw new Error(r.error);

    const added = `${r.songs_added} new song(s), ${r.fps_added} fingerprint(s)` +
      (r.fps_skipped ? ` (${r.fps_skipped} already known)` : '') +
      (r.fps_invalid ? `, ${r.fps_invalid} invalid` : '');
    if (!r.rescan_files) {
      say(`✓ ${added}. Nothing new to rescan.`);
      btn.disabled = false;
      return;
    }

    // Background rematch: poll until the sweep finishes
    say(`✓ ${added}.<br>Rescanning ${r.rescan_files} fingerprinted file(s)… 0%`);
    const poll = setInterval(async () => {
      let s;
      try { s = await fetch('/api/music/seedpack/rematch-status').then(x => x.json()); } catch { return; }
      if (s.running) {
        say(`✓ ${added}.<br>Rescanning… ${Math.round((s.done / Math.max(1, s.total)) * 100)}% — ${s.new_links} match(es) so far`);
        return;
      }
      clearInterval(poll);
      btn.disabled = false;
      say(`✓ ${added}.<br>${s.error ? '⚠ ' + escapeHtml(s.error) + ' — ' : ''}Rescan done: <b>${s.new_links}</b> new match(es) across your library.`);
      showToast(`📦 Seed pack imported — ${s.new_links} new song match(es)`);
      renderEditorSongList();
      if (typeof loadDatabase === 'function') loadDatabase();   // 🎵 tile badges
    }, 1000);
  } catch (e) {
    btn.disabled = false;
    say('⚠ Import failed: ' + escapeHtml(e.message));
  }
}

/* ── Songs area: card grid or open-song picker ─────────────────────────── */

function renderEditorSongList() {
  if (_editorOpenSongId) renderEditorOpenSong(_editorOpenSongId);
  else renderEditorSongCards();
}

/**
 * Song cards — collections-style tiles with a 2×2 mosaic of up to four
 * linked-video thumbnails. Songs are reference points here: entries with no
 * linked VIDEOS (e.g. a lone labeled MP3) stay hidden until a video matches.
 */
async function renderEditorSongCards() {
  const box = document.getElementById('editorSongsBody');
  if (!box) return;
  const params = new URLSearchParams();
  if (_editorHomeSongsQ) params.set('q', _editorHomeSongsQ);
  if (_editorHomeSource) params.set('source', _editorHomeSource);
  let songs = [];
  try { songs = await fetch('/api/music/songs?' + params).then(r => r.json()); } catch {}

  const withVideos = songs.filter(s => (s.video_count || 0) > 0);
  const refOnly = songs.length - withVideos.length;

  if (!withVideos.length) {
    box.innerHTML = `<div class="music-hint editor-empty">
      ${_editorHomeSongsQ ? 'No songs with videos match.'
        : 'No songs found in videos yet. Fingerprint videos in the Library (select → 🎵 Fingerprint); scan an MP3 folder with "fingerprint audio" to build named references first.'}
      ${refOnly ? `<br>(${refOnly} reference song${refOnly === 1 ? '' : 's'} from audio files waiting for a video match)` : ''}
    </div>`;
    return;
  }

  box.innerHTML = `
    <div class="editor-song-grid">
      ${withVideos.map(s => {
        const unknown = s.source === 'auto-cluster';
        const thumbs = (s.first_video_ids || []).slice(0, 4);
        const cells = Array.from({ length: 4 }, (_, i) => thumbs[i]
          ? `<img class="coll-mosaic-img" loading="lazy" src="/thumb/${thumbs[i]}" alt="" onerror="this.style.visibility='hidden'">`
          : '<div class="coll-mosaic-empty"></div>').join('');
        return `
          <div class="editor-song-card ${unknown ? 'is-unknown' : ''}" onclick="editorOpenSong(${s.id})"
            title="${escapeHtml(s.artist)} – ${escapeHtml(s.title)} — ${s.video_count} video${s.video_count === 1 ? '' : 's'}">
            <div class="tile-thumb coll-mosaic">${cells}
              <span class="coll-tile-badge">${unknown ? '❓' : '🎵'}</span>
            </div>
            <div class="tile-name">${escapeHtml(s.title)}</div>
            <div class="tile-meta">
              <span class="editor-song-sub">${escapeHtml(s.artist)}</span>
              <span class="coll-count">${s.video_count} video${s.video_count === 1 ? '' : 's'}${s.ref_count ? ' · 🔗' : ''}</span>
            </div>
          </div>`;
      }).join('')}
    </div>
    ${refOnly ? `<div class="music-hint editor-refonly-hint">${refOnly} audio-only reference song${refOnly === 1 ? '' : 's'} hidden — they appear once a video matches them.</div>` : ''}
  `;
}

function editorOpenSong(songId) {
  _editorOpenSongId = songId;
  renderEditorSongList();
}

function editorCloseSong() {
  _editorOpenSongId = null;
  renderEditorSongList();
}

/**
 * Open-song view: header strip + selectable VIDEO cards (hover shows the
 * full details popover incl. path — that's how you choose stack members).
 */
async function renderEditorOpenSong(songId) {
  const box = document.getElementById('editorSongsBody');
  if (!box) return;
  box.innerHTML = '<span class="music-hint">Loading…</span>';

  let song = null, links = [];
  try {
    [song, links] = await Promise.all([
      fetch(`/api/music/songs/${songId}`).then(r => r.json()),
      fetch(`/api/music/songs/${songId}/links`).then(r => r.json()),
    ]);
  } catch {}
  if (!song || song.error) { editorCloseSong(); return; }

  const videos = links.filter(l => l.media_type === 'video' && getMediaById(l.media_id));
  const audioRefs = links.filter(l => l.media_type !== 'video').length;
  const unknown = song.source === 'auto-cluster';

  box.innerHTML = `
    <div class="editor-song-head">
      <button class="music-btn" onclick="editorCloseSong()" title="Back to all songs">← Songs</button>
      <div class="editor-song-head-main">
        <div class="editor-song-head-title">${unknown ? '❓ ' : '🎵 '}${escapeHtml(song.title)}
          <button class="music-icon-btn" onclick="musicEditSong(${songId}, renderEditorSongList)" title="Rename / identify">✎</button>
        </div>
        <div class="editor-song-sub">${escapeHtml(song.artist)}${song.remix_label ? ` · ${escapeHtml(song.remix_label)}` : ''}
          · ${videos.length} video${videos.length === 1 ? '' : 's'}${audioRefs ? ` · ${audioRefs} audio reference${audioRefs === 1 ? '' : 's'}` : ''}</div>
      </div>
      <div class="editor-song-head-actions" id="editorOpenSongBtns"></div>
    </div>
    ${unknown ? '<div class="music-hint">❓ Unlabeled cluster — ✎ name it once and every linked file updates.</div>' : ''}
    ${videos.length ? '' : '<div class="music-hint editor-empty">No videos link to this song yet.</div>'}
    <div class="editor-picker-grid">
      ${videos.map(l => {
        const m = getMediaById(l.media_id);
        const duration = m.duration_seconds ? formatDuration(m.duration_seconds) : '';
        return `
          <div class="media-tile editor-pick-tile" data-id="${l.media_id}">
            <div class="tile-thumb" onclick="this.querySelector('.tile-select').click()">
              <img class="tile-img" loading="lazy" src="/thumb/${l.media_id}" alt=""
                onerror="this.parentElement.classList.add('thumb-fallback'); this.remove();">
              ${duration ? `<span class="tile-duration">${duration}</span>` : ''}
              <input type="checkbox" class="tile-select" checked
                onclick="event.stopPropagation()" onchange="editorSyncOpenSongButtons(${songId})">
            </div>
            <div class="tile-name" title="${escapeHtml(m.filename)}">${escapeHtml(m.filename)}</div>
            <div class="tile-meta">
              <span class="music-time">${musicFmtTime(l.start_sec)}–${musicFmtTime(l.end_sec)}</span>
              ${l.method === 'manual' || l.method === 'filename'
                ? '<span class="music-badge music-badge-manual">manual</span>'
                : `<span class="music-badge music-badge-auto">auto${l.confidence ? ` ${Math.round(l.confidence * 100)}%` : ''}</span>`}
            </div>
          </div>`;
      }).join('')}
    </div>
  `;
  editorSyncOpenSongButtons(songId);
}

function editorOpenSongChecked() {
  return [...document.querySelectorAll('.editor-picker-grid .tile-select:checked')]
    .map(cb => Number(cb.closest('.editor-pick-tile')?.dataset.id))
    .filter(Boolean);
}

function editorSyncOpenSongButtons(songId) {
  const bar = document.getElementById('editorOpenSongBtns');
  if (!bar) return;
  const n = editorOpenSongChecked().length;
  const tooFew = n < 2;
  const many = n > 4 ? ' (playback smoothness depends on drive speed)' : '';
  bar.innerHTML = `
    <button class="music-btn music-btn-primary" ${tooFew ? 'disabled' : ''}
      onclick="editorOpenMix(editorOpenSongChecked(), 'stack', ${songId})"
      title="Play the checked videos stacked, aligned on this song${many}">▤ Stack ${n}</button>
    <button class="music-btn" ${tooFew ? 'disabled' : ''}
      onclick="editorOpenMix(editorOpenSongChecked(), 'grid', ${songId})"
      title="Play the checked videos side by side${many}">▦ Grid ${n}</button>
    <button class="music-btn" onclick="editorShowSongInLibrary(${songId})" title="Filter the Library to files containing this song">🔍 In Library</button>
    <button class="music-icon-btn music-icon-danger" onclick="editorDeleteSong(${songId}, this)" title="Delete song (unlinks all files)">×</button>
  `;
}

async function editorDeleteSong(songId, btn) {
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    btn.title = 'Click again to delete';
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.classList.remove('armed'); } }, 3000);
    return;
  }
  await fetch(`/api/music/songs/${songId}`, { method: 'DELETE' });
  showToast('Song deleted — files and fingerprints untouched');
  loadMusicData();
  if (_editorOpenSongId === songId) _editorOpenSongId = null;
  renderEditorSongList();
}

function editorShowSongInLibrary(songId) {
  const sel = document.getElementById('filterSong');
  if (sel) {
    sel.value = String(songId);
    sel._syncCombo?.();
  }
  switchTab('library');
  applyFilters();
}

/* ── Status / presets / exports panels ─────────────────────────────────── */

async function renderEditorStatusPanel() {
  const box = document.getElementById('editorStatusPanel');
  if (!box) return;
  const st = await loadMusicStatus();
  if (!st) { box.innerHTML = '<h3>🎵 Music ID</h3><div class="music-hint">Status unavailable</div>'; return; }

  const t = st.tools;
  const s = st.stats;
  box.innerHTML = `
    <h3>🎵 Music ID</h3>
    ${t.ok
      ? '<div class="editor-tools-ok">✓ fpcalc + ffmpeg ready</div>'
      : `<div class="music-hint music-warn">⚠ ${escapeHtml(t.errors[0] || 'tools missing')}</div>`}
    <div class="editor-stats">
      <span title="Identified + placeholder songs">${s.songs} songs${s.unknown_songs ? ` (${s.unknown_songs} ❓)` : ''}</span>
      <span title="Files with stored fingerprints">${s.fingerprinted_media} files fingerprinted</span>
      <span title="Song ↔ file links">${s.links} links</span>
      <span title="Reference fingerprints that scans match against">${s.references} references</span>
    </div>
    <div class="editor-queue" id="editorQueueBox"></div>
  `;
  editorRenderQueue(st.queue);
}

function editorRenderQueue(q) {
  const box = document.getElementById('editorQueueBox');
  if (!box || !q) return;
  if (!q.active && !q.queued.length) {
    box.innerHTML = '<div class="music-hint">Queue idle — select files in the Library and hit 🎵 Fingerprint.</div>';
    return;
  }
  const rows = [];
  if (q.active) {
    const pct = Math.round((q.active.progress || 0) * 100);
    rows.push(`
      <div class="editor-queue-row">
        <span class="editor-queue-name" title="${escapeHtml(q.active.filename)}">${escapeHtml(q.active.filename)}</span>
        <div class="music-progress editor-queue-progress">
          <div class="music-progress-fill" style="width:${pct}%"></div>
          <span class="music-progress-label">${q.active.state === 'scanning' ? 'matching…' : pct + '%'}</span>
        </div>
      </div>`);
  }
  if (q.queued.length) {
    rows.push(`<div class="music-hint">＋ ${q.queued.length} queued</div>`);
  }
  box.innerHTML = rows.join('');
}

// music.js queue poller calls this on every tick
window.editorOnQueueUpdate = (q) => {
  if (!editorMix) editorRenderQueue(q);
};
window.editorOnMusicData = () => {
  if (!editorMix && document.getElementById('editorSongList')) renderEditorSongList();
};

async function renderEditorPresetList() {
  const box = document.getElementById('editorPresetList');
  if (!box) return;
  let presets = [];
  try { presets = await fetch('/api/music/presets').then(r => r.json()); } catch {}
  if (!presets.length) {
    box.innerHTML = '<span class="music-hint">Mixes you save in the player show up here.</span>';
    return;
  }
  box.innerHTML = presets.map(p => {
    let ids = [];
    try { ids = JSON.parse(p.media_ids); } catch {}
    const label = p.song_title ? `${p.song_artist} – ${p.song_title}` : `${ids.length} files`;
    return `
      <div class="editor-mini-row">
        <div class="editor-mini-main">
          <div class="editor-mini-title">${escapeHtml(p.name)}</div>
          <div class="editor-mini-sub">${escapeHtml(label)}</div>
        </div>
        <button class="music-btn" onclick="editorLoadPreset(${p.id})">▶</button>
        <button class="music-icon-btn music-icon-danger" onclick="editorDeletePreset(${p.id}, this)" title="Delete mix">×</button>
      </div>`;
  }).join('');
}

async function editorLoadPreset(id) {
  const p = await fetch(`/api/music/presets/${id}`).then(r => r.json());
  if (!p || p.error) { showToast('⚠ Mix not found'); return; }
  let ids = [], cfg = {};
  try { ids = JSON.parse(p.media_ids); } catch {}
  try { cfg = JSON.parse(p.config_json); } catch {}
  ids = ids.filter(mid => getMediaById(mid));
  if (ids.length < 2) { showToast('⚠ This mix\'s files are no longer in the library'); return; }
  await editorOpenMix(ids, cfg.l === 'grid' ? 'grid' : 'stack', p.song_id || null, { presetCfg: cfg, presetId: p.id, presetName: p.name });
}

async function editorDeletePreset(id, btn) {
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.classList.remove('armed'); } }, 3000);
    return;
  }
  await fetch(`/api/music/presets/${id}`, { method: 'DELETE' });
  renderEditorPresetList();
}

async function renderEditorExportList() {
  const box = document.getElementById('editorExportList');
  if (!box) return;
  let jobs = [];
  try { jobs = await fetch('/api/music/exports').then(r => r.json()); } catch {}
  if (!jobs.length) {
    box.innerHTML = '<span class="music-hint">Stack-mix exports land here — held in memory only until you ⬇ download them (never auto-saved to disk).</span>';
    clearInterval(_editorExportPoll); _editorExportPoll = null;
    return;
  }
  box.innerHTML = jobs.slice(0, 8).map(j => {
    const pct = Math.round((j.progress || 0) * 100);
    const status =
      j.status === 'done' ? (j.available === false
        ? `<span class="music-badge music-badge-auto" title="Exports stay in memory until downloaded — this one is gone (restart or vault lock). Render it again if you still need it.">expired</span>`
        : `<a class="music-btn" href="/api/music/exports/${j.id}/download" download title="Held in memory — download to save it">⬇</a>`) :
      j.status === 'failed' ? `<span class="music-badge music-badge-auto" title="${escapeHtml(j.error || '')}">failed</span>` :
      `<span class="editor-export-pct">${j.status === 'running' ? pct + '%' : 'queued'}</span>`;
    return `
      <div class="editor-mini-row">
        <div class="editor-mini-main">
          <div class="editor-mini-title" title="${escapeHtml(j.filename)}">${escapeHtml(j.filename)}</div>
          ${j.status === 'running' ? `<div class="music-progress editor-queue-progress"><div class="music-progress-fill" style="width:${pct}%"></div></div>` : ''}
        </div>
        ${status}
        <button class="music-icon-btn music-icon-danger" onclick="editorDeleteExport(${j.id}, this)" title="Delete export">×</button>
      </div>`;
  }).join('');

  const busy = jobs.some(j => j.status === 'pending' || j.status === 'running');
  if (busy && !_editorExportPoll) {
    _editorExportPoll = setInterval(() => {
      if (document.getElementById('editorExportList')) renderEditorExportList();
      else { clearInterval(_editorExportPoll); _editorExportPoll = null; }
    }, 2000);
  } else if (!busy && _editorExportPoll) {
    clearInterval(_editorExportPoll);
    _editorExportPoll = null;
  }
}

async function editorDeleteExport(id, btn) {
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.classList.remove('armed'); } }, 3000);
    return;
  }
  await fetch(`/api/music/exports/${id}`, { method: 'DELETE' });
  renderEditorExportList();
}

/* =========================================================================
   MIX (synced player)
   ========================================================================= */

async function editorOpenMix(mediaIds, layout = 'stack', songId = null, opts = {}) {
  mediaIds = (mediaIds || []).filter(id => getMediaById(id));
  // No hard track cap — concurrent decode is bounded by drive speed, and
  // buildMixUi warns above 4. (Stack rendering itself has no real limit.)
  if (mediaIds.length < 2) { showToast('Need at least 2 videos for a mix'); return; }

  if (editorMix) editorCloseMix({ silent: true });

  // Alignment: a song shared by ALL files auto-seeks each track to its start.
  // The server pins ?song= when the caller asked for one, and fine-aligns
  // non-anchor tracks to ~0.12s via the stored audio fingerprints (start_sec
  // arrives FINAL — no client-side offset math).
  let align = { song: null, tracks: null };
  try {
    const q = songId ? `&song=${songId}` : '';
    const r = await fetch(`/api/music/stack-align?ids=${mediaIds.join(',')}${q}`).then(x => x.json());
    if (r && r.song) align = r;
  } catch {}

  const song = align.song;
  const tracks = mediaIds.map(id => {
    const m = getMediaById(id);
    const a = align.tracks?.find(t => t.media_id === id);
    return {
      media_id: id,
      title: m.filename,
      duration: m.duration_seconds || 0,
      link_id: a?.link_id ?? null,
      start_sec: a?.start_sec ?? 0,
      end_sec: a?.end_sec ?? null,
      opacity: 1,                    // layer opacity — independent of effect
      effect: { type: 'uniform' },   // mask/blend effect
    };
  });
  const fineAligned = (align.tracks || []).filter(t => t.aligned).length;
  if (fineAligned) showToast(`⚡ ${fineAligned} track${fineAligned === 1 ? '' : 's'} fine-aligned by audio fingerprint`);

  buildMixUi({
    mediaIds, layout, song, tracks,
    presetCfg: opts.presetCfg, presetId: opts.presetId, presetName: opts.presetName,
    libraryMediaId: opts.libraryMediaId || null,
    libTitle: opts.libTitle || '',
    libDescription: opts.libDescription || '',
    // Auto-snap on load: pairwise fingerprint-align every track to the master.
    // Defaults ON exactly when the server couldn't align (no single song shared
    // by ALL files — the similar-audio case); song stacks arrive pre-aligned
    // and preset/library opens carry saved offsets.
    autoSnap: opts.autoSnap ?? (!opts.presetCfg && !song),
    resumeT: opts.resumeT, resumePlay: opts.resumePlay,
  });
}

/**
 * Play a Library "custom mix" tile (media_type 'mix'): loads its saved
 * config and opens the Editor mix with everything restored.
 */
async function editorPlayLibraryMix(mediaId) {
  let mix;
  try { mix = await fetch(`/api/music/mixes/${mediaId}`).then(r => r.json()); } catch {}
  if (!mix || mix.error) { showToast('⚠ Mix config missing — was it saved with an older version?'); return; }

  const ids = (mix.media_ids || []).filter(id => getMediaById(id));
  if (ids.length < 2) { showToast('⚠ This mix\'s source videos are no longer in the library'); return; }
  if (ids.length < (mix.media_ids || []).length) {
    showToast(`⚠ ${mix.media_ids.length - ids.length} source video(s) missing — playing the rest`);
  }

  switchTab('editor');
  await editorOpenMix(ids, mix.config?.l === 'grid' ? 'grid' : 'stack', mix.song_id || null, {
    presetCfg: mix.config,
    libraryMediaId: mediaId,
    libTitle: mix.row?.filename || '',
    libDescription: mix.row?.description || '',
  });
}

function editorCloseMix({ silent = false } = {}) {
  if (editorMix) {
    try { editorMix.cleanup(); } catch {}
    editorMix = null;
  }
  if (!silent) renderEditorHome();
}

/* ── Waveform envelopes for the sync strips (cached across mixes) ────────────
   Reuses the beatbar's server-side audio extraction (/api/media/:id/beat-audio,
   small mono m4a) — decoded once per file into a peak envelope. */
const _mixEnvCache = new Map();   // media_id → {bins, binsPerSec, duration} | 'loading' | null(failed)
let _mixAudioCtx = null;

function mixLoadEnvelope(mediaId) {
  if (_mixEnvCache.has(mediaId)) return;   // loaded, loading, or failed — no refetch
  _mixEnvCache.set(mediaId, 'loading');
  (async () => {
    try {
      const buf = await fetch(`/api/media/${mediaId}/beat-audio`).then(r => r.ok ? r.arrayBuffer() : null);
      if (!buf) throw new Error('no audio');
      _mixAudioCtx = _mixAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const audio = await _mixAudioCtx.decodeAudioData(buf);
      const data = audio.getChannelData(0);
      const binsPerSec = 50;
      const per = Math.floor(audio.sampleRate / binsPerSec);
      const n = Math.ceil(audio.duration * binsPerSec);
      const bins = new Float32Array(n);
      let max = 0;
      for (let i = 0; i < n; i++) {
        let peak = 0;
        const s1 = Math.min(data.length, (i + 1) * per);
        for (let s = i * per; s < s1; s++) {
          const a = Math.abs(data[s]);
          if (a > peak) peak = a;
        }
        bins[i] = peak;
        if (peak > max) max = peak;
      }
      if (max > 0) for (let i = 0; i < n; i++) bins[i] /= max;
      _mixEnvCache.set(mediaId, { bins, binsPerSec, duration: audio.duration });
    } catch {
      _mixEnvCache.set(mediaId, null);     // failed — strips stay blank for this file
    }
  })();
}

function buildMixUi(ctx) {
  const { mediaIds, song, tracks } = ctx;
  let layout = ctx.layout;
  const root = editorEl();

  let masterIdx = 0;
  let masterMuted = false;
  let cols = tracks.length <= 4 ? 2 : 3;
  let driftTimer = null;
  // Out-of-range behavior: true → a track goes blank/black wherever the song
  // falls outside its own content; false → legacy loop-forever. Saved in
  // configs as `b`; toggled live via the Sync section checkbox.
  let blankOutOfRange = true;
  const trackVolume = tracks.map((_, i) => (i === 0 ? 1 : 0));

  // start_sec can go slightly negative after fine alignment (song begins
  // before the file does) — format the sign explicitly
  const fmtStart = (s) => (s < 0 ? '-' : '') + musicFmtTime(Math.abs(s));

  const mixTitle = ctx.libTitle
    ? `🎛 ${escapeHtml(ctx.libTitle)} <span class="editor-mix-artist">— library mix${song ? ` · ${escapeHtml(song.artist)} – ${escapeHtml(song.title)}` : ''}</span>`
    : song
      ? `${escapeHtml(song.title)} <span class="editor-mix-artist">— ${escapeHtml(song.artist)}</span>`
      : `Custom mix <span class="editor-mix-artist">— ${tracks.length} files (no shared song; use sync nudges)</span>`;

  root.innerHTML = `
    <div class="editor-mix">
      <div class="editor-mix-titlebar">
        <button class="music-btn" onclick="editorCloseMix()" title="Back to the Editor home">← Editor</button>
        <h2 class="editor-mix-title">${mixTitle}</h2>
        <button class="music-btn" id="mixRestart" title="Restart at the aligned start">⟲ Restart</button>
      </div>

      <div class="editor-mix-body">
        <div class="editor-mix-main">
          <div class="editor-stage" id="mixStage" data-layout="${layout}" style="--cols:${cols};">
            ${tracks.map((t, i) => `
              <div class="editor-tile ${i === 0 ? 'is-master' : ''}" data-idx="${i}">
                <video data-idx="${i}" muted playsinline preload="auto" src="/media/${t.media_id}"></video>
                <div class="editor-tile-label">${escapeHtml(t.title)}</div>
              </div>
            `).join('')}
          </div>

          <!-- Main-player control bar (same markup/CSS as the library viewer;
               loop/next/prev/random/done hidden, Info slot = 🎚 Mixer) -->
          <div class="player-controls-wrapper video-controls editor-mix-controls">
            <div class="video-progress-wrapper">
              <div class="video-progress" id="mixProgress">
                <div class="video-progress-bar" id="mixProgressBar" style="width: 0%"></div>
              </div>
            </div>
            <div class="video-playback-row">
              <span class="video-time">
                <span id="mixCurrentTime">0:00</span>
                <span class="time-separator">/</span>
                <span id="mixTotalTime">0:00</span>
              </span>
              <div class="playback-controls">
                <button id="mixBack10" class="control-btn" title="-10s (J)"><span>⏪</span><span class="seek-label">10</span></button>
                <button id="mixBack5" class="control-btn" title="-5s (←)"><span>◀</span><span class="seek-label">5</span></button>
                <button id="mixPlayPause" class="play-pause-btn" title="Play/Pause (Space)">▶</button>
                <button id="mixFwd5" class="control-btn" title="+5s (→)"><span class="seek-label">5</span><span>▶</span></button>
                <button id="mixFwd10" class="control-btn" title="+10s (L)"><span class="seek-label">10</span><span>⏩</span></button>
              </div>
            </div>
            <div class="video-extras-row">
              <div class="pr-side pr-left">
                <button class="ab-loop-btn" id="mixAbLoopBtn" title="Set loop start point">A↔B</button>
              </div>
              <div class="pr-center">
                <div class="speed-control">
                  <button id="mixSpeedDown" class="control-btn speed-btn" title="Slower">−</button>
                  <span class="speed-display" id="mixSpeedDisplay">1x</span>
                  <button id="mixSpeedUp" class="control-btn speed-btn" title="Faster">+</button>
                </div>
                <button id="mixBeatbar" class="nav-btn beatbar-toggle" title="Beat bar on the master video — always rides the top layer">
                  <span class="nav-icon">🥁</span><span class="beatbar-state" id="mixBeatbarState">OFF</span>
                </button>
              </div>
              <div class="pr-side pr-right"></div>
            </div>
            <div class="player-controls-wrapper-inner">
              <div class="unified-control-bar">
                <div class="controls-left">
                  <div class="volume-control">
                    <button id="mixMuteBtn" class="control-btn" title="Mute all">🔊</button>
                    <input type="range" class="volume-slider" id="mixVolumeSlider" min="0" max="1" step="0.01" value="1">
                    <span class="volume-display" id="mixVolumeDisplay">100%</span>
                  </div>
                </div>
                <div class="controls-center">
                  <button id="mixMixerBtn" class="info-btn" title="Toggle the mixer sidebar (M)">
                    <span>🎚</span><span>Mixer</span>
                  </button>
                </div>
                <div class="controls-right">
                  <button class="music-btn editor-layout-btn ${layout === 'stack' ? 'tk-active' : ''}"
                    data-layout="stack" title="Layer all videos on top of each other">▤</button>
                  <button class="music-btn editor-layout-btn ${layout === 'grid' ? 'tk-active' : ''}" data-layout="grid">▦</button>
                  <span class="editor-toolbar-label" id="mixColsWrap">cols
                    <input type="number" class="music-input editor-cols-input" id="mixCols" min="1" max="6" value="${cols}">
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div id="mixExportStatus" style="display:none;"></div>
        </div>

        <aside class="editor-mixer-sidebar" id="mixerSidebar">
          <div class="editor-mixer-sidebar-head">
            <span class="editor-mixer-sidebar-title">🎚 Mixer</span>
            <button class="music-modal-close" id="mixMixerClose" title="Close mixer (M)">✕</button>
          </div>
          <div class="editor-mixer-sidebar-body">

            <div class="mixer-section">
              <div class="mixer-section-label">Master audio</div>
              <div class="mixer-master-row">
                <select class="editor-select" id="mixAudio">
                  ${tracks.map((t, i) => `<option value="${i}">${escapeHtml(t.title)}</option>`).join('')}
                </select>
                <input type="range" id="mixMasterVol" min="0" max="100" value="100" title="Master track volume">
                <label class="editor-toolbar-label" title="Silence every track"><input type="checkbox" id="mixMute"> mute</label>
              </div>
            </div>

            <div class="mixer-section">
              <div class="mixer-section-label mixer-sync-head">Sync
                <span class="music-hint">(drag a row sideways to align it)</span>
                <button class="music-btn" id="mixSnapAll"
                  title="Auto-align EVERY track to the master via audio fingerprints (~0.1s)">⚡ Snap all</button>
              </div>
              <canvas id="mixSyncPanel"
                title="Waveforms are fixed; the red playhead moves. Drag any row horizontally to slide that track into alignment."></canvas>
              <label class="editor-toolbar-label mix-range-toggle"
                title="ON: a track goes blank/black wherever the song is outside its own content (with a small buffer so starts/ends still play). OFF: the track keeps playing, looping its own content.">
                <input type="checkbox" id="mixBlankRange" checked> blank video outside its matched range
              </label>
            </div>

            <div class="mixer-section">
              <div class="mixer-section-label">Layers <span class="music-hint">(top = back layer${layout === 'stack' ? '; back stays opaque' : ''})</span></div>
              ${tracks.map((t, i) => `
                <div class="mixer-layer" data-idx="${i}">
                  <div class="mixer-layer-head">
                    <span class="editor-mixer-title ${i === 0 ? 'is-master' : ''}" data-idx="${i}" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
                    <button class="music-icon-btn mix-master-btn" data-idx="${i}" title="Make this the audio master">🔊</button>
                    <button class="music-icon-btn mix-spot-btn" data-idx="${i}" title="Spotlight this layer (dim the others) — click again to restore the previous opacities">★</button>
                    <button class="music-icon-btn music-icon-danger mix-remove-btn" data-idx="${i}" title="Remove this video from the mix">✕</button>
                  </div>
                  <label class="editor-mixer-slider" title="Layer opacity">op
                    <input type="range" class="mix-opacity" data-idx="${i}" min="0" max="100" value="100">
                    <span class="editor-pct mix-op-pct" data-idx="${i}">100</span>
                  </label>
                  <label class="editor-mixer-slider" title="Track volume">vol
                    <input type="range" class="mix-volume" data-idx="${i}" min="0" max="100" value="${i === 0 ? 100 : 0}">
                    <span class="editor-pct mix-vol-pct" data-idx="${i}">${i === 0 ? 100 : 0}</span>
                  </label>
                  <div class="mixer-layer-fx">
                    <select class="editor-select mix-effect-type" data-idx="${i}">
                      ${EDITOR_EFFECT_TYPES.map(x => `<option value="${x}">${x}</option>`).join('')}
                    </select>
                    <div class="editor-fx-params" data-idx="${i}"></div>
                  </div>
                  <div class="editor-mixer-sync">
                    <span class="editor-toolbar-label">sync</span>
                    <button class="music-btn mix-nudge" data-idx="${i}" data-nudge="-1">-1s</button>
                    <button class="music-btn mix-nudge" data-idx="${i}" data-nudge="-0.1">-0.1</button>
                    <span class="editor-offset mix-offset" data-idx="${i}">${fmtStart(t.start_sec)}</span>
                    <button class="music-btn mix-nudge" data-idx="${i}" data-nudge="0.1">+0.1</button>
                    <button class="music-btn mix-nudge" data-idx="${i}" data-nudge="1">+1s</button>
                    <button class="music-btn mix-autoalign" data-idx="${i}" title="Auto-align this track to the master via audio fingerprints (~0.1s)">⚡</button>
                    <span class="music-hint mix-save-hint" data-idx="${i}"></span>
                  </div>
                </div>
              `).join('')}
              <div class="editor-mixer-foot">
                <button class="music-btn" id="mixBalance" title="Equal visual contribution per layer">⚖ Balanced</button>
                <button class="music-btn" id="mixAll100">All 100%</button>
                <button class="music-btn" id="mixMasterOnly" title="Only the master track audible">Master only</button>
              </div>
            </div>

            <div class="mixer-section">
              <div class="mixer-section-label">Mix presets</div>
              <div class="mixer-preset-rows">
                <select class="editor-select" id="mixPresetLoad"><option value="">— load —</option></select>
                <div class="mixer-preset-save">
                  <input type="text" class="music-input" id="mixPresetName" placeholder="Mix name…" value="${escapeHtml(ctx.presetName || '')}">
                  <button class="music-btn" id="mixPresetSave">💾 Save</button>
                </div>
                <span class="music-hint">Saves layout, volumes, effects &amp; master</span>
              </div>
            </div>

            <div class="mixer-section">
              <div class="mixer-section-label">Library</div>
              <div class="mixer-preset-rows">
                <input type="text" class="music-input" id="mixLibTitle" placeholder="Mix title…" value="${escapeHtml(ctx.libTitle || '')}">
                <textarea class="music-input mixer-desc-input" id="mixLibDesc" rows="2"
                  placeholder="Description (optional)">${escapeHtml(ctx.libDescription || '')}</textarea>
                <button class="music-btn music-btn-primary" id="mixLibSave">${ctx.libraryMediaId ? '⟳ Update library mix' : '💾 Save to Library'}</button>
                <span class="music-hint">Playable 🎛 tile in the Library — layout, effects &amp; volumes included, no export needed. Ratings/notes work like any file.</span>
              </div>
            </div>

            <div class="mixer-section">
              <div class="mixer-section-label">Export</div>
              <button class="music-btn music-btn-primary" id="mixExport">📤 Export this mix to MP4</button>
            </div>

          </div>
        </aside>
      </div>
    </div>
  `;

  const stage = document.getElementById('mixStage');
  const videos = [...stage.querySelectorAll('video')];
  const playPauseBtn = document.getElementById('mixPlayPause');
  const audioSel = document.getElementById('mixAudio');
  const masterVol = document.getElementById('mixMasterVol');
  const colsWrap = document.getElementById('mixColsWrap');
  const progressBar = document.getElementById('mixProgressBar');
  const currentTimeEl = document.getElementById('mixCurrentTime');
  const totalTimeEl = document.getElementById('mixTotalTime');
  const volumeSlider = document.getElementById('mixVolumeSlider');
  const volumeDisplay = document.getElementById('mixVolumeDisplay');
  const muteBtn = document.getElementById('mixMuteBtn');

  colsWrap.style.display = layout === 'grid' ? '' : 'none';

  /* ---- Mixer sidebar toggle (the Editor's counterpart to the player's
         info sidebar — 🎚 in the toolbar or the M key) ---- */
  const mixerSidebar = document.getElementById('mixerSidebar');
  function setMixerOpen(open) {
    mixerSidebar.classList.toggle('active', open);
    document.getElementById('mixMixerBtn')?.classList.toggle('tk-active', open);
    try { localStorage.setItem('editor_mixer_open', open ? '1' : '0'); } catch {}
    // stage width changes — reposition the beat bar overlay
    requestAnimationFrame(() => refreshBeatbar());
  }
  document.getElementById('mixMixerBtn').addEventListener('click', () =>
    setMixerOpen(!mixerSidebar.classList.contains('active')));
  document.getElementById('mixMixerClose').addEventListener('click', () => setMixerOpen(false));

  // The MASTER always loops (the mix restarts with it). Followers loop only in
  // legacy mode: in blank mode they must NOT wrap — outside their own content
  // range they go blank instead of loop-repeating random slices (the old
  // modulo-wrap showed ~2 stutters/sec out of range).
  const tiles = tracks.map((_, i) => stage.querySelector(`.editor-tile[data-idx="${i}"]`));
  function applyLoopFlags() { videos.forEach((v, i) => { v.loop = i === masterIdx || !blankOutOfRange; }); }
  applyLoopFlags();

  videos.forEach((v, i) => {
    // Followers must keep rolling while the master plays — some engines
    // self-pause muted/occluded stacked videos. Master pausing = user intent
    // (checked again inside the timeout so pauseAll doesn't get fought).
    // Blank tiles are intentionally paused — never fight that either.
    v.addEventListener('pause', () => {
      if (i === masterIdx || masterVideo().paused) return;
      setTimeout(() => {
        if (editorMix && i !== masterIdx && !masterVideo().paused && v.paused && v.src
            && !tiles[i]?.classList.contains('mix-tile-blank')) {
          v.play().catch(() => {});
        }
      }, 0);
    });
  });

  /* ---- Core sync helpers ---- */
  const masterVideo = () => videos[masterIdx];
  const songToVideo = (idx, T) => tracks[idx].start_sec + T;
  const masterSongTime = () => Math.max(0, masterVideo().currentTime - tracks[masterIdx].start_sec);

  /**
   * Align one follower to song-time T.
   *
   * Blank mode: outside its content range (target < 0 → the file hasn't
   * started; target > duration → it's over) the tile goes blank/black and the
   * video pauses, parked at the nearest boundary so re-entry is seamless.
   * RANGE_BUF keeps the tile VISIBLE for a beat past the exact edges (frozen
   * boundary frame) so alignment jitter never clips the start/end of a song.
   *
   * Legacy mode (blankOutOfRange off): the old behavior — wrap the target
   * modulo the file's duration so the track loops its own content forever.
   */
  const RANGE_BUF = 0.3;
  function syncTrack(i, T, threshold) {
    if (i === masterIdx) return;
    const v = videos[i];
    const dur = tracks[i].duration || v.duration || 0;
    const target = songToVideo(i, T);

    if (!blankOutOfRange) {
      tiles[i]?.classList.remove('mix-tile-blank');
      const wrapped = dur > 0 ? ((target % dur) + dur) % dur : target;
      const nearWrap = wrapped < 0.5 || (dur > 0 && wrapped > dur - 0.5);
      if (Math.abs(v.currentTime - wrapped) > (nearWrap ? Math.max(0.5, threshold) : threshold)) v.currentTime = wrapped;
      if (v.paused && !masterVideo().paused) v.play().catch(() => {});
      return;
    }

    const inRange = target >= -RANGE_BUF && (dur <= 0 || target < dur + RANGE_BUF);
    tiles[i]?.classList.toggle('mix-tile-blank', !inRange);
    if (!inRange) {
      if (!v.paused) v.pause();
      const park = target < 0 ? 0 : Math.max(0, dur - 0.05);
      if (Math.abs(v.currentTime - park) > 0.5) v.currentTime = park;
      return;
    }
    // Inside the buffer but before/past the actual content → hold the frozen
    // boundary frame (visible, paused); play only while target is real content.
    const clamped = Math.max(0, dur > 0 ? Math.min(target, dur - 0.05) : target);
    if (Math.abs(v.currentTime - clamped) > threshold) v.currentTime = clamped;
    const playable = target >= 0 && (dur <= 0 || target < dur);
    if (playable) {
      if (v.paused && !masterVideo().paused) v.play().catch(() => {});
    } else if (!v.paused) {
      v.pause();
    }
  }

  function applyAudio() {
    videos.forEach((v, i) => {
      const vol = masterMuted ? 0 : trackVolume[i];
      v.muted = vol <= 0;
      v.volume = Math.max(0, Math.min(1, vol));
    });
  }

  function setTrackVolume(idx, val) {
    val = Math.max(0, Math.min(1, val));
    trackVolume[idx] = val;
    applyAudio();
    const slider = document.querySelector(`.mix-volume[data-idx="${idx}"]`);
    if (slider) slider.value = Math.round(val * 100);
    const pct = document.querySelector(`.mix-vol-pct[data-idx="${idx}"]`);
    if (pct) pct.textContent = Math.round(val * 100);
    if (idx === masterIdx) {
      masterVol.value = Math.round(val * 100);
      // mirror into the control-bar volume (drives the master track)
      if (volumeSlider) volumeSlider.value = val;
      if (volumeDisplay) volumeDisplay.textContent = `${Math.round(val * 100)}%`;
      if (muteBtn) muteBtn.textContent = (masterMuted || val <= 0) ? '🔇' : '🔊';
    }
  }

  function syncAllToMaster() {
    const T = masterSongTime();
    for (let i = 0; i < videos.length; i++) syncTrack(i, T, 0.25);
  }

  function startDriftLoop() {
    stopDriftLoop();
    driftTimer = setInterval(() => {
      if (masterVideo().paused) return;
      const T = masterSongTime();
      // syncTrack self-heals stalled followers (play() lost races) and pauses/
      // blanks out-of-range ones — one code path for both loops.
      for (let i = 0; i < videos.length; i++) syncTrack(i, T, 0.18);
    }, 400);
  }
  function stopDriftLoop() { if (driftTimer) { clearInterval(driftTimer); driftTimer = null; } }

  /* ---- A-B loop on the master timeline (same UX as single videos) ---- */
  let mixAbA = null, mixAbB = null;

  function mixAbState() {
    if (mixAbA === null) return { label: 'A↔B', cls: '', title: 'Set loop start point' };
    if (mixAbB === null) return { label: `A: ${formatDuration(mixAbA)} → ?`, cls: 'has-a', title: 'Set loop end point' };
    return { label: `🔁 ${formatDuration(mixAbA)} → ${formatDuration(mixAbB)}`, cls: 'has-ab', title: 'Clear loop' };
  }

  function mixUpdateAbUi() {
    const btn = document.getElementById('mixAbLoopBtn');
    if (btn) {
      const s = mixAbState();
      btn.className = `ab-loop-btn ${s.cls}`;
      btn.textContent = s.label;
      btn.title = s.title;
    }
    const prog = document.getElementById('mixProgress');
    if (!prog) return;
    prog.querySelectorAll('.ab-loop-region, .ab-loop-marker').forEach(el => el.remove());
    const dur = masterVideo().duration;
    if (!dur) return;
    if (mixAbA !== null) {
      const a = document.createElement('div');
      a.className = 'ab-loop-marker marker-a';
      a.style.left = `calc(${(mixAbA / dur) * 100}% - 1px)`;
      a.dataset.label = 'A';
      prog.appendChild(a);
    }
    if (mixAbA !== null && mixAbB !== null) {
      const region = document.createElement('div');
      region.className = 'ab-loop-region';
      region.style.left = `${(mixAbA / dur) * 100}%`;
      region.style.width = `${((mixAbB - mixAbA) / dur) * 100}%`;
      prog.appendChild(region);
      const b = document.createElement('div');
      b.className = 'ab-loop-marker marker-b';
      b.style.left = `calc(${(mixAbB / dur) * 100}% - 1px)`;
      b.dataset.label = 'B';
      prog.appendChild(b);
    }
  }

  function mixToggleAbLoop() {
    const m = masterVideo();
    if (mixAbA === null) {
      mixAbA = m.currentTime;
      mixAbB = null;
    } else if (mixAbB === null) {
      const b = m.currentTime;
      if (b <= mixAbA) { mixAbB = mixAbA; mixAbA = b; } else { mixAbB = b; }
      m.currentTime = mixAbA;
      syncAllToMaster();
    } else {
      mixAbA = null;
      mixAbB = null;
    }
    mixUpdateAbUi();
  }

  function mixClearAbLoop() {
    if (mixAbA === null && mixAbB === null) return;
    mixAbA = null;
    mixAbB = null;
    mixUpdateAbUi();
  }

  function mixCheckAbLoop() {
    if (mixAbA === null || mixAbB === null) return;
    const m = masterVideo();
    if (m.currentTime >= mixAbB - 0.05) {
      m.currentTime = mixAbA;
      syncAllToMaster();
    }
  }

  /* ---- Control-bar UI tick: progress, time, A-B (master's timeline) ---- */
  let uiTimer = null;
  function uiTick() {
    const m = masterVideo();
    const dur = m.duration || 0;
    if (progressBar && dur > 0) progressBar.style.width = `${(m.currentTime / dur) * 100}%`;
    if (currentTimeEl) currentTimeEl.textContent = formatDuration(m.currentTime) || '0:00';
    if (totalTimeEl) totalTimeEl.textContent = dur > 0 ? formatDuration(dur) : '0:00';
    mixCheckAbLoop();
  }
  uiTimer = setInterval(uiTick, 200);

  /* ---- Playback speed (applied to every track — sync needs one clock) ---- */
  const MIX_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
  let mixSpeedIdx = 3;
  function mixCycleSpeed(dir) {
    mixSpeedIdx = Math.max(0, Math.min(MIX_SPEEDS.length - 1, mixSpeedIdx + dir));
    const speed = MIX_SPEEDS[mixSpeedIdx];
    videos.forEach(v => { v.playbackRate = speed; });
    const disp = document.getElementById('mixSpeedDisplay');
    if (disp) {
      disp.textContent = speed + 'x';
      disp.classList.toggle('speed-modified', speed !== 1);
    }
  }

  async function playAll() {
    syncAllToMaster();
    try { await masterVideo().play(); }
    catch { showToast('⚠ Browser blocked autoplay — click a tile first'); return; }
    for (let i = 0; i < videos.length; i++) {
      // blank tiles stay paused — syncTrack resumes them when back in range
      if (i !== masterIdx && !tiles[i]?.classList.contains('mix-tile-blank')) {
        try { await videos[i].play(); } catch {}
      }
    }
    startDriftLoop();
  }
  function pauseAll() { videos.forEach(v => v.pause()); stopDriftLoop(); }
  function togglePlay() { masterVideo().paused ? playAll() : pauseAll(); }
  function seekBy(d) {
    const m = masterVideo();
    m.currentTime = Math.max(0, m.duration ? Math.min(m.duration - 0.1, m.currentTime + d) : m.currentTime + d);
    syncAllToMaster();
  }

  function updatePlayLabel() {
    playPauseBtn.textContent = masterVideo().paused ? '▶' : '⏸';
  }
  function bindMasterListeners() {
    const m = masterVideo();
    ['play', 'pause', 'playing'].forEach(ev => m.addEventListener(ev, updatePlayLabel));
    updatePlayLabel();
  }

  /* ---- Effects (mask/blend — layer opacity is handled separately) ---- */
  function applyTrackEffect(idx, effect) {
    tracks[idx].effect = effect;
    const tile = stage.querySelector(`.editor-tile[data-idx="${idx}"]`);
    if (tile) editorApplyEffectToTile(tile, effect, tracks[idx].opacity);
    const sel = document.querySelector(`.mix-effect-type[data-idx="${idx}"]`);
    if (sel) sel.value = effect.type;
    const box = document.querySelector(`.editor-fx-params[data-idx="${idx}"]`);
    if (box) box.innerHTML = renderFxParams(idx, effect);
    bindFxParams(idx);
  }

  /** Opacity ONLY — the active effect (radial, gradient, …) is untouched. */
  function setTileOpacity(idx, op) {
    op = Math.max(0, Math.min(1, op));
    tracks[idx].opacity = op;
    const tile = stage.querySelector(`.editor-tile[data-idx="${idx}"]`);
    if (tile) editorApplyEffectToTile(tile, tracks[idx].effect, op);
    const slider = document.querySelector(`.mix-opacity[data-idx="${idx}"]`);
    if (slider) slider.value = Math.round(op * 100);
    const pct = document.querySelector(`.mix-op-pct[data-idx="${idx}"]`);
    if (pct) pct.textContent = Math.round(op * 100);
  }

  function applyBalancedBlend() {
    for (let i = 0; i < tracks.length; i++) setTileOpacity(i, 1 / (i + 1));
  }

  // Plain-language tooltips for every effect parameter
  const FX_TIPS = {
    'angle': 'Direction of the effect: 0° = bottom→top, 90° = left→right, 180° = top→bottom (steps of 30°)',
    'alpha0': 'Opacity at the START of the gradient (0 = fully transparent, 100 = fully visible)',
    'alpha1': 'Opacity at the END of the gradient',
    'stop0': 'Where along the direction the fade BEGINS (% across the frame)',
    'stop1': 'Where along the direction the fade ENDS — between the stops the opacity ramps',
    'cx': 'Horizontal position of the circle center (% from the left edge)',
    'cy': 'Vertical position of the circle center (% from the top edge)',
    'inner': 'Radius where the center opacity starts fading out (% of frame size)',
    'outer': 'Radius where the fade finishes (% of frame size) — between inner and outer it ramps',
    'alpha_in': 'Opacity INSIDE the circle center (100 = layer fully visible in the middle)',
    'alpha_out': 'Opacity OUTSIDE the circle edge (0 = layer disappears at the edges)',
    'position': 'Where the hard split line sits along the direction (% across the frame)',
    'mode': 'Pixel math used to combine this layer with the ones below it',
  };

  function renderFxParams(idx, eff) {
    const slider = (label, key, value, min = 0, max = 100, step = 1) => `
      <label class="editor-fx-param" title="${escapeHtml(FX_TIPS[key] || '')}">
        <span>${label}</span>
        <input type="range" class="mix-fx-param" data-idx="${idx}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}">
        <span class="editor-pct" data-key="${key}">${value}</span>
      </label>`;
    switch (eff.type) {
      case 'linear-gradient':
      case 'soft-fade': {
        let html = slider('angle', 'angle', Math.round(eff.angle ?? 90), 0, 360, 30);
        html += slider('α start', 'alpha0', Math.round((eff.alpha0 ?? 0) * 100));
        html += slider('α end', 'alpha1', Math.round((eff.alpha1 ?? 1) * 100));
        if (eff.type === 'linear-gradient') {
          html += slider('fade from', 'stop0', Math.round((eff.stop0 ?? 0) * 100));
          html += slider('fade to', 'stop1', Math.round((eff.stop1 ?? 1) * 100));
        }
        return html;
      }
      case 'radial':
        return slider('center x', 'cx', Math.round((eff.cx ?? 0.5) * 100))
          + slider('center y', 'cy', Math.round((eff.cy ?? 0.5) * 100))
          + slider('inner r', 'inner', Math.round((eff.inner ?? 0.3) * 100))
          + slider('outer r', 'outer', Math.round((eff.outer ?? 0.7) * 100))
          + slider('α center', 'alpha_in', Math.round((eff.alpha_in ?? 1) * 100))
          + slider('α edge', 'alpha_out', Math.round((eff.alpha_out ?? 0) * 100));
      case 'wipe-split':
        return slider('angle', 'angle', Math.round(eff.angle ?? 90), 0, 360, 30)
          + slider('split at', 'position', Math.round((eff.position ?? 0.5) * 100))
          + slider('α before', 'alpha0', Math.round((eff.alpha0 ?? 1) * 100))
          + slider('α after', 'alpha1', Math.round((eff.alpha1 ?? 0) * 100));
      case 'blend':
        return `
          <label class="editor-fx-param editor-fx-param-wide" title="${escapeHtml(FX_TIPS.mode)}"><span>mode</span>
            <select class="mix-fx-param editor-select" data-idx="${idx}" data-key="mode">
              ${EDITOR_BLEND_MODES.map(m => `<option value="${m}" ${m === (eff.mode || 'screen') ? 'selected' : ''}>${m}</option>`).join('')}
            </select>
          </label>`;
      default:
        return '';
    }
  }

  function bindFxParams(idx) {
    const box = document.querySelector(`.editor-fx-params[data-idx="${idx}"]`);
    if (!box) return;
    box.querySelectorAll('.mix-fx-param').forEach(inp => {
      inp.addEventListener('input', () => {
        const key = inp.dataset.key;
        const val = inp.tagName === 'SELECT' ? inp.value
          : (key === 'angle' ? Number(inp.value) : Number(inp.value) / 100);
        tracks[idx].effect = { ...tracks[idx].effect, [key]: val };
        const lbl = box.querySelector(`.editor-pct[data-key="${key}"]`);
        if (lbl) lbl.textContent = key === 'angle' ? Math.round(val) : (inp.tagName === 'SELECT' ? val : Math.round(val * 100));
        const tile = stage.querySelector(`.editor-tile[data-idx="${idx}"]`);
        if (tile) editorApplyEffectToTile(tile, tracks[idx].effect, tracks[idx].opacity);
      });
    });
  }

  function setEffectType(idx, type) {
    const defaults = {
      'uniform': { type: 'uniform' },
      'linear-gradient': { type: 'linear-gradient', angle: 90, stop0: 0, stop1: 1, alpha0: 0, alpha1: 1 },
      'soft-fade': { type: 'soft-fade', angle: 90, alpha0: 0, alpha1: 1 },
      'radial': { type: 'radial', cx: 0.5, cy: 0.5, inner: 0.3, outer: 0.7, alpha_in: 1, alpha_out: 0 },
      'wipe-split': { type: 'wipe-split', angle: 90, position: 0.5, alpha0: 1, alpha1: 0 },
      'blend': { type: 'blend', mode: 'screen' },
    };
    applyTrackEffect(idx, defaults[type] || defaults.uniform);
  }

  /* ---- Master switching ---- */
  function setMaster(newIdx) {
    // A-B points live on the master's timeline — a new master invalidates them
    if (newIdx !== masterIdx) mixClearAbLoop();
    if (newIdx === masterIdx) {
      // still refresh visuals (used at init)
      stage.querySelectorAll('.editor-tile').forEach(t =>
        t.classList.toggle('is-master', Number(t.dataset.idx) === masterIdx));
      return;
    }
    const T = masterSongTime();
    const oldIdx = masterIdx;
    const oldVol = trackVolume[oldIdx];
    const newPrevVol = trackVolume[newIdx];
    masterIdx = newIdx;
    // SWAP volumes rather than zeroing the old master — promoting back and
    // forth loses nothing (typically the follower was at 0, so this behaves
    // exactly like the old mute-the-old-master handoff).
    setTrackVolume(oldIdx, newPrevVol);
    setTrackVolume(newIdx, oldVol > 0 ? oldVol : 1);
    masterVideo().currentTime = songToVideo(newIdx, T);
    applyLoopFlags();                 // loop follows the master; followers blank at range ends
    syncAllToMaster();
    bindMasterListeners();
    audioSel.value = String(newIdx);
    stage.querySelectorAll('.editor-tile').forEach(t =>
      t.classList.toggle('is-master', Number(t.dataset.idx) === masterIdx));
    document.querySelectorAll('.editor-mixer-title').forEach(t =>
      t.classList.toggle('is-master', Number(t.dataset.idx) === masterIdx));
    refreshBeatbar();
  }

  /* ---- Layout ---- */
  function setLayout(l) {
    layout = l;
    stage.dataset.layout = l;
    document.querySelectorAll('.editor-layout-btn').forEach(b =>
      b.classList.toggle('tk-active', b.dataset.layout === l));
    colsWrap.style.display = l === 'grid' ? '' : 'none';
    if (l === 'stack') {
      // First stack entry with untouched opacities → balance so every layer shows
      const allDefault = tracks.every(t => (t.opacity ?? 1) >= 0.999);
      if (allDefault) applyBalancedBlend();
    } else {
      // Back to grid: restore full opacity unless the user has mask effects going
      const anyFancy = tracks.some(t => t.effect && t.effect.type !== 'uniform');
      if (!anyFancy) for (let i = 0; i < tracks.length; i++) setTileOpacity(i, 1);
    }
    requestAnimationFrame(refreshBeatbar);
  }

  /* ---- Sync nudges (persist to the song link when aligned) ---- */
  const saveTimers = new Map();
  function scheduleSaveStart(idx) {
    const t0 = saveTimers.get(idx);
    if (t0) clearTimeout(t0);
    const hint = document.querySelector(`.mix-save-hint[data-idx="${idx}"]`);
    if (!tracks[idx].link_id) {
      if (hint) hint.textContent = 'session only';
      return;
    }
    if (hint) hint.textContent = 'saving…';
    saveTimers.set(idx, setTimeout(async () => {
      saveTimers.delete(idx);
      try {
        await fetch(`/api/music/links/${tracks[idx].link_id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start_sec: tracks[idx].start_sec }),
        });
        if (hint) {
          hint.textContent = 'saved ✓';
          setTimeout(() => { if (hint.textContent === 'saved ✓') hint.textContent = ''; }, 1500);
        }
      } catch {
        if (hint) hint.textContent = 'save failed';
      }
    }, 600));
  }

  /* ---- Beat bar (top layer, follows the master) ---- */
  const beatbarOn = () => localStorage.getItem('beatbar_enabled') === '1';
  function refreshBeatbar() {
    if (!window.BeatBar) return;
    const st = document.getElementById('mixBeatbarState');
    if (st) st.textContent = beatbarOn() ? 'ON' : 'OFF';
    document.getElementById('mixBeatbar')?.classList.toggle('beatbar-btn-on', beatbarOn());
    if (beatbarOn() && editorMix) {
      BeatBar.attach({ id: tracks[masterIdx].media_id }, masterVideo());
    } else {
      BeatBar.detach();
    }
  }
  document.getElementById('mixBeatbar').addEventListener('click', () => {
    localStorage.setItem('beatbar_enabled', beatbarOn() ? '0' : '1');
    refreshBeatbar();
    showToast(beatbarOn() ? '🥁 Beat bar ON — riding the master track' : 'Beat bar off');
  });

  /* ---- Wire controls ---- */
  playPauseBtn.addEventListener('click', togglePlay);
  document.getElementById('mixBack5').addEventListener('click', () => seekBy(-5));
  document.getElementById('mixBack10').addEventListener('click', () => seekBy(-10));
  document.getElementById('mixFwd5').addEventListener('click', () => seekBy(5));
  document.getElementById('mixFwd10').addEventListener('click', () => seekBy(10));
  document.getElementById('mixRestart').addEventListener('click', () => {
    pauseAll();
    masterVideo().currentTime = tracks[masterIdx].start_sec;
    syncAllToMaster();
    playAll();
  });
  masterVol.addEventListener('input', () => setTrackVolume(masterIdx, Number(masterVol.value) / 100));
  audioSel.addEventListener('change', () => setMaster(Number(audioSel.value)));
  document.getElementById('mixMute').addEventListener('change', (e) => {
    masterMuted = e.target.checked;
    applyAudio();
    if (muteBtn) muteBtn.textContent = masterMuted ? '🔇' : '🔊';
  });

  // Control-bar extras: seek bar, volume, mute-all, A-B loop, speed
  document.getElementById('mixProgress').addEventListener('click', (e) => {
    const m = masterVideo();
    if (!isFinite(m.duration) || m.duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    m.currentTime = ((e.clientX - rect.left) / rect.width) * m.duration;
    syncAllToMaster();
    uiTick();
  });
  volumeSlider.addEventListener('input', () => setTrackVolume(masterIdx, Number(volumeSlider.value)));
  muteBtn.addEventListener('click', () => {
    masterMuted = !masterMuted;
    const cb = document.getElementById('mixMute');
    if (cb) cb.checked = masterMuted;
    applyAudio();
    muteBtn.textContent = masterMuted ? '🔇' : '🔊';
  });
  document.getElementById('mixAbLoopBtn').addEventListener('click', mixToggleAbLoop);
  document.getElementById('mixSpeedDown').addEventListener('click', () => mixCycleSpeed(-1));
  document.getElementById('mixSpeedUp').addEventListener('click', () => mixCycleSpeed(1));
  document.querySelectorAll('.editor-layout-btn').forEach(b =>
    b.addEventListener('click', () => setLayout(b.dataset.layout)));
  document.getElementById('mixCols').addEventListener('change', (e) => {
    cols = Math.max(1, Math.min(6, Number(e.target.value) || 2));
    e.target.value = cols;
    stage.style.setProperty('--cols', cols);
    requestAnimationFrame(refreshBeatbar);
  });
  function updateOffsetLabels(idx) {
    document.querySelectorAll(`.mix-offset[data-idx="${idx}"]`).forEach(el => {
      el.textContent = fmtStart(tracks[idx].start_sec);
    });
  }

  document.querySelectorAll('.mix-nudge').forEach(b => {
    b.addEventListener('click', () => {
      const idx = Number(b.dataset.idx);
      // negatives allowed: fine alignment can place a song start before 0:00
      tracks[idx].start_sec += Number(b.dataset.nudge);
      updateOffsetLabels(idx);
      syncAllToMaster();
      scheduleSaveStart(idx);
    });
  });

  /* ---- Sync panel + ⚡ auto-align ----
     ONE canvas, one waveform row per track (master starred), all plotted in
     SONG time over a FIXED window: the waveforms hold still and the red
     playhead sweeps across them — so peaks stay put under the mouse while
     aligning live. When the playhead runs off the page (or a seek jumps
     outside it) the window re-pages and the head snaps back to the new page.
     Drag any row sideways to slide that track; matching peaks in a column
     mean the tracks are in sync. */
  const WAVE_WINDOW = 12;   // seconds of song-time per page
  const SYNC_ROW_H = 36;
  const SYNC_COLORS = ['#e8e8e8', '#7aa8ff', '#ffb86c', '#7fe3a0'];
  const syncPanel = document.getElementById('mixSyncPanel');
  let syncWinStart = 0;     // left edge of the current page (song-time seconds)
  let syncRaf = null;

  function drawSyncPanel() {
    if (!syncPanel || !mixerSidebar.classList.contains('active')) return;
    const w = syncPanel.clientWidth || 280;
    if (!w) return;                          // sidebar mid-transition
    const h = SYNC_ROW_H * tracks.length;
    if (syncPanel.width !== w) syncPanel.width = w;
    if (syncPanel.height !== h) syncPanel.height = h;
    const g = syncPanel.getContext('2d');
    g.clearRect(0, 0, w, h);

    // Page the fixed window so the playhead always lands inside it. Pages are
    // aligned multiples of WAVE_WINDOW, so a page-turn mid-drag re-bases the
    // VIEW only — drag math is delta-based and unaffected (see pointermove).
    const T = masterSongTime();
    if (T < syncWinStart || T >= syncWinStart + WAVE_WINDOW) {
      syncWinStart = Math.max(0, Math.floor(T / WAVE_WINDOW) * WAVE_WINDOW);
    }

    tracks.forEach((t, i) => {
      mixLoadEnvelope(t.media_id);
      const env = _mixEnvCache.get(t.media_id);
      const yBase = (i + 1) * SYNC_ROW_H - 2;            // row baseline
      const barMax = SYNC_ROW_H - 14;                    // leave room for the label
      if (!env || env === 'loading') {
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.font = '10px sans-serif';
        g.fillText(env === null ? 'waveform unavailable' : 'loading…', 6, yBase - barMax / 2);
      } else {
        g.fillStyle = SYNC_COLORS[i % SYNC_COLORS.length];
        g.globalAlpha = 0.85;
        for (let x = 0; x < w; x++) {
          const ft = t.start_sec + syncWinStart + (x / w) * WAVE_WINDOW;   // file time at this pixel
          const v = (ft < 0 || ft >= env.duration) ? 0
            : env.bins[Math.min(env.bins.length - 1, Math.floor(ft * env.binsPerSec))] || 0;
          if (v > 0) g.fillRect(x, yBase - v * barMax, 1, v * barMax);
        }
        g.globalAlpha = 1;
      }
      g.fillStyle = 'rgba(255,255,255,0.22)';
      g.fillRect(0, (i + 1) * SYNC_ROW_H - 0.5, w, 1);   // row separator
      g.fillStyle = i === masterIdx ? '#fff' : 'rgba(255,255,255,0.6)';
      g.font = '9px sans-serif';
      g.fillText(`${i === masterIdx ? '★ ' : ''}${t.title.slice(0, 34)}`, 4, i * SYNC_ROW_H + 10);
    });

    // Page range (bottom-right) + the moving playhead
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.font = '9px sans-serif';
    const label = `${musicFmtTime(syncWinStart)}–${musicFmtTime(syncWinStart + WAVE_WINDOW)}`;
    g.fillText(label, w - g.measureText(label).width - 4, h - 4);
    g.fillStyle = 'rgba(255,90,90,0.9)';
    g.fillRect(Math.round(((T - syncWinStart) / WAVE_WINDOW) * w), 0, 1, h);
  }

  // rAF (not the old 400ms tick): the playhead sweeps, so it must move smoothly
  (function syncPanelLoop() {
    drawSyncPanel();
    syncRaf = requestAnimationFrame(syncPanelLoop);
  })();

  // Drag any row sideways = slide that track's audio in song-time
  if (syncPanel) {
    let dragIdx = -1, dragStartX = 0, dragStartSec = 0, lastDragSeek = 0;
    syncPanel.addEventListener('pointerdown', (e) => {
      const rect = syncPanel.getBoundingClientRect();
      dragIdx = Math.max(0, Math.min(tracks.length - 1, Math.floor((e.clientY - rect.top) / SYNC_ROW_H)));
      dragStartX = e.clientX;
      dragStartSec = tracks[dragIdx].start_sec;
      try { syncPanel.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    syncPanel.addEventListener('pointermove', (e) => {
      if (dragIdx < 0) return;
      // Delta from pointer-DOWN (not from the last frame): if the window
      // pages mid-drag the track keeps its alignment relative to the others —
      // the view re-bases but total mouse travel still maps 1:1 to offset.
      const dxSec = ((e.clientX - dragStartX) / (syncPanel.clientWidth || 280)) * WAVE_WINDOW;
      tracks[dragIdx].start_sec = dragStartSec - dxSec;   // drag right → audio later in song-time
      updateOffsetLabels(dragIdx);
      const now = Date.now();
      if (now - lastDragSeek > 300) { lastDragSeek = now; syncAllToMaster(); }  // don't seek-thrash
    });
    const endSyncDrag = (e) => {
      if (dragIdx < 0) return;
      const idx = dragIdx;
      dragIdx = -1;
      try { syncPanel.releasePointerCapture(e.pointerId); } catch {}
      syncAllToMaster();
      scheduleSaveStart(idx);
    };
    syncPanel.addEventListener('pointerup', endSyncDrag);
    syncPanel.addEventListener('pointercancel', endSyncDrag);
  }

  /* ---- ⚡ fingerprint alignment: one track, all tracks, and on-load ---- */

  /** Fine-align track idx to the master via audio fingerprints.
   *  Returns the API payload on success, false on any failure. */
  async function snapTrack(idx, { quiet = false } = {}) {
    if (idx === masterIdx) return false;
    try {
      const resp = await fetch(`/api/music/fine-align?a=${tracks[masterIdx].media_id}&b=${tracks[idx].media_id}`);
      const data = await resp.json();
      if (!resp.ok) { if (!quiet) showToast('⚠ ' + (data.error || 'alignment failed')); return false; }
      tracks[idx].start_sec = tracks[masterIdx].start_sec - data.delta_sec;
      updateOffsetLabels(idx);
      scheduleSaveStart(idx);
      return data;
    } catch (err) {
      if (!quiet) showToast('⚠ ' + err.message);
      return false;
    }
  }

  /** Snap every non-master track to the master (sequential — the fine-align
   *  endpoint is CPU-bound). Used by the Snap-all button AND auto-snap on load. */
  async function snapAll() {
    const btn = document.getElementById('mixSnapAll');
    if (btn) { btn.disabled = true; btn.textContent = '⚡ Snapping…'; }
    let ok = 0, fail = 0;
    for (let i = 0; i < tracks.length; i++) {
      if (i === masterIdx) continue;
      (await snapTrack(i, { quiet: true })) ? ok++ : fail++;
    }
    syncAllToMaster();
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Snap all'; }
    showToast(`⚡ Snapped ${ok} track${ok === 1 ? '' : 's'} to the master${fail ? ` — ${fail} had no audio match` : ''}`);
  }
  document.getElementById('mixSnapAll').addEventListener('click', snapAll);

  // ⚡ per-layer: snap just this track
  document.querySelectorAll('.mix-autoalign').forEach(b => {
    b.addEventListener('click', async () => {
      const idx = Number(b.dataset.idx);
      if (idx === masterIdx) { showToast('This is the master — align the other tracks to it'); return; }
      b.disabled = true;
      const data = await snapTrack(idx);
      if (data) {
        syncAllToMaster();
        showToast(`⚡ Aligned to ~0.1s (${data.pairs} matching chunk${data.pairs === 1 ? '' : 's'}, BER ${data.ber.toFixed(3)})`);
      }
      b.disabled = false;
    });
  });

  // Out-of-range behavior toggle (Sync section)
  document.getElementById('mixBlankRange').addEventListener('change', (e) => {
    blankOutOfRange = e.target.checked;
    applyLoopFlags();
    syncAllToMaster();
  });

  // ✕ remove a layer: rebuild the mix without it, carrying over the full
  // config (offsets/volumes/effects/master) and the playback position —
  // far safer than in-place index surgery on every data-idx binding.
  document.querySelectorAll('.mix-remove-btn').forEach(b =>
    b.addEventListener('click', () => removeTrack(Number(b.dataset.idx))));
  function removeTrack(idx) {
    if (tracks.length <= 2) { showToast('A mix needs at least 2 videos — close the mix instead'); return; }
    const T = masterSongTime();
    const wasPlaying = !masterVideo().paused;
    const cfg = currentConfig();
    cfg.t.splice(idx, 1);
    cfg.m = masterIdx === idx ? 0 : (masterIdx > idx ? masterIdx - 1 : masterIdx);
    const ids = mediaIds.filter((_, i) => i !== idx);
    editorOpenMix(ids, layout, song?.id ?? null, {
      presetCfg: cfg, presetName: ctx.presetName,
      libraryMediaId: ctx.libraryMediaId, libTitle: ctx.libTitle, libDescription: ctx.libDescription,
      resumeT: T, resumePlay: wasPlaying, autoSnap: false,
    });
  }
  document.querySelectorAll('.mix-opacity').forEach(s =>
    s.addEventListener('input', () => setTileOpacity(Number(s.dataset.idx), Number(s.value) / 100)));
  document.querySelectorAll('.mix-volume').forEach(s =>
    s.addEventListener('input', () => setTrackVolume(Number(s.dataset.idx), Number(s.value) / 100)));
  document.querySelectorAll('.mix-master-btn').forEach(b =>
    b.addEventListener('click', () => setMaster(Number(b.dataset.idx))));
  // Spotlight is a TOGGLE: on saves the current opacities and dims the rest;
  // off restores exactly what was there — nothing is lost. Clicking another
  // layer's star moves the spotlight (restore happens on final toggle-off).
  let spotIdx = -1, spotSaved = null;
  function toggleSpotlight(idx) {
    if (spotIdx === idx) {
      if (spotSaved) spotSaved.forEach((op, i) => { if (i < tracks.length) setTileOpacity(i, op); });
      spotIdx = -1;
      spotSaved = null;
    } else {
      if (spotIdx < 0) spotSaved = tracks.map(t => t.opacity ?? 1);   // save once, before any dimming
      spotIdx = idx;
      for (let i = 0; i < tracks.length; i++) setTileOpacity(i, i === idx ? 1 : 0.15);
    }
    document.querySelectorAll('.mix-spot-btn').forEach(b =>
      b.classList.toggle('tk-active', Number(b.dataset.idx) === spotIdx));
  }
  document.querySelectorAll('.mix-spot-btn').forEach(b =>
    b.addEventListener('click', () => toggleSpotlight(Number(b.dataset.idx))));
  document.querySelectorAll('.mix-effect-type').forEach(sel =>
    sel.addEventListener('change', () => setEffectType(Number(sel.dataset.idx), sel.value)));
  document.getElementById('mixBalance').addEventListener('click', applyBalancedBlend);
  document.getElementById('mixAll100').addEventListener('click', () => {
    for (let i = 0; i < tracks.length; i++) setTileOpacity(i, 1);
  });
  document.getElementById('mixMasterOnly').addEventListener('click', () => {
    for (let i = 0; i < tracks.length; i++) setTrackVolume(i, i === masterIdx ? 1 : 0);
  });

  /* ---- Keyboard (only while the editor tab shows a mix) ---- */
  function onKeydown(e) {
    if (currentTab !== 'editor' || !editorMix) return;
    if (e.target.matches('input, textarea, select')) return;
    if (document.getElementById('mediaPlayerOverlay')?.classList.contains('active')) return;
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(e.shiftKey ? -10 : -5); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(e.shiftKey ? 10 : 5); }
    else if (e.key === 'm' || e.key === 'M') { setMixerOpen(!mixerSidebar.classList.contains('active')); }
    else if (e.key === '[' || e.key === ']') { mixToggleAbLoop(); }
    else if (e.key === '\\') { mixClearAbLoop(); }
  }
  window.addEventListener('keydown', onKeydown);

  /* ---- Presets ---- */
  const presetSel = document.getElementById('mixPresetLoad');
  const presetName = document.getElementById('mixPresetName');

  function currentConfig() {
    return {
      m: masterIdx, l: layout, c: cols,
      b: blankOutOfRange ? 1 : 0,     // out-of-range: 1 = blank/black, 0 = loop
      t: tracks.map((t, i) => ({
        v: Number((trackVolume[i] ?? 0).toFixed(3)),
        o: Number((t.opacity ?? 1).toFixed(3)),
        e: t.effect,
        s: t.start_sec,
      })),
    };
  }

  function applyConfig(cfg) {
    if (!cfg) return;
    // Master FIRST: setMaster's interactive volume-swap would otherwise
    // trample the per-track volumes loaded below (any config with m ≠ 0)
    if (typeof cfg.m === 'number' && cfg.m >= 0 && cfg.m < tracks.length) setMaster(cfg.m);
    if (cfg.b !== undefined) {
      blankOutOfRange = cfg.b !== 0 && cfg.b !== false;
      const cb = document.getElementById('mixBlankRange');
      if (cb) cb.checked = blankOutOfRange;
      applyLoopFlags();
    }
    if (Array.isArray(cfg.t)) {
      cfg.t.forEach((it, i) => {
        if (i >= tracks.length) return;
        if (typeof it.s === 'number') {
          tracks[i].start_sec = it.s;
          document.querySelectorAll(`.mix-offset[data-idx="${i}"]`).forEach(el => {
            el.textContent = musicFmtTime(it.s);
          });
        }
        if (typeof it.v === 'number') setTrackVolume(i, it.v);
        // Opacity: new configs carry `o`; older ones embedded it in a
        // uniform/blend effect — migrate on load
        if (typeof it.o === 'number') setTileOpacity(i, it.o);
        else if ((it.e?.type === 'uniform' || it.e?.type === 'blend') && typeof it.e.opacity === 'number') {
          setTileOpacity(i, it.e.opacity);
        }
        if (it.e) {
          const { opacity: _legacy, ...eff } = it.e;
          applyTrackEffect(i, eff);
        }
      });
    }
    if (typeof cfg.c === 'number') {
      cols = Math.max(1, Math.min(6, cfg.c));
      document.getElementById('mixCols').value = cols;
      stage.style.setProperty('--cols', cols);
    }
    if (cfg.l === 'grid' || cfg.l === 'stack') setLayout(cfg.l);
    syncAllToMaster();
  }

  async function refreshPresetOptions() {
    let list = [];
    try { list = await fetch('/api/music/presets').then(r => r.json()); } catch {}
    const matching = list.filter(p => {
      let ids = [];
      try { ids = JSON.parse(p.media_ids); } catch {}
      return ids.length === mediaIds.length && ids.every((v, i) => Number(v) === Number(mediaIds[i]));
    });
    presetSel.innerHTML = '<option value="">— load —</option>' +
      matching.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  }
  refreshPresetOptions();

  presetSel.addEventListener('change', async () => {
    const id = Number(presetSel.value);
    if (!id) return;
    const p = await fetch(`/api/music/presets/${id}`).then(r => r.json());
    try {
      applyConfig(JSON.parse(p.config_json));
      presetName.value = p.name;
      showToast(`Loaded mix: ${p.name}`);
    } catch { showToast('⚠ Mix corrupted'); }
  });

  document.getElementById('mixPresetSave').addEventListener('click', async () => {
    const name = presetName.value.trim();
    if (!name) { showToast('Name the mix first'); presetName.focus(); return; }
    await fetch('/api/music/presets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, song_id: song?.id || null, media_ids: mediaIds, config: currentConfig() }),
    });
    showToast(`💾 Mix saved: ${name}`);
    refreshPresetOptions();
  });

  /* ---- Save to Library (custom mix tile — plays through the Editor) ---- */
  let libraryMediaId = ctx.libraryMediaId || null;
  document.getElementById('mixLibSave').addEventListener('click', async function () {
    const title = document.getElementById('mixLibTitle').value.trim();
    const description = document.getElementById('mixLibDesc').value.trim();
    if (!title) { showToast('Give the mix a title first'); document.getElementById('mixLibTitle').focus(); return; }

    this.disabled = true;
    try {
      if (libraryMediaId) {
        const r = await fetch(`/api/music/mixes/${libraryMediaId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description, config: currentConfig(), media_ids: mediaIds, song_id: song?.id || null }),
        }).then(x => x.json());
        if (r.error) { showToast('⚠ ' + r.error); return; }
        showToast(`⟳ Library mix updated: ${title}`);
      } else {
        const r = await fetch('/api/music/mixes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description, song_id: song?.id || null, media_ids: mediaIds, config: currentConfig() }),
        }).then(x => x.json());
        if (r.error) { showToast('⚠ ' + r.error); return; }
        libraryMediaId = r.media_id;
        this.textContent = '⟳ Update library mix';
        showToast(`💾 Saved to Library: ${title} — find the 🎛 tile in the grid`);
      }
      if (typeof loadDatabase === 'function') loadDatabase();
    } catch (e) {
      showToast('⚠ Save failed: ' + e.message);
    } finally {
      this.disabled = false;
    }
  });

  /* ---- Export ---- */
  let exportPoll = null;
  const stopExportPoll = () => { if (exportPoll) { clearInterval(exportPoll); exportPoll = null; } };

  document.getElementById('mixExport').addEventListener('click', () => {
    // Default range: overlap window across tracks (song-aligned) or the
    // shortest remaining runtime from each track's current start
    const lengths = tracks.map(t => {
      if (t.end_sec != null && t.end_sec > t.start_sec) return t.end_sec - t.start_sec;
      return Math.max(0, (t.duration || 0) - t.start_sec);
    }).filter(x => x > 0);
    const overlapEnd = lengths.length ? Math.min(...lengths) : 30;

    const slugBase = song ? `${song.artist}-${song.title}` : 'mix';
    const slug = slugBase.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    const defName = `${slug || 'mix'}-${Date.now().toString().slice(-6)}.mp4`;

    // Beatbar bake is offered only while the bar actually rides this mix
    const bbAttached = !!(window.BeatBar && BeatBar.isAttached());
    const { body, close } = musicModal('📤 Export current mix', `
      <div class="music-hint">Encodes ${tracks.length} track(s) with the current opacities, effects and volumes (ffmpeg, runs in the background). The finished MP4 is held in memory only — nothing touches disk until you hit ⬇ Download.</div>
      <div class="music-form-row">
        <label class="music-time-field">start
          <input type="text" class="music-input music-input-time" id="mex-start" value="0:00">
        </label>
        <label class="music-time-field">end
          <input type="text" class="music-input music-input-time" id="mex-end" value="${musicFmtTime(overlapEnd)}">
        </label>
        <select class="editor-select" id="mex-res">
          <option value="1280x720" selected>720p</option>
          <option value="1920x1080">1080p</option>
          <option value="640x360">360p</option>
        </select>
      </div>
      <div class="music-form-row">
        <input type="text" class="music-input" id="mex-name" value="${escapeHtml(defName)}">
      </div>
      ${bbAttached ? `
      <div class="music-form-row">
        <label class="music-hint" style="display:flex;align-items:center;gap:.45rem;cursor:pointer;margin:0">
          <input type="checkbox" id="mex-beatbar" checked style="accent-color:var(--accent)">
          🥁 Bake the beat bar into the video — uses its settings as they are at submit (changes after won't affect this render)
        </label>
      </div>` : ''}
      <div class="music-form-row music-form-actions">
        <button class="music-btn music-btn-primary" id="mex-go">Start export</button>
        <button class="music-btn" id="mex-cancel">Cancel</button>
      </div>
    `);
    body.querySelector('#mex-cancel').addEventListener('click', close);
    body.querySelector('#mex-go').addEventListener('click', async function () {
      const goBtn = this;
      if (goBtn.disabled) return;
      const t0 = musicParseTime(body.querySelector('#mex-start').value);
      const t1 = musicParseTime(body.querySelector('#mex-end').value);
      if (t0 == null || t1 == null || t1 <= t0) { showToast('Invalid range'); return; }
      const [w, h] = body.querySelector('#mex-res').value.split('x').map(Number);
      const durationSec = t1 - t0;

      // Beatbar bake: snapshot NOW, render the overlay client-side (same
      // painter as the live bar), upload it, and reference it in the job.
      let beatbar = null;
      if (bbAttached && body.querySelector('#mex-beatbar')?.checked) {
        const snap = BeatBar.exportSnapshot();
        if (!snap) { showToast('⚠ Beat bar has no beats yet — wait for the analysis or untick the bake option'); return; }
        goBtn.disabled = true;
        try {
          // Beats live in the ridden video's time base; export t=0 is that
          // track's seek. Fall back to the master if the id got out of step.
          const bbIdx = tracks.findIndex(tr => tr.media_id === snap.mediaId);
          const offset = tracks[bbIdx >= 0 ? bbIdx : masterIdx].start_sec + t0;
          const beats = snap.beats.map(b => b - offset).filter(b => b > -2 && b < durationSec + 2);

          // Same vertical footprint the user sees, mapped onto output pixels
          const barH = Math.max(24, Math.min(Math.round(h * 0.9), Math.round(snap.hFrac * h)));
          const y = Math.max(0, Math.min(h - barH, Math.round(snap.yFrac * h)));
          const fps = 30;

          const blob = await BeatBar.renderOverlayPngStream({
            beats, config: snap.config, width: w, height: barH, fps, durationSec,
            onProgress: (p) => { goBtn.textContent = `Rendering beat bar… ${Math.round(p * 100)}%`; },
          });
          goBtn.textContent = 'Uploading beat bar…';
          const up = await fetch('/api/music/exports/overlay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: blob,
          }).then(r => r.json());
          if (!up.token) throw new Error(up.error || 'overlay upload failed');
          beatbar = { overlay_token: up.token, x: 0, y, w, h: barH, fps };
        } catch (e) {
          goBtn.disabled = false;
          goBtn.textContent = 'Start export';
          showToast('⚠ Beat bar bake failed: ' + e.message);
          return;
        }
      }

      goBtn.disabled = true;
      goBtn.textContent = 'Queueing…';
      let job;
      try {
        job = await fetch('/api/music/exports', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            song_id: song?.id || null,
            filename: body.querySelector('#mex-name').value.trim() || defName,
            width: w, height: h,
            duration_sec: durationSec,
            beatbar,
            tracks: tracks.map((t, i) => ({
              media_id: t.media_id,
              seek: t.start_sec + t0,
              volume: trackVolume[i] ?? 0,
              effect: editorExportEffect(t.effect, t.opacity),
            })),
          }),
        }).then(r => r.json());
      } catch (e) {
        job = { error: e.message };
      }
      if (!job || job.error) {
        goBtn.disabled = false;
        goBtn.textContent = 'Start export';
        showToast('⚠ Export failed: ' + (job?.error || 'request failed'));
        return;
      }
      close();
      showToast(beatbar ? '📤 Export queued — beat bar baked in' : '📤 Export queued');
      pollExport(job.id);
    });
  });

  function pollExport(jobId) {
    stopExportPoll();
    const box = document.getElementById('mixExportStatus');
    const tick = async () => {
      let job;
      try { job = await fetch(`/api/music/exports/${jobId}`).then(r => r.json()); } catch { return; }
      if (!job || !box) return;
      box.style.display = '';
      const pct = Math.round((job.progress || 0) * 100);
      if (job.status === 'done') {
        // Finished MP4s live in memory only — Download is the save action
        box.innerHTML = job.available === false
          ? `<div class="editor-export-fail">✓ ${escapeHtml(job.filename)} — expired (exports stay in memory until downloaded; render again)
            <button class="music-btn" onclick="this.closest('#mixExportStatus').style.display='none'">✕</button></div>`
          : `<div class="editor-export-done">✓ ${escapeHtml(job.filename)} — in memory, not on disk
            <a class="music-btn" href="/api/music/exports/${job.id}/download" download>⬇ Download</a>
            <button class="music-btn" onclick="this.closest('#mixExportStatus').style.display='none'">✕</button></div>`;
        stopExportPoll();
        showToast(`✓ Export ready: ${job.filename} — hit ⬇ to save it`);
      } else if (job.status === 'failed') {
        box.innerHTML = `<div class="editor-export-fail">⚠ Export failed: ${escapeHtml((job.error || '').slice(0, 200))}
          <button class="music-btn" onclick="this.closest('#mixExportStatus').style.display='none'">✕</button></div>`;
        stopExportPoll();
      } else {
        box.innerHTML = `<div class="editor-export-run">Encoding ${escapeHtml(job.filename)} — ${pct}%
          <div class="music-progress editor-queue-progress"><div class="music-progress-fill" style="width:${pct}%"></div></div></div>`;
      }
    };
    tick();
    exportPoll = setInterval(tick, 1500);
  }

  /* ---- Init ---- */
  applyAudio();
  bindMasterListeners();
  for (let i = 0; i < tracks.length; i++) {
    const box = document.querySelector(`.editor-fx-params[data-idx="${i}"]`);
    if (box) box.innerHTML = renderFxParams(i, tracks[i].effect);
    bindFxParams(i);
  }
  masterVideo().addEventListener('loadedmetadata', () => {
    if (masterVideo().currentTime < tracks[masterIdx].start_sec) {
      masterVideo().currentTime = tracks[masterIdx].start_sec;
    }
    syncAllToMaster();
  }, { once: true });
  if (layout === 'stack' && !ctx.presetCfg) {
    // fresh stack starts balanced so every layer is visible
    applyBalancedBlend();
  }

  editorMix = {
    mediaIds, song, tracks, layout,
    pauseAll,
    cleanup() {
      stopDriftLoop();
      stopExportPoll();
      cancelAnimationFrame(syncRaf);
      if (uiTimer) { clearInterval(uiTimer); uiTimer = null; }
      window.removeEventListener('keydown', onKeydown);
      if (window.BeatBar) BeatBar.detach();
      videos.forEach(v => { try { v.pause(); v.src = ''; v.load(); } catch {} });
    },
  };

  // preset restore (Saved mixes → ▶) happens after editorMix exists so
  // setLayout/setMaster/beatbar hooks all see the live context
  if (ctx.presetCfg) applyConfig(ctx.presetCfg);

  // Resume position (track removal rebuilds the mix mid-playback)
  if (typeof ctx.resumeT === 'number' && ctx.resumeT > 0) {
    masterVideo().currentTime = songToVideo(masterIdx, ctx.resumeT);
    syncAllToMaster();
    if (ctx.resumePlay) playAll();
  }

  // Auto-snap on load: similar-audio / custom stacks arrive with zero offsets
  // (no single song shared by all files) — fingerprint-align them immediately
  // so shared sections line up without a manual ⚡ per track.
  if (ctx.autoSnap && tracks.length >= 2) snapAll();

  // No hard track cap anymore — but many concurrent decodes are drive-bound
  if (tracks.length > 4) {
    showToast(`⚠ ${tracks.length} videos decode at once — smooth playback depends on drive read speed`);
  }

  // Mixer sidebar: remembered open/closed (open on first use — discoverable)
  let mixerOpen = true;
  try { mixerOpen = localStorage.getItem('editor_mixer_open') !== '0'; } catch {}
  setMixerOpen(mixerOpen);

  refreshBeatbar();
}

/* ── Hover popover on the open-song video picker (path + details) ──────── */
// Reuses cards.js's tile popover machinery; the Library's delegation only
// covers #resultsGrid, so the Editor container gets its own.
document.addEventListener('DOMContentLoaded', () => {
  const cont = document.getElementById('editorContainer');
  if (!cont) return;
  cont.addEventListener('mouseover', (e) => {
    const tile = e.target.closest('.editor-pick-tile');
    if (!tile) return;
    const id = Number(tile.dataset.id);
    if (id === _popoverForId) return;
    clearTimeout(_popoverTimer);
    _popoverTimer = setTimeout(() => {
      const media = getMediaById(id);
      if (media && tile.isConnected) showTilePopover(tile, media);
    }, 150);
  });
  cont.addEventListener('mouseout', (e) => {
    const tile = e.target.closest('.editor-pick-tile');
    if (!tile) return;
    const to = e.relatedTarget;
    if (to && (tile.contains(to) || to.closest?.('#tilePopover'))) return;
    clearTimeout(_popoverTimer);
    _popoverTimer = null;
    setTimeout(() => {
      const pop = document.getElementById('tilePopover');
      if (pop && !pop.matches(':hover') && !cont.querySelector('.editor-pick-tile:hover')) {
        hideTilePopover();
      }
    }, 80);
  });
});
