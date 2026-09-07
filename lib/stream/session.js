/**
 * HLS remux producer — one FFmpeg child per media id.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COMMAND, AND WHY IT LOOKS LIKE THIS
 *
 *   ffmpeg -v error -nostdin -y
 *     [-fflags +genpts]                  # AVI only, see (3)
 *     -readrate 1.5 -readrate_initial_burst 60   # see (7)
 *     [-ss <tStart>]                     # media-relative, only when starting mid-file
 *     -i <file>
 *     -map 0:v:0 [-map 0:a:0?]           # or  -vn -map 0:a:0  for audio-only
 *     -c:v copy
 *     -c:a copy | -c:a aac -b:a 160k -ac 2
 *     -copyts [-avoid_negative_ts disabled]
 *     -muxdelay 0 -muxpreload 0
 *     -f segment -segment_format mpegts
 *     -segment_times <relative boundary list>
 *     -segment_start_number <n or n-1>
 *     -segment_list pipe:1 -segment_list_type flat -segment_list_flags +live
 *     -reset_timestamps 0
 *     <tempdir>/%d.ts
 *
 * Every questionable flag below was settled by running it against the scratch
 * clips (mp4 / mkv / avi / mpegts / audio-only), not from the documentation.
 *
 * (1) -segment_times is RELATIVE, not absolute. Measured: an MP4 seeked with
 *     `-ss 12` and given `-segment_times 15.999` produced its next boundary at
 *     28 s, i.e. 12 + 15.999. The segment muxer compares against the FIRST
 *     OUTPUT TIMESTAMP, so every boundary we pass has to be
 *     `wanted - actualStart`. The spec's "absolute times when -copyts keeps
 *     them absolute" does not hold on this build (FFmpeg N-123074).
 *
 * (2) -ss does not land where you ask. Also measured: on Matroska, `-ss 12`
 *     lands at 10 and `-ss 14` lands at 12 (cluster granularity); on AVI with
 *     +genpts, `-ss 12` lands at 10.042. Since (1) makes every boundary
 *     relative to wherever it landed, guessing is not an option — so each
 *     mid-file start runs a PREFLIGHT first:
 *
 *       ffmpeg -ss <t> -i <file> -map 0:v:0 -c copy -copyts -frames:v 1 \
 *              -f framemd5 -
 *
 *     which reports the first packet's pts/dts in the stream time base. That is
 *     `actualStart`. It costs one short extra process (tens of milliseconds)
 *     and makes the boundaries exact instead of hopeful.
 *
 *     When actualStart is EARLIER than the segment we were asked for, the extra
 *     leading content is not silently glued onto segment n (that would make the
 *     fragment start before the playlist says it does, and hls.js would offset
 *     the whole timeline by the difference). Instead we ask FFmpeg for one
 *     extra split at the wanted boundary and number the run from n-1: the
 *     junk prefix lands in file (n-1).ts, which is thrown away, and file n
 *     starts exactly where the playlist says.
 *
 * (3) -copyts + AVI needs +genpts. AVI carries no PTS at all; with -copyts the
 *     mpegts muxer refuses every packet ("first pts and dts value must be
 *     set"). `-fflags +genpts` synthesizes them and the copy succeeds.
 *
 * (4) -avoid_negative_ts disabled keeps the source timestamps EXACTLY, which is
 *     what makes a restart at segment n produce bytes that line up with a run
 *     that started at 0. Without it the mpegts muxer shifts the whole output so
 *     the first DTS is non-negative, and the shift differs between a cold start
 *     at 0 and a cold start at n. It is left off for +genpts inputs, where the
 *     synthesized timestamps need the muxer's own normalization.
 *
 *     One residue: when a source's first DTS is negative (an MP4 with B-frames
 *     starts at dts -0.083), the mpegts muxer still clamps it, so segment 0
 *     starts ~2 frames later than the playlist says. It affects segment 0 only
 *     and hls.js absorbs it, because...
 *
 * (5) ...the two timelines are never reconciled by us. The playlist is
 *     MEDIA-RELATIVE (container_start subtracted, so it starts at 0 and matches
 *     video.currentTime) while the segments keep their ORIGINAL absolute
 *     timestamps (a TS capture really does start at 1401.4). hls.js derives the
 *     constant offset between the two from the first fragment it parses and
 *     applies it to every later fragment, which is exactly why every session
 *     must emit the same absolute timestamps — see (4).
 *
 * (6) -segment_list pipe:1 -segment_list_type flat -segment_list_flags +live
 *     works: one line per CLOSED segment, flushed immediately because of
 *     +live. Without +live the list is cached and arrives in a lump at the end.
 *     Process exit is still handled as a second signal, so a build where the
 *     pipe misbehaves degrades to "everything appears when ffmpeg finishes"
 *     rather than hanging.
 *
 * (7) -readrate 1.5 -readrate_initial_burst 60 (both accepted by this build,
 *     N-123074) keeps the producer near playback pace instead of racing to the
 *     end of the file. Nothing is kept once a segment has been played, so
 *     running ahead only costs disk bandwidth someone else wants and RAM the
 *     ring would immediately throw away. The burst converts the first 60 s of
 *     media at full speed so the player starts instantly and has a cushion;
 *     after that the input is read at 1.5x realtime. Both are INPUT options and
 *     must sit before -i. If a build ever rejects -readrate_initial_burst,
 *     drop that flag alone and lower ring.BEHIND: -readrate 1.5 by itself
 *     still works, it just makes the first seconds tighter.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../../config');
const ffmpegLocate = require('../ffmpeg-locate');
const ring = require('./ring');

/** At most this many FFmpeg children at once, across the whole app. */
const MAX_SESSIONS = 2;

