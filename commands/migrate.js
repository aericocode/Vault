/**
 * Path migration — repoint the library at moved files WITHOUT rescanning.
 *
 *   node vault.js migrate <oldPrefix> <newPrefix> [--dry-run]
 *   node vault.js migrate --relink <newRoot> [--dry-run]
 *
 * media.filepath is the library's only file identity. Move the library from
 * K:\ to M:\ and every row points at nothing while every file looks brand new —
 * a rescan that costs days of GPU time to rebuild metadata that already exists.
 * This command edits the paths instead. Nothing is re-analyzed; ids, AI
 * metadata, notes, stars, ratings, view counts and collections all survive.
 *
 * MODE A — prefix rewrite. The straightforward case: the whole library moved
 * to a new drive or parent folder and the tree below it is unchanged. Every
 * live row under oldPrefix is repointed at newPrefix + the same remainder,
 * but ONLY where the file is actually there — a rewrite onto a path with no
 * file would silently break the row instead of fixing it.
 *
 * MODE B — relink. For the messier case (folders renamed, files reorganized,
 * or a COPY-style move where the originals are still sitting on the old drive).
 * Every live row whose path is not already under newRoot is matched against
 * the files under newRoot — not just the rows whose file has gone missing.
 * That used to be the gate, and it made relink useless for the most common
 * migration of all: copy everything across, verify, delete the original later.
 * Both drives connected meant zero missing rows and zero matches. The old
 * behaviour is a strict subset of this one, so a disconnected drive still
 * works exactly as before.
 *
 * Matching runs in tiers, and every planned move is byte-verified:
 *   Tier 1  normalized filename + media type + size within ±1%.
 *   Tier 2  (only when tier 1 found nothing) a UNIQUE exact-byte-size match of
 *           the same media type, whatever it is called — the rename rescue.
 *           Not unique means no tier-2 match at all, never a guess.
 *   Verify  64KB from the head and 64KB from the tail of both files must be
 *           identical. A same-size decoy is caught here and reported under
 *           content_mismatch instead of being adopted. When the OLD file is
 *           unreadable (the disconnected-drive case) there is nothing to
 *           compare against, so the check is skipped and the match stands on
 *           name+size alone — exactly the trust level relink always had.
 *
 * Several tier-1 candidates are decided by the longest matching path SUFFIX
 * (…/season 2/ep3.mkv beats …/misc/ep3.mkv), then by the shallower path, and
 * only then given up as ambiguous. The look-alikes that lose are usually
 * copies of the same content, so any that already have rows in the database
 * join the winner's dupe group rather than vanishing from view.
 *
 * ABSORBING STUBS is the part that matters in practice. Dragging the new
 * drive's folders into the viewer creates 'unscanned' stub rows at the new
 * paths, so the destination is already occupied and a naive UPDATE hits
 * filepath's UNIQUE index. A stub holds nothing worth keeping, so it is
 * deleted and the real record takes its path (one transaction — see
 * db.repointPath). A destination held by a fully SCANNED row is a different
 * story: two real records for one file is a judgement call about which
 * metadata wins, so those are reported as conflicts and left untouched.
 *
 * PHASH FALLBACK, honestly scoped: it compares the missing row's stored phash
 * against phashes ALREADY RECORDED for files under newRoot. No hashes are
 * computed here (far too slow over a whole library), and a stub has never been
 * hashed — so this only ever fires when the destination already holds a
 * fully-scanned record, i.e. it finds duplicate records rather than rescuing
 * renamed files. It is reported, never auto-applied.
 *
 * SHARED WITH THE VIEWER. planPrefix / planRelink / apply / summarize are the
 * engine behind the Settings › Library panel too (server/index.js routes
 * /api/migrate/preview and /api/migrate/apply). They therefore print nothing
 * and never call process.exit: progress goes to an optional onProgress
 * callback and bad input throws a typed error. Everything that talks to a
 * terminal lives below the "Entry point" divider, in run().
 */

const fs = require('fs');
const path = require('path');
const db = require('../lib/database');
const dupes = require('../lib/dupes');
const scanner = require('../lib/file-scanner');

const IS_WIN = process.platform === 'win32';
const SEP = IS_WIN ? '\\' : '/';

