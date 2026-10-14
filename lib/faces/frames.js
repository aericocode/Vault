/**
 * Raw frames for the face engine, straight out of ffmpeg over a pipe.
 *
 * Every function here spawns the app's own ffmpeg (lib/ffmpeg-locate) and reads
 * PPM images (P6) from its stdout. PPM is chosen over raw rgb24 because each
 * frame carries its own width/height header, so no ffprobe round trip is
 * needed to know the output size after scaling. Nothing touches the disk.
 *
 * frame = { width, height, data: Uint8Array }   data is packed RGB (R,G,B per
 * pixel, row-major, no padding): data.length === width * height * 3.
 *
 * Videos: ONE ffmpeg process per file. Frames are picked on a time grid
 * (the first frame inside each intervalS bucket), so spacing stays even when
 * keyframes are irregular. When keyframes are dense enough, only keyframe
 * packets are read and decoded (-discard nokey -skip_frame nokey), ~4-5x faster than a
 * full decode; otherwise every frame is decoded and the select filter drops
 * the ones we don't want.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const locate = require('../ffmpeg-locate');
const proc = require('../proc');

const DEFAULT_MAX_SIDE = 1280;

// ---------------------------------------------------------------------------
// PPM stream parsing

/** Incremental P6 parser: push() chunks in, complete frames come out. */
class PpmReader {
  constructor() { this.head = Buffer.alloc(0); this.cur = null; this.filled = 0; }

  /**
   * Pixels are copied straight into each frame's own array as chunks arrive
   * (pipe chunks are ~64 KB; re-concatenating a 2.7 MB frame per chunk would
   * copy it ~40 times over). Only header bytes are ever concatenated.
   * @returns {Array<{width,height,data}>} frames completed by this chunk
   */
  push(chunk) {
    const out = [];
    let off = 0;
    while (off < chunk.length) {
      if (!this.cur) {
        this.head = this.head.length ? Buffer.concat([this.head, chunk.subarray(off)]) : chunk.subarray(off);
        const h = parsePpmHeader(this.head);
        if (!h) { this.head = Buffer.from(this.head); break; }   // own the partial header bytes
        this.cur = { width: h.width, height: h.height, data: new Uint8Array(h.width * h.height * 3) };
        this.filled = 0;
        chunk = this.head.subarray(h.headerLen);
        this.head = Buffer.alloc(0);
        off = 0;
        if (this.cur.data.length === 0) { out.push(this.cur); this.cur = null; }
        continue;
      }
      const take = Math.min(this.cur.data.length - this.filled, chunk.length - off);
      this.cur.data.set(chunk.subarray(off, off + take), this.filled);
      this.filled += take;
      off += take;
      if (this.filled === this.cur.data.length) { out.push(this.cur); this.cur = null; }
    }
    return out;
  }
}

/** P6 header: "P6" ws width ws height ws maxval single-ws. Returns null if incomplete. */
function parsePpmHeader(buf) {
  if (buf.length < 2) return null;
  if (buf[0] !== 0x50 || buf[1] !== 0x36) throw new Error('ffmpeg did not produce a PPM stream');
  const vals = [];
  let i = 2;
  while (vals.length < 3) {
    while (i < buf.length && isWs(buf[i])) i++;
    if (i < buf.length && buf[i] === 0x23) {               // comment line
      while (i < buf.length && buf[i] !== 0x0a) i++;
      continue;
    }
    let j = i;
    while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x39) j++;
    if (j >= buf.length) return null;                     // number may continue in the next chunk
    if (j === i) throw new Error('bad PPM header');
    vals.push(parseInt(buf.toString('latin1', i, j), 10));
    i = j;
  }
  if (i >= buf.length) return null;
  const [width, height, maxval] = vals;
  if (maxval !== 255) throw new Error(`unsupported PPM maxval ${maxval}`);
  return { width, height, headerLen: i + 1 };
}

function isWs(c) { return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09; }

// ---------------------------------------------------------------------------
// Filters

/** Downscale so the longer side is <= maxSide (never upscale), square pixels. */
function scaleFilter(maxSide) {
  const M = Math.max(16, Math.round(maxSide));
  // iw*sar fixes anamorphic sources so faces aren't squashed.
  const W = 'iw*sar';
  return `scale=w='round(min(${W},${M}*${W}/max(${W},ih)))':h='round(min(ih,${M}*ih/max(${W},ih)))'` +
    ':flags=bilinear,setsar=1';
}

