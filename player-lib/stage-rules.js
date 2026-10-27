/* =========================================================================
   STAGE RULES - the pure parts of Stage (PLAYLISTS_SPEC 5), shared by the
   Stage page (player-lib/stage.js), the remote (player-lib/stage-control.js)
   and the tests (test/stage.test.js). No DOM, no network.

   - upcoming(o)            what Stage plays next by itself, in order: Up next
                            first, then the list carries on from its anchor,
                            wrapping only with Repeat all (the same rule as
                            player-lib/up-next-rule.js plan() for a file that
                            ends on its own)
   - resumeAt(row)          where a file opens: its saved spot, as the player
                            does (player-lib/viewtracker.js)
   - positionToSave(t, d)   the spot to store (0 once nearly finished)
   - viewCounts(acc, d)     has enough been watched to count a view
   - gifLoopSeconds(bytes)  how long one loop of a GIF takes
   - pictureMs(item, s, g)  how long a picture or GIF stays on Stage
   - nameText(filename)     the name shown as a file starts
   - playerChoice(o)        which Stage runs: mpv, or Basic (the browser's
                            picture-in-picture, no extra program)
   - basicPlays(type)       what Basic Stage can show (videos only)
   ========================================================================= */

const StageRules = (() => {
  const RESUME_MIN_S = 10;           // same numbers as viewtracker.js
  const RESUME_MAX_FRACTION = 0.9;
  const WATCH_THRESHOLD = 0.75;
  const WATCH_THRESHOLD_SECONDS = 180;
  const DWELL_MS = 2000;             // a picture counts as seen after this long

  /**
   * The files Stage moves on to by itself, best first.
   * o: {
   *   upNext: [{ id, ok }]   Up next in order; ok false: cannot play there
   *   anchor: number         where the list stands (-1: nothing from it yet)
   *   length: number         files in the list
   *   okAt(i): boolean       can the list file at i play (documents and
   *                          files nothing can play are passed over)
   *   repeat: 'off'|'all'|'one'
   *   count: how many to give (default 2)
   * }
   * Answers [{ via: 'upnext', id } | { via: 'list', index }].
   * Repeat one gives nothing: the file on Stage loops.
   */
  function upcoming(o) {
    const m = o || {};
    const count = Number.isInteger(m.count) && m.count > 0 ? m.count : 2;
    if (m.repeat === 'one') return [];
    const out = [];
    for (const u of m.upNext || []) {
      if (out.length >= count) return out;
      if (u && Number.isInteger(u.id) && u.ok !== false) out.push({ via: 'upnext', id: u.id });
    }
    const n = Number.isInteger(m.length) && m.length > 0 ? m.length : 0;
    const anchor = Number.isInteger(m.anchor) && m.anchor >= -1 ? Math.min(m.anchor, n - 1) : -1;
    // okAt: true, false (passed over), or null: not known yet (its row has not
    // loaded). The answer ends at an unknown file rather than skip it unseen.
    const ok = (i) => (typeof m.okAt !== 'function' ? true : m.okAt(i));
    let fromList = 0;
    for (let i = anchor + 1; i < n && out.length < count; i++) {
      const v = ok(i);
      if (v === null) return out;
      if (v !== false) { out.push({ via: 'list', index: i }); fromList++; }
    }
    // Repeat all starts the list over (a list of one is repeat one's job, and
    // so is coming back round to the anchor when nothing else in it plays).
    if (m.repeat === 'all' && n >= 2) {
      let alone = false;
      for (let i = 0; i <= anchor && out.length < count; i++) {
        const v = ok(i);
        if (v === null) return out;
        if (v === false) continue;
        if (i === anchor && fromList === 0) { alone = true; break; }
        out.push({ via: 'list', index: i });
        fromList++;
      }
      // ...and round again until count is reached: Stage left on its own
      // for hours (the Vault tab frozen in the background) keeps going. Each
      // lap is the list in its order from just after the anchor.
      if (!alone && fromList >= 2) {
        while (out.length < count) {
          let added = 0;
          for (let k = 0; k < n && out.length < count; k++) {
            const i = (anchor + 1 + k) % n;
            const v = ok(i);
            if (v === null) return out;
            if (v !== false) { out.push({ via: 'list', index: i }); added++; }
          }
          if (!added) break;
        }
      }
    }
    return out;
  }

  /** Where a file opens on Stage: its saved spot, unless it is near the start or nearly done. */
  function resumeAt(row, { resume = true } = {}) {
    if (!resume || !row) return 0;
    const pos = Number(row.last_position) || 0;
    const dur = Number(row.duration_seconds) || 0;
    if (pos > RESUME_MIN_S && dur > 0 && pos < dur * RESUME_MAX_FRACTION) return pos;
    return 0;
  }

  /** The spot to store for t of d: 0 once effectively finished, null when there is nothing to store. */
  function positionToSave(t, d) {
    if (!(t > 0) || !(d > 0)) return null;
    return t >= d * RESUME_MAX_FRACTION ? 0 : Math.round(t * 10) / 10;
  }

  /** A view counts once this much has been watched (in pieces is fine): 75 % or 3 minutes. */
  function viewCounts(accumulated, d) {
    if (!(d > 0) || !(accumulated > 0)) return false;
    return accumulated >= d * WATCH_THRESHOLD || accumulated >= WATCH_THRESHOLD_SECONDS;
  }

  /**
   * One loop of an animated GIF, in seconds, from its bytes (0 when it is not
   * a GIF). Frames with no delay, or one under 2/100 s, show for 1/10 s, as
   * browsers draw them.
   */
  function gifLoopSeconds(bytes) {
    const b = bytes;
    if (!b || b.length < 13) return 0;
    if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return 0;   // "GIF"
    let p = 13;
    const flags = b[10];
    if (flags & 0x80) p += 3 * (1 << ((flags & 0x07) + 1));
    let total = 0;       // hundredths
    let delay = -1;      // the next frame's, from its Graphic Control Extension
    const skipSubBlocks = () => {
      while (p < b.length) {
        const n = b[p++];
        if (n === 0) return true;
        p += n;
      }
      return false;
    };
    while (p < b.length) {
      const tag = b[p++];
      if (tag === 0x3B) break;                       // trailer
      if (tag === 0x21) {                            // extension
        const label = b[p++];
        if (label === 0xF9 && b[p] === 4 && p + 5 < b.length) {
          delay = b[p + 2] | (b[p + 3] << 8);
          p += 5;
          if (b[p] === 0) p++;
          else if (!skipSubBlocks()) break;
        } else if (!skipSubBlocks()) break;
      } else if (tag === 0x2C) {                     // a frame
        if (p + 9 > b.length) break;
        const lf = b[p + 8];
        p += 9;
        if (lf & 0x80) p += 3 * (1 << ((lf & 0x07) + 1));
        p++;                                         // LZW minimum code size
        if (!skipSubBlocks()) { total += delay < 2 ? 10 : delay; break; }
        total += delay < 2 ? 10 : delay;
        delay = -1;
      } else {
        break;                                       // not a GIF block: stop here
      }
    }
    return total / 100;
  }

  /**
   * How long a picture stays on Stage, in ms: the setting's seconds; a GIF at
   * least one full loop (its known loop length, else its probed duration).
   */
  function pictureMs(item, imageSeconds, gifLoop) {
    const base = Math.max(1, Number(imageSeconds) || 8) * 1000;
    if (!item || item.media_type !== 'gif') return base;
    const loop = Number(gifLoop) > 0 ? Number(gifLoop) : (Number(item.duration) > 0 ? Number(item.duration) : 0);
    if (!loop) return base;
    // Enough whole loops to cover the setting, and at least one.
    const loops = Math.max(1, Math.ceil(base / (loop * 1000)));
    return Math.round(loops * loop * 1000);
  }

  /** The file's name as viewers see it: no folder, no extension. */
  function nameText(filename) {
    const s = String(filename || '').split(/[\\/]/).pop();
    const dot = s.lastIndexOf('.');
    const base = dot > 0 && s.length - dot <= 6 ? s.slice(0, dot) : s;
    return base.trim();
  }

  const PLAYERS = ['auto', 'basic'];

  /**
   * Which Stage runs. setting: 'auto' (mpv when it is found, else Basic) or
   * 'basic' (always Basic). Anything else counts as 'auto'.
   */
  function playerChoice({ setting = 'auto', mpvFound = false } = {}) {
    if (setting === 'basic') return 'basic';
    return mpvFound === true ? 'mpv' : 'basic';
  }

  /** Basic Stage is the browser's video picture-in-picture: videos only. */
  function basicPlays(mediaType) {
    return mediaType === 'video';
  }

  return {
    RESUME_MIN_S, RESUME_MAX_FRACTION, DWELL_MS, PLAYERS,
    upcoming, resumeAt, positionToSave, viewCounts, gifLoopSeconds, pictureMs, nameText,
    playerChoice, basicPlays,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = StageRules;
if (typeof window !== 'undefined') window.StageRules = StageRules;