/** Match the separator style path.join() produced when the rows were written. */
function normalize(p) {
  let s = String(p).trim().replace(/^"(.*)"$/, '$1');
  if (IS_WIN) s = s.replace(/\//g, '\\');
  return s;
}

/**
 * Prefix comparison is done without a trailing separator, so the remainder
 * always starts with one. "K:\" becomes "K:" and "K:\Media\x.mp4" splits into
 * "K:" + "\Media\x.mp4" — which recombines correctly against any new prefix.
 */
function stripTrailing(p) {
  return p.replace(/[\\/]+$/, '');
}

/** Case-folded key — Windows paths compare case-insensitively. */
function key(p) {
  return IS_WIN ? String(p).toLowerCase() : String(p);
}

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

// ── Content verification ───────────────────────────────────────────────────

/** Bytes compared at each end of a file. Two reads per side, no full hash. */
const SPOT_BYTES = 64 * 1024;

function _readAt(fd, length, position) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (n <= 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

/**
 * Are these two paths the same content? Compares the first and last 64KB.
 *
 * Cheap enough to run on every planned move (four reads total) and strong
 * enough for what it guards against: adopting a DIFFERENT file that merely
 * happens to share a name or a byte count. A full hash would be correct and
 * unaffordable — a 4TB library would be read end to end just to plan a move.
 *
 * NOTE the interaction with tier 1's ±1% size tolerance: when both files are
 * readable, "same size-ish" is no longer enough — the bytes have to match, so
 * a genuine re-encode is REJECTED rather than adopted. That is the intended
 * trade. A re-encode is not the file the record describes, and the old file
 * is right there to prove it. Only when the old side is gone does the tolerance
 * stand on its own again.
 *
 * @returns {'ok'|'mismatch'|'skipped'} 'skipped' = old side unreadable
 */
function spotCheck(oldPath, newPath) {
  let a = null, b = null;
  try {
    try { a = fs.openSync(oldPath, 'r'); }
    catch { return 'skipped'; }           // nothing to compare against
    try { b = fs.openSync(newPath, 'r'); }
    catch { return 'mismatch'; }          // destination unreadable — don't adopt it

    const sizeA = fs.fstatSync(a).size;
    const sizeB = fs.fstatSync(b).size;
    const n = Math.min(SPOT_BYTES, sizeA, sizeB);
    if (n === 0) return sizeA === sizeB ? 'ok' : 'mismatch';

    if (!_readAt(a, n, 0).equals(_readAt(b, n, 0))) return 'mismatch';
    if (!_readAt(a, n, sizeA - n).equals(_readAt(b, n, sizeB - n))) return 'mismatch';
    return 'ok';
  } catch {
    return 'mismatch';                    // an I/O error mid-compare proves nothing
  } finally {
    if (a !== null) { try { fs.closeSync(a); } catch {} }
    if (b !== null) { try { fs.closeSync(b); } catch {} }
  }
}

// ── Candidate tiebreak ─────────────────────────────────────────────────────

function segments(p) {
  return key(p).split(/[\\/]+/).filter(Boolean);
}

/** How many trailing path segments two paths share, case-folded. */
function suffixMatch(a, b) {
  const A = segments(a), B = segments(b);
  let n = 0;
  while (n < A.length && n < B.length && A[A.length - 1 - n] === B[B.length - 1 - n]) n++;
  return n;
}

/**
 * Choose the candidate that best corresponds to oldPath, or null when the
 * field is still tied and the honest answer is "ambiguous".
 *
 * Longest shared path suffix first — a library that moved wholesale keeps its
 * folder structure, so "…\Season 2\ep3.mkv" is a far better answer for
 * "…\Season 2\ep3.mkv" than "…\misc\ep3.mkv" is. Shallower path breaks a
 * remaining tie, on the theory that the copy nearer the root is the library
 * and the deeper one is a backup or an extras folder.
 */
function pickBest(oldPath, candidates) {
  let best = [], bestScore = -1;
  for (const c of candidates) {
    const s = suffixMatch(oldPath, c.path);
    if (s > bestScore) { bestScore = s; best = [c]; }
    else if (s === bestScore) best.push(c);
  }
  if (best.length === 1) return best[0];

  let shallow = [], bestDepth = Infinity;
  for (const c of best) {
    const d = segments(c.path).length;
    if (d < bestDepth) { bestDepth = d; shallow = [c]; }
    else if (d === bestDepth) shallow.push(c);
  }
  return shallow.length === 1 ? shallow[0] : null;
}

function usage() {
  console.log(`
Vault - migrate: move the library's file paths without rescanning

Usage:
  node vault.js migrate --auto <newRoot> [--dry-run]
      The one to reach for. Point it at the folder your files live in now.
      It searches there (subfolders included), works out for itself which
      folders moved where, and applies each move in one fast step after
      byte-checking a sample of the files it covers. Anything the moves do
      not explain falls back to the full per-file search below, including
      files that were renamed. The old drive can stay plugged in.

  node vault.js migrate <oldPrefix> <newPrefix> [--dry-run]
      Rewrite every live record under <oldPrefix> to sit under <newPrefix>.
      Example: node vault.js migrate "K:\\Media" "M:\\Media"

  node vault.js migrate --relink <newRoot> [--dry-run]
      For renamed or reorganized folders, and for a COPY-style move where
      the originals are still on the old drive. Every record not already
      under <newRoot> is matched against the files there (subfolders
      included), in tiers:
        1. normalized filename + media type + size within ±1%
        2. if that finds nothing: a UNIQUE exact-byte-size match of the same
           type, whatever it is called (finds renamed files)
      Every match is then byte-verified: 64KB from each end of both files
      must be identical, so a same-size look-alike is reported, not adopted.
      When the old file is unreadable (drive disconnected) there is nothing
      to compare, so the match stands on name + size alone.
      Several equally good candidates are decided by the longest matching
      path suffix, then the shallower path, and otherwise left as ambiguous.

Options:
  --dry-run       Print the report; change nothing.
  --limit N       How many example paths to list per bucket (default 10).

Only records that are NOT in the trash are considered, and a record is only
repointed when the file really exists at the destination. An 'unscanned' stub
already sitting at the destination is absorbed (deleted, its path taken over);
a fully scanned record there is reported as a conflict and left alone. Records
that do not match are left completely untouched.
`);
}

// ── Cooperative scheduling ─────────────────────────────────────────────────
//
// The planners run inside the viewer's server process, where blocking the
// event loop means no streaming, no thumbnails and a frozen UI. A relink over
// a big library is minutes of work — mostly the spot check's file reads — so
// the row loops hand the loop back every few milliseconds. Time-based rather
// than every-N-rows: how long N rows take swings wildly depending on how many
// of them reach the disk.

const YIELD_MS = 25;
const nextTick = () => new Promise(resolve => setImmediate(resolve));

/** A yield gate plus the progress tick, since they happen at the same moments. */
function makePacer(onTick) {
  let last = Date.now();
  return async function pace(processed, total, phase, force = false) {
    if (!force && Date.now() - last < YIELD_MS) return;
    last = Date.now();
    onTick(processed, total, phase);
    await nextTick();
  };
}

/**
 * Recursive media walk that yields — migrate's own, deliberately not
 * file-scanner's scan().
 *
 * scan() recurses synchronously and returns only when the entire tree is in
 * memory. Every other caller is a CLI run where that is exactly right; here it
 * is a hundred thousand readdir/stat calls with the server's event loop held
 * shut for all of them. So: an explicit stack, one directory per step, a yield
 * between steps. Classification comes from file-scanner so the two walks can
 * never disagree about what counts as media.
 *
 * `total` is genuinely unknown until the walk ends — you cannot know how many
 * files a tree holds without walking it — so progress reports the running
 * count with total 0, and the UI shows "N found" instead of a fake fraction.
 */
async function pacedWalk(root, pace) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }               // unreadable dir — same as scan(): skip it
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      const mediaType = scanner.mediaTypeForExt(ext);
      if (mediaType) out.push({ path: full, name: e.name, ext, mediaType });
    }
    await pace(out.length, 0, 'walking');
  }
  // Forced: the pacer throttles, so without this the last directories' finds
  // are never reported and the walk appears to stop short of its own total.
  await pace(out.length, 0, 'walking', true);
  return out;
}