/** EXIF orientation (1..8) -> ffmpeg filter chain that displays it upright. */
const ORIENT_FILTERS = {
  2: 'hflip', 3: 'hflip,vflip', 4: 'vflip',
  5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2',
};

/**
 * Read the EXIF orientation tag from a JPEG without decoding it. We apply it
 * ourselves (and pass -noautorotate) because ffmpeg's handling of JPEG EXIF
 * orientation differs between versions; this way the result is the same with
 * whatever ffmpeg the user has. Returns 1 (normal) when absent/unreadable.
 */
function jpegOrientation(filepath) {
  return sniffJpeg(filepath).orientation;
}

/**
 * Is this a JPEG, judged by its FF D8 FF magic rather than its name (uploads
 * arrive as "query.img" with types like image/pjpeg), and its orientation.
 * @returns {{ isJpeg: boolean, orientation: number }}
 */
function sniffJpeg(filepath) {
  let fd;
  try {
    fd = fs.openSync(filepath, 'r');
    const head = Buffer.alloc(128 * 1024);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const isJpeg = n >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    return { isJpeg, orientation: isJpeg ? exifOrientationFromBuffer(head.subarray(0, n)) : 1 };
  } catch {
    return { isJpeg: false, orientation: 1 };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function exifOrientationFromBuffer(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return 1;
    const marker = b[p + 1];
    if (marker === 0xd9 || marker === 0xda) return 1;     // EOI / start of scan: no EXIF before image data
    const len = b.readUInt16BE(p + 2);
    if (marker === 0xe1 && p + 4 + len - 2 <= b.length &&
        b.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      return readTiffOrientation(b.subarray(p + 10, p + 2 + len));
    }
    p += 2 + len;
  }
  return 1;
}

function readTiffOrientation(t) {
  if (t.length < 8) return 1;
  const le = t[0] === 0x49 && t[1] === 0x49;
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return 1;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Single frames

function _ffmpeg() { return locate.resolve('ffmpeg'); }

/** Run ffmpeg once and return the first PPM frame on stdout. `input` (a Buffer) is fed on stdin. */
function _oneFrame(args, what, input = null) {
  return new Promise((resolve, reject) => {
    const reader = new PpmReader();
    let frame = null;
    let stderr = '';
    let child;
    try {
      child = spawn(_ffmpeg(), args, { windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (e) { reject(e); return; }
    if (input) {
      child.stdin.on('error', () => { /* ffmpeg stopped reading (bad data): the close handler reports it */ });
      child.stdin.end(input);
    }
    child.stdout.on('data', (c) => {
      if (frame) return;
      try {
        const got = reader.push(c);
        if (got.length) frame = got[0];
      } catch (e) { child.kill(); reject(e); }
    });
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (frame) resolve(frame);
      else {
        const err = new Error(`ffmpeg could not decode ${what}` +
          (code ? ` (exit ${code})` : '') + (stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''));
        err.code = 'FRAME_DECODE_FAILED';
        reject(err);
      }
    });
  });
}

/**
 * Decode an image (JPEG/PNG/WebP/GIF/...) to RGB. GIFs and other animated
 * formats yield their first frame. JPEG EXIF orientation is honoured.
 */
function decodeImage(filepath, { maxSide = DEFAULT_MAX_SIDE } = {}) {
  // JPEG: apply EXIF orientation ourselves (ffmpeg versions differ) and stop
  // ffmpeg doing it too. Anything else (HEIC, WebP, PNG...): leave ffmpeg's
  // own orientation handling on.
  const { isJpeg, orientation } = sniffJpeg(filepath);
  const vf = [ORIENT_FILTERS[orientation], scaleFilter(maxSide)].filter(Boolean).join(',');
  return _oneFrame([
    '-hide_banner', '-nostdin', '-loglevel', 'error', ...(isJpeg ? ['-noautorotate'] : []),
    '-i', filepath, '-map', '0:v:0', '-frames:v', '1', '-vf', vf,
    '-f', 'image2pipe', '-c:v', 'ppm', '-pix_fmt', 'rgb24', 'pipe:1',
  ], filepath);
}

/**
 * decodeImage() for image bytes held in memory (an upload): fed to ffmpeg on
 * stdin, so the bytes never land in a temp file. JPEG EXIF orientation is
 * honoured the same way.
 */
function decodeImageBuffer(buf, { maxSide = DEFAULT_MAX_SIDE } = {}) {
  const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const orientation = isJpeg ? exifOrientationFromBuffer(buf.subarray(0, 128 * 1024)) : 1;
  const vf = [ORIENT_FILTERS[orientation], scaleFilter(maxSide)].filter(Boolean).join(',');
  return _oneFrame([
    '-hide_banner', '-loglevel', 'error', ...(isJpeg ? ['-noautorotate'] : []),
    '-i', 'pipe:0', '-map', '0:v:0', '-frames:v', '1', '-vf', vf,
    '-f', 'image2pipe', '-c:v', 'ppm', '-pix_fmt', 'rgb24', 'pipe:1',
  ], 'the image', buf);
}

/** One video frame at timeS (accurate seek). Rotation metadata is honoured. */
function grabFrame(filepath, timeS, { maxSide = DEFAULT_MAX_SIDE } = {}) {
  const t = Math.max(0, Number(timeS) || 0);
  return _oneFrame([
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', t.toFixed(3), '-i', filepath, '-map', '0:v:0', '-frames:v', '1',
    '-vf', scaleFilter(maxSide),
    '-f', 'image2pipe', '-c:v', 'ppm', '-pix_fmt', 'rgb24', 'pipe:1',
  ], `${filepath} @ ${t}s`);
}

// ---------------------------------------------------------------------------
// Video sampling

/**
 * Duration + keyframe spacing from one cheap ffprobe pass over the first
 * `windowS` seconds of packets (no decoding).
 */
async function probeVideo(filepath, { windowS = 30 } = {}) {
  const { stdout } = await proc.run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-read_intervals', `%+${windowS}`,
    '-show_entries', 'packet=pts_time,flags:format=duration',
    '-of', 'json', filepath,
  ], { maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
  const j = JSON.parse(stdout);
  const durationS = parseFloat(j.format?.duration) || 0;
  const keys = (j.packets || [])
    .filter((p) => p.flags && p.flags.includes('K') && p.pts_time !== undefined)
    .map((p) => parseFloat(p.pts_time))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < keys.length; i++) gaps.push(keys[i] - keys[i - 1]);
  gaps.sort((a, b) => a - b);
  return {
    durationS,
    keyframes: keys.length,
    medianKeyGapS: gaps.length ? gaps[gaps.length >> 1] : Infinity,
    maxKeyGapS: gaps.length ? gaps[gaps.length - 1] : Infinity,
  };
}

/** Keyframe-only decoding is used when keyframes land at least this densely. */
function keyframesDenseEnough(p, intervalS) {
  return p.keyframes >= 2 && p.medianKeyGapS <= intervalS && p.maxKeyGapS <= intervalS * 2;
}

/**
 * Yield { timeS, frame } roughly every intervalS seconds through one ffmpeg.
 *
 * opts.durationS   known duration (skips the probe's duration field use)
 * opts.mode        'auto' (default) | 'keyframes' | 'full' — force a decode path
 * opts.signal      AbortSignal: kills ffmpeg and makes the iterator throw AbortError
 * opts.threads     ffmpeg decode threads (default 0 = ffmpeg's choice)
 * Breaking out of the loop (iterator.return()) also kills ffmpeg immediately.
 */
async function* sampleVideo(filepath, opts = {}) {
  const {
    intervalS = 3.5, maxFrames = 2000, maxSide = DEFAULT_MAX_SIDE,
    signal, mode = 'auto', threads = 0,
  } = opts;
  let { durationS } = opts;
  if (signal?.aborted) throw _abortError();

  let probe = null;
  if (mode === 'auto' || !(durationS > 0)) {
    try { probe = await probeVideo(filepath); } catch { probe = null; }
    if (!(durationS > 0) && probe?.durationS > 0) durationS = probe.durationS;
  }
  if (signal?.aborted) throw _abortError();

  let step = Math.max(0.05, Number(intervalS) || 3.5);
  if (durationS > 0 && durationS / step > maxFrames) step = durationS / maxFrames;
  const useKeys = mode === 'keyframes' || (mode === 'auto' && probe && keyframesDenseEnough(probe, step));

  // Pick the first frame inside each step-wide bucket of the timeline.
  const sel = `select='isnan(prev_selected_t)+gt(floor(t/${step.toFixed(4)}),floor(prev_selected_t/${step.toFixed(4)}))'`;
  const args = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info'];
  if (threads > 0) args.push('-threads', String(threads));
  // -discard drops non-key packets in the demuxer (~7x faster than -skip_frame
  // alone, which still hands every packet to the threaded decoder); -skip_frame
  // covers demuxers that ignore -discard.
  if (useKeys) args.push('-skip_frame', 'nokey', '-discard', 'nokey');
  args.push('-i', filepath, '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `${sel},showinfo,${scaleFilter(maxSide)}`,
    '-fps_mode', 'passthrough', '-frames:v', String(maxFrames),
    '-f', 'image2pipe', '-c:v', 'ppm', '-pix_fmt', 'rgb24', 'pipe:1');

  const child = spawn(_ffmpeg(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const reader = new PpmReader();
  const frames = [];
  const times = [];
  let stderrTail = '';
  let lineBuf = '';
  let closed = false;
  let exitCode = null;
  let failure = null;
  let wake = null;
  const poke = () => { if (wake) { const w = wake; wake = null; w(); } };

  child.stdout.on('data', (c) => {
    try {
      for (const f of reader.push(c)) frames.push(f);
    } catch (e) { failure = e; child.kill(); }
    if (frames.length >= 2) child.stdout.pause();   // backpressure: ffmpeg blocks on the pipe
    poke();
  });
  child.stderr.setEncoding('latin1');
  child.stderr.on('data', (s) => {
    lineBuf += s;
    let nl;
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      if (line.includes('Parsed_showinfo')) {
        const m = /pts_time:\s*(-?[\d.]+(?:e[-+]?\d+)?)/i.exec(line);
        if (m) times.push(parseFloat(m[1]));
      } else {
        stderrTail = (stderrTail + line + '\n').slice(-3000);
      }
    }
    poke();
  });
  child.on('error', (e) => { failure = failure || e; closed = true; poke(); });
  child.on('close', (code) => { exitCode = code; closed = true; poke(); });

  const onAbort = () => { failure = failure || _abortError(); try { child.kill(); } catch {} poke(); };
  signal?.addEventListener('abort', onAbort, { once: true });

  let yielded = 0;
  try {
    for (;;) {
      if (failure) throw failure;
      // A frame is ready when both its pixels and its showinfo timestamp are in,
      // or when ffmpeg has exited (then the timestamp is estimated).
      if (frames.length && (times.length > yielded || closed)) {
        const frame = frames.shift();
        if (frames.length < 2) child.stdout.resume();
        const t = times.length > yielded ? times[yielded] : yielded * step;
        yielded++;
        yield { timeS: Math.max(0, t), frame, durationS: durationS > 0 ? durationS : null };
        continue;
      }
      if (closed && !frames.length) {
        if (yielded === 0 && exitCode !== 0) {
          const err = new Error(`ffmpeg could not sample ${filepath} (exit ${exitCode}): ` +
            stderrTail.trim().split('\n').slice(-3).join(' | '));
          err.code = 'FRAME_DECODE_FAILED';
          throw err;
        }
        return;
      }
      await new Promise((r) => { wake = r; });
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!closed) { try { child.kill(); } catch {} }
  }
}

/** Which path sampleVideo('auto') would take for this file — for diagnostics/benchmarks. */
async function sampleMode(filepath, intervalS = 3.5) {
  const p = await probeVideo(filepath);
  return { ...p, mode: keyframesDenseEnough(p, intervalS) ? 'keyframes' : 'full' };
}

function _abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  e.code = 'ABORT_ERR';
  return e;
}

module.exports = {
  decodeImage, decodeImageBuffer, grabFrame, sampleVideo, probeVideo, sampleMode,
  // exposed for tests
  PpmReader, scaleFilter, exifOrientationFromBuffer, keyframesDenseEnough, sniffJpeg,
};
