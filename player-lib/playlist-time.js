/* =========================================================================
   PLAYLIST TIME - how long a playlist plays once its skipped files are left
   out, and how much of it is left from where it stands now. Pure: no DOM,
   no network (test/playlist-time.test.js runs it in Node).

   Built for Skip on tracks (player-lib/collection-skips.js) and for anything
   that counts down to the end of a stream (the Stage bar's "2:14:30 left",
   a countdown on the Stage window): hand it the list in play order and where
   it stands.

   A file's seconds follow StageCount.fileSeconds (stage-count.js): videos and
   sound files their length, pictures the "Show pictures for" seconds, GIFs at
   least one whole loop. Documents and mixes never play, so they never count.
   A length that is not known adds nothing and makes the answer "about".

     PlaylistTime.totals(items, { imageSeconds })
       -> { files, seconds, about, skipped: { files, seconds, about } }
          seconds: what plays (skipped files left out)
     PlaylistTime.timeLeft(items, { index, position, imageSeconds })
       -> { seconds, about, files }  from `position` seconds into items[index]
          to the end of the list, skipped files left out. The file at index
          counts from position even when it is skipped (it is playing: a
          click on a skipped file still plays it). index -1: nothing playing
          yet, the whole list is left.

   items: [{ type: 'video' | 'audio' | 'image' | 'gif' | ..., duration: seconds
   or null, skipped: boolean }] in play order.
   ========================================================================= */

const PlaylistTime = (() => {
  const PLAYS = new Set(['video', 'audio', 'image', 'gif']);

  /** Seconds a file plays for, or null when its length is not known (StageCount.fileSeconds). */
  function fileSeconds(f, imageSeconds = 8) {
    if (!f) return null;
    const base = Math.max(1, Number(imageSeconds) || 8);
    const d = Number(f.duration) > 0 ? Number(f.duration) : 0;
    if (f.type === 'image') return base;
    if (f.type === 'gif') return d ? Math.max(1, Math.ceil(base / d)) * d : base;
    return d || null;
  }

  const plays = (f) => !!f && PLAYS.has(f.type);

  function add(acc, f, imageSeconds) {
    const s = fileSeconds(f, imageSeconds);
    acc.files++;
    if (s == null) acc.about = true;
    else acc.seconds += s;
  }

  /** The whole list: what plays, and what the skips take off. */
  function totals(items, { imageSeconds = 8 } = {}) {
    const on = { files: 0, seconds: 0, about: false };
    const off = { files: 0, seconds: 0, about: false };
    for (const f of items || []) {
      if (!plays(f)) continue;
      add(f.skipped ? off : on, f, imageSeconds);
    }
    return {
      files: on.files, seconds: Math.round(on.seconds), about: on.about,
      skipped: { files: off.files, seconds: Math.round(off.seconds), about: off.about },
    };
  }

  /** From `position` seconds into items[index] to the end, skipped files left out. */
  function timeLeft(items, { index = -1, position = 0, imageSeconds = 8 } = {}) {
    const list = items || [];
    const acc = { files: 0, seconds: 0, about: false };
    const i0 = Number.isInteger(index) ? index : -1;
    const cur = i0 >= 0 ? list[i0] : null;
    if (cur && plays(cur)) {
      const s = fileSeconds(cur, imageSeconds);
      acc.files++;
      if (s == null) acc.about = true;
      else acc.seconds += Math.max(0, s - Math.max(0, Number(position) || 0));
    }
    for (let i = Math.max(0, i0 + 1); i < list.length; i++) {
      const f = list[i];
      if (!plays(f) || f.skipped) continue;
      add(acc, f, imageSeconds);
    }
    return { seconds: Math.round(acc.seconds), about: acc.about, files: acc.files };
  }

  return { fileSeconds, totals, timeLeft };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PlaylistTime;
if (typeof window !== 'undefined') window.PlaylistTime = PlaylistTime;