// ── Planning ───────────────────────────────────────────────────────────────

function emptyReport(mode) {
  return {
    mode,
    considered: 0,
    rewrite: [],     // { row, newPath, reason }
    absorb: [],      // { row, newPath, absorbId, reason }
    missing: [],     // { row, newPath }   destination has no file
    conflict: [],    // { row, newPath, occupant, reason }
    ambiguous: [],   // { row, candidates }
    unmatched: [],   // { row }
    mismatch: [],    // { row, newPath, reason }  matched, but the bytes differ
    dupeLink: [],    // { rowId, stubIds }        rejected look-alikes to group
    rules: [],       // auto mode: the moves it worked out for itself
    unchanged: 0,
  };
}

/**
 * Decide what repointing `row` at `newPath` would mean, and file it under the
 * right bucket. `claimed` stops two records planning to take the same path in
 * one run — the second would fail the UNIQUE index at apply time, so it is a
 * conflict rather than a rewrite.
 */
function classify(row, newPath, report, claimed, reason) {
  if (key(newPath) === key(row.filepath)) { report.unchanged++; return; }

  if (!exists(newPath)) {
    report.missing.push({ row, newPath });
    return;
  }

  if (claimed.has(key(newPath))) {
    report.conflict.push({ row, newPath, occupant: null, reason: 'claimed by another record in this run' });
    return;
  }

  const occupant = db.findByPathInsensitive(newPath);

  if (!occupant || occupant.id === row.id) {
    claimed.add(key(newPath));
    report.rewrite.push({ row, newPath, reason });
    return;
  }

  if (occupant.processing_error === db.UNSCANNED_MARKER) {
    // The stub is a placeholder; the old row is the one carrying metadata.
    // Take the stub's exact stored spelling of the path — it came from the
    // real directory walk, so it is what every other lookup will use.
    claimed.add(key(occupant.filepath));
    report.absorb.push({ row, newPath: occupant.filepath, absorbId: occupant.id, reason });
    return;
  }

  report.conflict.push({
    row, newPath, occupant,
    reason: `destination already holds a ${occupant.user_trashed ? 'trashed' : 'scanned'} record${reason ? ` (matched by ${reason})` : ''}`,
  });
}

/**
 * Mode A: <oldPrefix> → <newPrefix>.
 * @param {object} [opts]
 * @param {(processed:number,total:number,phase:string)=>void} [opts.onTick]
 */
async function planPrefix(oldPrefixRaw, newPrefixRaw, { onTick = () => {} } = {}) {
  const oldPrefix = stripTrailing(normalize(oldPrefixRaw));
  const newPrefix = stripTrailing(normalize(newPrefixRaw));
  const oldKey = key(oldPrefix);

  const report = emptyReport('prefix');
  report.oldPrefix = oldPrefix;
  report.newPrefix = newPrefix;

  const rows = db.getMigrationRows();
  report.liveRows = rows.length;
  const claimed = new Set();
  const pace = makePacer(onTick);

  // Select the rows under oldPrefix FIRST — pure string tests, milliseconds
  // even at 100k rows — so the progress total is the folder being moved, not
  // the whole library. "0 / 30,000" on a 25-file move reads as a full-library
  // scan; the per-row disk work below only ever runs for the matches anyway.
  const matches = [];
  for (const row of rows) {
    if (!key(row.filepath).startsWith(oldKey)) continue;
    const rest = row.filepath.slice(oldPrefix.length);
    // "K:\Media" must not swallow "K:\MediaBackup\x.mp4" — what follows the
    // prefix has to start at a path boundary (or be nothing, for the prefix
    // itself, which only happens if a file is literally named that).
    if (rest && !/^[\\/]/.test(rest)) continue;
    matches.push({ row, rest });
  }

  let seen = 0;
  onTick(0, matches.length, 'matching');
  for (const { row, rest } of matches) {
    seen++;
    await pace(seen, matches.length, 'matching');
    report.considered++;
    classify(row, newPrefix + rest, report, claimed, 'prefix');
  }
  onTick(matches.length, matches.length, 'matching');

  return report;
}

/**
 * The relink matcher: the tiered, per-file-verified path.
 *
 * Extracted so --auto can run it over the leftovers rather than reimplementing
 * it. --relink hands it every candidate row; --auto hands it only the rows no
 * prefix rule accounted for. Behaviour is identical either way.
 *
 * TWO PASSES, and the order is the whole point. Tier 2 is a guess from a byte
 * count alone; tier 1 is a name match. Resolving row by row let a tier-2 guess
 * CLAIM a file that a later row would have matched by name, so which record won
 * came down to row id: the lowest id got the file and the rightful owner was
 * reported unmatched. Settling every tier-1 match first makes strong matches
 * beat weak ones no matter what order the rows come in.
 *
 * @param {object} prog shared {processed, total} so a caller running several
 *   stages can present one progress scale. Mutated as rows are consumed.
 */
