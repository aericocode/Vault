/* =========================================================================
   FLOW ORDER - the pure part of Flow, shared by the server (lib/flow/,
   GET /api/flow/collections/:id), the Flow panel (player-lib/flow.js) and the
   tests (test/flow-order.test.js). No DOM, no network.

   A file's features (from media_flow, lib/flow/analyze.js):
     { id, measured, music, es, em, ee (energy 0..1 at start, middle, end),
       bs, bm, be (BPM at start, middle, end, or null) }

   - SHAPES, shapeLabel(k)       the shapes you pick from
   - targetsFor(shape, feats)    the energy each position aims for, across the
                                 collection's own range (null for Smooth only)
   - handoverCost(a, b)          how well the end of a flows into the start of b
   - grade(cost, a, b)           smooth | noticeable | jump | none (no music)
   - planOrder(feats, o)         Flow order: least total cost, deterministic
   - PLACES, resolvePlace(ps)    where a stream tag puts a file (o.places)
   - summary(feats, order)       the hand-overs of an order, and its jumps
   - flowShuffle(feats, o)       a shuffle that leans toward good hand-overs
   - flowText(f)                 "128 BPM · energy high" (the Stage bar)

   The cost of an order:
     sum over neighbours of handoverCost(end of A, start of B)
   + 1.5 x sum over positions of |middle energy - the shape's target there|
   handoverCost = 0.65 x |energy at A's end - energy at B's start|
                + 0.35 x tempo distance, where the tempo distance is the
                  smallest ratio between A's end BPM and B's start BPM, its
                  double or its half (128 into 64 is a match), 0 at the same
                  tempo and 1 at 16 % apart or more (0.5 when a tempo is
                  unknown). A file with no music (or not measured yet) hands
                  over at a flat 0.25 either way: it is placed by the shape
                  alone.
   Grades: smooth under 0.12, noticeable under 0.25, a jump from 0.25.

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
  const NEUTRAL = 0.25;            // a hand-over with no music on one side
  const SMOOTH = 0.12;
  const NOTICEABLE = 0.25;
  const TEMPO_FULL = 0.16;         // 16 % apart is as far as tempo goes
  const W_ENERGY = 0.65;
  const W_TEMPO = 0.35;
  const W_SHAPE = 1.5;             // a shape you picked outweighs a hand-over or two
  const UNKNOWN_SHAPE = 0.3;       // an unmeasured file's cost at any position (the same everywhere)
  const ALL_STARTS_MAX = 120;
  const FULL_SWAP_MAX = 600;       // up to here every pair is tried; above, pairs within a window
  const RELOCATE_MAX = 150;        // up to here a file may move anywhere; above, within 20 places
  const BUDGET_OPS = 2e6;          // cost terms the improvement pass may look at (deterministic, unlike a clock)
  const BUDGET_PER_FILE = 2000;    // ...plus this much per file, so a big collection still gets improved
  const BUDGET_MAX = 1.2e7;
  const SHUFFLE_TEMP = 0.1;
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

  /** The smallest ratio between two tempos, allowing double and half time. */
  function tempoRatio(a, b) {
    let best = Infinity;
    for (const k of [1, 2, 0.5]) best = Math.min(best, Math.abs(Math.log(a / (b * k))));
    return Math.exp(best) - 1;
  }

  /**
   * A file whose energy can place it: measured, with sound. Not measured yet,
   * couldn't be measured, no audio stream, or silent: placed by the shape
   * alone, at the same cost anywhere (so the files around it decide), and a
   * neutral hand-over either side.
   */
  const known = (f) => !!(f && f.measured && !f.failed && !f.noSound);
  const hasBeat = (f) => known(f) && !!f.music;

  /** End of a into the start of b. */
  function handoverCost(a, b) {
    if (!hasBeat(a) || !hasBeat(b)) return NEUTRAL;
    const e = Math.abs((a.ee ?? a.em) - (b.es ?? b.em));
    const ab = a.be || a.bm, bb = b.bs || b.bm;
    const t = ab && bb ? Math.min(1, tempoRatio(ab, bb) / TEMPO_FULL) : 0.5;
    return W_ENERGY * e + W_TEMPO * t;
  }

  function grade(cost, a, b) {
    if (a && b && (!hasBeat(a) || !hasBeat(b))) return 'none';
    return cost < SMOOTH ? 'smooth' : cost < NOTICEABLE ? 'noticeable' : 'jump';
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
      const g = grade(cost, a, b);
      if (g === 'jump') jumps++;
      handovers.push({ cost: Math.round(cost * 1000) / 1000, grade: g });
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
   * exp(-handover cost / 0.1) + 0.02 from the one before. Soft, never a filter.
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

  /** A media_flow row (or null) as features. */
  function fromRow(id, row) {
    if (!row || row.error) return { id, measured: false, failed: !!(row && row.error), music: false, es: 0, em: 0, ee: 0, bs: null, bm: null, be: null };
    return {
      id, measured: true, failed: false, music: !!row.has_music, noAudio: !!row.no_audio,
      // No audio stream, or nothing above -70 LUFS: no energy to place it by.
      noSound: !!row.no_audio || row.lufs == null,
      es: row.e_start ?? 0, em: row.e_mid ?? 0, ee: row.e_end ?? 0,
      bs: row.bpm_start, bm: row.bpm_mid, be: row.bpm_end, lufs: row.lufs,
    };
  }

  return {
    SHAPES, SHAPE_KEYS, NEUTRAL, SMOOTH, NOTICEABLE, PLACES, resolvePlace,
    shapeLabel, isShape, curve, targetsFor, tempoRatio, handoverCost, grade, planOrder, summary,
    flowShuffle, pickFrom, seeded, energyWord, bpmText, flowText, fromRow, totalCost,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FlowOrder;
if (typeof window !== 'undefined') window.FlowOrder = FlowOrder;
