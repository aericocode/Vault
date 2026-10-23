/* =========================================================================
   MODERN DOCK GEOMETRY - the numbers behind the Modern player's dock.

   Pure functions, no DOM: player-lib/player/player-modern.js measures the
   stage and hands the numbers in, so all of this is testable on its own
   (test/dock-geometry.test.js).

   - zoneDecision(y, h, visible)         show / keep / hide for a pointer
                                         height over the stage
   - foldLevel(width, present)           how much of the control row folds
                                         away at this stage width (0..7)
   - segments(duration, songs)           the timeline split at song edges
   - layout(segs, width, gap)            each segment's x and width in px
   - timeToX / xToTime                   time <-> px across those gaps
   - segmentIndexAt(segs, t)             the segment holding a time
   - scrubFrameIndex(t, duration)        the nearest of the 5 hover frames
   - noteMarks(notes)                    times named inside note text
   - noteNear(marks, t, win)             a note within `win` seconds
   - hotMarks(heat, duration, lastPos)   where Hot was pressed
   - smoothHeat(heat)                    the heat ridge's curve
   ========================================================================= */

const DockGeom = (() => {
  /* Show and hide (spec: show zone 150 px at the bottom, 76 px at the top,
     and an 80 px buffer before the controls let go). */
  const DOCK_ZONE = 150;
  const TOP_ZONE = 76;
  const BUFFER = 80;

  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /**
   * What a pointer at height `y` over a stage `h` tall does to the chrome.
   *  'show': it is in a show zone (bottom 150 px or top 76 px): show now.
   *  'keep': leave things as they are (visible stays visible while the
   *          pointer is inside the buffer; hidden stays hidden outside the
   *          show zones).
   *  'hide': visible, and the pointer went past the hide line: hide now.
   */
  function zoneDecision(y, h, visible) {
    y = num(y, NaN);
    h = num(h, 0);
    if (h <= 0 || !Number.isFinite(y)) return 'keep';
    const dockTop = h - DOCK_ZONE;
    if (y >= dockTop || y <= TOP_ZONE) return 'show';
    if (!visible) return 'keep';
    if (y >= dockTop - BUFFER || y <= TOP_ZONE + BUFFER) return 'keep';
    return 'hide';
  }

  /* Fold order (spec 7): 1 the volume slider folds into its icon, 2 previous
     and next leave the row, 3 faces and beat bar move into the gear menu,
     4 (below ~700 px) device sync and speed follow them. Past that, for
     stages down to 480 px: 5 back / forward 10 s go to the keyboard (and the
     gear menu), 6 the time shows the current time only, 7 volume and full
     screen go to the gear menu (M, Up / Down and F still work). Hot, Done,
     play, A-B, repeat and subtitles never leave. Up to 3 the play group is
     truly centred; from 4 the three clusters share the row (the centred
     sum no longer fits), so the check is their plain total. */
  const W = {
    btn: 42,        // 40 px target + 2 px gap
    time: 104,      // "12:34 / 45:06" at 14 px tabular, with its padding
    timeHours: 136, // "1:01:40 / 1:02:36"
    timeShort: 58,  // current time only: "12:34"
    timeShortHours: 72,  // "1:01:40"
    sep: 13,
    speed: 54,      // the "1.25x" pill and its margins
    play: 66,       // the 54 px round button and its margins
    slider: 88,     // the 80 px volume slider and its margins
    pad: 48,        // the dock's own side padding
    gaps: 16,       // between the clusters once they share the row
  };
  const NARROW = 700;
  const CENTRED_MAX = 3;
  const MAX_LEVEL = 7;

  /** The time label's width at a fold level; present.hours: the file runs an hour or more. */
  function timeWidth(level, p) {
    if (level >= 6) return p.hours ? W.timeShortHours : W.timeShort;
    return p.hours ? W.timeHours : W.time;
  }

  /** Widths of the three clusters at a fold level, for the buttons present. */
  function clusterWidths(level, present = {}) {
    const p = present || {};
    let left = timeWidth(level, p) + W.sep + 2 * W.btn;   // time, Hot, Done
    if (level < 3) left += (p.faces ? W.btn : 0) + (p.beat ? W.btn : 0);
    if (level < 4) left += (p.vibe ? W.btn : 0) + W.speed;
    let center = W.play + (level < 5 ? 2 * W.btn : 0) + (level < 2 ? 2 * W.btn : 0);
    // A-B, repeat, CC, gear always; volume and full screen until level 7
    const right = 4 * W.btn + (level < 7 ? 2 * W.btn : 0) + (level < 1 ? W.slider : 0);
    return { left, center, right };
  }

  /** Room the row needs at a level: play truly centred (grid 1fr auto 1fr)
   *  up to level 3, the clusters side by side from level 4. */
  function rowNeed(level, present) {
    const c = clusterWidths(level, present);
    if (level <= CENTRED_MAX) return 2 * Math.max(c.left, c.right) + c.center + W.pad;
    return c.left + c.center + c.right + W.gaps + W.pad;
  }

  /** The least folding that fits `width` px of stage. */
  function foldLevel(width, present) {
    width = num(width, 0);
    const from = width < NARROW ? CENTRED_MAX + 1 : 0;
    for (let level = from; level < MAX_LEVEL; level++) {
      if (rowNeed(level, present) <= width) return level;
    }
    return MAX_LEVEL;
  }

  /**
   * The timeline split at song boundaries. Songs are {start_sec, end_sec};
   * overlaps merge, everything is clamped to the file, and a sliver of
   * plain time between two songs (under a second, or 0.4% of the file) is
   * given to the song before it, so the bar is not cut into crumbs.
   * Returns [{start, end, song}] covering 0..duration, song = index into
   * `songs` or -1. With no usable song data: one plain segment.
   */
  function segments(duration, songs) {
    const dur = num(duration, 0);
    if (dur <= 0) return [];
    const minGap = Math.max(1, dur * 0.004);
    const ranges = (Array.isArray(songs) ? songs : [])
      .map((s, i) => ({ start: clamp(num(s && Number(s.start_sec), NaN), 0, dur), end: clamp(num(s && Number(s.end_sec), NaN), 0, dur), song: i }))
      .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end - r.start >= 0.5)
      .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else merged.push({ ...r });
    }
    const out = [];
    let at = 0;
    for (const r of merged) {
      if (r.start - at >= minGap) out.push({ start: at, end: r.start, song: -1 });
      else if (out.length) out[out.length - 1].end = r.start;
      else r.start = 0;   // a song that starts within the first second takes it
      out.push({ start: r.start, end: r.end, song: r.song });
      at = r.end;
    }
    if (dur - at >= minGap || !out.length) out.push({ start: at, end: dur, song: -1 });
    else out[out.length - 1].end = dur;
    return out;
  }

  /** Each segment's left x and width in px for a bar `width` px wide. */
  function layout(segs, width, gap = 3) {
    const n = segs.length;
    if (!n) return [];
    const total = segs[n - 1].end - segs[0].start;
    const room = Math.max(0, num(width, 0) - gap * (n - 1));
    let x = 0;
    return segs.map((s) => {
      const w = total > 0 ? room * ((s.end - s.start) / total) : 0;
      const box = { x, w };
      x += w + gap;
      return box;
    });
  }

  function segmentIndexAt(segs, t) {
    if (!segs.length) return -1;
    t = num(t, 0);
    for (let i = 0; i < segs.length; i++) if (t < segs[i].end) return i;
    return segs.length - 1;
  }

  /** Px along the bar for a time. */
  function timeToX(t, segs, lay) {
    const i = segmentIndexAt(segs, t);
    if (i < 0 || !lay[i]) return 0;
    const s = segs[i];
    const f = s.end > s.start ? clamp((num(t, 0) - s.start) / (s.end - s.start), 0, 1) : 0;
    return lay[i].x + f * lay[i].w;
  }

  /** Time for a px along the bar; a px in a gap lands on the edge it is nearer. */
  function xToTime(x, segs, lay) {
    if (!segs.length) return 0;
    x = num(x, 0);
    for (let i = 0; i < segs.length; i++) {
      const b = lay[i];
      const s = segs[i];
      if (x < b.x) {
        // In the gap before segment i: snap to the closer of the two edges
        const prevEnd = i > 0 ? lay[i - 1].x + lay[i - 1].w : 0;
        return (x - prevEnd) < (b.x - x) && i > 0 ? segs[i - 1].end : s.start;
      }
      if (x <= b.x + b.w) return s.start + (b.w > 0 ? (x - b.x) / b.w : 0) * (s.end - s.start);
    }
    return segs[segs.length - 1].end;
  }

  /** The nearest of the hover frames, which sit at duration * (i+1)/(count+1). */
  function scrubFrameIndex(t, duration, count = 5) {
    const dur = num(duration, 0);
    if (dur <= 0 || count < 1) return 0;
    return clamp(Math.round((num(t, 0) / dur) * (count + 1)) - 1, 0, count - 1);
  }

  /* Times written inside notes ("2:35", "1:02:33", a range "0:11-1:23"
     counts from its start), same shape notes.js links. */
  const TS_RE = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;

  /** [{t, text}] for every time named in the notes, sorted by time. */
  function noteMarks(notes) {
    const out = [];
    for (const n of Array.isArray(notes) ? notes : []) {
      const text = String((n && n.text) || '').trim();
      if (!text) continue;
      const seen = new Set();
      TS_RE.lastIndex = 0;
      let m;
      while ((m = TS_RE.exec(text))) {
        const t = (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
        if (Number(m[3]) > 59 || seen.has(t)) continue;
        seen.add(t);
        out.push({ t, text });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /** The note mark closest to `t`, if one is within `win` seconds. */
  function noteNear(marks, t, win = 2) {
    let best = null;
    for (const m of marks || []) {
      const d = Math.abs(m.t - num(t, 0));
      if (d <= win && (!best || d < Math.abs(best.t - t))) best = m;
    }
    return best;
  }

  /** Times Hot was pressed: the centre of each heatmap bucket with a mark,
   *  or the single last position for an item from before the heatmap. */
  function hotMarks(heat, duration, lastPos) {
    const dur = num(duration, 0);
    if (dur <= 0) return [];
    if (Array.isArray(heat) && heat.some(c => c > 0)) {
      const n = heat.length;
      const out = [];
      heat.forEach((c, i) => { if (c > 0) out.push(((i + 0.5) / n) * dur); });
      return out;
    }
    const p = num(Number(lastPos), 0);
    return p > 0 ? [Math.min(p, dur)] : [];
  }

  /** The ridge's curve: each bucket averaged with its neighbours, 0..1. */
  function smoothHeat(heat) {
    if (!Array.isArray(heat) || !heat.length) return [];
    const v = heat.map(x => Math.max(0, num(Number(x), 0)));
    const n = v.length;
    const s = v.map((x, i) => ((v[i - 1] || 0) + x + (v[i + 1] || 0)) / ((i > 0 ? 1 : 0) + 1 + (i < n - 1 ? 1 : 0)));
    const max = Math.max(...s);
    return max > 0 ? s.map(x => x / max) : [];
  }

  return {
    DOCK_ZONE, TOP_ZONE, BUFFER, NARROW, CENTRED_MAX, MAX_LEVEL, W,
    zoneDecision, clusterWidths, rowNeed, foldLevel,
    segments, layout, segmentIndexAt, timeToX, xToTime,
    scrubFrameIndex, noteMarks, noteNear, hotMarks, smoothHeat,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DockGeom;
