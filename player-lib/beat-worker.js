/* =========================================================================
   BEAT WORKER — streaming beat detection off the main thread (WebCodecs).

   Fed by /api/media/:id/beat-audio?fmt=adts — raw ADTS AAC that the server
   streams WHILE ffmpeg extracts it, so analysis starts within ~a second even
   on multi-hour videos. Pipeline, all incremental with constant memory:

     fetch stream → ADTS framer → AudioDecoder → band-pass (2×HP + 2×LP
     biquads, state carried across chunks) → per-hop RMS energy envelope →
     threshold detection (exact port of beatbar.js detectBeats).

   Only the energy envelope is kept (~1.2 MB for 2 hours; PCM is discarded as
   it's analyzed), which also makes sensitivity retunes instant: re-run the
   threshold pass, no re-download, no re-decode.

   Detection is APPEND-ONLY while streaming: a beat is only emitted once its
   full averaging window exists, so every progressive result is a stable
   prefix of the final one (no flicker, and the main thread can keep its
   playhead bookkeeping).

   Protocol:
     in : { cmd:'start', url, effSens, rawSens,
            opts:{ minGapMs, avgWindowSec, bandLow, bandHigh, q } }
          { cmd:'retune', effSens, rawSens }
          { cmd:'stop' }
     out: { type:'beats', beats, bpm, progressSec, done, rawSens }
          { type:'error', message }
   ========================================================================= */
'use strict';

const FRAME_SIZE = 1024, HOP = 512;
const ADTS_SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000, 7350];

let opts = null;
let effSens = 1.5, rawSens = 2.0;
let sampleRate = 22050;

let abortCtrl = null;
let decoder = null;
let decoderConfig = null;
let recreatesLeft = 3;
let streamEnded = false;
let finished = false;

// Compressed-side state
let pendingChunks = [];             // EncodedAudioChunks awaiting decode
let readGate = null;                // resolves when pendingChunks drains
let adtsBuf = new Uint8Array(0);    // partial ADTS bytes between reads
let frameIndex = 0;                 // decoded AAC frames so far (timestamps)

// PCM-side state
let filters = null;
let carry = new Float32Array(0);    // < FRAME_SIZE tail awaiting next chunk
let energy = new Float32Array(1 << 16);
let nFrames = 0;

// Detection state (append-only incremental scan)
let beats = [];
let lastBeatFrame = -Infinity;
let scanPos = 1;
let lastPost = 0;

/* ── Biquads (Web Audio semantics: HP/LP interpret Q in dB) ──────────────── */

function biquad(kind, fs, f0, qDb) {
  const q = Math.pow(10, qDb / 20);
  const w0 = 2 * Math.PI * f0 / fs;
  const cosw = Math.cos(w0), alpha = Math.sin(w0) / (2 * q);
  let b0, b1, b2;
  if (kind === 'lowpass') {
    b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = b0;
  } else {
    b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = b0;
  }
  const a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
  return {
    b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0,
    x1: 0, x2: 0, y1: 0, y2: 0,
  };
}

function runBiquad(f, data) {
  const { b0, b1, b2, a1, a2 } = f;
  let { x1, x2, y1, y2 } = f;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    data[i] = y;
  }
  f.x1 = x1; f.x2 = x2; f.y1 = y1; f.y2 = y2;
}

function makeFilters(fs) {
  return [
    biquad('highpass', fs, opts.bandLow, opts.q),
    biquad('highpass', fs, opts.bandLow, opts.q),
    biquad('lowpass', fs, opts.bandHigh, opts.q),
    biquad('lowpass', fs, opts.bandHigh, opts.q),
  ];
}

/* ── Energy envelope (RMS per FRAME_SIZE window, HOP stride) ─────────────── */

function pushEnergy(v) {
  if (nFrames === energy.length) {
    const bigger = new Float32Array(energy.length * 2);
    bigger.set(energy);
    energy = bigger;
  }
  energy[nFrames++] = v;
}

