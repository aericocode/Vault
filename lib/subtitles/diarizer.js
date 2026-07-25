/**
 * Subtitles — speaker diarization (SUBTITLES_SPEC §4.4).
 *
 * Wraps the diarize_service.py sidecar (sherpa-onnx: pyannote segmentation +
 * CAM++ speaker embeddings, ONNX/CPU — no HuggingFace account needed). The
 * ~35MB models (k2-fsa GitHub releases) download on first use, but that fetch
 * is CONSENT-GATED (SUB_ALLOW_DOWNLOADS / VAULT_OFFLINE, via lib/net.js) — with
 * downloads off, diarize() errors instead of reaching out, and you can
 * pre-place the model files in DIARIZE_MODEL_DIR to run fully offline. Runs
 * ~20× real-time on CPU, so the service kicks it off in parallel with the
 * (GPU) whisper pass — wall-clock cost ≈ free.
 *
 * diarize(wavPath) → [{ start, end, speaker }] speaker turns; the generator
 * then assigns per-word voices and splits cues at speaker changes.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const config = require('../../config');
const { netFetch } = require('../net');
const { ROOT } = require('../approot');

const SIDECAR = path.join(__dirname, 'diarize_service.py');
const PYTHON = process.env.PYTHON_PATH || 'python';

// Resilient to an older/partial config missing the subtitles block
const SUBS = config.subtitles || {};
const MODEL_DIR = process.env.DIARIZE_MODEL_DIR || SUBS.diarizeModelDir ||
  path.join(ROOT, 'models', 'diarize');
const BACKEND = process.env.SUB_DIARIZE_BACKEND || SUBS.diarizeBackend || 'sherpa';

// Ungated model files (k2-fsa GitHub releases — "recongition" typo is real)
const SEG_NAME = 'segmentation-pyannote-3.0.onnx';
const EMB_NAME = 'embedding-3dspeaker-campplus-zh_en.onnx';
const SEG_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2';
const EMB_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx';

/* ── Model provisioning ─────────────────────────────────────────────────── */

function _err(code, message) {
  return Object.assign(new Error(message), { code });
}

function isProvisioned() {
  if (BACKEND === 'pyannote') return true;   // pyannote fetches via HF at load
  return fs.existsSync(path.join(MODEL_DIR, SEG_NAME)) &&
         fs.existsSync(path.join(MODEL_DIR, EMB_NAME));
}

