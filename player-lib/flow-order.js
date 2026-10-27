/* =========================================================================
   FLOW ORDER - the pure part of Flow, shared by the server (lib/flow/,
   GET /api/flow/collections/:id), the Flow panel (player-lib/flow.js) and the
   tests (test/flow-order.test.js). No DOM, no network.

   A file's features (from media_flow, lib/flow/analyze.js):
     { id, measured, music, es, em, ee (energy 0..1 at start, middle, end),
       bs, bm, be (BPM at start, middle, end, or null),
       env (optional: the energy envelope, [[t, e], ...] with t 0..1 where in
       the file and e 0..1 on the same scale, about 10 points; absent for a row
       measured before it existed, which the chart draws from es, em, ee),
       ei, eo (optional: the envelope's first and last energy, set with env;
       hand-overs use them),
       name, title (optional: the file name, and the library's title when it
       has one, for the chart) }

   - SHAPES, shapeLabel(k)       the shapes you pick from
   - targetsFor(shape, feats)    the energy each position aims for, across the
                                 collection's own range (null for Smooth only)
   - guideTargets(shape, data)   the chart's dashed guide for the shape picked
                                 (the server's targets when they are for it)
   - handoverCost(a, b)          how well the end of a flows into the start of b
   - handover(a, b)              its grade and parts: { grade, energyGrade,
                                 tempoGrade, dE, tempoPct }
   - grade(a, b)                 smooth | noticeable | jump | none
   - handoverText(a, b)          why, in plain words ("Energy drops 14 · same tempo")
   - planOrder(feats, o)         Flow order: least total cost, deterministic
   - PLACES, resolvePlace(ps)    where a stream tag puts a file (o.places)
   - summary(feats, order)       the hand-overs of an order, and its jumps
   - flowShuffle(feats, o)       a shuffle that leans toward good hand-overs
   - flowText(f)                 "128 BPM · energy high" (the Stage bar)
   - parseEnv(text)              media_flow.env as the features' env (2 decimals), or null
   - reconcileOrder(order, members)  an order kept to a collection's files
   - moveBlock(order, ids, before)   a drag in Flow order: the new order, or null
   - parseRemembered(text)       a remembered Flow order from storage, or null
   - nextAfter(playing, o)       the file that plays next (Up next, else the list)

   The cost of an order:
     sum over neighbours of handoverCost(end of A, start of B)
   + 1.5 x sum over positions of |middle energy - the shape's target there|
   A hand-over has two parts, graded on their own:
     energy  dE = energy at B's start - energy at A's end (the envelope's
             first and last points when the file has one, as the chart's
             line ends; else start and end; a file with no music: its
             middle energy): smooth under 0.05 apart,
             noticeable under 0.10, a jump from 0.10;
     tempo   the smallest ratio between A's end BPM and B's start BPM, its
             double or its half (128 into 64 is a match): smooth under 4 %
             apart, noticeable under 10 %, a jump from 10 %. No tempo grade
             when either side has no BPM.
   The grade is the worse of the two. Music on one side only: the energy
   alone. No music either side, or a side not measured (no energy): none.
   handoverCost, each part as a share of its jump step (eN = |dE| / 0.10,
   tN = tempo apart / 0.10, each at most 4; tN = 0.5 when both have music
   but a tempo is unknown):
     0.25 x (the larger + 0.3 x the smaller)
   so a jump in either part costs about 0.25 or more, and both together
   more again. Music on one side only: 0.25 x eN. No music either side, or
   not measured: a flat 0.25 (placed by the shape alone).

   Files with nothing to place them by (not measured yet, couldn't be
   measured, no audio stream, silent) keep their playlist positions; the
   rest are ordered around them.

   planOrder: greedy (each next file is the cheapest from the one before; for
   up to 120 files every file is tried as the first and the cheapest result
   kept), then improved by swapping pairs and moving single files while the
   total drops. Up to 600 files every pair is tried; above that, pairs within
   a window sized so a whole pass fits a fixed amount of work (more for a
   bigger collection, never a cliff), so a big collection stays quick. Ties go to the playlist order, and nothing
   depends on the clock, so the same files and shape always give the same
   order.

   Places (o.places: id -> place, from the files' stream tags, lib/stream-tags.js):
   a file with a place is pinned to positions of that kind, and the rest is
   ordered as above around them. A file with several places takes the first
   of First > Last > At a peak > After a peak > At a low point.
     first       the very start (after o.firstId, which always comes first)
     last        the very end
     peak        the shape's highest targets, spread out (one per crest
                 before two side by side)
     after_peak  right after a peak-placed file, else after the highest target
     low         the shape's lowest targets, spread out the same way
     anywhere    ignored
   With Smooth only (no targets) and with Steady (a flat target: no high or
   low points) only First and Last apply. Pinned files of the same kind may
   swap among their positions (Firsts are ordered among themselves by the
   shape and the hand-overs), never with anything else. A placed file is
   ordered even when it is not measured.
   ========================================================================= */