/**
 * A running session is left alone when the request is at most this far ahead of
 * what it has already delivered. With the read throttle a segment takes about
 * 2.7 s of wall clock to make, so three of them fit inside WAIT_MS with room to
 * spare; anything further ahead is a seek and is served by restarting FFmpeg
 * there, which is much faster than letting the producer grind up to it.
 */
const LOOKAHEAD = 3;

/** How long a segment request waits for the producer before giving up. */
const WAIT_MS = 15000;

/** Read the input at this multiple of realtime once the burst is spent. */
const READRATE = '1.5';

/** Seconds of media converted at full speed before the throttle applies. */
const READRATE_BURST = '60';

/** A session with no segment request for this long ends itself. */
const IDLE_MS = 60000;

/** How often the idle sweeper looks. */
const IDLE_TICK_MS = 10000;

/** Ties: boundaries are keyframe times, so nudge under them by a millisecond. */
const TIE = 0.001;

const NOPTS = '-9223372036854775808';

/** mediaId -> Session */
const sessions = new Map();

/** Counts every FFmpeg child this process has started (verification hook). */
let spawnCount = 0;

const ffmpeg = () => ffmpegLocate.resolve('ffmpeg');

/** AVI has no PTS; -copyts needs them synthesized (see note 3). */
function needsGenPts(container) {
  return /(^|,)avi(,|$)/.test(String(container || '').toLowerCase());
}

/**
 * Where does `-ss t` actually land? Absolute source timestamp in seconds, or
 * null when FFmpeg could not tell us (caller then starts from the top).
 */
function preflightStart(filepath, t, genpts) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-nostdin'];
    if (genpts) args.push('-fflags', '+genpts');
    args.push('-ss', String(t), '-i', filepath,
      '-map', '0:v:0', '-c', 'copy', '-copyts', '-frames:v', '1', '-f', 'framemd5', '-');

    const child = spawn(ffmpeg(), args, { windowsHide: true });
    spawnCount++;
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.resume();
    const watchdog = setTimeout(() => { try { child.kill(); } catch {} }, 20000);
    child.on('error', () => { clearTimeout(watchdog); resolve(null); });
    child.on('close', () => {
      clearTimeout(watchdog);
      resolve(parseFrameMd5(out));
    });
  });
}

/** First frame's timestamp out of framemd5 output, in seconds. */
function parseFrameMd5(text) {
  let tb = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = line.match(/^#tb\s+0:\s*(\d+)\s*\/\s*(\d+)/);
      if (m) tb = Number(m[1]) / Number(m[2]);
      continue;
    }
    const f = line.split(',').map(s => s.trim());
    if (f.length < 3 || tb === null) continue;
    const pick = f[2] !== NOPTS ? f[2] : f[1];
    const v = Number(pick);
    if (!Number.isFinite(v) || pick === NOPTS) return null;
    return v * tb;
  }
  return null;
}

/**
 * One producer. Owns an FFmpeg child, a temp directory, and the mapping from
 * "file appeared" to "segment stored".
 */
class Session {
  constructor(mediaId, row, idx, plan) {
    this.mediaId = mediaId;
    this.row = row;
    this.idx = idx;
    this.plan = plan;                    // { audioPlan, audioOnly }
    this.from = 0;                       // first segment this run produces
    this.head = -1;                      // highest segment this run has delivered
    this.child = null;
    this.dir = null;
    this.dead = false;
    this.error = null;
    this.lastRequest = Date.now();
    this.dropFirst = null;               // junk-prefix file number to discard
    this.stdoutBuf = '';
  }

