/* =========================================================================
   UP NEXT RULE - which file a move lands on (PLAYLISTS_SPEC step 4).

   Pure functions, no DOM, so test/up-next.test.js can load them in Node.
   player-core.js asks these and then walks the results (the list) itself,
   skipping documents and files that cannot play, as it always has.

   The list is the results that were playing (a collection, a search). Up
   next is the saved queue (player-lib/up-next.js). The list keeps an
   anchor: the last file that came from the list. A file played from Up next
   never moves the anchor, so when Up next runs dry the list carries on from
   where it left off, not from wherever the Up next file sits in it.

   - anchorIndex(anchor, indexOf)   where the anchor sits in the list now
   - anchorAfterPlay(prev, play)    the anchor once a file has opened
   - plan(move)                     what Next, Previous or a file ending does
   - undoRemove / undoClear / undoAdd   Undo of one change, worked out
                                    against Up next as it is now
   ========================================================================= */

const UpNextRule = (() => {
  const NO_ANCHOR = Object.freeze({ id: null, index: -1 });

  /**
   * The anchor's position in the list. By id while the file is in the list
   * (the list can be re-run under the player: a trash, a restore), else the
   * position it had when it played. -1: nothing from the list has played.
   */
  function anchorIndex(anchor, indexOf) {
    if (!anchor) return -1;
    if (anchor.id != null && typeof indexOf === 'function') {
      const i = indexOf(anchor.id);
      if (Number.isInteger(i) && i >= 0) return i;
    }
    return Number.isInteger(anchor.index) && anchor.index >= 0 ? anchor.index : -1;
  }

  /**
   * The anchor after a file opened. play: { fromUpNext, keep, id, index }:
   * a file from Up next, or keep (the same file reopened, as Maximize does),
   * leaves it; any other file is now where the list stands (index -1 for a
   * file outside the list, which starts the list from the top, as before).
   */
  function anchorAfterPlay(prev, play) {
    const p = play || {};
    if (p.fromUpNext || p.keep) return prev || NO_ANCHOR;
    return { id: p.id != null ? p.id : null, index: Number.isInteger(p.index) ? p.index : -1 };
  }

  /**
   * What a move does.
   * move: {
   *   dir: 'next' | 'prev',
   *   auto: true when a file ended (or failed) on its own, false for a press,
   *   upNextCount: files waiting in Up next,
   *   anchor: anchorIndex(...),
   *   fromUpNext: is the file on screen one Up next played,
   *   repeat: 'off' | 'all' | 'one',
   * }
   * Answers one of:
   *   { take: 'upnext' }                          play the first file in Up next
   *   { take: 'list', from, step, wrap }          walk the list from `from`
   *                                               (exclusive) by `step`; wrap:
   *                                               start over at the top when
   *                                               the walk finds nothing
   */
  function plan(move) {
    const m = move || {};
    const anchor = Number.isInteger(m.anchor) ? m.anchor : -1;
    if (m.dir === 'prev') {
      // Previous goes back in the list, never into Up next. From a file Up
      // next played, back is the list file it came after: walk down from
      // just past the anchor, so the anchor itself is the first one tried.
      if (m.fromUpNext && anchor >= 0) return { take: 'list', from: anchor + 1, step: -1, wrap: false };
      return { take: 'list', from: anchor, step: -1, wrap: false };
    }
    // Repeat one never gets here on its own: the element loops, and
    // autoAdvanceOnEnded stops a stray 'ended' (player-core.js). A file that
    // fails still moves on, as it always has.
    if (m.upNextCount > 0) return { take: 'upnext' };
    // Repeat all wraps the list (not Up next), and only on its own: Next
    // pressed at the end of the list stays put, as it always has.
    return { take: 'list', from: anchor, step: 1, wrap: !!m.auto && m.repeat === 'all' };
  }

  /* ── Undo: invert one change against Up next as it is NOW ──────────────
     Undo never restores an old snapshot: files may have played (left Up
     next) or been added since. Each inverse touches only the files that one
     change touched, and a file in `skip` (it has started playing since) is
     never put back. All take and give lists of media ids. */

  /** Position in `out` of the first file after `at` in `before` that is still queued, or -1. */
  function followerPos(out, before, at) {
    for (let k = at + 1; k < before.length; k++) {
      const j = out.indexOf(before[k]);
      if (j !== -1) return j;
    }
    return -1;
  }

  /**
   * Undo a removal: each removed file goes back where it was, before the
   * file that followed it if that one is still queued, else at its old
   * position (clamped). Files already back in Up next are left alone.
   */
  function undoRemove(now, before, removed, skip = []) {
    const out = (now || []).slice();
    const gone = new Set(removed || []);
    const no = new Set(skip || []);
    (before || []).forEach((id, at) => {
      if (!gone.has(id) || no.has(id) || out.includes(id)) return;
      const pos = followerPos(out, before, at);
      out.splice(pos === -1 ? Math.min(at, out.length) : pos, 0, id);
    });
    return out;
  }

  /** Undo Clear: the cleared files not in Up next now go back at the front, in their old order. */
  function undoClear(now, cleared, skip = []) {
    const cur = now || [];
    const no = new Set([...(skip || []), ...cur]);
    return [...(cleared || []).filter(id => !no.has(id)), ...cur];
  }

  /**
   * Undo an add: the files it put in come out; a file that was already
   * queued (the add only moved it) goes back beside its old neighbour (after
   * the file before it, else before the file after it, else its old place).
   */
  function undoAdd(now, before, added) {
    const had = new Set(before || []);
    const touched = new Set(added || []);
    const out = (now || []).filter(id => !(touched.has(id) && !had.has(id)));
    (before || []).forEach((id, at) => {
      if (!touched.has(id) || !out.includes(id)) return;
      out.splice(out.indexOf(id), 1);
      let pos = -1;
      for (let k = at - 1; k >= 0 && pos === -1; k--) {
        const j = out.indexOf(before[k]);
        if (j !== -1) pos = j + 1;
      }
      if (pos === -1) pos = followerPos(out, before, at);
      out.splice(pos === -1 ? Math.min(at, out.length) : pos, 0, id);
    });
    return out;
  }

  return { NO_ANCHOR, anchorIndex, anchorAfterPlay, plan, undoRemove, undoClear, undoAdd };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = UpNextRule;