async function matchRows(candidateRows, ctx, report, claimed, pace, prog) {
  const { byKey, bySize, byPhash } = ctx;
  const free = (c) => !claimed.has(key(c.path));

  /**
   * Verify, plan, and group the rejected look-alikes.
   * @returns {boolean} false when the bytes disagreed (row already reported)
   */
  const adopt = (row, chosen, tier, losers) => {
    const verdict = spotCheck(row.filepath, chosen.path);
    if (verdict === 'mismatch') {
      report.mismatch.push({ row, newPath: chosen.path, reason: `matched by ${tier}, content differs` });
      return false;
    }

    const before = report.rewrite.length + report.absorb.length;
    classify(row, chosen.path, report, claimed,
      verdict === 'skipped' ? `${tier}, unverified` : tier);

    // Only group the losers if the winner actually got planned. A conflict or
    // a vanished destination means nothing was adopted.
    if (losers.length && report.rewrite.length + report.absorb.length > before) {
      const stubIds = [];
      for (const l of losers) {
        const occ = db.findByPathInsensitive(l.path);
        if (occ && occ.processing_error === db.UNSCANNED_MARKER) stubIds.push(occ.id);
      }
      if (stubIds.length) report.dupeLink.push({ rowId: row.id, stubIds });
    }
    return true;
  };

  const pending = [];

  // ── Pass 1: normalized name + media type + size ±1% ──
  for (const row of candidateRows) {
    prog.processed++;
    await pace(prog.processed, prog.total, 'matching');
    const nameKey = row.name_key || dupes.nameKey(row.filename);
    let pool = (byKey.get(`${row.media_type}|${nameKey}`) || []).filter(free);
    if (row.filesize_bytes) {
      pool = pool.filter(c => dupes.sizesMatch(c.size, row.filesize_bytes));
    }

    if (pool.length === 0) { pending.push(row); continue; }

    let chosen = pool[0];
    let losers = [];
    if (pool.length > 1) {
      // Byte-exact copies outrank merely-close ones (the same preference
      // findDupeCandidate encodes as ORDER BY ABS(size difference)); the
      // path-shape tiebreak then runs inside whichever set survives.
      let narrowed = pool;
      if (row.filesize_bytes) {
        const exact = pool.filter(c => c.size === row.filesize_bytes);
        if (exact.length > 0) narrowed = exact;
      }
      chosen = narrowed.length === 1 ? narrowed[0] : pickBest(row.filepath, narrowed);
      if (!chosen) {
        report.ambiguous.push({ row, candidates: pool.map(c => c.path) });
        continue;
      }
      losers = pool.filter(c => c !== chosen);
    }

    adopt(row, chosen, 'name+size', losers);
  }

  // ── Pass 2: the rename rescue, over whatever is still unclaimed ──
  prog.total += pending.length;
  await pace(prog.processed, prog.total, 'matching', true);
  for (const row of pending) {
    prog.processed++;
    await pace(prog.processed, prog.total, 'matching');
    let chosen = null;
    let tier = null;

    // Unique exact byte size, same media type, any name. Uniqueness is
    // required outright: two files of one size is not a rename, it is a
    // coin flip.
    if (row.filesize_bytes) {
      const sized = (bySize.get(`${row.media_type}|${row.filesize_bytes}`) || []).filter(free);
      if (sized.length === 1) { chosen = sized[0]; tier = 'exact size'; }
    }

    // Last resort: a phash already on record under the new root.
    if (!chosen && row.phash) {
      const hits = (byPhash.get(row.phash) || [])
        .filter(p => key(p) !== key(row.filepath) && !claimed.has(key(p)));
      if (hits.length === 1) { chosen = { path: hits[0], size: null }; tier = 'phash'; }
      else if (hits.length > 1) {
        report.ambiguous.push({ row, candidates: hits });
        continue;
      }
    }

    if (!chosen) { report.unmatched.push({ row }); continue; }
    adopt(row, chosen, tier, []);
  }
}

/**
 * Mode B: --relink <newRoot>.
 * @param {object} [opts]
 * @param {(line:string)=>void} [opts.onProgress] where the two summary lines
 *   go. The CLI hands it console.log; the HTTP route drops them.
 * @param {(processed:number,total:number,phase:string)=>void} [opts.onTick]
 *   fine-grained progress: 'walking' while the folder is indexed, 'matching'
 *   for the row loops. Called on the same beats the event loop is yielded.
 * @throws {Error} code 'EMIGRATEROOT' when newRoot is not a directory — the
 *   caller decides whether that is a usage message or a 400.
 */
async function planRelink(newRootRaw, { onProgress = () => {}, onTick = () => {} } = {}) {
  const newRoot = stripTrailing(normalize(newRootRaw));
  const report = emptyReport('relink');
  report.newRoot = newRoot;

  if (!scanner.isDirectory(newRoot)) {
    throw Object.assign(new Error(`not a directory: ${newRoot}`),
      { code: 'EMIGRATEROOT', root: newRoot });
  }

  const rootPrefix = key(newRoot) + SEP;
  const underRoot = (p) => key(p) === key(newRoot) || key(p).startsWith(rootPrefix);

  const rows = db.getMigrationRows();
  report.liveRows = rows.length;
  // Everything not already living under the new root is a candidate — see the
  // header for why "missing from disk" was the wrong gate. Scanned records go
  // first: a stub outside the root is also a candidate now, and if it competed
  // in id order it could claim a file away from the record that carries the
  // actual metadata (which would then read as "did not migrate").
  const isStub = (r) => r.processing_error === db.UNSCANNED_MARKER;
  const candidateRows = rows.filter(r => !underRoot(r.filepath))
    .sort((a, b) => isStub(a) - isStub(b));
  report.considered = candidateRows.length;

  if (candidateRows.length === 0) {
    onProgress(`  0 of ${rows.length} live records sit outside ${newRoot}`);
    return report;
  }

  const pace = makePacer(onTick);

  // One existsSync per candidate row, for the summary line. Cheap per call and
  // ruinous in bulk — 100k of them back to back is the event loop gone for
  // seconds, so it is paced like everything else.
  let goneCount = 0;
  for (let i = 0; i < candidateRows.length; i++) {
    if (!exists(candidateRows[i].filepath)) goneCount++;
    await pace(i + 1, candidateRows.length, 'walking');
  }
  onProgress(`  ${candidateRows.length} of ${rows.length} live records sit outside ${newRoot}` +
    ` (${goneCount} of them missing from disk)`);

  // Index every media file under newRoot two ways: by the key scan-time dupe
  // detection uses (tier 1) and by exact byte size (tier 2). One stat per file.
  onTick(0, 0, 'walking');
  const files = await pacedWalk(newRoot, pace);
  onProgress(`  ${files.length} media files under ${newRoot}`);
  const byKey = new Map();
  const bySize = new Map();
  const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
  let walked = 0;
  for (const f of files) {
    walked++;
    await pace(walked, files.length, 'walking');
    const st = scanner.getStats(f.path);
    if (!st) continue;
    const entry = { path: f.path, size: st.size };
    push(byKey, `${f.mediaType}|${dupes.nameKey(f.name)}`, entry);
    push(bySize, `${f.mediaType}|${st.size}`, entry);
  }

  // Last-resort index: phashes already recorded for present files under
  // newRoot. See the header — this finds duplicate records, not renamed files.
  const byPhash = new Map();
  for (const r of rows) {
    if (!r.phash || !underRoot(r.filepath) || !exists(r.filepath)) continue;
    push(byPhash, r.phash, r.filepath);
  }

  const claimed = new Set();
  const ctx = { byKey, bySize, byPhash };
  const prog = { processed: 0, total: candidateRows.length };
  onTick(0, prog.total, 'matching');
  await matchRows(candidateRows, ctx, report, claimed, pace, prog);
  onTick(prog.total, prog.total, 'matching');

  return report;
}

