/**
 * Flow's measuring (lib/flow/analyze.js, lib/audio/dsp.js) on synthetic audio
 * made with ffmpeg here (written to a temp folder, never played): click
 * tracks at known tempos, loud and quiet, a held tone, silence, a video with
 * no sound. Loudness is checked against ffmpeg's own ebur128 filter. Long
 * files are checked with a fake decoder (which windows are read).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dsp = require('../lib/audio/dsp');
const analyze = require('../lib/flow/analyze');
const loudness = require('../lib/flow/loudness');

const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
const haveFfmpeg = ff.status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-flow-'));
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

/** A click track: a low thump and a tick on every beat, plus a soft pad. */
function clickExpr(bpm, amp) {
  const P = (60 / bpm).toFixed(6);
  return `${amp}*(0.9*sin(2*PI*70*t)*exp(-mod(t\\,${P})*25)+0.35*sin(2*PI*1800*t)*exp(-mod(t\\,${P})*180)+0.12*sin(2*PI*220*t))`;
}
function make(name, audioArgs, { video = false, seconds = 40 } = {}) {
  const out = path.join(tmp, name);
  const args = ['-v', 'error', '-y'];
  if (video) args.push('-f', 'lavfi', '-i', `color=c=black:s=64x36:r=5:d=${seconds}`);
  if (audioArgs) args.push('-f', 'lavfi', '-i', audioArgs);
  if (video) args.push('-c:v', 'libx264', '-preset', 'ultrafast');
  if (audioArgs) args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  args.push('-t', String(seconds), out);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return out;
}
function ebur128(file) {
  const r = spawnSync('ffmpeg', ['-nostats', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  const all = [...r.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
  return Number(all[all.length - 1][1]);
}

const opt = { skip: haveFfmpeg ? false : 'ffmpeg is not installed' };

test('click tracks: tempo within 1 BPM, music, loudness within 0.3 LU of ffmpeg ebur128', opt, async () => {
  for (const [bpm, amp] of [[90, 0.1], [128, 0.8], [140, 0.6], [174, 0.6]]) {
    const f = make(`click-${bpm}.m4a`, `aevalsrc=${clickExpr(bpm, amp)}:s=44100:d=40`);
    const r = await analyze.measureFile(f, { duration: 40 });
    assert.strictEqual(r.has_music, 1, `${bpm} is music`);
    for (const k of ['bpm_start', 'bpm_mid', 'bpm_end']) assert.ok(Math.abs(r[k] - bpm) <= 1, `${bpm}: ${k} ${r[k]}`);
    assert.ok(r.bpm_conf > 0.6, `confidence ${r.bpm_conf}`);
    const ref = ebur128(f);
    assert.ok(Math.abs(r.lufs - ref) <= 0.3, `${bpm}: ${r.lufs} vs ebur128 ${ref}`);
    assert.strictEqual(r.version, analyze.VERSION);
  }
});

test('energy: a loud fast track is well above a quiet slow one; a build-up rises from start to end', opt, async () => {
  const quiet = await analyze.measureFile(make('quiet.m4a', `aevalsrc=${clickExpr(90, 0.05)}:s=44100:d=40`), { duration: 40 });
  const loud = await analyze.measureFile(make('loud.m4a', `aevalsrc=${clickExpr(140, 0.8)}:s=44100:d=40`), { duration: 40 });
  assert.ok(loud.e_mid - quiet.e_mid > 0.3, `${loud.e_mid} vs ${quiet.e_mid}`);
  for (const r of [quiet, loud]) for (const k of ['e_start', 'e_mid', 'e_end']) assert.ok(r[k] >= 0 && r[k] <= 1);
  const ramp = `aevalsrc=(0.04+0.86*t/90)*(0.9*sin(2*PI*70*t)*exp(-mod(t\\,0.6)*25)+0.12*sin(2*PI*220*t)):s=44100:d=90`;
  const b = await analyze.measureFile(make('build.m4a', ramp, { seconds: 90 }), { duration: 90 });
  assert.ok(b.e_end - b.e_start > 0.15, `start ${b.e_start} end ${b.e_end}`);
  // The envelope: 10 slices of the whole file, in time order, on the same scale, rising with it.
  assert.strictEqual(b.env.length, analyze.ENV_POINTS);
  b.env.forEach(([t, e], i) => {
    assert.ok(Math.abs(t - (i + 0.5) / 10) < 0.01, `t ${t}`);
    assert.ok(e >= 0 && e <= 1);
  });
  assert.ok(b.env[9][1] - b.env[0][1] > 0.2, JSON.stringify(b.env));
  let rises = 0;
  for (let i = 1; i < 10; i++) if (b.env[i][1] >= b.env[i - 1][1] - 0.02) rises++;
  assert.ok(rises >= 8, `mostly rising: ${JSON.stringify(b.env)}`);
  // A steady track's envelope sits around its windows' energy.
  for (const [, e] of loud.env) assert.ok(Math.abs(e - loud.e_mid) < 0.12, `${e} vs ${loud.e_mid}`);
  // Too short for 3 slices of 4 s: no envelope (the chart uses start, middle, end).
  const short = await analyze.measureFile(make('short.m4a', `aevalsrc=${clickExpr(120, 0.5)}:s=44100:d=10`, { seconds: 10 }), { duration: 10 });
  assert.strictEqual(short.env, null);
  assert.ok(short.e_mid > 0);
});

test('no music: a held tone and silence; no audio stream is its own answer', opt, async () => {
  const tone = await analyze.measureFile(make('tone.m4a', 'sine=f=220:sample_rate=44100:d=30', { seconds: 30 }), { duration: 30 });
  assert.strictEqual(tone.has_music, 0);
  assert.strictEqual(tone.bpm_mid, null);
  assert.ok(tone.lufs < -10 && tone.lufs > -40);
  const silent = await analyze.measureFile(make('silent.m4a', 'anullsrc=r=44100:cl=stereo', { seconds: 20 }), { duration: 20 });
  assert.strictEqual(silent.has_music, 0);
  assert.strictEqual(silent.lufs, null);
  assert.strictEqual(silent.e_mid, 0);
  const noAudio = make('noaudio.mp4', null, { video: true, seconds: 5 });
  await assert.rejects(analyze.measureFile(noAudio, { duration: 5 }), (e) => e.code === 'NO_AUDIO');
});

test('a long file reads only the start, middle and end windows plus a few loudness samples', async () => {
  const calls = [];
  const sr = 22050;
  const click = (seconds) => {
    const n = Math.round(seconds * sr);
    const s = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const t = i / sr, ph = t % 0.5;
      const v = 0.5 * Math.sin(2 * Math.PI * 70 * t) * Math.exp(-ph * 25);
      s[2 * i] = v; s[2 * i + 1] = v;
    }
    return s;
  };
  const extract = async (file, o) => { calls.push([o.start || 0, o.duration]); return { samples: click(o.duration), sampleRate: sr, channels: 2, truePeakDb: -6 }; };
  const probe = async () => ({ channels: 2, layout: 'stereo', sampleRate: 48000, duration: 3600 });
  const r = await analyze.measureFile('x.mkv', { duration: null, extract, probe });
  const [start, mid, end, ...samples] = calls;
  assert.deepStrictEqual(start, [0, 30]);
  assert.deepStrictEqual(mid, [1800 - 22.5, 45]);
  assert.deepStrictEqual(end, [3570, 30]);
  assert.ok(samples.length >= 4 && samples.length <= 6, `${samples.length} samples`);
  assert.ok(samples.every(([, d]) => d === 8));
  assert.ok(calls.reduce((s, c) => s + c[1], 0) < 160, 'about two and a half minutes decoded in all');
  assert.strictEqual(r.has_music, 1);
  assert.ok(Math.abs(r.bpm_mid - 120) <= 1);
  assert.strictEqual(r.peak_db, -6);
  // The envelope: the three windows (each a small part of an hour: not split) and the six samples, in time order.
  assert.strictEqual(r.env.length, 9);
  assert.deepStrictEqual(r.env.map(p => p[0]), [15, 300, 900, 1500, 1800, 2100, 2700, 3300, 3585].map(s => Math.round(s / 3600 * 1000) / 1000));
  assert.ok(r.env.every(([, e]) => e > 0 && e <= 1));

  // Length unknown even to ffprobe: only the first 150 s, as the whole (memory stays bounded).
  calls.length = 0;
  const r2 = await analyze.measureFile('y.mkv', { duration: null, extract, probe: async () => ({ channels: 2, layout: 'stereo', duration: null }) });
  assert.deepStrictEqual(calls, [[0, 151]]);
  assert.strictEqual(r2.has_music, 1);
  assert.strictEqual(r2.env.length, 10);
  // Surround: whole only up to 60 s, windows past that.
  calls.length = 0;
  const r3 = await analyze.measureFile('z.mkv', { extract, probe: async () => ({ channels: 6, layout: '5.1', duration: 100 }) });
  assert.ok(calls.length >= 3, 'windowed');
  // Windows that cover an eighth of the file or more are split in two; samples inside a window add nothing.
  assert.strictEqual(r3.env.length, 6);
  assert.ok(r3.env.every((p, i) => !i || p[0] > r3.env[i - 1][0]), 'in time order');
});

test('a cancelled measurement stops ffmpeg and says ABORTED', opt, async () => {
  const f = make('cancel.m4a', `aevalsrc=${clickExpr(120, 0.5)}:s=44100:d=40`);
  const ctl = new AbortController();
  const p = analyze.measureFile(f, { duration: null, signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, (e) => e.code === 'ABORTED');
});

test('K-weighted loudness of a full-scale 1 kHz sine is about -3 LUFS (the standard\'s reference)', () => {
  const sr = 22050, n = sr * 5;
  const s = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { const v = Math.sin(2 * Math.PI * 1000 * i / sr); s[2 * i] = v; s[2 * i + 1] = 0; }
  const l = dsp.integratedLoudness(dsp.loudnessBlocks(s, sr, 2));
  assert.ok(Math.abs(l - (-3.01)) < 0.2, `${l}`);
  assert.strictEqual(dsp.integratedLoudness([]), null);
});

test('tempo: double-time pulses pick the faster tempo, a half-time pattern stays slow', () => {
  const sr = 22050;
  const pulses = (bpm, seconds = 30) => {
    const n = seconds * sr, s = new Float32Array(n), P = 60 / bpm;
    for (let i = 0; i < n; i++) { const ph = (i / sr) % P; s[i] = 0.6 * Math.sin(2 * Math.PI * 80 * i / sr) * Math.exp(-ph * 30); }
    return s;
  };
  assert.ok(Math.abs(dsp.estimateTempo(pulses(174), sr).bpm - 174) <= 1.5);
  assert.ok(Math.abs(dsp.estimateTempo(pulses(64), sr).bpm - 64) <= 1);
  assert.ok(Math.abs(dsp.estimateTempo(pulses(100), sr).bpm - 100) <= 1);
  assert.strictEqual(dsp.estimateTempo(new Float32Array(sr * 10), sr).confidence, 0);
});

test('Even out loudness: -16 LUFS, clamped to 12 dB, never louder than 1 dB under the peak', () => {
  assert.strictEqual(loudness.gainDb({ lufs: -20, peak_db: -10 }), 4);
  assert.strictEqual(loudness.gainDb({ lufs: -10, peak_db: 0 }), -6);
  assert.strictEqual(loudness.gainDb({ lufs: -40, peak_db: -30 }), 12, 'up to +12');
  assert.strictEqual(loudness.gainDb({ lufs: 0, peak_db: 0 }), -12, 'down to -12');
  assert.strictEqual(loudness.gainDb({ lufs: -24, peak_db: -3 }), 2, 'stops 1 dB under the peak');
  assert.strictEqual(loudness.gainDb({ lufs: -24, peak_db: 0.5 }), 0, 'already at the peak: no boost');
  assert.strictEqual(loudness.gainDb({ lufs: -16.02, peak_db: -5 }), 0);
  assert.strictEqual(loudness.gainDb({ lufs: null }), null);
  assert.strictEqual(loudness.gainDb({ lufs: -20, error: 'x' }), null);
  assert.strictEqual(loudness.gainDb(null), null);
});

test('5.1: the file\'s own channels with BS.1770 weights, within 0.3 LU of ebur128', opt, async () => {
  const ch = ['0.3*sin(2*PI*220*t)', '0.3*sin(2*PI*330*t)', '0.25*sin(2*PI*440*t)', '0.5*sin(2*PI*50*t)', '0.2*sin(2*PI*550*t)', '0.2*sin(2*PI*660*t)'].join('|');
  const f = make('surround.mka', `aevalsrc=${ch}:s=48000:d=20:channel_layout=5.1`, { seconds: 20 });
  // make() asks for -ac 2 for normal files; rebuild this one with all six channels.
  const out = path.join(tmp, 'surround6.mka');
  const r0 = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${ch}:s=48000:d=20:channel_layout=5.1`, '-c:a', 'flac', out], { encoding: 'utf8' });
  assert.strictEqual(r0.status, 0, r0.stderr);
  assert.ok(f);
  const info = await dsp.probeAudio(out);
  assert.strictEqual(info.channels, 6);
  const r = await analyze.measureFile(out, { duration: 20 });
  const ref = ebur128(out);
  assert.ok(Math.abs(r.lufs - ref) <= 0.3, `${r.lufs} vs ebur128 ${ref}`);
  assert.deepStrictEqual(dsp.channelWeights('5.1(side)', 6).weights, [1, 1, 1, 0, 1.41, 1.41]);
  assert.deepStrictEqual(dsp.channelWeights('hexadecagonal', 16), { channels: 2, weights: [1, 1] });
});

test('the peak counts what a 22.05 kHz decode cannot carry (true peak at the source rate)', opt, async () => {
  // A 15 kHz tone under a quiet 200 Hz one (about -12 dBFS once ffmpeg makes it two channels): invisible to the analysis decode.
  const out = path.join(tmp, 'hfpeak.wav');
  const r0 = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.316*sin(2*PI*15000*t)+0.02*sin(2*PI*200*t):s=48000:d=10', '-ac', '2', out], { encoding: 'utf8' });
  assert.strictEqual(r0.status, 0, r0.stderr);
  const r = await analyze.measureFile(out, { duration: 10 });
  assert.ok(r.peak_db > -13 && r.peak_db < -10.5, `true peak ${r.peak_db}`);
  const lowPass = await dsp.extractPCM(out, { sampleRate: 22050, channels: 2 });
  const lowDb = 20 * Math.log10(dsp.samplePeak(lowPass.samples));
  assert.ok(lowDb < r.peak_db - 6, `the 22.05 kHz decode alone reads ${lowDb.toFixed(1)}`);
  // So Even out loudness never lifts it past -1 dBTP.
  const g = loudness.gainDb(r);
  assert.ok(g <= -1 - r.peak_db + 1e-9, `gain ${g} with peak ${r.peak_db}`);
});

test('the worker: measuring runs off the main thread, and can be stopped', opt, async () => {
  const pool = require('../lib/flow/pool');
  const f = make('worker.m4a', `aevalsrc=${clickExpr(120, 0.5)}:s=44100:d=30`, { seconds: 30 });
  const r = await pool.measure(f, { duration: 30 });
  assert.strictEqual(r.has_music, 1);
  assert.ok(Math.abs(r.bpm_mid - 120) <= 1);
  const ctl = new AbortController();
  const p = pool.measure(f, { duration: 30, signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, (e) => e.code === 'ABORTED');
  const o = await pool.order([{ id: 1, measured: true, music: true, es: 0.9, em: 0.9, ee: 0.9, bs: 120, bm: 120, be: 120 }, { id: 2, measured: true, music: true, es: 0.1, em: 0.1, ee: 0.1, bs: 120, bm: 120, be: 120 }], { shape: 'build' });
  assert.deepStrictEqual(o.order, [2, 1]);
  pool.stop();
});

test('Even out loudness rounds down at the peak ceiling, never past it', () => {
  assert.strictEqual(loudness.gainDb({ lufs: -30, peak_db: -9.96 }), 8.9);
  assert.strictEqual(loudness.gainDb({ lufs: -30, peak_db: -9.94 }), 8.9);
  assert.strictEqual(loudness.gainDb({ lufs: -30, peak_db: -9.9 }), 8.9);
});

test('a worker that dies or hangs: the file is tried once more in a fresh worker, then counted as failed', async () => {
  process.env.VAULT_FLOW_TEST_HOOKS = '1';
  const pool = require('../lib/flow/pool');
  pool.stop();
  try {
    const marker = path.join(tmp, 'crash-once');
    const r = await pool.measure(`:crash-once:${marker}`, {});
    assert.strictEqual(r.fromRetry, true, 'answered by the fresh worker');
    await assert.rejects(pool.measure(':crash', {}), (e) => e.code === 'WORKER_EXIT');
    const hang = path.join(tmp, 'hang-once');
    const t0 = Date.now();
    const r2 = await pool.measure(`:hang-once:${hang}`, { watchdogMs: 300 });
    assert.strictEqual(r2.fromRetry, true);
    assert.ok(Date.now() - t0 < 5000);
    await assert.rejects(pool.measure(':hang', { watchdogMs: 200 }), (e) => e.code === 'HUNG');
  } finally {
    pool.stop();
    delete process.env.VAULT_FLOW_TEST_HOOKS;
  }
});

test('no peak reading: positive gain is capped at +3 dB', () => {
  assert.strictEqual(loudness.gainDb({ lufs: -40, peak_db: null }), 3);
  assert.strictEqual(loudness.gainDb({ lufs: -10, peak_db: null }), -6, 'turning down is not limited');
});

test('Flow order has its own worker: a file that hangs the measuring worker does not hold it up', async () => {
  process.env.VAULT_FLOW_TEST_HOOKS = '1';
  const pool = require('../lib/flow/pool');
  pool.stop();
  try {
    const hung = pool.measure(':hang', { watchdogMs: 1500 }).catch(e => e);
    await new Promise(r => setTimeout(r, 100));
    const t0 = Date.now();
    const o = await pool.order([{ id: 1, measured: true, music: true, es: 0.9, em: 0.9, ee: 0.9, bs: 120, bm: 120, be: 120 }, { id: 2, measured: true, music: true, es: 0.1, em: 0.1, ee: 0.1, bs: 120, bm: 120, be: 120 }], { shape: 'build' });
    assert.deepStrictEqual(o.order, [2, 1]);
    assert.ok(Date.now() - t0 < 1000, `order answered in ${Date.now() - t0} ms while a file hangs`);
    assert.strictEqual((await hung).code, 'HUNG');
  } finally {
    pool.stop();
    delete process.env.VAULT_FLOW_TEST_HOOKS;
  }
});