  /** Spawn the child, producing segments n..end. */
  async start(n) {
    const idx = this.idx;
    const segs = idx.segments;
    const genpts = needsGenPts(this.row.container);
    const tWanted = segs[n];             // media-relative
    const base = idx.containerStart;

    // Where will FFmpeg actually begin? Segment 0 needs no seek at all.
    let actualRel = 0;
    if (n > 0) {
      const abs = await preflightStart(this.row.filepath, tWanted, genpts);
      if (this.dead) return;
      actualRel = abs === null ? tWanted : abs - base;
    }

    // Boundaries are relative to where the output really starts (note 1).
    const rel = (t) => Math.max(0.001, t - actualRel - TIE);
    const times = [];
    let firstNumber = n;
    // Landed early? Split at the wanted boundary too and throw that file away.
    if (n > 0 && tWanted - actualRel > 0.002) {
      times.push(rel(tWanted));
      firstNumber = n - 1;
      this.dropFirst = n - 1;
    }
    for (let k = n + 1; k < segs.length; k++) times.push(rel(segs[k]));

    this.from = n;
    this.head = n - 1;
    this.dir = fs.mkdtempSync(path.join(config.paths.tempDir, `stream-${this.mediaId}-`));

    const args = ['-v', 'error', '-nostdin', '-y'];
    if (genpts) args.push('-fflags', '+genpts');
    // Input options, so they go before -ss and -i (note 7).
    args.push('-readrate', READRATE, '-readrate_initial_burst', READRATE_BURST);
    if (n > 0) args.push('-ss', String(tWanted));
    args.push('-i', this.row.filepath);

    if (this.plan.audioOnly) {
      args.push('-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '160k', '-ac', '2');
    } else {
      args.push('-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy');
      if (this.plan.audioPlan === 'copy') args.push('-c:a', 'copy');
      else args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
    }

    args.push('-copyts');
    if (!genpts) args.push('-avoid_negative_ts', 'disabled');
    args.push(
      '-muxdelay', '0', '-muxpreload', '0',
      '-f', 'segment', '-segment_format', 'mpegts',
      '-segment_start_number', String(firstNumber),
      '-segment_list', 'pipe:1', '-segment_list_type', 'flat', '-segment_list_flags', '+live',
      '-reset_timestamps', '0',
    );
    if (times.length) args.push('-segment_times', times.map(t => t.toFixed(3)).join(','));
    args.push(path.join(this.dir, '%d.ts'));

    this.args = args;
    const child = spawn(ffmpeg(), args, { windowsHide: true });
    spawnCount++;
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this._onListData(d));
    let errTail = '';
    child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-500); });

    child.on('error', (err) => {
      this.error = err.message;
      this._finish();
    });
    child.on('close', (code) => {
      // Everything still on disk is complete once the muxer is gone; on a
      // failure the highest-numbered file may be a torn write, so drop it.
      this._ingestLeftovers(code === 0);
      if (code !== 0 && !this.error) this.error = errTail.split('\n')[0] || `ffmpeg exit ${code}`;
      this._finish();
    });
  }

  _onListData(chunk) {
    this.stdoutBuf += chunk;
    const lines = this.stdoutBuf.split(/\r?\n/);
    this.stdoutBuf = lines.pop();
    for (const line of lines) {
      const m = line.trim().match(/(\d+)\.ts$/);
      if (m) this._ingest(Number(m[1]));
    }
  }

  /** Move one finished temp segment into the in-memory ring. */
  _ingest(n) {
    // A stopped session ingests nothing more. stop() sets `dead` before it kills
    // the child, and the child's own 'close' handler (registered first, so it
    // runs first) would otherwise sweep the temp dir into the ring on the way
    // out, handing a locked or deleted file's plaintext back to a reader.
    if (this.dead || !this.dir) return;
    const file = path.join(this.dir, `${n}.ts`);
    if (n === this.dropFirst) {                       // the seek-overshoot prefix
      try { fs.rmSync(file, { force: true }); } catch {}
      return;
    }
    if (n >= this.idx.segments.length) {
      try { fs.rmSync(file, { force: true }); } catch {}
      return;
    }
    let buf;
    try { buf = fs.readFileSync(file); } catch { return; }
    // The temp file goes as soon as it has been read: the only bytes this
    // feature ever leaves on disk are the segment FFmpeg is still writing.
    try { fs.rmSync(file, { force: true }); } catch {}
    if (!buf.length) return;
    try {
      ring.put(this.mediaId, n, buf);
      if (n > this.head) this.head = n;
    } catch (err) {
      this.error = err.message;
    }
  }

  _ingestLeftovers(clean) {
    if (!this.dir) return;
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    const nums = names
      .map(nm => (nm.match(/^(\d+)\.ts$/) || [])[1])
      .filter(Boolean).map(Number).sort((a, b) => a - b);
    const keep = clean ? nums : nums.slice(0, -1);
    for (const n of keep) this._ingest(n);
  }

  /** Remove the temp directory, once, whenever the child is really gone. */
  _cleanupDir() {
    if (!this.dir) return;
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch {}
    this.dir = null;
  }

  _finish() {
    this.dead = true;
    this.child = null;
    this._cleanupDir();
    if (sessions.get(this.mediaId) === this) sessions.delete(this.mediaId);
    // The ring is deliberately NOT dropped here. A short file finishes remuxing
    // long before the player has watched it; the buffers stay until the session
    // really ends (idle timeout, close beacon, lock, delete).
  }

  /** Kill the child and clean up. Resolves once the process is really gone. */
  stop() {
    this.dead = true;
    const child = this.child;
    if (sessions.get(this.mediaId) === this) sessions.delete(this.mediaId);
    if (!child) { this._finish(); return Promise.resolve(); }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(hard);
        this._finish();
        resolve();
      };
      child.once('close', done);
      child.once('error', done);
      // Windows has no signals: kill() maps to TerminateProcess, which the
      // child cannot ignore. The second attempt is for the case where the
      // handle was already gone and 'close' never arrives.
      try { child.kill(); } catch {}
      const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
    });
  }
}