/* ── Mode C: --auto <newRoot> ──────────────────────────────────────────────
   One folder in, no prefixes typed. The observation it is built on: when a
   library moves, it usually moves as a BLOCK. Ten thousand records did not
   each take an independent journey; one folder was dragged somewhere and
   everything under it came along. Relink can find every one of those files,
   but it pays a spot check per file to do it, and on a big library that is
   the slow part.

   So --auto looks for the block first. It asks the cheap tier-1 index which
   records have exactly one plausible match, reads the implied
   "old head -> new head" rewrite off each one, and counts votes. A rewrite
   with real support is a MOVE, and a move can be applied to every record
   under it by string surgery plus one existsSync, no reading of file bytes at
   all.

   The trust for those rows comes from a SAMPLE: up to fifty of the rule's own
   voters get the full 64KB head-and-tail comparison, and a single mismatch
   throws the whole rule out. That is strictly stronger than prefix mode, which
   verifies nothing beyond "a file is there", and it costs fifty reads instead
   of fifty thousand.

   Whatever the rules do not explain (a rule that failed its sample, a mapped
   path with no file, a record that never voted) falls through to the full
   relink matcher, unchanged, with its per-file verification intact. */

/** A rewrite needs this many voting records before it counts as a real move. */
const MIN_RULE_SUPPORT = 10;
/** Ceiling on how many of a rule's rows get the full byte comparison. */
const MAX_RULE_SAMPLE = 50;

/**
 * Where does the common trailing part of `p` begin, counting back `nSegs`
 * path segments? Returns a character index, so the caller can slice the
 * ORIGINAL string. Working on indices rather than split/join is what keeps
 * drive letters and UNC roots (\\server\share) intact.
 */
function headLengthBefore(p, nSegs) {
  let i = p.length, seen = 0;
  while (i > 0 && seen < nSegs) {
    while (i > 0 && (p[i - 1] === '\\' || p[i - 1] === '/')) i--;
    while (i > 0 && p[i - 1] !== '\\' && p[i - 1] !== '/') i--;
    seen++;
  }
  return i;
}

/**
 * Read the prefix rewrite implied by one record moving to one file: strip the
 * longest common run of trailing path segments, and whatever heads remain are
 * the rule.
 *
 *   C:\Media\Shows\ep1.mp4  ->  D:\Media\Shows\ep1.mp4
 *   shares "Media\Shows\ep1.mp4", so the rule is  C: -> D:
 *
 * @returns {{oldPrefix,newPrefix}|null} null when the paths share nothing, or
 *   when stripping the common tail leaves no head to rewrite.
 */
function deriveRule(oldPath, newPath) {
  const A = oldPath.split(/[\\/]+/).filter(Boolean);
  const B = newPath.split(/[\\/]+/).filter(Boolean);
  let n = 0;
  while (n < A.length && n < B.length &&
         key(A[A.length - 1 - n]) === key(B[B.length - 1 - n])) n++;
  if (n === 0) return null;                       // nothing in common at all

  const oldPrefix = stripTrailing(oldPath.slice(0, headLengthBefore(oldPath, n)));
  const newPrefix = stripTrailing(newPath.slice(0, headLengthBefore(newPath, n)));
  if (!oldPrefix && !newPrefix) return null;      // identical paths
  if (key(oldPrefix) === key(newPrefix)) return null;   // not a move
  return { oldPrefix, newPrefix };
}

/** Does `p` sit under `prefix`, at a path boundary? */
function underPrefix(p, prefix) {
  const pk = key(p), qk = key(prefix);
  if (!pk.startsWith(qk)) return false;
  const rest = p.slice(prefix.length);
  return rest === '' || /^[\\/]/.test(rest);
}

/**
 * Mode C: --auto <newRoot>. See the block comment above.
 * @throws {Error} code 'EMIGRATEROOT' when newRoot is not a directory
 */
