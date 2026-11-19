/* =========================================================================
   STAGE COUNT - "Track 12 of 40 · 2:14:30 left" on the Stage bar, and
   "40 files · 2:41:05" on an open collection's count line. Pure: no DOM,
   no network, so test/stage-count.test.js runs it in Node. stage-control.js
   gathers what it needs (the list Stage plays, Up next, the rows' lengths)
   and draws the bar; collections.js draws the count line.

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
     A file's "Plays in" still shows with Repeat all (the list comes round
     again), not with Repeat this file (nothing else comes up).
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
    const out = count(m);
    if (!out || m.repeat === 'all' || m.repeat === 'one') return out;
    const lap = timeLeft(m, waitingOf(m), false);
    if (!lap || lap.unknown * 2 > lap.counted) return out;
    out.left = Math.round(lap.left);
    out.about = lap.unknown > 0;
    return out;
  }

  /** The Up next files Stage will play, in order. */
  function waitingOf(m) {
    return (m.upNext || []).filter(u => u && plays(u.type, !!m.basic));
  }

  /** summary() without the time: { index, total, left: null, about: false }, or null. */
  function count(m) {
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
    const index = before + upPlayed;
    const total = all + upPlayed + waitingOf(m).length;
    if (!n || index < 1 || total < index) return null;
    return { index, total, left: null, about: false };
  }

  /**
   * The time from now to the end of the list (to the anchor again, round
   * the top, with wrap): the rest of the file on Stage, Up next (waiting),
   * the rest of the list. { left, unknown, counted }, or null past TIME_CAP.
   */
  function timeLeft(m, waiting, wrap) {
    const basic = !!m.basic;
    const restAll = Number.isInteger(m.restTotal) ? m.restTotal : (m.rest || []).length;
    const rest = (m.rest || []).slice(0, restAll);
    const wrapAll = !wrap ? 0 : Number.isInteger(m.wrapTotal) ? m.wrapTotal : (m.wrap || []).length;
    const top = (m.wrap || []).slice(0, wrapAll);
    if (restAll + wrapAll + waiting.length > TIME_CAP) return null;
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
    for (const [list, all] of [[rest, restAll], [top, wrapAll]]) {
      for (let k = 0; k < all; k++) {
        const f = list[k];
        if (f && !plays(f.type, basic)) continue;
        add(f || null);
      }
    }
    return { left, unknown, counted };
  }

  /**
   * How long from now until a file is up on Stage, for the preview pane's
   * "Plays in 12:30". o: what summary() takes, with the ids to look for:
   *   current.id   the file on Stage
   *   upNext[k].id the Up next files
   *   restIds      the ids of rest, in step with it (rest entries may be
   *                null, rows not loaded yet, so the ids come apart)
   *   wrap         Repeat all: [{ type, duration } | null] the list files
   *                Stage comes back round to, from the top up to and
   *                including the anchor, in order (only ones that play)
   *   wrapIds      their ids, in step with wrap
   *   wrapTotal    how many there are in all (wrap may be cut short)
   * The order is summary()'s: the rest of the file on Stage, Up next, then
   * the rest of the list, files that do not play passed over; with Repeat
   * all, then the list from the top again (so a file already played this
   * time round is up once the list comes back to it). A file ahead twice is
   * up the first time. Answers { now: true } for the file on Stage,
   * { seconds, about } (about: some length on the way is not known), or null
   * when there is no honest answer: not ahead, nothing on Stage, Repeat this
   * file (the file on Stage plays again and again, nothing else comes up),
   * past TIME_CAP, or too many lengths not known. Repeat all gives no time
   * left for the list (it never ends), but each file still has its time.
   * TIME_CAP and "too many not known" look at the whole way to the end of
   * the list, as summary() does: a file reached before the list comes round
   * gets exactly its Repeat off answer; one in the part round the top, at
   * the whole lap (up to the anchor again).
   */
  function until(o, id) {
    const m = o || {};
    const cur = m.current || {};
    if (id == null || cur.id == null) return null;
    if (cur.id === id) return { now: true };
    if (m.repeat === 'one') return null;
    if (!count(m)) return null;
    const basic = !!m.basic;
    const round = m.repeat === 'all';
    const waiting = waitingOf(m);
    const honest = (wrap) => {
      const lap = timeLeft(m, waiting, wrap);
      return !!lap && lap.unknown * 2 <= lap.counted;
    };
    let secs = 0, unknown = false;
    const cd = Number(cur.d) > 0 ? Number(cur.d) : 0;
    if (cd) secs += Math.max(0, cd - (Number(cur.t) || 0));
    else unknown = true;
    const add = (f) => {
      const s = fileSeconds(f, m.imageSeconds);
      if (s == null) unknown = true; else secs += s;
    };
    const hit = (wrap) => (honest(wrap) ? { seconds: Math.round(secs), about: unknown } : null);
    for (const u of waiting) {
      if (u.id === id) return hit(false);
      add(u);
    }
    const restAll = Number.isInteger(m.restTotal) ? m.restTotal : (m.rest || []).length;
    const parts = [[m.rest || [], m.restIds || [], restAll, false]];
    // Round the top only after all of the rest: with some of it not given, the time to there is not known.
    if (round && (m.rest || []).length >= restAll) {
      parts.push([m.wrap || [], m.wrapIds || [], Number.isInteger(m.wrapTotal) ? m.wrapTotal : (m.wrap || []).length, true]);
    }
    for (const [list, ids, all, wrap] of parts) {
      for (let k = 0; k < all && k < list.length; k++) {
        const f = list[k];
        if (f && !plays(f.type, basic)) continue;
        if (ids[k] === id) return hit(wrap);
        add(f || null);
      }
    }
    return null;
  }

  /** The preview pane's line for until(): "Plays in 12:30", "Plays in about 12:30", "On Stage now", or ''. */
  function untilText(u) {
    if (!u) return '';
    if (u.now) return 'On Stage now';
    return `Plays in ${u.about ? 'about ' : ''}${clock(u.seconds)}`;
  }

  /** 4:05 under an hour, 2:14:30 under a day, 3:02:14:30 (days first) past it. */
  function clock(s) {
    const v = Math.max(0, Math.round(Number(s) || 0));
    const d = Math.floor(v / 86400);
    const h = Math.floor((v % 86400) / 3600);
    const mm = Math.floor((v % 3600) / 60);
    const ss = String(v % 60).padStart(2, '0');
    if (d) return `${d}:${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${ss}`;
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
   * A collection's count line (collections.js): "40 files · 2:41:05". files:
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
   * A whole collection's length as the server added it up (GET
   * /api/collections: timed_count, total_seconds, unknown_seconds_count):
   * { seconds, about }, or null when there is nothing to time or more than
   * half the lengths are not known (the same rules as a list counted here).
   * Any size: the server adds it up, so TIME_CAP does not apply.
   */
  function collectionTime(c) {
    if (!c || !Number.isFinite(c.total_seconds)) return null;
    const timed = Number(c.timed_count) || 0, unknown = Number(c.unknown_seconds_count) || 0;
    if (!(timed > 0) || unknown * 2 > timed) return null;
    return { seconds: Math.round(c.total_seconds), about: unknown > 0 };
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

  return { TIME_CAP, plays, fileSeconds, summary, until, untilText, clock, text, listText, collectionTime, nextUpPlayed };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = StageCount;
if (typeof window !== 'undefined') window.StageCount = StageCount;