/* ── Serialisation ─────────────────────────────────────────────────── */

/**
 * ensure() reads and writes shared state (the session map, the global cap) with
 * awaits in the middle of it, so two requests arriving together used to be able
 * to interleave: both find the live session out of range, both stop it, and the
 * second overwrites the first in the map — orphaning a child that is no longer
 * protected from eviction and no longer reachable to stop. The same interleave
 * lets the `sessions.size >= MAX_SESSIONS` loop pass twice and put three
 * producers on the box.
 *
 * One global chain, not one per media id: the cap is global, so the cap check
 * has to be inside the same critical section as the insert. Everything inside
 * is short (a preflight and a spawn, measured at well under a second) and no
 * segment is ever produced while holding it.
 */
let chain = Promise.resolve();

function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

/* ── Public API ───────────────────────────────────────────────────────────── */

/**
 * Make sure a producer exists that will deliver segment n reasonably soon.
 * Restarts (or starts) one when the running session is behind or too far ahead.
 */
async function ensure(mediaId, row, idx, plan, n) {
  return serialize(async () => {
    const live = sessions.get(mediaId);
    if (live && !live.dead) {
      live.lastRequest = Date.now();
      // Only "just ahead of the producer" is worth waiting for. A segment at or
      // below its head was made and then dropped by the ring, and one far ahead
      // is a seek: both are restarts.
      if (n > live.head && n <= live.head + LOOKAHEAD) return live;
      await live.stop();
    }

    // Concurrency cap: the producer whose reader went away longest ago loses.
    while (sessions.size >= MAX_SESSIONS) {
      let oldest = null;
      for (const s of sessions.values()) {
        if (!oldest || s.lastRequest < oldest.lastRequest) oldest = s;
      }
      if (!oldest) break;
      await oldest.stop();
    }

    const s = new Session(mediaId, row, idx, plan);
    sessions.set(mediaId, s);
    try {
      await s.start(n);
    } catch (err) {
      s.error = err.message;
      await s.stop();
      throw err;
    }
    return s;
  });
}

/** Poll the ring until segment n shows up (or the producer dies). */
function waitFor(mediaId, n, timeoutMs = WAIT_MS) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (ring.has(mediaId, n)) return resolve({ ok: true });
      const s = sessions.get(mediaId);
      if (!s || s.dead) {
        // The run ended. One last look — the final ingest may have landed
        // between the check above and the session being dropped.
        if (ring.has(mediaId, n)) return resolve({ ok: true });
        return resolve({ ok: false, error: (s && s.error) || 'the remux ended before this segment' });
      }
      if (Date.now() > deadline) return resolve({ ok: false, error: 'timed out waiting for the remux' });
      setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * Stop one file's producer WITHOUT awaiting the child.
 *
 * The delete paths need this. deleteRecords() runs inside a synchronous
 * better-sqlite3 transaction, so it cannot await stop() — and without a stop at
 * all the producer simply keeps going: it holds the source file open (which on
 * Windows is enough to make a delete or a rename fail) and it keeps writing
 * segments for a record that no longer exists.
 *
 * Marking the session dead is what stops anything else being ingested —
 * `_ingest` refuses on `dead`, so every in-flight completion, and the whole
 * leftover sweep the child's 'close' handler runs, is dropped. Killing the child and sweeping
 * the temp dir are cleanup that can happen at their own pace afterwards.
 *
 * @returns {boolean} true when a live session was killed
 */