async function planAuto(newRootRaw, { onProgress = () => {}, onTick = () => {} } = {}) {
  const newRoot = stripTrailing(normalize(newRootRaw));
  const report = emptyReport('auto');
  report.newRoot = newRoot;

  if (!scanner.isDirectory(newRoot)) {
    throw Object.assign(new Error(`not a directory: ${newRoot}`),
      { code: 'EMIGRATEROOT', root: newRoot });
  }

  const rootPrefix = key(newRoot) + SEP;
  const underRoot = (p) => key(p) === key(newRoot) || key(p).startsWith(rootPrefix);

  const rows = db.getMigrationRows();
  report.liveRows = rows.length;
  // Same candidate rule and same stub-last ordering as relink: a stub must
  // never claim a file away from the record carrying the metadata.
  const isStub = (r) => r.processing_error === db.UNSCANNED_MARKER;
  const candidateRows = rows.filter(r => !underRoot(r.filepath))
    .sort((a, b) => isStub(a) - isStub(b));
  report.considered = candidateRows.length;

  if (candidateRows.length === 0) {
    onProgress(`  0 of ${rows.length} live records sit outside ${newRoot}`);
    return report;
  }
  onProgress(`  ${candidateRows.length} of ${rows.length} live records sit outside ${newRoot}`);

  const pace = makePacer(onTick);

  // ── Walk + index, exactly as relink does ──
  onTick(0, 0, 'walking');
  const files = await pacedWalk(newRoot, pace);
  onProgress(`  ${files.length} media files under ${newRoot}`);
  const byKey = new Map();
  const bySize = new Map();
  const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
  let walked = 0;
  for (const f of files) {
    walked++;
    await pace(walked, files.length, 'walking');
    const st = scanner.getStats(f.path);
    if (!st) continue;
    const entry = { path: f.path, size: st.size };
    push(byKey, `${f.mediaType}|${dupes.nameKey(f.name)}`, entry);
    push(bySize, `${f.mediaType}|${st.size}`, entry);
  }
  const byPhash = new Map();
  for (const r of rows) {
    if (!r.phash || !underRoot(r.filepath) || !exists(r.filepath)) continue;
    push(byPhash, r.phash, r.filepath);
  }

  // ── R1: infer candidate rules. Index lookups only, no file I/O. ──
  const prog = { processed: 0, total: candidateRows.length };
  onTick(0, prog.total, 'matching');
  const tally = new Map();
  for (const row of candidateRows) {
    prog.processed++;
    await pace(prog.processed, prog.total, 'matching');
    const nameKey = row.name_key || dupes.nameKey(row.filename);
    let pool = byKey.get(`${row.media_type}|${nameKey}`) || [];
    if (row.filesize_bytes) {
      pool = pool.filter(c => dupes.sizesMatch(c.size, row.filesize_bytes));
    }
    // Only an unambiguous match gets a vote. An ambiguous one has no single
    // implied rewrite to read off, and guessing here would poison the tally.
    if (pool.length !== 1) continue;
    const rule = deriveRule(row.filepath, pool[0].path);
    if (!rule) continue;
    const k = `${key(rule.oldPrefix)}\u0000${key(rule.newPrefix)}`;
    if (!tally.has(k)) tally.set(k, { ...rule, voters: [] });
    tally.get(k).voters.push({ row, matched: pool[0].path });
  }

  // ── Verify each well-supported rule against a sample of its own voters ──
  // Longest oldPrefix first, so the most specific rule claims a row before a
  // broader one does.
  const supported = [...tally.values()]
    .filter(r => r.voters.length >= MIN_RULE_SUPPORT)
    .sort((a, b) => b.oldPrefix.length - a.oldPrefix.length);

  const accepted = [];
  for (const rule of supported) {
    const step = Math.max(1, Math.floor(rule.voters.length / MAX_RULE_SAMPLE));
    let sampled = 0, verified = 0, poisoned = null;
    for (let i = 0; i < rule.voters.length && sampled < MAX_RULE_SAMPLE; i += step) {
      const v = rule.voters[i];
      sampled++;
      await pace(prog.processed, prog.total, 'matching');
      const verdict = spotCheck(v.row.filepath, v.matched);
      // 'skipped' means the old file is gone, so there is nothing to compare
      // against. That is the disconnected-drive case, and it is exactly the
      // trust level prefix mode has always run on: not evidence for the rule,
      // but not evidence against it either.
      if (verdict === 'mismatch') { poisoned = v; break; }
      if (verdict === 'ok') verified++;
    }
    if (poisoned) {
      onProgress(`  rule ${rule.oldPrefix} -> ${rule.newPrefix} rejected: ` +
        `${path.basename(poisoned.row.filepath)} does not match its destination`);
      continue;                       // its rows fall through to the matcher
    }
    accepted.push({ ...rule, sampled, verified });
  }

  // ── R2: apply accepted rules by string surgery + one existsSync ──
  const claimed = new Set();
  const leftovers = [];
  prog.total += candidateRows.length;
  await pace(prog.processed, prog.total, 'matching', true);

  const applied = new Map(accepted.map(r => [r, 0]));
  for (const row of candidateRows) {
    prog.processed++;
    await pace(prog.processed, prog.total, 'matching');

    const rule = accepted.find(r => underPrefix(row.filepath, r.oldPrefix));
    if (!rule) { leftovers.push(row); continue; }

    const mapped = rule.newPrefix + row.filepath.slice(rule.oldPrefix.length);
    if (!exists(mapped)) { leftovers.push(row); continue; }

    // A conflict here is REPORTED, not retried: the destination is genuinely
    // occupied by another record, and the matcher would only reach the same
    // conclusion more slowly.
    const before = report.rewrite.length + report.absorb.length;
    classify(row, mapped, report, claimed, `rule ${rule.oldPrefix} -> ${rule.newPrefix}`);
    if (report.rewrite.length + report.absorb.length > before) {
      applied.set(rule, applied.get(rule) + 1);
    }
  }

  report.rules = accepted.map(r => ({
    oldPrefix: r.oldPrefix, newPrefix: r.newPrefix,
    rows: applied.get(r) || 0, support: r.voters.length,
    sampled: r.sampled, verified: r.verified,
  })).filter(r => r.rows > 0);

  for (const r of report.rules) {
    onProgress(`  rule ${r.oldPrefix} -> ${r.newPrefix}: ${r.rows} record(s), ` +
      `${r.verified}/${r.sampled} sampled files byte-verified`);
  }

  // ── R3: everything the rules did not explain gets the full treatment ──
  prog.total += leftovers.length;
  await pace(prog.processed, prog.total, 'matching', true);
  await matchRows(leftovers, { byKey, bySize, byPhash }, report, claimed, pace, prog);
  onTick(prog.total, prog.total, 'matching');

  return report;
}

// ── Apply + report ─────────────────────────────────────────────────────────

/**
 * Write the plan. One outer transaction over the whole run: per-row commits
 * would mean a hundred thousand fsyncs on a big library, and a crash halfway
 * through would leave the library split across two drives with no record of
 * where the boundary fell. All or nothing is both faster and easier to reason
 * about. repointPath's own transaction nests as a savepoint inside this one.
 */
