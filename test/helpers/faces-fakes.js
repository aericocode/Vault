/**
 * Fakes for the face engine contract (FACES_BUILD_SPEC section 2), so the
 * faces suites run with zero models and no network.
 *
 * Embeddings are built from basis vectors: person(i) is the unit vector e_i,
 * and like(i, c, n) is a face whose cosine to person(i) is exactly c (the rest
 * of its length points along e_n, a "noise" axis no person uses).
 *
 * analyzeFile / analyzeFrame answer from scripts keyed by file path (or frame
 * tag), so a test can say "same person in files 1 and 3, someone else in 2".
 */

const fs = require('fs');

const DIM = 128;

function person(i) {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
}

function like(i, c, noise = 100) {
  const v = new Float32Array(DIM);
  v[i] = c;
  v[noise] = Math.sqrt(Math.max(0, 1 - c * c));
  return v;
}

/** A group in analyzeFile's result shape. */
function group(embeddings, { appearances = 1, firstTimeS = 0, bbox = [0.1, 0.1, 0.2, 0.2], crop } = {}) {
  const list = Array.isArray(embeddings) ? embeddings : [embeddings];
  return {
    appearances,
    firstTimeS,
    best: { bbox, frameTimeS: firstTimeS, detScore: 0.9, crop: crop || Buffer.from(`crop-${Math.random()}`) },
    exemplars: list.map((embedding, k) => ({ embedding, bbox, frameTimeS: firstTimeS + k, detScore: 0.9 - k * 0.1 })),
  };
}

function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject);
  });
}

/**
 * fileScripts: Map filepath -> { groups } | { error } | { gate: Promise, groups }
 * frameScripts: Map tag -> [{ embedding, bbox, detScore, crop }]
 */
function createFakes({ modelId = 'stub-v1' } = {}) {
  const fileScripts = new Map();
  const frameScripts = new Map();
  const calls = { analyzeFile: [], decodeImage: [], grabFrame: [], aborted: [], loads: 0 };
  let ready = true;

  const engine = {
    modelId,
    async load() { calls.loads++; },
    close() {},
  };

  const analyze = {
    async analyzeFile(eng, file, opts = {}) {
      calls.analyzeFile.push({ file, opts });
      const s = fileScripts.get(file.filepath) || { groups: [] };
      opts.onProgress?.({ fraction: 0.5 });
      if (s.gate) {
        try {
          await abortable(s.gate, opts.signal);
        } catch (err) {
          calls.aborted.push(file.filepath);
          throw err;
        }
      }
      if (s.error) throw new Error(s.error);
      return { framesChecked: 3, groups: s.groups || [] };
    },
    async analyzeFrame(eng, frame) {
      return (frameScripts.get(frame.tag) || []).map(f => ({ detScore: 0.9, landmarks: [], ...f }));
    },
  };

  const frames = {
    async decodeImage(filepath) {
      const exists = fs.existsSync(filepath);
      const tag = exists ? fs.readFileSync(filepath, 'utf8') : filepath;
      calls.decodeImage.push({ filepath, existed: exists, tag });
      if (tag === 'not-an-image') throw new Error('ffmpeg could not decode');
      return { width: 4, height: 4, data: new Uint8Array(48), tag };
    },
    async grabFrame(filepath, timeS) {
      calls.grabFrame.push({ filepath, timeS });
      return { width: 4, height: 4, data: new Uint8Array(48), tag: `${filepath}@${timeS}` };
    },
  };

  const modelStore = {
    entries: () => [],
    status: () => (ready ? { ready: true, missing: [], paths: { 'face:detect': 'x', 'face:embed': 'y' } }
      : { ready: false, missing: ['face:detect', 'face:embed'], paths: {} }),
  };

  return {
    engine, analyze, frames, modelStore, fileScripts, frameScripts, calls,
    engineFactory: () => engine,
    setReady(v) { ready = v; },
  };
}

module.exports = { DIM, person, like, group, createFakes };