async function _download(url, dest) {
  const res = await netFetch(url, { purpose: 'model' });
  if (!res.ok) throw new Error(`download failed (${res.status}) ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Fetch the sherpa-onnx models (one-time, ~35MB). */
async function provision(onProgress) {
  fs.mkdirSync(MODEL_DIR, { recursive: true });

  const segPath = path.join(MODEL_DIR, SEG_NAME);
  if (!fs.existsSync(segPath)) {
    onProgress?.('Fetching speaker segmentation model (first use)…');
    const tarPath = path.join(MODEL_DIR, 'seg.tar.bz2');
    await _download(SEG_URL, tarPath);
    // Windows 10+/macOS/Linux all ship a bz2-capable tar
    await new Promise((resolve, reject) => {
      const p = spawn('tar', ['-xjf', tarPath, '-C', MODEL_DIR], { windowsHide: true });
      p.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)));
      p.on('error', reject);
    });
    const extracted = path.join(MODEL_DIR, 'sherpa-onnx-pyannote-segmentation-3-0');
    fs.renameSync(path.join(extracted, 'model.onnx'), segPath);
    fs.rmSync(extracted, { recursive: true, force: true });
    fs.rmSync(tarPath, { force: true });
  }

  const embPath = path.join(MODEL_DIR, EMB_NAME);
  if (!fs.existsSync(embPath)) {
    onProgress?.('Fetching speaker embedding model (first use)…');
    await _download(EMB_URL, embPath);
  }
}

/* ── Sidecar lifecycle (same shape as the OPUS-MT sidecar) ──────────────── */

let _server = null;          // { proc, ready, pending: Map, nextId }
let _starting = null;

async function ensureSidecar() {
  if (_server?.ready) return _server;
  if (_starting) return _starting;

  _starting = new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, ['-X', 'utf8', '-u', SIDECAR, BACKEND, MODEL_DIR], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: {
        ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
        // The pyannote backend fetches its models from HuggingFace at load
        // time — hard-offline mode must forbid that reach in the sidecar too,
        // since it can't route through lib/net.js.
        ...(config.net?.offline ? { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } : {}),
      },
    });
    const server = { proc, ready: false, pending: new Map(), nextId: 0 };

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'ready') {
        server.ready = true;
        _server = server;
        resolve(server);
      } else if (msg.type === 'progress') {
        try { server.pending.get(msg.id)?.onPct?.(msg.pct); } catch {}
      } else if (msg.type === 'result') {
        const p = server.pending.get(msg.id);
        if (p) {
          server.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.turns);
        }
      } else if (msg.type === 'error' && !server.ready) {
        reject(new Error(msg.message));
      }
    });

    proc.on('error', reject);
    proc.on('close', () => {
      for (const [, p] of server.pending) p.reject(new Error('diarizer closed'));
      server.pending.clear();
      if (_server === server) _server = null;
    });
    // pyannote's first run downloads models from HF; sherpa loads in ~1s
    setTimeout(() => { if (!server.ready) reject(new Error('diarizer startup timeout')); }, 300000);
  }).finally(() => { _starting = null; });

  return _starting;
}

function shutdownSidecar() {
  if (_server) {
    try { _server.proc.stdin.write(JSON.stringify({ command: 'shutdown' }) + '\n'); } catch {}
    try { _server.proc.kill(); } catch {}
    _server = null;
  }
}

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Diarize an audio file → speaker turns [{start, end, speaker}], speakers as
 * opaque labels ("0", "1", … / "SPEAKER_00"). Rejects on any failure — callers
 * treat diarization as best-effort and continue without voices.
 * opts.onPct(0–100) streams chunk progress (sherpa backend, ~2% steps) — the
 * service surfaces it in the pill while the pipeline waits on this pass.
 */
async function diarize(wavPath, { onProgress, onPct, numSpeakers, threshold, timeoutMs = 20 * 60 * 1000 } = {}) {
  if (!isProvisioned()) {
    // Air-gap promise (SETUP.md): with downloads off, never reach out — error
    // with something actionable instead. Caught upstream (service.js) which
    // logs "diarization unavailable (…) — keeping plain cues" and continues.
    if (SUBS.allowModelDownload === false) {
      throw _err('DOWNLOADS_OFF',
        `diarization models not installed and downloads are off (SUB_ALLOW_DOWNLOADS=0 / VAULT_OFFLINE=1). ` +
        `Pre-place ${SEG_NAME} and ${EMB_NAME} in ${MODEL_DIR}, or allow the one-time download.`);
    }
    await provision(onProgress);
  }
  const server = await ensureSidecar();

  return new Promise((resolve, reject) => {
    const id = ++server.nextId;
    server.pending.set(id, { resolve, reject, onPct });
    try {
      server.proc.stdin.write(JSON.stringify({
        id, filepath: wavPath,
        num_speakers: numSpeakers ?? SUBS.diarizeNumSpeakers ?? -1,
        threshold: threshold ?? SUBS.diarizeThreshold ?? 0.5,
      }) + '\n');
    } catch (err) {
      server.pending.delete(id);
      reject(err);
      return;
    }
    setTimeout(() => {
      if (server.pending.has(id)) {
        server.pending.delete(id);
        reject(new Error('diarization timeout'));
      }
    }, timeoutMs);
  });
}

module.exports = { diarize, isProvisioned, provision, shutdownSidecar, MODEL_DIR, BACKEND };