function apply(report, { onProgress = () => {}, onTick = () => {} } = {}) {
  const total = report.rewrite.length + report.absorb.length;
  const links = report.dupeLink || [];
  if (total === 0 && links.length === 0) return 0;

  // The write is one transaction and therefore one synchronous block — there
  // is nowhere to yield inside it, and it is fast next to planning (no file
  // I/O at all). So 'writing' is announced, not sampled.
  onTick(0, total, 'writing');

  let n = 0;
  const step = (it, absorbId) => {
    db.repointPath(it.row.id, it.newPath, absorbId);
    if (++n % 5000 === 0) onProgress(`  …${n}/${total} repointed`);
  };

  db.get().transaction(() => {
    for (const it of report.rewrite) step(it, null);
    for (const it of report.absorb) step(it, it.absorbId);
    // After the repoints, never before: a stub listed here may also have been
    // the absorb target of another row. Its path — and the look-alike
    // relationship — now belongs to the row that absorbed it, so remap the id
    // instead of letting linkDupeGroup drop the pairing with the dead stub.
    const absorbedBy = new Map(report.absorb.map(it => [it.absorbId, it.row.id]));
    for (const link of links) {
      const ids = [...new Set([link.rowId,
        ...link.stubIds.map(id => absorbedBy.get(id) ?? id)])];
      db.linkDupeGroup(ids);
    }
  })();

  onTick(total, total, 'writing');
  return total;
}

// ── Duration formatting (shared by the CLI line and, in spirit, the panel) ──

/** "1m 12s" / "3h 04m" / "8s" — never "0.13 hours". */
function humanDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  // "~0s left" reads as a bug rather than as "nearly done".
  if (s < 1) return '<1s';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * The CLI's live progress line.
 *
 * Overwrites in place on a TTY (\r, no newline) and falls back to one line
 * every few seconds when the output is piped or redirected — a log file full
 * of carriage returns is worse than no progress at all.
 */
function makeCliProgress() {
  const startedAt = Date.now();
  const tty = !!process.stdout.isTTY;
  let lastPrint = 0;
  let baseline = null;      // { phase, total, processed, at }
  let wrote = false;

  const PHASES = { walking: 'indexing folder', matching: 'matching', writing: 'writing' };

  return {
    tick(processed, total, phase) {
      // ETA is projected from the current phase only — 'walking' and
      // 'matching' move at completely different rates.
      if (!baseline || baseline.phase !== phase || baseline.total !== total) {
        baseline = { phase, total, processed, at: Date.now() };
      }
      const now = Date.now();
      if (now - lastPrint < (tty ? 200 : 3000)) return;
      lastPrint = now;

      const elapsed = now - startedAt;
      let eta = null;
      const dp = processed - baseline.processed;
      const dt = now - baseline.at;
      if (total > 0 && dp > 0 && dt > 1500) {
        eta = Math.round((total - processed) * dt / dp);
      }

      const label = PHASES[phase] || phase;
      // The folder walk cannot know its own size until it finishes, so it
      // reports a running count rather than a fraction it would have to invent.
      const of = total > 0 ? ` ${processed.toLocaleString()}/${total.toLocaleString()}`
        : (processed > 0 ? ` ${processed.toLocaleString()} found` : '');
      const line = `  ${label}${of} · ${humanDuration(elapsed)} elapsed` +
        (eta != null ? ` · ~${humanDuration(eta)} left` : '');

      if (tty) {
        process.stdout.write('\r' + line.padEnd(78).slice(0, 78));
        wrote = true;
      } else {
        console.log(line);
      }
    },
    done() {
      if (tty && wrote) process.stdout.write('\r' + ' '.repeat(78) + '\r');
    },
  };
}

/**
 * A JSON-safe view of a plan, for the viewer's Library panel.
 *
 * The raw report holds whole media rows — megabytes of AI metadata that the
 * panel has no use for. This keeps the counts (always complete) and at most
 * `limit` example paths per bucket, with `more` saying how many were cut, so
 * "1 of 4,312 conflicts" never reads as "1 conflict".
 */
/** How many "did not migrate" ids the viewer is handed to filter on. */
const NOT_MIGRATED_ID_CAP = 5000;

function summarize(report, limit = 25) {
  const cut = (items, fmt) => ({
    total: items.length,
    shown: items.slice(0, limit).map(fmt),
    more: Math.max(0, items.length - limit),
  });

  // Ids of every record the plan leaves behind, so the viewer can pull exactly
  // that set up afterwards instead of making the user copy paths by hand.
  // Capped — handing a browser 100k ids to hold in a filter helps nobody.
  // Mismatch and ambiguous go first: those are the ones needing a human
  // decision, so they must survive the cap ahead of plain no-matches.
  const leftovers = [...report.mismatch, ...report.ambiguous, ...report.unmatched];
  const notMigrated = {
    total: leftovers.length,
    ids: leftovers.slice(0, NOT_MIGRATED_ID_CAP).map(it => it.row.id),
    capped: leftovers.length > NOT_MIGRATED_ID_CAP,
  };

  return {
    notMigrated,
    // Auto mode only: the moves it worked out for itself, each with how many
    // records it covered and how much of it was byte-checked.
    rules: (report.rules || []).map(r => ({
      oldPrefix: r.oldPrefix, newPrefix: r.newPrefix,
      rows: r.rows, sampled: r.sampled, verified: r.verified,
    })),
    mode: report.mode,
    oldPrefix: report.oldPrefix,
    newPrefix: report.newPrefix,
    newRoot: report.newRoot,
    liveRows: report.liveRows,
    considered: report.considered,
    unchanged: report.unchanged,
    counts: {
      rewrite: report.rewrite.length,
      absorb: report.absorb.length,
      missing: report.missing.length,
      conflict: report.conflict.length,
      ambiguous: report.ambiguous.length,
      unmatched: report.unmatched.length,
      mismatch: report.mismatch.length,
      dupesLinked: report.dupeLink.reduce((n, l) => n + l.stubIds.length, 0),
    },
    rewrite: cut(report.rewrite, it => ({ from: it.row.filepath, to: it.newPath })),
    absorb: cut(report.absorb, it => ({ from: it.row.filepath, to: it.newPath, stubId: it.absorbId })),
    missing: cut(report.missing, it => ({ from: it.row.filepath, to: it.newPath })),
    conflict: cut(report.conflict, it => ({
      from: it.row.filepath, to: it.newPath,
      occupantId: it.occupant ? it.occupant.id : null, reason: it.reason,
    })),
    ambiguous: cut(report.ambiguous, it => ({
      from: it.row.filepath, candidates: it.candidates.slice(0, 5), candidateCount: it.candidates.length,
    })),
    unmatched: cut(report.unmatched, it => ({ from: it.row.filepath })),
    mismatch: cut(report.mismatch, it => ({ from: it.row.filepath, to: it.newPath, reason: it.reason })),
  };
}