function processPcm(chunk) {
  for (const f of filters) runBiquad(f, chunk);
  let buf;
  if (carry.length) {
    buf = new Float32Array(carry.length + chunk.length);
    buf.set(carry); buf.set(chunk, carry.length);
  } else {
    buf = chunk;
  }
  let start = 0;
  while (start + FRAME_SIZE <= buf.length) {
    let sum = 0;
    for (let j = start; j < start + FRAME_SIZE; j++) { const v = buf[j]; sum += v * v; }
    pushEnergy(Math.sqrt(sum / FRAME_SIZE));
    start += HOP;
  }
  carry = buf.slice(start);
}

/* ── Detection (port of beatbar.js detectBeats over the envelope) ────────── */

function windowFrames() { return Math.round((sampleRate / HOP) * opts.avgWindowSec); }
function minGapFrames() { return Math.round((opts.minGapMs / 1000) * (sampleRate / HOP)); }

// Scan [scanPos, hi): identical decisions to the reference loop because every
// scanned index has its full averaging window present.
function scanTo(hi) {
  const wF = windowFrames(), gap = minGapFrames(), N = nFrames;
  for (let i = scanPos; i < hi; i++) {
    const w0 = Math.max(0, i - wF), w1 = Math.min(N, i + wF);
    let avg = 0;
    for (let k = w0; k < w1; k++) avg += energy[k];
    avg /= (w1 - w0);
    const e = energy[i];
    const onset = e - energy[i - 1];
    if (e > avg * effSens && e > energy[i - 1] && e >= energy[i + 1] &&
        onset > 0 && i - lastBeatFrame > gap) {
      beats.push((i * HOP) / sampleRate);
      lastBeatFrame = i;
    }
  }
  scanPos = Math.max(scanPos, hi);
}

function stableHi() { return Math.max(1, nFrames - windowFrames() - 2); }

function estimateBpm(list) {
  if (list.length < 4) return 0;
  const ivs = [];
  for (let i = 1; i < list.length; i++) ivs.push(list[i] - list[i - 1]);
  ivs.sort((a, b) => a - b);
  const med = ivs[Math.floor(ivs.length / 2)];
  return med ? 60 / med : 0;
}

function post(done) {
  postMessage({
    type: 'beats',
    beats,
    bpm: estimateBpm(beats),
    progressSec: (nFrames * HOP) / sampleRate,
    done: !!done,
    rawSens,
  });
  lastPost = Date.now();
}

function progressTick() {
  scanTo(stableHi());
  if (Date.now() - lastPost >= 400) post(false);
}

/* ── ADTS framing ────────────────────────────────────────────────────────── */