const FlowOrder = (() => {
  const SHAPES = [
    { key: 'smooth', label: 'Smooth only' },
    { key: 'build', label: 'Build up' },
    { key: 'waves', label: 'Waves' },
    { key: 'peak', label: 'Peak then cool down' },
    { key: 'steady', label: 'Steady' },
  ];
  const SHAPE_KEYS = SHAPES.map(s => s.key);
  const NEUTRAL = 0.25;            // a hand-over with nothing to grade (no music either side, not measured)
  const E_SMOOTH = 0.05;           // energy apart: smooth under this, noticeable under E_JUMP
  const E_JUMP = 0.10;
  const T_SMOOTH = 0.04;           // tempo apart (a share): smooth under this, noticeable under T_JUMP
  const T_JUMP = 0.10;
  const PART_MAX = 4;              // a part's share of its jump step counts up to this
  const W_HAND = 0.25;             // a jump in one part costs about this
  const W_OTHER = 0.3;             // the smaller part's weight
  const UNKNOWN_TEMPO = 0.5;       // both have music, a tempo is unknown: half a jump step
  const W_SHAPE = 1.5;             // a shape you picked outweighs a hand-over or two
  const UNKNOWN_SHAPE = 0.3;       // an unmeasured file's cost at any position (the same everywhere)
  const ALL_STARTS_MAX = 120;
  const FULL_SWAP_MAX = 600;       // up to here every pair is tried; above, pairs within a window
  const RELOCATE_MAX = 150;        // up to here a file may move anywhere; above, within 20 places
  const BUDGET_OPS = 2e6;          // cost terms the improvement pass may look at (deterministic, unlike a clock)
  const BUDGET_PER_FILE = 2000;    // ...plus this much per file, so a big collection still gets improved
  const BUDGET_MAX = 1.2e7;
  const SHUFFLE_TEMP = 0.25;       // hand-over costs: a jump is about 0.25
  const SHUFFLE_FLOOR = 0.02;

  const PLACES = ['first', 'last', 'peak', 'after_peak', 'low', 'anywhere'];
  // Group codes for positions and files: 0 free, 1 o.firstId, then one per place.
  const PLACE_GROUP = { first: 2, last: 3, peak: 4, after_peak: 5, low: 6 };
  const PLACE_ORDER = ['first', 'last', 'peak', 'after_peak', 'low'];

  /** The place that wins among several (a string or a list), or null. */
  function resolvePlace(ps) {
    const list = Array.isArray(ps) ? ps : [ps];
    for (const p of PLACE_ORDER) if (list.includes(p)) return p;
    return null;
  }

  const shapeLabel = (k) => (SHAPES.find(s => s.key === k) || SHAPES[0]).label;
  const isShape = (k) => SHAPE_KEYS.includes(k);

  /** The shape's curve at t (0 first .. 1 last), 0..1, or null (Smooth only). */
  function curve(shape, t) {
    switch (shape) {
      case 'build': return t;
      case 'waves': return 0.5 + 0.5 * Math.sin(t * Math.PI * 3);
      case 'peak': return t < 0.7 ? t / 0.7 : 1 - (t - 0.7) / 0.3 * 0.85;
      case 'steady': return 0.5;
      default: return null;
    }
  }

  function median(xs) {
    const s = xs.slice().sort((a, b) => a - b);
    if (!s.length) return 0.5;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /**
   * Target energy per position for n files: the shape stretched over the
   * collection's own range of middle energies (so Build up climbs from its
   * calmest file to its most intense), Steady holds the median.
   * @returns {number[]|null}
   */
  function targetsFor(shape, feats) {
    const n = feats.length;
    if (!isShape(shape) || shape === 'smooth' || !n) return null;
    const ems = feats.filter(f => known(f) && f.music).map(f => f.em);
    const pool = ems.length ? ems : feats.filter(known).map(f => f.em);
    if (shape === 'steady') { const m = median(pool); return feats.map(() => m); }
    let lo = pool.length ? Math.min(...pool) : 0.2;
    let hi = pool.length ? Math.max(...pool) : 0.8;
    if (hi - lo < 0.15) {
      const c = (hi + lo) / 2;
      lo = Math.max(0, c - 0.075); hi = Math.min(1, c + 0.075);
    }
    const out = [];
    for (let i = 0; i < n; i++) out.push(lo + (hi - lo) * curve(shape, n === 1 ? 0 : i / (n - 1)));
    return out;
  }

  /**
   * The Flow chart's dashed guide: the targets of the shape picked now. The
   * server's answer carries them for the shape it was asked for; an answer
   * for another shape (one still on its way when the shape changed) gets
   * them worked out here from its files, the same way the server does.
   * @param {string} shape
   * @param {{shape?: string, targets?: number[]|null, features?: object[]}|null} data
   * @returns {number[]|null}
   */
  function guideTargets(shape, data) {
    if (!data || !isShape(shape)) return null;
    const feats = Array.isArray(data.features) ? data.features : [];
    if (data.shape === shape && Array.isArray(data.targets) && data.targets.length === feats.length) return data.targets;
    return targetsFor(shape, feats);
  }

  /**
   * The smallest ratio between two tempos, allowing double and half time,
   * rounded to 4 decimals (so exactly 10 % apart is 0.1, not 0.0999...; the
   * cost and the grade both use this).
   */
  function tempoRatio(a, b) {
    let best = Infinity;
    for (const k of [1, 2, 0.5]) best = Math.min(best, Math.abs(Math.log(a / (b * k))));
    return Math.round((Math.exp(best) - 1) * 1e4) / 1e4;
  }

  /**
   * A file whose energy can place it: measured, with sound. Not measured yet,
   * couldn't be measured, no audio stream, or silent: placed by the shape
   * alone, at the same cost anywhere (so the files around it decide), and a
   * neutral hand-over either side.
   */
  const known = (f) => !!(f && f.measured && !f.failed && !f.noSound);
  const hasBeat = (f) => known(f) && !!f.music;

  /**
   * Energy where a file starts and ends: ei / eo, the envelope's ends (fromRow
   * sets them; they travel without the envelope, so the order worker grades
   * as the page does), else start and end. A file with no music meets its
   * neighbours at its middle energy (the chart draws it as a flat line there).
   */
  const eIn = (f) => (f.music ? f.ei ?? f.es ?? f.em : f.em);
  const eOut = (f) => (f.music ? f.eo ?? f.ee ?? f.em : f.em);
  // A tempo is a finite BPM above 0; anything else counts as no tempo.
  const bpmOk = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const bpmOut = (f) => (f.music ? bpmOk(f.be) || bpmOk(f.bm) : null);
  const bpmIn = (f) => (f.music ? bpmOk(f.bs) || bpmOk(f.bm) : null);

  /** End of a into the start of b (see the top). Hot: no objects made. */
  function handoverCost(a, b) {
    if (!known(a) || !known(b)) return NEUTRAL;
    const ma = !!a.music, mb = !!b.music;
    if (!ma && !mb) return NEUTRAL;
    const eN = Math.min(PART_MAX, Math.abs(eOut(a) - eIn(b)) / E_JUMP);
    if (!ma || !mb) return W_HAND * eN;
    const ab = bpmOut(a), bb = bpmIn(b);
    const tN = ab && bb ? Math.min(PART_MAX, tempoRatio(ab, bb) / T_JUMP) : UNKNOWN_TEMPO;
    return W_HAND * (Math.max(eN, tN) + W_OTHER * Math.min(eN, tN));
  }

  const RANK = { none: 0, smooth: 1, noticeable: 2, jump: 3 };
  const partGrade = (v, smooth, jump) => (v < smooth ? 'smooth' : v < jump ? 'noticeable' : 'jump');

  /**
   * The hand-over from a into b, graded by part (see the top).
   * @returns {{grade: string, energyGrade: string|null, tempoGrade: string|null, dE: number|null, tempoPct: number|null}}
   *   dE signed (b's start - a's end), tempoPct in percent, both rounded; null when there is none
   */
  function handover(a, b) {
    const out = { grade: 'none', energyGrade: null, tempoGrade: null, dE: null, tempoPct: null };
    if (!known(a) || !known(b) || (!a.music && !b.music)) return out;
    const dE = eIn(b) - eOut(a);
    out.dE = Math.round(dE * 1000) / 1000;
    out.energyGrade = partGrade(Math.abs(out.dE), E_SMOOTH, E_JUMP);
    const ab = bpmOut(a), bb = bpmIn(b);
    if (ab && bb) {
      const r = tempoRatio(ab, bb);
      out.tempoPct = Math.round(r * 1000) / 10;
      out.tempoGrade = partGrade(r, T_SMOOTH, T_JUMP);
    }
    out.grade = !out.tempoGrade || RANK[out.energyGrade] >= RANK[out.tempoGrade] ? out.energyGrade : out.tempoGrade;
    return out;
  }

  /** The hand-over's grade: smooth | noticeable | jump | none. */
  const grade = (a, b) => handover(a, b).grade;

  /**
   * Why a hand-over got its grade, in plain words, the worse part first:
   * "Energy drops 14 · same tempo", "Tempo 115 → 137 BPM (16% apart) · energy steady".
   */
  function handoverText(a, b, h = handover(a, b)) {
    if (h.grade === 'none') return '';
    const pts = Math.round(Math.abs(h.dE) * 100);
    const energy = h.energyGrade === 'smooth' && pts < 3 ? 'energy steady'
      : `energy ${h.dE < 0 ? 'drops' : 'rises'} ${pts}`;
    let tempo;
    if (h.tempoGrade) {
      const ab = Math.round(bpmOut(a)), bb = Math.round(bpmIn(b));
      // Matched against double or half time (128 into 64): say so.
      const k = Math.abs(Math.log(bpmOut(a) / bpmIn(b))) > Math.log(1.5) ? (bpmOut(a) > bpmIn(b) ? 'half time' : 'double time') : '';
      tempo = h.tempoPct < 1 && !k ? 'same tempo'
        : h.tempoGrade === 'smooth' ? `tempo close, ${ab} → ${bb} BPM${k ? ` (${k})` : ''}`
        : `tempo ${ab} → ${bb} BPM (${k ? `${k}, ` : ''}${Math.round(h.tempoPct)}% apart)`;
    } else if (!a.music || !b.music) {
      tempo = !b.music ? 'no music in the next file' : 'no music in the file before';
    } else tempo = 'tempo unknown';
    const parts = h.tempoGrade && RANK[h.tempoGrade] > RANK[h.energyGrade] ? [tempo, energy] : [energy, tempo];
    const s = parts.join(' · ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function shapeCost(f, target) {
    if (target == null) return 0;
    if (!known(f)) return UNKNOWN_SHAPE;
    return W_SHAPE * Math.abs(f.em - target);
  }

  function totalCost(seq, feats, targets) {
    let c = 0;
    for (let i = 0; i < seq.length; i++) {
      if (targets) c += shapeCost(feats[seq[i]], targets[i]);
      if (i) c += handoverCost(feats[seq[i - 1]], feats[seq[i]]);
    }
    return c;
  }

  /**
   * Greedy from one start (indices into feats). G (places): a position only
   * takes a file of its own group.
   */
  function greedy(feats, targets, start, G = null) {
    const n = feats.length;
    const used = new Uint8Array(n);
    const seq = [start];
    used[start] = 1;
    let cost = targets ? shapeCost(feats[start], targets[0]) : 0;
    for (let pos = 1; pos < n; pos++) {
      const prev = feats[seq[pos - 1]];
      let best = -1, bc = Infinity;
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        if (G && G.file[j] !== G.pos[pos]) continue;
        const c = handoverCost(prev, feats[j]) + (targets ? shapeCost(feats[j], targets[pos]) : 0);
        if (c < bc - 1e-12) { bc = c; best = j; }
      }
      used[best] = 1;
      seq.push(best);
      cost += bc;
    }
    return { seq, cost };
  }

  /** Swap pairs and move single files while the total drops. */
  function improve(seq, feats, targets, { fixedFirst, budget, G = null }) {
    const n = seq.length;
    const lo = fixedFirst ? 1 : 0;
    // Places: swaps stay within a group of positions; a move only crosses free ones.
    let pinnedBefore = null;
    if (G) {
      pinnedBefore = new Int32Array(n + 1);
      for (let p = 0; p < n; p++) pinnedBefore[p + 1] = pinnedBefore[p] + (G.pos[p] ? 1 : 0);
    }
    const edge = (i) => (i <= 0 || i >= n ? 0 : handoverCost(feats[seq[i - 1]], feats[seq[i]]));
    const sc = (i) => (targets ? shapeCost(feats[seq[i]], targets[i]) : 0);
    // Cost of the terms touching positions in the set (edges i-1..i and i..i+1, shapes).
    let ops = 0;
    const spent = () => ops > budget;
    const local = (ps) => {
      ops += ps.length * 3;
      const edges = new Set();
      let c = 0;
      for (const p of ps) { edges.add(p); edges.add(p + 1); c += sc(p); }
      for (const e of edges) c += edge(e);
      return c;
    };
    // Windows: everything for small collections; a bounded neighbourhood for
    // big ones, sized so a whole pass fits the budget (no cliff at any size).
    const swapW = n <= FULL_SWAP_MAX ? n : Math.max(8, Math.floor(budget / (n * 12)));
    const moveW = n <= RELOCATE_MAX ? n : 20;
    let improved = true;
    let passes = 0;
    while (improved && passes < 50 && !spent()) {
      improved = false;
      passes++;
      for (let i = lo; i < n - 1; i++) {
        for (let j = i + 1; j < Math.min(n, i + 1 + swapW); j++) {
          if (G && G.pos[i] !== G.pos[j]) continue;
          const before = local([i, j]);
          const t = seq[i]; seq[i] = seq[j]; seq[j] = t;
          const after = local([i, j]);
          if (after < before - 1e-9) improved = true;
          else { seq[j] = seq[i]; seq[i] = t; }
        }
        if (spent()) break;
      }
      {
        for (let i = lo; i < n; i++) {
          for (let j = Math.max(lo, i - moveW); j < Math.min(n, i + moveW + 1); j++) {
            if (j === i) continue;
            const a = Math.min(i, j), b = Math.max(i, j);
            if (G && pinnedBefore[b + 1] !== pinnedBefore[a]) continue;
            const span = [];
            for (let p = a; p <= b; p++) span.push(p);
            const before = local(span);
            const [x] = seq.splice(i, 1);
            seq.splice(j, 0, x);
            const after = local(span);
            if (after < before - 1e-9) improved = true;
            else { seq.splice(j, 1); seq.splice(i, 0, x); }
          }
          if (spent()) break;
        }
      }
    }
    return seq;
  }

  /**
   * Flow order.
   * @param {object[]} feats  in playlist order (ties keep it)
   * @param {object} [o]
   * @param {string} [o.shape='smooth']
   * @param {number} [o.firstId]  keep this file first
   * @param {Map|object} [o.places]  id -> place (or a list of places): stream tags
   * @returns {{order: number[], targets: number[]|null, cost: number, placed: number}}
   */
  function planOrder(feats, o = {}) {
    const shape = isShape(o.shape) ? o.shape : 'smooth';
    const firstId = o.firstId != null && feats.some(f => f.id === o.firstId) ? o.firstId : null;
    const places = placesFor(feats, o.places, shape, firstId);
    // Files with nothing to place them by (not measured yet, couldn't be
    // measured, no sound) stay where they are in the playlist; the rest are
    // ordered around them. A file with a place is ordered all the same.
    const aside = [], placed = [];
    feats.forEach((f, i) => ((known(f) || f.id === firstId || places.has(f.id)) ? placed : aside).push(i));
    const opts = { ...o, shape, firstId, places };
    if (!aside.length || placed.length < 2) return { ...planCore(feats, opts), placed: places.size };
    const n = feats.length;
    const slots = new Array(n);
    // The start and the end belong to First and Last (and the fixed first file).
    let head = firstId != null ? 1 : 0, tail = 0;
    for (const p of places.values()) { if (p === 'first') head++; else if (p === 'last') tail++; }
    for (const i of aside) {
      let p = Math.max(i, head);
      while (p < n - tail && slots[p] !== undefined) p++;
      if (p >= n - tail) { p = n - tail - 1; while (slots[p] !== undefined) p--; }
      slots[p] = feats[i].id;
    }
    const targets = targetsFor(shape, feats);
    // With places, the rest is planned against the positions it will really
    // take: the shape's targets at those slots of the whole order, and which
    // of them sit side by side (a peak and its After a peak must, and an
    // unmeasured file between two slots means they do not).
    let coreOpts = opts;
    if (places.size) {
      const free = [];
      for (let p = 0; p < n; p++) if (slots[p] === undefined) free.push(p);
      coreOpts = { ...opts, targets: targets ? free.map(p => targets[p]) : null, adj: free.map((p, k) => (k > 0 && free[k - 1] === p - 1 ? 1 : 0)), meanTarget: targets ? targets.reduce((x, y) => x + y, 0) / n : null };
    }
    const core = planCore(placed.map(i => feats[i]), coreOpts);
    let k = 0;
    for (let p = 0; p < n; p++) if (slots[p] === undefined) slots[p] = core.order[k++];
    const idx = new Map(feats.map((f, i) => [f.id, i]));
    return { order: slots, targets, cost: totalCost(slots.map(id => idx.get(id)), feats, targets), placed: places.size };
  }

  /** o.places as Map(id -> place) for these files: what applies with this shape. */
  function placesFor(feats, given, shape, firstId) {
    const out = new Map();
    if (!given) return out;
    const get = given instanceof Map ? (id) => given.get(id) : (id) => given[id];
    // No high or low points without a shape (Smooth only) or with a flat one (Steady).
    const shaped = shape !== 'smooth' && shape !== 'steady';
    for (const f of feats) {
      if (f.id === firstId) continue;
      const v = get(f.id);
      if (v == null) continue;
      const p = resolvePlace(v);
      if (!p) continue;
      if (!shaped && p !== 'first' && p !== 'last') continue;
      out.set(f.id, p);
    }
    return out;
  }

  /**
   * Which positions each place takes, for these files and targets:
   * { pos: Int8Array (group per position), file: Int8Array (group per file) }.
   * adj[p]: position p directly follows p - 1 in the whole order (default:
   * always; not when an unmeasured file sits between them).
   */
  function pinGroups(feats, targets, places, fixed, adj = null, meanTarget = null) {
    const n = feats.length;
    const next = (p) => p > 0 && (!adj || !!adj[p]);       // p directly follows p - 1
    const pos = new Int8Array(n), file = new Int8Array(n);
    const count = { first: 0, last: 0, peak: 0, after_peak: 0, low: 0 };
    feats.forEach((f, j) => {
      if (j === fixed) { file[j] = 1; return; }
      const p = places.get(f.id);
      if (p) { file[j] = PLACE_GROUP[p]; count[p]++; }
    });
    let at = 0;
    if (fixed >= 0) pos[at++] = 1;
    for (let k = 0; k < count.first; k++) pos[at++] = PLACE_GROUP.first;
    for (let k = 0; k < count.last; k++) pos[n - 1 - k] = PLACE_GROUP.last;
    const t = (p) => (targets ? targets[p] : 0.5);
    // The highest (or lowest) free targets, one per crest first: a position
    // next to one already taken waits for a later round, and so does one
    // with no free slot after it while After a peak files want one (room).
    // Never the wrong side of the mean target while a right one is free.
    // (The whole order's mean: these may be only some of its slots.)
    let mean = meanTarget;
    if (mean == null) { mean = 0; for (let p = 0; p < n; p++) mean += t(p); mean /= n || 1; }
    const spread = (k, group, high, room = 0) => {
      const free = [];
      for (let p = 0; p < n; p++) if (!pos[p]) free.push(p);
      free.sort((a, b) => (high ? t(b) - t(a) : t(a) - t(b)) || a - b);
      const near = (p) => (next(p) && pos[p - 1] === group) || (p < n - 1 && next(p + 1) && pos[p + 1] === group);
      const side = (p) => (high ? t(p) >= mean - 1e-12 : t(p) <= mean + 1e-12);
      for (let round = 0; round < 3 && k > 0; round++) {
        for (const p of free) {
          if (k <= 0) break;
          if (pos[p] || (round < 2 && !side(p)) || (round === 0 && near(p))) continue;
          if (round === 0 && room > 0 && (p >= n - 1 || pos[p + 1] || !next(p + 1))) continue;
          pos[p] = group;
          k--;
          room--;
        }
      }
    };
    spread(count.peak, PLACE_GROUP.peak, true, count.after_peak);
    for (let k = 0; k < count.after_peak; k++) {
      // Right after a peak-placed file first, then after the highest target
      // (a slot with an unmeasured file before it comes last).
      let best = -1, bs = -Infinity;
      for (let p = 1; p < n; p++) {
        if (pos[p]) continue;
        const s = next(p) ? (pos[p - 1] === PLACE_GROUP.peak ? 2 : 0) + t(p - 1) : -1 + t(p);
        if (s > bs + 1e-12) { bs = s; best = p; }
      }
      for (let p = 0; p < n && best < 0; p++) if (!pos[p]) best = p;
      pos[best] = PLACE_GROUP.after_peak;
    }
    spread(count.low, PLACE_GROUP.low, false);
    return { pos, file };
  }

  /**
   * targets / adj (planOrder with places and unmeasured files): the targets
   * of the slots these files will take in the whole order, and which slots
   * sit side by side, instead of the shape over these files alone.
   */
  function planCore(feats, { shape = 'smooth', firstId = null, budget = null, places = null, targets: given, adj = null, meanTarget = null } = {}) {
    const n = feats.length;
    if (!isShape(shape)) shape = 'smooth';
    if (n <= 1) return { order: feats.map(f => f.id), targets: targetsFor(shape, feats), cost: 0 };
    const targets = given !== undefined ? given : targetsFor(shape, feats);
    const fixed = firstId != null ? feats.findIndex(f => f.id === firstId) : -1;
    const G = places && places.size && feats.some(f => places.has(f.id)) ? pinGroups(feats, targets, places, fixed, adj, meanTarget) : null;
    const startOk = (s) => !G || G.file[s] === G.pos[0];
    let best = null;
    if (fixed >= 0) {
      best = greedy(feats, targets, fixed, G);
    } else if (n <= ALL_STARTS_MAX) {
      for (let s = 0; s < n; s++) {
        if (!startOk(s)) continue;
        const g = greedy(feats, targets, s, G);
        if (!best || g.cost < best.cost - 1e-9) best = g;
      }
    } else {
      // The calmest opening for Smooth only, the file nearest the shape's start otherwise.
      let s0 = -1, bc = Infinity;
      for (let s = 0; s < n; s++) {
        if (!startOk(s)) continue;
        const f = feats[s];
        const c = targets ? shapeCost(f, targets[0]) : (hasBeat(f) ? f.es : 1);
        if (c < bc - 1e-12) { bc = c; s0 = s; }
      }
      best = greedy(feats, targets, s0, G);
    }
    const starts = [best.seq];
    // With a shape, also start from the files matched to the targets by rank
    // (the calmest file to the calmest spot...), which is the best fit to the
    // shape alone: greedy tends to use up the files a shape's end needs.
    if (targets) starts.push(rankFit(feats, targets, fixed, G));
    let out = null;
    for (const s of starts) {
      const seq = improve(s.slice(), feats, targets, { fixedFirst: fixed >= 0, G, budget: budget == null ? Math.min(BUDGET_MAX, BUDGET_OPS + n * BUDGET_PER_FILE) : budget });
      const cost = totalCost(seq, feats, targets);
      if (!out || cost < out.cost - 1e-9) out = { seq, cost };
    }
    return { order: out.seq.map(i => feats[i].id), targets, cost: out.cost };
  }

  /**
   * Files to positions by rank of energy against rank of target (ties:
   * playlist order, position). G (places): within each group of positions.
   */
  function rankFit(feats, targets, fixed, G = null) {
    const n = feats.length;
    const mid = median(feats.filter(known).map(f => f.em));
    const em = (i) => (known(feats[i]) ? feats[i].em : mid);
    const seq = new Array(n);
    if (fixed >= 0) seq[0] = fixed;
    for (const g of (G ? [0, ...Object.values(PLACE_GROUP)] : [0])) {
      const files = [], spots = [];
      for (let i = 0; i < n; i++) if (i !== fixed && (!G || G.file[i] === g)) files.push(i);
      for (let p = fixed >= 0 ? 1 : 0; p < n; p++) if (!G || G.pos[p] === g) spots.push(p);
      files.sort((a, b) => em(a) - em(b) || a - b);
      spots.sort((a, b) => targets[a] - targets[b] || a - b);
      spots.forEach((p, k) => { seq[p] = files[k]; });
    }
    return seq;
  }

  /** The hand-overs of an order (ids), in feats' terms. */
  function summary(feats, order) {
    const by = new Map(feats.map(f => [f.id, f]));
    const handovers = [];
    let jumps = 0;
    for (let i = 1; i < order.length; i++) {
      const a = by.get(order[i - 1]), b = by.get(order[i]);
      const cost = handoverCost(a, b);
      const h = handover(a, b);
      if (h.grade === 'jump') jumps++;
      handovers.push({ cost: Math.round(cost * 1000) / 1000, ...h });
    }
    return { handovers, jumps };
  }

  /** Small seeded generator for tests (mulberry32). */
  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** One weighted pick: a good hand-over is likelier, anything can still come up. */
  function pickFrom(prev, pool, rng) {
    const w = pool.map(f => (prev ? Math.exp(-handoverCost(prev, f) / SHUFFLE_TEMP) : 1) + SHUFFLE_FLOOR);
    let total = 0;
    for (const x of w) total += x;
    let r = rng() * total;
    for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) return i; }
    return pool.length - 1;
  }

  /**
   * Flow shuffle: a random order where each next file is drawn with weight
   * exp(-handover cost / 0.25) + 0.02 from the one before. Soft, never a filter.
   * @param {object[]} feats
   * @param {{startId?: number, rng?: Function}} [o]
   * @returns {number[]} ids
   */
  function flowShuffle(feats, { startId = null, rng = Math.random } = {}) {
    const pool = feats.slice();
    const out = [];
    let prev = null;
    if (startId != null) {
      const i = pool.findIndex(f => f.id === startId);
      if (i >= 0) { prev = pool.splice(i, 1)[0]; out.push(prev.id); }
    }
    while (pool.length) {
      const i = prev ? pickFrom(prev, pool, rng) : Math.floor(rng() * pool.length);
      prev = pool.splice(i, 1)[0];
      out.push(prev.id);
    }
    return out;
  }

  const energyWord = (e) => (e >= 0.65 ? 'high' : e >= 0.4 ? 'medium' : 'low');

  function bpmText(f) {
    if (!f || !f.bs) return f && f.bm ? String(Math.round(f.bm)) : '';
    const s = Math.round(f.bs), e = Math.round(f.be || f.bs);
    return Math.abs(s - e) < 2 ? String(Math.round(f.bm || s)) : `${s}→${e}`;
  }

  /** The Stage bar's line for a file: "128 BPM · energy high", "no music", or '' (not measured). */
  function flowText(f) {
    if (!f || !f.measured) return '';
    if (!f.music) return 'no music';
    return `${bpmText(f)} BPM · energy ${energyWord(f.em)}`;
  }

  /** media_flow.env (JSON pairs) as the features carry it: inside 0..1, rounded to 2 decimals, sorted by t; or null. */
  function parseEnv(text) {
    if (!text) return null;
    let a;
    try { a = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
    if (!Array.isArray(a)) return null;
    // Pairs that are not two finite numbers are dropped; t and e kept inside 0..1; in time order.
    const r2 = (x) => Math.round(Math.max(0, Math.min(1, x)) * 100) / 100;
    const out = a.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map(p => [r2(p[0]), r2(p[1])])
      .sort((x, y) => x[0] - y[0]);
    return out.length >= 2 ? out : null;
  }

  /**
   * An order kept to a collection's files: ids that are not members (and
   * repeats) dropped, members it lacks added at the end in members' order.
   */
  function reconcileOrder(order, members) {
    const inMembers = new Set(members);
    const seen = new Set();
    const out = [];
    for (const id of order || []) if (inMembers.has(id) && !seen.has(id)) { seen.add(id); out.push(id); }
    for (const id of members) if (!seen.has(id)) { seen.add(id); out.push(id); }
    return out;
  }

  /**
   * Move ids (as a block, in the order's own order) to sit right before
   * `before` (null: the end). Null when nothing moves, before is one of
   * them, or before is not in the order.
   */
  function moveBlock(order, ids, before) {
    const moving = new Set(ids);
    const block = order.filter(id => moving.has(id));
    if (!block.length || (before != null && moving.has(before))) return null;
    const rest = order.filter(id => !moving.has(id));
    const at = before == null ? rest.length : rest.indexOf(before);
    if (at < 0) return null;
    const next = [...rest.slice(0, at), ...block, ...rest.slice(at)];
    return next.every((id, i) => id === order[i]) ? null : next;
  }

  /**
   * A remembered Flow order (localStorage text) as { shape, places, edited },
   * or null when there is none or it is not exactly that shape (the caller
   * removes it then): a plain object, a known shape, places true / false /
   * null, edited null or a list of whole positive ids.
   */
  function parseRemembered(text) {
    if (typeof text !== 'string' || !text) return null;
    let v;
    try { v = JSON.parse(text); } catch { return null; }
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return null;
    if (!isShape(v.shape)) return null;
    if (v.places != null && typeof v.places !== 'boolean') return null;
    let edited = null;
    if (v.edited != null) {
      if (!Array.isArray(v.edited) || !v.edited.every(id => Number.isInteger(id) && id > 0)) return null;
      edited = v.edited.length ? [...new Set(v.edited)] : null;
    }
    return { shape: v.shape, places: v.places == null ? null : v.places, edited };
  }

  /**
   * The file that plays after `playing`: Up next's first file when it has
   * one ({ upNext: true }), else the next in the list, else null.
   * @param {number|null} playing
   * @param {{upNext?: number[], indexOf: Function, idAt: Function}} o
   */
  function nextAfter(playing, { upNext = [], indexOf, idAt }) {
    if (upNext.length) return { id: upNext[0], upNext: true };
    if (playing == null) return null;
    const i = indexOf(playing);
    if (i < 0) return null;
    const id = idAt(i + 1);
    return id != null ? { id, upNext: false } : null;
  }

  /** A media_flow row (or null) as features. */
  function fromRow(id, row) {
    if (!row || row.error) return { id, measured: false, failed: !!(row && row.error), music: false, es: 0, em: 0, ee: 0, bs: null, bm: null, be: null };
    return {
      id, measured: true, failed: false, music: !!row.has_music, noAudio: !!row.no_audio,
      // No audio stream, or nothing above -70 LUFS: no energy to place it by.
      noSound: !!row.no_audio || row.lufs == null,
      es: row.e_start ?? 0, em: row.e_mid ?? 0, ee: row.e_end ?? 0,
      bs: row.bpm_start, bm: row.bpm_mid, be: row.bpm_end, lufs: row.lufs,
      ...withEnv(row.env),
    };
  }
  const withEnv = (text) => { const env = parseEnv(text); return env ? { env, ei: env[0][1], eo: env[env.length - 1][1] } : {}; };

  return {
    SHAPES, SHAPE_KEYS, NEUTRAL, E_SMOOTH, E_JUMP, T_SMOOTH, T_JUMP, PLACES, resolvePlace,
    shapeLabel, isShape, curve, targetsFor, guideTargets, tempoRatio, handoverCost, handover, grade, handoverText, planOrder, summary,
    flowShuffle, pickFrom, seeded, energyWord, bpmText, flowText, fromRow, parseEnv, totalCost,
    reconcileOrder, moveBlock, parseRemembered, nextAfter,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FlowOrder;
if (typeof window !== 'undefined') window.FlowOrder = FlowOrder;