function printReport(report, { dryRun, limit }) {
  const head = report.mode === 'prefix'
    ? `Prefix rewrite\n  old: ${report.oldPrefix}\n  new: ${report.newPrefix}`
    : `${report.mode === 'auto' ? 'Auto' : 'Relink'}\n  root: ${report.newRoot}`;
  console.log(`\n${head}${dryRun ? '\n  (DRY RUN, nothing written)' : ''}\n`);

  if (report.rules && report.rules.length) {
    console.log('  moves detected:');
    for (const r of report.rules) {
      console.log(`    ${r.oldPrefix} -> ${r.newPrefix}`);
      console.log(`      ${r.rows.toLocaleString()} record(s), ${r.verified}/${r.sampled} sampled files byte-verified`);
    }
    console.log('');
  }

  const n = (v) => String(v).padStart(7);
  console.log(`  live records         ${n(report.liveRows)}`);
  console.log(`  considered           ${n(report.considered)}`);
  console.log(`  repointed            ${n(report.rewrite.length)}`);
  console.log(`  stubs absorbed       ${n(report.absorb.length)}`);
  if (report.mode === 'prefix') {
    console.log(`  missing at dest      ${n(report.missing.length)}`);
  } else if (report.mode === 'auto' || report.mode === 'relink') {
    console.log(`  no match             ${n(report.unmatched.length)}`);
    console.log(`  ambiguous            ${n(report.ambiguous.length)}`);
    console.log(`  content mismatch     ${n(report.mismatch.length)}`);
    const linked = report.dupeLink.reduce((t, l) => t + l.stubIds.length, 0);
    if (linked) console.log(`  look-alikes grouped  ${n(linked)}`);
    if (report.missing.length) console.log(`  vanished mid-run     ${n(report.missing.length)}`);
  }
  console.log(`  conflicts            ${n(report.conflict.length)}`);
  if (report.unchanged) console.log(`  already correct      ${n(report.unchanged)}`);

  const list = (label, items, fmt) => {
    if (!items.length) return;
    console.log(`\n  ${label}:`);
    for (const it of items.slice(0, limit)) console.log(`    ${fmt(it)}`);
    if (items.length > limit) console.log(`    … and ${items.length - limit} more`);
  };

  list('missing at destination', report.missing, it => `${it.row.filepath}  ->  ${it.newPath}`);
  list('conflicts (left untouched)', report.conflict, it =>
    `${it.row.filepath}\n      wanted ${it.newPath}\n      held by #${it.occupant ? it.occupant.id : '?'}, ${it.reason}`);
  list('ambiguous', report.ambiguous, it =>
    `${it.row.filepath}\n      ${it.candidates.length} candidates: ${it.candidates.slice(0, 3).join(', ')}`);
  list('content mismatch (matched, but the bytes differ)', report.mismatch, it =>
    `${it.row.filepath}\n      vs ${it.newPath}\n      ${it.reason}`);
  list('no match found', report.unmatched, it => it.row.filepath);

  console.log('');
}

// ── Entry point ────────────────────────────────────────────────────────────

async function run(args) {
  if (!args || args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(args && args.length ? 0 : 1);
  }

  const dryRun = args.includes('--dry-run');
  const limIdx = args.indexOf('--limit');
  const limit = limIdx >= 0 && args[limIdx + 1] ? Math.max(1, parseInt(args[limIdx + 1], 10) || 10) : 10;

  // Positionals: everything that isn't a flag or a flag's value.
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit') { i++; continue; }
    if (a.startsWith('--')) continue;
    positional.push(a);
  }

  const autoIdx = args.indexOf('--auto');
  const relinkIdx = args.indexOf('--relink');
  const rootIdx = autoIdx >= 0 ? autoIdx : relinkIdx;

  if (rootIdx >= 0) {
    const flag = autoIdx >= 0 ? '--auto' : '--relink';
    // The root may be given after the flag or anywhere else.
    const explicit = args[rootIdx + 1] && !args[rootIdx + 1].startsWith('--')
      ? args[rootIdx + 1] : positional[0];
    if (!explicit) {
      console.error(`migrate ${flag} needs a root directory\n`);
      usage();
      process.exit(1);
    }
    db.init();
    const verb = autoIdx >= 0 ? 'Searching' : 'Relinking against';
    console.log(`\n${verb} ${normalize(explicit)}…`);
    const progress = makeCliProgress();
    const plan = autoIdx >= 0 ? planAuto : planRelink;
    let report;
    try {
      report = await plan(explicit, {
        onProgress: (line) => { progress.done(); console.log(line); },
        onTick: progress.tick,
      });
    } catch (err) {
      progress.done();
      // A bad root is a usage mistake, not a crash, and the wording predates
      // the planner being shared with the HTTP route.
      if (err.code !== 'EMIGRATEROOT') throw err;
      console.error(`migrate ${flag}: ${err.message}\n`);
      usage();
      process.exit(1);
    }
    if (!dryRun) {
      apply(report, {
        onProgress: (line) => { progress.done(); console.log(line); },
        onTick: progress.tick,
      });
    }
    progress.done();
    printReport(report, { dryRun, limit });
    return;
  }

  if (positional.length < 2) {
    console.error('migrate needs <oldPrefix> <newPrefix> (or --relink <newRoot>)\n');
    usage();
    process.exit(1);
  }

  db.init();
  const progress = makeCliProgress();
  const report = await planPrefix(positional[0], positional[1], { onTick: progress.tick });
  if (!dryRun) {
    apply(report, {
      onProgress: (line) => { progress.done(); console.log(line); },
      onTick: progress.tick,
    });
  }
  progress.done();
  printReport(report, { dryRun, limit });
}

module.exports = {
  run, planPrefix, planRelink, planAuto, apply, summarize,
  normalize, stripTrailing, humanDuration, deriveRule,
};