// Split accumulated bytes into whole ADTS frames (header included — that is
// the framing WebCodecs expects for description-free AAC). Returns leftover.
function parseAdts(buf, onFrame) {
  let i = 0;
  while (i + 7 <= buf.length) {
    if (buf[i] !== 0xFF || (buf[i + 1] & 0xF6) !== 0xF0) { i++; continue; } // resync
    const frameLen = ((buf[i + 3] & 0x03) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
    if (frameLen < 7) { i++; continue; }
    if (i + frameLen > buf.length) break;                 // partial — wait for more
    const sr = ADTS_SR[(buf[i + 2] >> 2) & 0x0F];
    onFrame(buf.subarray(i, i + frameLen), sr || sampleRate);
    i += frameLen;
  }
  return buf.slice(i);
}

/* ── Decoder with backpressure + per-error recreation ────────────────────── */

function fail(message) {
  if (finished) return;
  finished = true;
  try { abortCtrl?.abort(); } catch {}
  try { decoder?.close(); } catch {}
  postMessage({ type: 'error', message: String(message) });
}

function onDecoded(data) {
  try {
    const pcm = new Float32Array(data.numberOfFrames);
    data.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
    data.close();
    processPcm(pcm);
    progressTick();
  } catch (err) {
    data.close?.();
    fail(`pcm copy failed: ${err.message}`);
  }
}

function makeDecoder() {
  const d = new AudioDecoder({
    output: onDecoded,
    error: (e) => {
      // A corrupt packet closes the decoder; recreate and keep going (the
      // lost queue costs a few seconds of envelope at worst) instead of
      // failing the whole multi-hour analysis.
      if (finished) return;
      if (recreatesLeft-- > 0) {
        try { decoder.close(); } catch {}
        decoder = makeDecoder();
        decoder.configure(decoderConfig);
        pump();
      } else {
        fail(`decode failed: ${e?.message || e}`);
      }
    },
  });
  d.ondequeue = pump;
  return d;
}

function pump() {
  if (finished || !decoder || decoder.state !== 'configured') return;
  while (pendingChunks.length && decoder.decodeQueueSize < 64) {
    try { decoder.decode(pendingChunks.shift()); }
    catch (err) { fail(`decode submit failed: ${err.message}`); return; }
  }
  if (readGate && pendingChunks.length < 1024) {
    const g = readGate; readGate = null; g();
  }
}

async function drainPending() {
  while (!finished && (pendingChunks.length || decoder.decodeQueueSize > 0)) {
    pump();
    await new Promise(r => setTimeout(r, 15));
  }
}

/* ── Main flow ───────────────────────────────────────────────────────────── */

async function start(msg) {
  opts = msg.opts;
  effSens = msg.effSens;
  rawSens = msg.rawSens;

  try {
    if (typeof AudioDecoder !== 'function') return fail('WebCodecs unavailable');

    abortCtrl = new AbortController();
    const resp = await fetch(msg.url, { signal: abortCtrl.signal });
    if (!resp.ok) return fail(`audio extraction failed (${resp.status})`);
    const reader = resp.body.getReader();

    let configured = false;
    const onFrame = (frameBytes, sr) => {
      if (!configured) {
        sampleRate = sr;
        filters = makeFilters(sampleRate);
        decoderConfig = { codec: 'mp4a.40.2', sampleRate, numberOfChannels: 1 };
        decoder = makeDecoder();
        decoder.configure(decoderConfig);
        configured = true;
      }
      pendingChunks.push(new EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round(frameIndex * 1024 / sampleRate * 1e6),
        data: frameBytes.slice(),          // detach from the network buffer
      }));
      frameIndex++;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (finished) return;
      const merged = new Uint8Array(adtsBuf.length + value.length);
      merged.set(adtsBuf); merged.set(value, adtsBuf.length);
      adtsBuf = parseAdts(merged, onFrame);
      pump();
      if (pendingChunks.length >= 4096) {                 // decode backpressure
        await new Promise(resolve => { readGate = resolve; });
      }
    }
    streamEnded = true;
    if (!configured) return fail('no decodable audio in stream');

    await drainPending();
    if (finished) return;
    try { await decoder.flush(); } catch { /* tail flush errors: analyze what we have */ }
    if (finished) return;

    scanTo(nFrames - 1);                  // final pass reaches the true end
    finished = true;
    post(true);
    try { decoder.close(); } catch {}
  } catch (err) {
    if (err?.name !== 'AbortError') fail(err?.message || 'stream failed');
  }
}

function retune(msg) {
  effSens = msg.effSens;
  rawSens = msg.rawSens;
  beats = [];
  lastBeatFrame = -Infinity;
  scanPos = 1;
  if (finished) {                          // envelope complete — instant answer
    scanTo(nFrames - 1);
    post(true);
  } else {
    scanTo(stableHi());                    // mid-stream: stable prefix now,
    post(false);                           // the rest lands as decoding continues
  }
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.cmd === 'start') start(m);
  else if (m.cmd === 'retune') retune(m);
  else if (m.cmd === 'stop') {
    finished = true;
    try { abortCtrl?.abort(); } catch {}
    try { decoder?.close(); } catch {}
    self.close();
  }
};
