/* =========================================================================
   INFO PANEL LAYOUT - what the Modern tabbed Info panel shows
   (player-lib/detail-view.js renderDetailPanel draws it, beside the player
   and as the library's detail view).

   Pure functions, no DOM, so test/panel-layout.test.js can load them in vm.
   See .notes/MODERN_PLAYER_SPEC.md, Phase 3.

   - tabsFor(type, {faces, fingerprinted, upNext})  the tabs a file gets, in order
   - pickTab(tabs, remembered)              the tab to open on
   - actionsFor(media)                      quick actions: {row, more}
   - fitActions(width, count, sizes)        how many row buttons fit
   ========================================================================= */

const PanelLayout = (() => {
  const TAB_ORDER = ['details', 'notes', 'subtitles', 'music', 'people', 'upnext', 'file'];
  const TIMED = ['video', 'audio'];
  // Same list as faces.js FACES_KINDS: the types face search looks at.
  const FACE_KINDS = ['image', 'gif', 'video'];

  /**
   * Details, Notes and File always; Subtitles for video and audio; Music for
   * audio, and for a video once it has been fingerprinted; People while face
   * search is on, for the types it reads; Up next beside the player only
   * (upNext: the queue that plays before the list carries on).
   */
  function tabsFor(type, { faces = false, fingerprinted = false, upNext = false } = {}) {
    const on = {
      details: true,
      notes: true,
      subtitles: TIMED.includes(type),
      music: type === 'audio' || (type === 'video' && !!fingerprinted),
      people: !!faces && FACE_KINDS.includes(type),
      upnext: !!upNext,
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

  return { TAB_ORDER, tabsFor, pickTab, actionsFor, fitActions };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PanelLayout;