function killNow(mediaId) {
  ring.forget(mediaId);
  const s = sessions.get(mediaId);
  if (!s) return false;
  s.dead = true;                       // before the kill: nothing more is ingested
  sessions.delete(mediaId);
  const child = s.child;
  if (!child) { s._cleanupDir(); return true; }
  try { child.kill(); } catch {}
  // The child's own 'close' handler reaches _finish() and sweeps the temp dir.
  // This is the backstop for a handle that was already gone, where 'close'
  // never arrives and the directory would otherwise be left behind.
  const hard = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
    s._cleanupDir();
  }, 3000);
  if (typeof hard.unref === 'function') hard.unref();
  return true;
}

/** Stop one file's producer. */
async function stop(mediaId) {
  const s = sessions.get(mediaId);
  if (s) await s.stop();
}

/** Stop every producer and free every ring (vault lock, shutdown). */
async function stopAll() {
  await Promise.all([...sessions.values()].map(s => s.stop()));
  sessions.clear();
  ring.clearAll();
}

/**
 * End one playback session: the producer stops and the buffers go. This is what
 * the idle timeout and the player's close beacon call; it is also the shape
 * every other "this file is done" path (lock, delete, trash) reduces to.
 */
async function end(mediaId) {
  ring.forget(mediaId);
  await stop(mediaId);
}

/**
 * Idle sweeper. The close beacon is best effort (a crashed tab sends nothing),
 * so the guarantee that FFmpeg stops and the RAM comes back is this: no segment
 * request for IDLE_MS and the session ends itself.
 */
let idleTimer = null;
function startIdleSweeper() {
  if (idleTimer) return idleTimer;
  idleTimer = setInterval(() => {
    for (const id of ring.idleIds(IDLE_MS)) { end(id).catch(() => {}); }
    // A producer with no ring at all (it has not delivered anything yet) is
    // still on the clock through its own lastRequest.
    for (const s of [...sessions.values()]) {
      if (!ring.peek(s.mediaId) && Date.now() - s.lastRequest > IDLE_MS) {
        end(s.mediaId).catch(() => {});
      }
    }
  }, IDLE_TICK_MS);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
  return idleTimer;
}
startIdleSweeper();

/** Media ids with a live producer. */
function activeIds() {
  return new Set(sessions.keys());
}

/** GET /api/stream/status: what is playing, and what it is holding in memory. */
function status() {
  const r = ring.status();
  const byId = new Map(r.rings.map(x => [x.mediaId, x]));
  const active = [];
  for (const s of sessions.values()) {
    const st = byId.get(s.mediaId);
    byId.delete(s.mediaId);
    active.push({
      mediaId: s.mediaId,
      from: s.from,
      head: s.head,                       // this run's producer head, not the ring's high-water mark
      producing: true,
      ringSegments: st ? st.ringSegments : 0,
      ringBytes: st ? st.ringBytes : 0,
      playhead: st ? st.playhead : null,
      produced: st ? st.produced : 0,
      idleMs: st ? st.idleMs : Date.now() - s.lastRequest,
    });
  }
  // A ring with no producer left: the remux finished, the player has not.
  for (const st of byId.values()) {
    active.push({
      mediaId: st.mediaId, from: null, head: st.head, producing: false,
      ringSegments: st.ringSegments, ringBytes: st.ringBytes,
      playhead: st.playhead, produced: st.produced, idleMs: st.idleMs,
    });
  }
  return {
    active,
    ringBytes: r.ringBytes,
    ringSegments: active.reduce((n, a) => n + a.ringSegments, 0),
    maxRingBytes: ring.MAX_TOTAL_BYTES,
    maxRingSegments: ring.MAX_SEGMENTS,
    spawns: spawnCount,
  };
}

module.exports = {
  ensure, waitFor, stop, end, killNow, stopAll, activeIds, status,
  IDLE_MS, READRATE, READRATE_BURST,
  needsGenPts, preflightStart, parseFrameMd5,
  MAX_SESSIONS, WAIT_MS,
  get spawnCount() { return spawnCount; },
};
