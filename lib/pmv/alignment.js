/**
 * PMV Studio — alignment engine: maps soundtrack beats/energy to source-video
 * segments, producing an Edit Decision List (EDL).
 *
 * Reworked from the sample (spec §6.1/§6.2):
 *  - orderMode 'shuffle' (default): weighted-random pick among the top-K
 *    scored candidates across ALL videos, with a same-video streak penalty —
 *    output order follows the music, not the upload order.
 *  - orderMode 'sequential': the sample's forward-marching playheads, kept as
 *    an option, but video interleave order is shuffled once per job.
 *  - Seeded RNG (mulberry32) threads through every random choice, so a recipe
 *    (sources + options + seed) always reproduces the same EDL.
 *  - Cuts respect segment boundaries: candidates shorter than the slot are
 *    penalized, and sourceOut is clamped to the segment/video end (the sample
 *    could run past scene cuts and even past EOF).
 */

/* ── Seeded RNG ─────────────────────────────────────────────────────────── */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s) {
  // Accept numbers or strings; strings hash FNV-1a style
  if (typeof s === 'number' && Number.isFinite(s)) return s >>> 0;
  const str = String(s ?? Date.now());
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ── EDL creation ───────────────────────────────────────────────────────── */

/**
 * @param {object} audioAnalysis - { duration, beats, energyCurve }
 * @param {Array} videoSegments - segments with sourceVideo/videoPath attached
 * @param {object} options
 * @param {Array} videoInfos - [{ index, duration }] for EOF clamping
 */
function createEDL(audioAnalysis, videoSegments, options = {}, videoInfos = []) {
  const {
    targetDuration = audioAnalysis.duration,
    minClipDuration = 0.3,
    maxClipDuration = 4,
    cutOnBeats = true,
    preferHighAction = true,
    orderMode = 'shuffle',            // 'shuffle' | 'sequential'
    userFilter = null,
    relevanceThreshold = 6,
    seed = Date.now(),
  } = options;

  if (!videoSegments || videoSegments.length === 0) {
    return { edl: [], totalEdits: 0, targetDuration, coverage: 0, uniqueSegments: 0, totalSegments: 0, seed };
  }

  const rng = mulberry32(hashSeed(seed));
  const videoDur = new Map(videoInfos.map(v => [v.index, v.duration]));

  const segments = [...videoSegments];

  // VL-relevant segments get a flat boost before anything else
  if (userFilter) {
    for (const seg of segments) {
      if (seg.vlRelevance && seg.vlRelevance >= relevanceThreshold) {
        seg.score = seg.score * 1.5 + 0.2;
      }
    }
  }

  /* ── Cut points from beats ── */
  const beats = audioAnalysis.beats || [];
  const cutPoints = [0];

  if (cutOnBeats && beats.length > 0) {
    let lastCut = 0;
    for (const beat of beats) {
      if (beat.time - lastCut >= minClipDuration && beat.time < targetDuration) {
        // Long gaps between beats get split by maxClipDuration below
        cutPoints.push(beat.time);
        lastCut = beat.time;
      }
    }
  }

  // Split any span longer than maxClipDuration (also covers cutOnBeats=false)
  const withMax = [cutPoints[0]];
  for (let i = 1; i <= cutPoints.length; i++) {
    const end = i < cutPoints.length ? cutPoints[i] : targetDuration;
    let prev = withMax[withMax.length - 1];
    while (end - prev > maxClipDuration) {
      prev += maxClipDuration;
      withMax.push(prev);
    }
    if (i < cutPoints.length && end - prev >= 0.05) withMax.push(end);
  }
  const finalCuts = withMax;
  if (finalCuts[finalCuts.length - 1] < targetDuration) finalCuts.push(targetDuration);

  /* ── Sequential mode setup (kept as an option) ── */
  const videoGroups = new Map();
  for (const seg of segments) {
    const vid = seg.sourceVideo ?? 0;
    if (!videoGroups.has(vid)) videoGroups.set(vid, []);
    videoGroups.get(vid).push(seg);
  }
  for (const [, group] of videoGroups) group.sort((a, b) => a.start - b.start);

  // Interleave order is shuffled per job, so even sequential mode doesn't
  // follow upload order across videos
  const videoIds = shuffleInPlace([...videoGroups.keys()], rng);
  const totalSlots = finalCuts.length - 1;
  const slotsPerVideo = Math.max(1, Math.ceil(totalSlots / videoIds.length));
  const playheads = new Map();
  const strides = new Map();
  for (const [vid, group] of videoGroups) {
    playheads.set(vid, 0);
    strides.set(vid, Math.max(1, group.length / slotsPerVideo));
  }
  let videoRobin = 0;

  /* ── Pick loop ── */
  const edl = [];
  const recentlyUsed = [];
  const recentWindow = Math.min(8, Math.floor(segments.length / 3) || 2);
  const usageCount = new Map();
  const lastVideos = [];               // trailing source-video picks (streak penalty)

  for (let i = 0; i < finalCuts.length - 1; i++) {
    const editStart = finalCuts[i];
    const editEnd = finalCuts[i + 1];
    const editDuration = editEnd - editStart;
    if (editDuration < 0.05) continue;

    const energyAtPoint = getEnergyAt(audioAnalysis.energyCurve, editStart);

    let segment;
    if (orderMode === 'sequential') {
      segment = pickSequential(videoGroups, videoIds, playheads, videoRobin,
        editDuration, energyAtPoint, recentlyUsed, usageCount,
        { preferHighAction, relevanceThreshold, userFilter });
      videoRobin = (videoRobin + 1) % videoIds.length;
    } else {
      segment = pickShuffle(segments, editDuration, energyAtPoint,
        recentlyUsed, usageCount, lastVideos, rng,
        { preferHighAction, relevanceThreshold, userFilter });
    }

    if (!segment) continue;

    // Clamp the cut inside the segment/video (sample bug: ran past both)
    const segEnd = segment.end ?? (segment.start + segment.duration);
    const hardEnd = Math.min(
      segEnd + 0.75,                                   // small overrun into the next shot is fine
      videoDur.get(segment.sourceVideo ?? 0) ?? Infinity
    );
    const sourceIn = segment.start;
    const sourceOut = Math.min(sourceIn + editDuration, hardEnd);
    const actualDuration = sourceOut - sourceIn;
    if (actualDuration < 0.05) continue;

    edl.push({
      id: i,
      sourceSegment: segment.index,
      sourceVideo: segment.sourceVideo ?? 0,
      videoPath: segment.videoPath ?? null,
      sourceIn,
      sourceOut,
      editIn: editStart,
      editOut: editStart + actualDuration,
      duration: actualDuration,
      score: segment.score,
      tags: segment.vlTags || [],
      mood: segment.mood || 'neutral',
      vlRelevance: segment.vlRelevance || 0,
      onBeat: beats.some(b => Math.abs(b.time - editStart) < 0.05),
      energyLevel: energyAtPoint,
    });

    recentlyUsed.push(segment.index);
    if (recentlyUsed.length > recentWindow) recentlyUsed.shift();
    usageCount.set(segment.index, (usageCount.get(segment.index) || 0) + 1);
    lastVideos.push(segment.sourceVideo ?? 0);
    if (lastVideos.length > 2) lastVideos.shift();

    if (orderMode === 'sequential') {
      const vid = segment.sourceVideo ?? 0;
      const group = videoGroups.get(vid);
      const newHead = playheads.get(vid) + strides.get(vid);
      playheads.set(vid, newHead >= group.length ? newHead % group.length : newHead);
    }
  }

  return {
    edl,
    totalEdits: edl.length,
    targetDuration,
    coverage: edl.reduce((sum, e) => sum + e.duration, 0) / targetDuration,
    uniqueSegments: new Set(edl.map(e => e.sourceSegment)).size,
    totalSegments: videoSegments.length,
    seed,
  };
}

/**
 * Shuffle picker (default): score every candidate, take the top K, pick one
 * weighted by score with the seeded RNG. The streak penalty stops one video
 * from dominating consecutive cuts without forcing a mechanical round-robin.
 */
function pickShuffle(segments, neededDuration, energyLevel, recentlyUsed, usageCount, lastVideos, rng, opts) {
  const TOP_K = 6;
  const scored = [];

  for (const seg of segments) {
    if (seg.duration < 0.1) continue;

    let score = seg.score + 0.01;      // floor so zero-motion segments still qualify

    // Too short for the slot → penalize (the cut would get clamped short)
    if (seg.duration + 0.75 < neededDuration) score *= 0.4;

    if (recentlyUsed.includes(seg.index)) score *= 0.05;

    const timesUsed = usageCount.get(seg.index) || 0;
    score *= 1 / (1 + timesUsed * 0.5);

    // Same-video streak penalty: last 2 picks from this video → halve
    const vid = seg.sourceVideo ?? 0;
    if (lastVideos.length === 2 && lastVideos[0] === vid && lastVideos[1] === vid) score *= 0.5;

    if (opts.preferHighAction) {
      const motionMatch = 1 - Math.abs(energyLevel - seg.avgMotion);
      score *= (0.5 + motionMatch * 0.5);
    }

    if (opts.userFilter && seg.vlRelevance >= opts.relevanceThreshold) score *= 1.5;

    scored.push({ seg, score });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const pool = scored.slice(0, TOP_K);

  const total = pool.reduce((s, c) => s + c.score, 0);
  if (total <= 0) return pool[0].seg;
  let roll = rng() * total;
  for (const c of pool) {
    roll -= c.score;
    if (roll <= 0) return c.seg;
  }
  return pool[pool.length - 1].seg;
}

/** Sequential picker — the sample's forward-marching behavior, unchanged. */
function pickSequential(videoGroups, videoIds, playheads, videoRobin, neededDuration, energyLevel, recentlyUsed, usageCount, opts) {
  const lookAhead = 5;

  for (let v = 0; v < videoIds.length; v++) {
    const vid = videoIds[(videoRobin + v) % videoIds.length];
    const group = videoGroups.get(vid);
    const head = Math.floor(playheads.get(vid)) % group.length;

    let bestSeg = null;
    let bestScore = -Infinity;

    for (let offset = 0; offset < lookAhead && head + offset < group.length; offset++) {
      const seg = group[head + offset];
      if (seg.duration < 0.1) continue;

      let score = (seg.score + 0.01) * (1 - offset * 0.1);
      if (recentlyUsed.includes(seg.index)) score *= 0.05;
      score *= 1 / (1 + (usageCount.get(seg.index) || 0) * 0.5);
      if (opts.preferHighAction) {
        score *= (0.5 + (1 - Math.abs(energyLevel - seg.avgMotion)) * 0.5);
      }
      if (opts.userFilter && seg.vlRelevance >= opts.relevanceThreshold) score *= 1.5;

      if (score > bestScore) { bestScore = score; bestSeg = seg; }
    }

    if (bestSeg) return bestSeg;
  }
  return null;
}

/**
 * Center-panel pick for triptych: prefer a different video, else a distant
 * segment in the same one. Seeded when called through enrichTriptych.
 */
function pickCenterSegment(allSegments, sideSeg, rng, videoIds) {
  const sideVid = sideSeg.sourceVideo ?? 0;

  if (videoIds.length > 1) {
    const other = allSegments.filter(s => (s.sourceVideo ?? 0) !== sideVid && s.duration >= 0.1);
    if (other.length > 0) return other[Math.floor(rng() * other.length)];
  }

  const same = allSegments.filter(s => (s.sourceVideo ?? 0) === sideVid && s.duration >= 0.1);
  if (same.length < 2) return null;
  const withDist = same.map(s => ({ seg: s, dist: Math.abs(s.start - sideSeg.start) }))
    .sort((a, b) => b.dist - a.dist);
  const pool = withDist.slice(0, Math.max(3, Math.floor(withDist.length * 0.3)));
  return pool[Math.floor(rng() * pool.length)].seg;
}

/** Attach center-panel sources to an EDL (only needed for triptych layout). */
function attachCenterSources(edlData, allSegments, seed) {
  const rng = mulberry32(hashSeed((seed ?? 0) + ':center'));
  const videoIds = [...new Set(allSegments.map(s => s.sourceVideo ?? 0))];
  for (const entry of edlData.edl) {
    const sideSeg = allSegments.find(s => s.index === entry.sourceSegment);
    const center = sideSeg ? pickCenterSegment(allSegments, sideSeg, rng, videoIds) : null;
    entry.centerVideoPath = center?.videoPath ?? entry.videoPath;
    entry.centerSourceIn = center?.start ?? entry.sourceIn;
    entry.centerSourceVideo = center?.sourceVideo ?? entry.sourceVideo;
  }
  return edlData;
}

function getEnergyAt(energyCurve, time) {
  if (!energyCurve || energyCurve.length === 0) return 0.5;
  for (let i = 0; i < energyCurve.length - 1; i++) {
    if (energyCurve[i + 1].time > time) {
      const t = (time - energyCurve[i].time) / (energyCurve[i + 1].time - energyCurve[i].time);
      return (energyCurve[i].energyNorm || 0) * (1 - t) + (energyCurve[i + 1].energyNorm || 0) * t;
    }
  }
  return energyCurve[energyCurve.length - 1].energyNorm || 0.5;
}

/** Transition/effect decoration (unchanged from the sample). */
function enrichEDL(edlData, options = {}) {
  const {
    transitions = true,
    transitionDuration = 0.3,
    colorEffects = false,
    speedRamping = false,
  } = options;

  const enriched = edlData.edl.map((entry, i) => {
    const result = { ...entry, effects: [] };

    if (transitions && i > 0) {
      const transType = entry.onBeat ? 'cut' : 'xfade';
      result.transition = {
        type: transType,
        duration: transType === 'cut' ? 0 : transitionDuration,
        effect: pickTransitionEffect(entry.energyLevel),
      };
    }

    if (colorEffects && entry.mood) {
      const eff = getColorEffect(entry.mood);
      if (eff.filter) result.effects.push(eff);
    }
    if (speedRamping && entry.onBeat && entry.energyLevel > 0.7) {
      result.effects.push({ type: 'speed', value: 1.2 });
    }

    return result;
  });

  return { ...edlData, edl: enriched };
}

function pickTransitionEffect(energy) {
  if (energy > 0.8) return 'wiperight';
  if (energy > 0.5) return 'fade';
  return 'dissolve';
}

function getColorEffect(mood) {
  const effects = {
    energetic: { type: 'color', filter: 'eq=saturation=1.3:contrast=1.1' },
    calm: { type: 'color', filter: 'eq=saturation=0.8:brightness=0.05' },
    dramatic: { type: 'color', filter: 'eq=contrast=1.3:saturation=1.1:brightness=-0.05' },
    dark: { type: 'color', filter: 'eq=brightness=-0.1:contrast=1.2' },
    bright: { type: 'color', filter: 'eq=brightness=0.1:saturation=1.2' },
    neutral: { type: 'color', filter: '' },
  };
  return effects[mood] || effects.neutral;
}

module.exports = { createEDL, enrichEDL, attachCenterSources, mulberry32, hashSeed };
