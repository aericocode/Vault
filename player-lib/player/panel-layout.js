/* =========================================================================
   INFO PANEL LAYOUT - what the Modern player's tabbed Info panel shows
   (player-lib/detail-view.js renderDetailPanel draws it).

   Pure functions, no DOM, so test/panel-layout.test.js can load them in vm.
   See .notes/MODERN_PLAYER_SPEC.md, Phase 3.

   - tabsFor(type, {faces, fingerprinted})  the tabs a file gets, in order
   - pickTab(tabs, remembered)              the tab to open on
   - actionsFor(media)                      quick actions: {row, more}
   - fitActions(width, count, sizes)        how many row buttons fit
   - formatTime(seconds)                    "1:16" / "1:02:03"
   - noteWithTime(text, seconds)            a note led by its playback time
   ========================================================================= */

const PanelLayout = (() => {
  const TAB_ORDER = ['details', 'notes', 'subtitles', 'music', 'people', 'file'];
  const TIMED = ['video', 'audio'];
  // Same list as faces.js FACES_KINDS: the types face search looks at.
  const FACE_KINDS = ['image', 'gif', 'video'];

  /**
   * Details, Notes and File always; Subtitles for video and audio; Music for
   * audio, and for a video once it has been fingerprinted; People while face
   * search is on, for the types it reads.
   */
  function tabsFor(type, { faces = false, fingerprinted = false } = {}) {
    const on = {
      details: true,
      notes: true,
      subtitles: TIMED.includes(type),
      music: type === 'audio' || (type === 'video' && !!fingerprinted),
      people: !!faces && FACE_KINDS.includes(type),
      file: true,
    };
    return TAB_ORDER.filter(k => on[k]);
  }

  /** The remembered tab when this file has it, else the first one. */
  function pickTab(tabs, remembered) {
    if (!Array.isArray(tabs) || !tabs.length) return 'details';
    return tabs.includes(remembered) ? remembered : tabs[0];
  }

  /**
   * Quick action keys. `row` in the order they sit in the header (the ones
   * that do not fit go to More, from the end); `more` always lives in More.
   * Mixes have no file on disk: no trash and no force refresh, but Open in
   * Editor. Rescan shows only for a scan that failed or never ran, as today.
   */
  function actionsFor(media) {
    const m = media || {};
    const mix = m.media_type === 'mix';
    const row = ['flag'];
    if (!mix) row.push(m.user_trashed ? 'restore' : 'trash');
    row.push('copy');
    if (!mix) row.push('refresh');
    if (m.processing_error) row.push(m.processing_error === 'unscanned' ? 'scan' : 'rescan');
    row.push('collections');
    if (mix) row.push('editor');
    return { row, more: ['remove'] };
  }

  /**
   * How many of `count` row buttons fit in `width` px, after `fixed` px for
   * the More and close buttons. Before layout (width 0) every button shows.
   */
  function fitActions(width, count, { btn = 36, gap = 4, fixed = 0 } = {}) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (!(width > 0)) return n;
    const fits = Math.floor((width - fixed + gap) / (btn + gap));
    return Math.max(0, Math.min(n, fits));
  }

  /** "1:16", "0:05", "1:02:03" (formatDuration in utils.js, but 0 is "0:00"). */
  function formatTime(seconds) {
    const t = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Any [h:]m:ss in the note, whatever sits right after it ("0:05intro",
  // "10:30pm"): a word boundary would miss those and a second time would go
  // in front. Not preceded by a digit or colon, not followed by a digit.
  const HAS_TIME = /(?:^|[^\d:])(?:\d{1,2}:)?\d{1,2}:\d{2}(?!\d)/;

  /**
   * The note box saves "1:16 good bit": the time leads, so the note links to
   * that spot and shows as a pin on the timeline. A note that already names
   * a time is saved as typed, and so is one with no usable time.
   */
  function noteWithTime(text, seconds) {
    const t = String(text == null ? '' : text).trim();
    if (!t || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return t;
    if (HAS_TIME.test(t)) return t;
    return `${formatTime(seconds)} ${t}`;
  }

  /**
   * Back from Classic: the start time remembered when the Modern box was
   * left ({id, text, at}) still belongs to the box only if the same file is
   * open and the box still holds that draft (or that draft typed on). A
   * draft saved in Classic, a new one, or another file: '' (the time is then
   * taken when typing starts, or at save).
   */
  function draftStartAt(saved, mediaId, draft) {
    if (!saved || !saved.text || saved.at === '' || saved.at == null) return '';
    if (Number(saved.id) !== Number(mediaId)) return '';
    const now = String(draft == null ? '' : draft).trim();
    return now.startsWith(saved.text) ? String(saved.at) : '';
  }

  return { TAB_ORDER, tabsFor, pickTab, actionsFor, fitActions, formatTime, noteWithTime, draftStartAt };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PanelLayout;
