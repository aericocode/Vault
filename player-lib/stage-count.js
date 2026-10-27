/* =========================================================================
   STAGE COUNT - "Track 12 of 40 · 2:14:30 left" on the Stage bar and the
   Flow order bar, and "40 files · 2:41:05" on the Flow order bar while
   Stage is closed. Pure: no DOM, no network, so test/stage-count.test.js
   runs it in Node. stage-control.js gathers what it needs (the list Stage
   plays, Up next, the rows' lengths) and flow.js draws it.

   How it counts (what Vault would really play, so the numbers come true):
   - The list is the list Stage plays from, in its order. A document is
     never played, so it is never counted; neither is a mix. Basic Stage
     plays videos only, so there pictures, GIFs and sound files are not
     counted either (it passes over them).
   - Track N is the list files up to and including the one the list stands
     on (its anchor), plus the Up next files played on Stage so far
     (upPlayed: one played now counts as the track on). Of M adds what is
     waiting in Up next.
   - Time left is the rest of the file on Stage, then every file still to
     play: Up next, then the rest of the list. Pictures count for the
     "Show pictures for" seconds, GIFs for at least one whole loop (as
     StageRules.pictureMs times them on Stage).
   - Repeat all and Repeat this file never end: the count shows, no time.
   - A file whose length Vault does not know yet adds nothing and makes the
     time "about"; with more than half unknown, or more than TIME_CAP files
     still to play, no time is shown at all.
   ========================================================================= */

const StageCount = (() => {
  const TIME_CAP = 400;
  const PLAYS = new Set(['video', 'audio', 'image', 'gif']);

  /** Does Stage play a file of this type? (Basic: videos only.) */
  function plays(type, basic = false) {
    if (basic) return type === 'video';
    return PLAYS.has(type);
  }

  /** Seconds a file takes on Stage; null when its length is not known. */
  function fileSeconds(f, imageSeconds = 8) {
    if (!f) return null;
    const base = Math.max(1, Number(imageSeconds) || 8);
    const d = Number(f.duration) > 0 ? Number(f.duration) : 0;
    if (f.type === 'image') return base;
    if (f.type === 'gif') return d ? Math.max(1, Math.ceil(base / d)) * d : base;
    return d || null;
  }

  /**
   * The count and the time left.
   * o: {
   *   types        the list's types in order (an array, or i => type)
   *   counts       optional { before, all }: the list's played files up to
   *                the anchor and in all, when the caller counted them
   *   length       files in the list
   *   anchor       where the list stands (-1: nothing from it played yet)
   *   upPlayed     Up next files played on Stage so far (the one on now included)
   *   upNext       [{ type, duration }] waiting in Up next, in order
   *   rest         [{ type, duration } | null] the list files after the
   *                anchor, in order (null: not loaded yet); may be cut short
   *   restTotal    how many list files come after the anchor in all
   *   current      { t, d } of the file on Stage (d 0: not known)
   *   repeat       off / all / one
   *   basic        Basic Stage (videos only)
   *   imageSeconds Settings › Stage › Show pictures for
   * }
   * Answers { index, total, left: seconds | null, about } or null when
   * there is nothing to count (no list, a file from outside it).
   */
  function summary(o) {
    const m = o || {};
    const basic = !!m.basic;
    const n = Number.isInteger(m.length) && m.length > 0 ? m.length : 0;
    const typeAt = typeof m.types === 'function' ? m.types : (i) => (m.types ? m.types[i] : 'video');
    const anchor = Number.isInteger(m.anchor) ? Math.min(m.anchor, n - 1) : -1;
    const upPlayed = Math.max(0, Number(m.upPlayed) || 0);
    let before = 0, all = 0;
    if (m.counts && Number.isInteger(m.counts.before) && Number.isInteger(m.counts.all)) {
      // Counted already (a long list is counted once per place, not per paint).
      ({ before, all } = m.counts);
    } else {
      for (let i = 0; i < n; i++) {
        if (!plays(typeAt(i), basic)) continue;
        all++;
        if (i <= anchor) before++;
      }
    }
    const waiting = (m.upNext || []).filter(u => u && plays(u.type, basic));
    const index = before + upPlayed;
    const total = all + upPlayed + waiting.length;
    if (!n || index < 1 || total < index) return null;
    const out = { index, total, left: null, about: false };
    if (m.repeat === 'all' || m.repeat === 'one') return out;

    const restAll = Number.isInteger(m.restTotal) ? m.restTotal : (m.rest || []).length;
    const rest = (m.rest || []).slice(0, restAll);
    if (restAll + waiting.length > TIME_CAP) return out;
    let left = 0, unknown = 0, counted = 0;
    const cur = m.current || {};
    const cd = Number(cur.d) > 0 ? Number(cur.d) : 0;
    if (cd) left += Math.max(0, cd - (Number(cur.t) || 0));
    else unknown++;
    counted++;
    const add = (f) => {
      counted++;
      const s = fileSeconds(f, m.imageSeconds);
      if (s == null) unknown++; else left += s;
    };
    for (const u of waiting) add(u);
    for (let k = 0; k < restAll; k++) {
      const f = rest[k];
      if (f && !plays(f.type, basic)) continue;
      add(f || null);
    }
    if (unknown * 2 > counted) return out;
    out.left = Math.round(left);
    out.about = unknown > 0;
    return out;
  }

  /** 2:14:30, or 4:05 under an hour. */
  function clock(s) {
    const v = Math.max(0, Math.round(Number(s) || 0));
    const h = Math.floor(v / 3600);
    const mm = Math.floor((v % 3600) / 60);
    const ss = String(v % 60).padStart(2, '0');
    return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  }

  /** What the bars show: { track: 'Track 12 of 40', time: '2:14:30 left' | '' }; both '' for null. */
  function text(sum) {
    if (!sum) return { track: '', time: '' };
    const track = `Track ${sum.index.toLocaleString()} of ${sum.total.toLocaleString()}`;
    const time = sum.left == null ? '' : `${sum.about ? 'about ' : ''}${clock(sum.left)} left`;
    return { track, time };
  }

  /**
   * The Flow order bar while Stage is closed: "40 files · 2:41:05". files:
   * how many; seconds: their length added up (null: not known, left out);
   * about: some lengths were not known.
   */
  function listText(files, seconds, about = false) {
    const n = Math.max(0, Number(files) || 0);
    const words = `${n.toLocaleString()} ${n === 1 ? 'file' : 'files'}`;
    if (seconds == null || !(n > 0)) return words;
    return `${words} · ${about ? 'about ' : ''}${clock(seconds)}`;
  }

  /**
   * The Up next files played so far, after a file started on Stage. via:
   * where it came from ('upnext', 'list', 'user'). A list file one step on
   * from the last one keeps the count, and so does one further on that the
   * queue moved to by itself (auto: it passed over files that do not play
   * there, a picture on Basic Stage, a document, a file that cannot play);
   * anything else (a file picked further on, Previous, the list starting
   * over) starts it again.
   */
  function nextUpPlayed(prev, { via, index = -1, lastIndex = -1, auto = false } = {}) {
    const p = Math.max(0, Number(prev) || 0);
    if (via === 'upnext') return p + 1;
    if (via === 'list' && index === lastIndex + 1 && lastIndex >= 0) return p;
    if (via === 'list' && auto && lastIndex >= 0 && index > lastIndex) return p;
    if (via === 'list' && index === lastIndex) return p;
    return 0;
  }

  return { TIME_CAP, plays, fileSeconds, summary, clock, text, listText, nextUpPlayed };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = StageCount;
if (typeof window !== 'undefined') window.StageCount = StageCount;
