/**
 * Flow's "has music" decision (lib/flow/analyze.js, lib/audio/dsp.js
 * estimateTempo) on synthetic audio made here in memory (never played, no
 * media files): what a real library showed it must tell apart.
 *
 *   music:     dense, limited mixes with a sidechained pad and loud
 *              off-beat voices over them (the PMV and EDM files the older
 *              detector called "no music"), a compilation that changes tempo
 *              half way, a talk intro before the beat, drum and bass;
 *   not music: speech-like bursts with pauses, several voices at once,
 *              noise, noise with a fast tremolo, a beatless ambient pad,
 *              a held tone.
 *
 * The thresholds checked (music scores at least 0.25, the rest at most 0.17)
 * are the margins the 96-file evaluation of the method showed.
 */

const test = require('node:test');
const assert = require('node:assert');

const dsp = require('../lib/audio/dsp');
const analyze = require('../lib/flow/analyze');

const SR = 22050;

/** A small seeded random source (mulberry32), so every run makes the same audio. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Voice-like bursts: harmonics of a drifting pitch, shaped like syllables, off any beat. */
function addVoices(out, rand, { rate = 3, amp = 0.6, from = 0, to = out.length / SR, phrases = false } = {}) {
  let t = from;
  let phraseEnd = from + 1.5 + rand() * 2.5;
  while (t < to) {
    const dur = 0.1 + rand() * 0.3;
    const f0 = 110 + rand() * 140;
    const a = Math.round(t * SR), n = Math.round(dur * SR);
    for (let i = 0; i < n && a + i < out.length; i++) {
      const x = i / n, f = f0 * (1 + 0.1 * x);
      const env = Math.sin(Math.PI * x) ** 2;
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * (i / SR)) / h;
      out[a + i] += amp * env * v * 0.5;
    }
    t += dur + rand() * (1 / rate);
    if (phrases && t > phraseEnd) { t += 0.25 + rand() * 0.6; phraseEnd = t + 1.5 + rand() * 2.5; }
  }
}

/**
 * A dense, limited mix: a kick on every beat, hats on the off-beats, a noisy
 * chord pad ducked by the kick (sidechain), loud voices over it, then
 * squashed by a soft limiter so the overall level barely moves.
 */
function denseMix(bpm, seconds, { seed = 1, voices = true, from = 0 } = {}) {
  const rand = rng(seed);
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const P = 60 / bpm;
  let lp = 0;
  for (let i = Math.round(from * SR); i < n; i++) {
    const t = i / SR, ph = t % P, ph8 = (t + P / 2) % P;
    const kick = Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-ph * 40)) * ph) * Math.exp(-ph * 12);
    const noise = rand() * 2 - 1;
    const hat = (noise - lp) * Math.exp(-ph8 * 60);
    lp = 0.7 * lp + 0.3 * noise;
    const duck = 0.35 + 0.65 * (1 - Math.exp(-ph * 6));
    const pad = (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t) + 0.6 * lp) * 0.25 * duck;
    out[i] = 0.9 * kick + 0.25 * hat + pad;
  }
  if (voices) addVoices(out, rand, { from, amp: 0.7 });
  for (let i = 0; i < n; i++) out[i] = Math.tanh(2.5 * out[i]) * 0.8;
  return out;
}

/** Speech-like: syllables in phrases with pauses between them, over a faint room tone. */
function speechLike(seconds, seed = 7, voices = 1) {
  const rand = rng(seed);
  const out = new Float32Array(Math.round(seconds * SR));
  for (let v = 0; v < voices; v++) addVoices(out, rand, { rate: 5, amp: 0.5, phrases: voices === 1, from: v * 0.37 });
  for (let i = 0; i < out.length; i++) out[i] += (rand() * 2 - 1) * 0.003;
  return out;
}

function noise(seconds, { seed = 3, tremoloHz = 0 } = {}) {
  const rand = rng(seed);
  const out = new Float32Array(Math.round(seconds * SR));
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    lp = 0.8 * lp + 0.2 * (rand() * 2 - 1);
    const g = tremoloHz ? 1 - 0.3 * (0.5 + 0.5 * Math.sin(2 * Math.PI * tremoloHz * i / SR)) : 1;
    out[i] = 0.4 * lp * g;
  }
  return out;
}

function ambientPad(seconds) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    out[i] = 0.12 * (1 + 0.3 * Math.sin(2 * Math.PI * 0.07 * t)) * (Math.sin(2 * Math.PI * 110 * t) + 0.6 * Math.sin(2 * Math.PI * 164.8 * t)
      + 0.5 * Math.sin(2 * Math.PI * 220.5 * t) + 0.3 * Math.sin(2 * Math.PI * 329.2 * t + Math.sin(2 * Math.PI * 0.3 * t)));
  }
  return out;
}

function concat(...parts) {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** measureFile on mono samples through a fake decoder (stereo, as a file would be). */
async function measure(mono) {
  const d = mono.length / SR;
  const extract = async (file, o) => {
    const a = Math.round((o.start || 0) * SR);
    const b = Math.min(mono.length, a + Math.round((o.duration || d) * SR));
    const s = new Float32Array((b - a) * 2);
    for (let i = a; i < b; i++) { s[2 * (i - a)] = mono[i]; s[2 * (i - a) + 1] = mono[i]; }
    return { samples: s, sampleRate: SR, channels: 2, truePeakDb: -1 };
  };
  const probe = async () => ({ channels: 2, layout: 'stereo', sampleRate: 44100, duration: d });
  return analyze.measureFile('synthetic', { extract, probe });
}

test('dense, limited mixes with loud voices over them are music, at their tempo', async () => {
  for (const [bpm, seed] of [[120, 1], [128, 2], [140, 3]]) {
    const r = await measure(denseMix(bpm, 90, { seed }));
    assert.strictEqual(r.has_music, 1, `${bpm}: score ${r.bpm_conf}`);
    assert.ok(r.bpm_conf >= 0.25, `${bpm}: score ${r.bpm_conf}`);
    for (const k of ['bpm_start', 'bpm_mid', 'bpm_end']) assert.ok(Math.abs(r[k] - bpm) <= 1.5, `${bpm}: ${k} ${r[k]}`);
  }
});

test('a compilation that changes tempo, a talk intro, drum and bass: music', async () => {
  const comp = await measure(concat(denseMix(100, 60, { seed: 4 }), denseMix(128, 60, { seed: 5 })));
  assert.strictEqual(comp.has_music, 1, `compilation: ${comp.bpm_conf}`);
  assert.ok(Math.abs(comp.bpm_start - 100) <= 1.5 && Math.abs(comp.bpm_end - 128) <= 1.5, `${comp.bpm_start} .. ${comp.bpm_end}`);
  // 40 s of talk, then the beat: the start window has none, the other two decide.
  const intro = await measure(concat(speechLike(40, 11), denseMix(126, 100, { seed: 6 })));
  assert.strictEqual(intro.has_music, 1, `talk intro: ${intro.bpm_conf}`);
  assert.ok(Math.abs(intro.bpm_start - 126) <= 1.5, `the talk window borrows the beat's tempo: ${intro.bpm_start}`);
  const dnb = await measure(denseMix(174, 90, { seed: 8 }));
  assert.strictEqual(dnb.has_music, 1);
  assert.ok(Math.abs(dnb.bpm_mid - 174) <= 2, `drum and bass at ${dnb.bpm_mid}`);
});

test('speech, voices, noise, a fast tremolo, a beatless pad and a held tone: not music', async () => {
  const cases = {
    speech: speechLike(90, 7),
    'speech, another voice': speechLike(90, 21),
    'several voices at once': speechLike(90, 9, 4),
    noise: noise(90),
    'noise with a 6 Hz tremolo': noise(90, { tremoloHz: 6 }),
    'beatless ambient pad': ambientPad(120),
    'held tone': Float32Array.from({ length: SR * 60 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / SR)),
  };
  for (const [name, mono] of Object.entries(cases)) {
    const r = await measure(mono);
    assert.strictEqual(r.has_music, 0, `${name}: score ${r.bpm_conf}`);
    assert.ok(r.bpm_conf <= 0.17, `${name}: score ${r.bpm_conf}`);
    assert.strictEqual(r.bpm_mid, null);
  }
});

test('a scene with a few seconds of intro music is not called music (two windows decide)', async () => {
  const r = await measure(concat(denseMix(124, 25, { seed: 12, voices: false }), speechLike(155, 13)));
  assert.strictEqual(r.has_music, 0, `score ${r.bpm_conf}`);
});

test('estimateTempo: a score and a confidence, both 0 for silence', () => {
  const t = dsp.estimateTempo(denseMix(128, 30, { seed: 14 }), SR);
  assert.ok(Math.abs(t.bpm - 128) <= 1.5, `${t.bpm}`);
  assert.ok(t.score >= t.confidence && t.score > 0.25, JSON.stringify(t));
  assert.deepStrictEqual(dsp.estimateTempo(new Float32Array(SR * 10), SR), { bpm: null, confidence: 0, score: 0 });
});
