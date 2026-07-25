/**
 * Subtitles — segment text translation to English (SUBTITLES_SPEC §4.2).
 *
 * Primary engine: OPUS-MT via CTranslate2 (local, fast, deterministic).
 *  - Models auto-provision on first use per language pair: a one-shot python
 *    call converts Helsinki-NLP/opus-mt-{src}-en to ct2 int8 into
 *    OPUS_MODEL_DIR/{src}-en and saves the tokenizer next to
 *    it (needs internet ONCE per pair; ~300MB).
 *  - A persistent sidecar (opus_translate.py) then serves line batches.
 *
 * Fallback engine: LM Studio (postChat) — numbered-line batch prompt with
 * count-preserving parsing. Used when provisioning/sidecar fails or when
 * TRANSLATE_ENGINE === 'llm'. Failures are preflighted (hub HEAD request),
 * time-capped, and remembered per pair so a dead pair falls back in
 * milliseconds instead of re-paying the wait on every batch.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const config = require('../../config');
const { netFetch } = require('../net');
const { ROOT } = require('../approot');

const SIDECAR = path.join(__dirname, 'opus_translate.py');
const PYTHON = process.env.PYTHON_PATH || 'python';

// Resilient to an older/partial config missing the subtitles block
const SUBS = config.subtitles || {};
const OPUS_MODEL_DIR = process.env.OPUS_MODEL_DIR || SUBS.opusModelDir || path.join(ROOT, 'models', 'opus-mt');
const TRANSLATE_ENGINE = process.env.SUB_TRANSLATE || SUBS.translateEngine || 'opus';

/* ── Model provisioning ─────────────────────────────────────────────────── */

function pairDir(srcLang) {
  return path.join(OPUS_MODEL_DIR, `${srcLang}-en`);
}

function isProvisioned(srcLang) {
  const dir = pairDir(srcLang);
  return fs.existsSync(path.join(dir, 'model.bin'));
}

// The python download path (transformers) retries and hangs for minutes before
// surfacing a failure. Cap the whole provision, and preflight the hub first so
// the two common failures — pair doesn't exist, host unreachable — fail in
// seconds instead. err.code tells callers WHICH failure ('MODEL_UNAVAILABLE'
// is permanent-ish; the rest are retryable).
const PROVISION_TIMEOUT_MS = 15 * 60 * 1000;
const PREFLIGHT_TIMEOUT_MS = 8000;

function _err(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Fast existence check for the pair on the HF hub (plain HTTPS request). */
async function _preflightPair(srcLang, hfModel) {
  let res;
  try {
    res = await netFetch(`https://huggingface.co/api/models/${hfModel}`, {
      method: 'HEAD', signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS), purpose: 'model',
    });
  } catch (e) {
    // Preserve the chokepoint's typed codes: the failure-memo TTL keys on
    // DOWNLOADS_OFF (24h), so don't let it get flattened into MODEL_UNREACHABLE.
    if (e.code === 'DOWNLOADS_OFF' || e.code === 'NET_OFF') throw e;
    throw _err('MODEL_UNREACHABLE',
      `Can't reach huggingface.co to fetch ${srcLang}-en (${String(e.message || e).slice(0, 120)})`);
  }
  if ([401, 403, 404].includes(res.status)) {
    throw _err('MODEL_UNAVAILABLE', `No OPUS-MT ${srcLang}-en model exists to download (${hfModel}: HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw _err('MODEL_UNREACHABLE', `Hugging Face returned HTTP ${res.status} for ${hfModel}`);
  }
}

/**
 * Convert + fetch the OPUS-MT pair (blocking, minutes on first run).
 * Throws fast (typed err.code) if the pair doesn't exist on the hub or the
 * hub is unreachable; the actual download is capped at PROVISION_TIMEOUT_MS.
 */
async function provision(srcLang, onProgress) {
  const dir = pairDir(srcLang);
  fs.mkdirSync(dir, { recursive: true });
  const hfModel = `Helsinki-NLP/opus-mt-${srcLang}-en`;
  await _preflightPair(srcLang, hfModel);
  onProgress?.(`Fetching translation model ${hfModel} (first use)…`);

  const script = `
import sys, warnings
warnings.filterwarnings("ignore")
from ctranslate2.converters import TransformersConverter
from transformers import AutoTokenizer
model, outdir = sys.argv[1], sys.argv[2]
TransformersConverter(model).convert(outdir, quantization="int8", force=True)
AutoTokenizer.from_pretrained(model).save_pretrained(outdir)
print("PROVISION_OK", flush=True)
`;
  await new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, ['-c', script, hfModel, dir], { windowsHide: true });
    let out = '', err = '', settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; clearTimeout(killer); fn(v); } };
    const killer = setTimeout(() => {
      try { proc.kill(); } catch {}
      settle(reject, _err('MODEL_DOWNLOAD_FAILED',
        `OPUS-MT ${srcLang}-en download timed out after ${PROVISION_TIMEOUT_MS / 60000} min`));
    }, PROVISION_TIMEOUT_MS);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      if (code === 0 && out.includes('PROVISION_OK')) settle(resolve, dir);
      else settle(reject, _err('MODEL_DOWNLOAD_FAILED', `OPUS-MT provisioning failed for ${srcLang}-en: ${err.slice(-400)}`));
    });
    proc.on('error', e => settle(reject, e));
  });
  _opusBlocked.delete(srcLang);   // fresh install clears any remembered failure
  return dir;
}

/* ── Failure memo ───────────────────────────────────────────────────────────
 * translateLines runs once per streamed BATCH — without a memo, a dead pair
 * re-attempts the whole download/sidecar dance every few cues (the "takes
 * forever to notice it failed" bug). Remember the failure per language and go
 * straight to the LLM fallback until the TTL lapses. */

const _opusBlocked = new Map();   // srcLang → { code, message, until }
const BLOCK_TTL_MS = {
  MODEL_UNAVAILABLE: 24 * 60 * 60 * 1000,   // pair doesn't exist on the hub
  DOWNLOADS_OFF:     24 * 60 * 60 * 1000,   // config says never download
  default:           10 * 60 * 1000,        // transient (network, sidecar, timeout)
};

function _blockOpus(srcLang, err) {
  const code = err.code || 'OPUS_FAILED';
  const info = { code, message: err.message || String(err) };
  _opusBlocked.set(srcLang, { ...info, until: Date.now() + (BLOCK_TTL_MS[code] || BLOCK_TTL_MS.default) });
  return info;
}

function _blockedInfo(srcLang) {
  const b = _opusBlocked.get(srcLang);
  if (!b) return null;
  if (Date.now() >= b.until) { _opusBlocked.delete(srcLang); return null; }
  return b;
}

/* ── Sidecar (one language pair loaded at a time) ───────────────────────── */

let _server = null;          // { proc, pair, pending: Map, nextId }
let _starting = null;

async function ensureSidecar(srcLang) {
  const pair = `${srcLang}-en`;
  if (_server && _server.pair === pair && _server.ready) return _server;
  if (_starting) { await _starting; if (_server?.pair === pair) return _server; }
  shutdownSidecar();                        // different pair (or dead) — restart

  _starting = new Promise((resolve, reject) => {
    // PYTHONUTF8: Windows Python otherwise decodes stdin as cp1252 and
    // mangles non-ASCII (Japanese/etc.) request JSON
    const proc = spawn(PYTHON, ['-X', 'utf8', '-u', SIDECAR, pairDir(srcLang)], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    const server = { proc, pair, ready: false, pending: new Map(), nextId: 0 };

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'ready') {
        server.ready = true;
        _server = server;
        resolve(server);
      } else if (msg.type === 'result') {
        const p = server.pending.get(msg.id);
        if (p) {
          server.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.lines);
        }
      } else if (msg.type === 'error' && !server.ready) {
        reject(new Error(msg.message));
      }
    });

    proc.on('error', reject);
    proc.on('close', () => {
      for (const [, p] of server.pending) p.reject(new Error('translator closed'));
      server.pending.clear();
      if (_server === server) _server = null;
    });
    setTimeout(() => { if (!server.ready) reject(new Error('translator startup timeout')); }, 60000);
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

function sidecarTranslate(server, lines) {
  return new Promise((resolve, reject) => {
    const id = ++server.nextId;
    server.pending.set(id, { resolve, reject });
    try {
      server.proc.stdin.write(JSON.stringify({ id, lines }) + '\n');
    } catch (err) {
      server.pending.delete(id);
      reject(err);
      return;
    }
    setTimeout(() => {
      if (server.pending.has(id)) {
        server.pending.delete(id);
        reject(new Error('translate batch timeout'));
      }
    }, 120000);
  });
}

/* ── LM Studio fallback ─────────────────────────────────────────────────── */

// Small batches on purpose: local models (especially thinking models) stay on
// task with a short, bounded job. The char cap keeps CJK-dense batches from
// ballooning; the token cap cuts off a runaway reasoning loop after ~a second
// instead of letting it burn a 6000-token budget per batch.
const LLM_BATCH_MAX_LINES = 8;
const LLM_BATCH_MAX_CHARS = 600;

const LANG_NAMES = {
  ja: 'Japanese', zh: 'Chinese', ko: 'Korean', de: 'German', fr: 'French',
  es: 'Spanish', ru: 'Russian', pt: 'Portuguese', it: 'Italian', nl: 'Dutch',
  pl: 'Polish', tr: 'Turkish', ar: 'Arabic', hi: 'Hindi', th: 'Thai',
  vi: 'Vietnamese', id: 'Indonesian', sv: 'Swedish', cs: 'Czech', uk: 'Ukrainian',
  fi: 'Finnish', da: 'Danish', no: 'Norwegian', el: 'Greek', he: 'Hebrew',
  hu: 'Hungarian', ro: 'Romanian',
};
const _langName = (code) => LANG_NAMES[code] || code;

/**
 * Drop <think>…</think> reasoning from a response. Handles the R1 quirk where
 * the opening tag is implicit (content starts mid-think, only </think> appears)
 * and the truncation case (opening tag, budget ran out before the close).
 */
function _stripThink(s) {
  let out = String(s || '');
  const close = out.toLowerCase().lastIndexOf('</think');
  if (close !== -1) out = out.slice(out.indexOf('>', close) + 1);
  const open = out.search(/<think/i);
  if (open !== -1) out = out.slice(0, open);
  return out.trim();
}

/** One-line rescue for a batch line the model dropped or mangled. */
async function _translateSingleLLM(llm, line, srcLang) {
  try {
    const { content } = await llm.postChat([
      { role: 'system', content: 'You are a subtitle translation engine. Translate each numbered line to English exactly as written, no interpretation. Output ONLY the numbered translations, one per line, keeping the same numbers. {%- set enable_thinking = false %}' },
      { role: 'user', content: `Translate this ${_langName(srcLang)} subtitle line to English:\n${line}` },
    ], { temperature: 0.1, maxTokens: Math.min(3000, 1000 + line.length * 10) });
    const first = _stripThink(content).split('\n').map(t => t.trim()).filter(Boolean)[0] || '';
    return first.replace(/^\s*\d+[.)]\s*/, '').replace(/^"(.*)"$/, '$1') || null;
  } catch {
    return null;
  }
}

async function translateLinesLLM(lines, srcLang, { onProgress } = {}) {
  const llm = require('../llm-client');
  const out = new Array(lines.length);
  let done = 0, i = 0;

  while (i < lines.length) {
    // Batch: up to MAX_LINES lines or MAX_CHARS chars, whichever first (min 1)
    let end = i, chars = 0;
    while (end < lines.length && end - i < LLM_BATCH_MAX_LINES) {
      const len = lines[end].length;
      if (end > i && chars + len > LLM_BATCH_MAX_CHARS) break;
      chars += len; end++;
    }
    const chunk = lines.slice(i, end).map(l => l.replace(/\n/g, ' '));
    const numbered = chunk.map((l, j) => `${j + 1}. ${l}`).join('\n');

    const parsed = new Map();
    try {
      const { content } = await llm.postChat([{
        role: 'system',
        content: 'You are a subtitle translation engine. Translate each numbered line to English exactly as written, no interpretation. Output ONLY the numbered translations, one per line, keeping the same numbers. {%- set enable_thinking = false %}',
      }, {
        role: 'user',
        content: `Translate from ${_langName(srcLang)} to English. Output exactly ${chunk.length} numbered line${chunk.length > 1 ? 's' : ''}:\n\n${numbered}`,
      }], { temperature: 0.1, maxTokens: Math.min(3000, 1000 + chars * 20) });

      const body = _stripThink(content);
      for (const line of body.split('\n')) {
        const m = line.match(/^\s*(\d+)[.)]\s*(.+)$/);
        if (m) parsed.set(Number(m[1]), m[2].trim());
      }
      // Terse models sometimes drop the numbering but keep order + count —
      // accept positionally rather than paying a per-line rescue round.
      if (!parsed.size) {
        const bare = body.split('\n').map(t => t.trim()).filter(Boolean);
        if (bare.length === chunk.length) bare.forEach((t, j) => parsed.set(j + 1, t));
      }
    } catch (err) {
      console.warn(`[Subtitles] LLM batch failed (${String(err.message || err).slice(0, 120)}) — keeping originals`);
    }

    for (let j = 0; j < chunk.length; j++) {
      let text = parsed.get(j + 1);
      if (!text) text = await _translateSingleLLM(llm, chunk[j], srcLang);
      out[i + j] = text || chunk[j];   // untranslated fallthrough beats data loss
    }
    done += chunk.length;
    onProgress?.(`AI translating ${done}/${lines.length} lines (LM Studio)…`);
    i = end;
  }
  return out;
}

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Translate cue texts to English. Engine per config (opus primary, llm
 * fallback); returns a same-length array so cue timings map 1:1.
 * opts.onFallback({ code, message }) fires when OPUS-MT is skipped or fails
 * and the LLM engine takes over (callers surface it as a pill/toast).
 */
async function translateLines(lines, srcLang, { onProgress, onFallback } = {}) {
  if (!lines?.length) return [];
  const engine = TRANSLATE_ENGINE;

  if (engine !== 'llm') {
    // A recent failure for this pair? Don't re-pay the download/sidecar wait
    // on every batch — go straight to the fallback with the remembered reason.
    const blocked = _blockedInfo(srcLang);
    if (blocked) {
      onFallback?.(blocked);
    } else {
      try {
        if (!isProvisioned(srcLang)) {
          // Local-first: an uninstalled language pair needs a one-time download.
          // The explicit "install language pack" action bypasses this; the
          // AUTOMATIC background provision during translation respects the flag
          // and otherwise falls through to the local LM Studio engine.
          if (SUBS.allowModelDownload === false) {
            throw _err('DOWNLOADS_OFF', `OPUS-MT ${srcLang}-en not installed and model downloads are off (SUB_ALLOW_DOWNLOADS=0)`);
          }
          onProgress?.(`Downloading translation model ${srcLang}-en — one-time…`);
          await provision(srcLang, onProgress);
        }
        const server = await ensureSidecar(srcLang);
        const out = [];
        const BATCH = 64;
        for (let i = 0; i < lines.length; i += BATCH) {
          onProgress?.(`Translating ${Math.min(i + BATCH, lines.length)}/${lines.length}…`);
          out.push(...await sidecarTranslate(server, lines.slice(i, i + BATCH)));
        }
        return out;
      } catch (err) {
        const info = _blockOpus(srcLang, err);
        console.warn(`[Subtitles] OPUS-MT unavailable (${info.message.slice(0, 200)}) — falling back to LM Studio`);
        onFallback?.(info);
      }
    }
  }

  return translateLinesLLM(lines, srcLang, { onProgress });
}

/* ── Language-pack management (CLI / API / UI) ──────────────────────────── */

function _dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const st = fs.statSync(path.join(dir, f));
      total += st.isDirectory() ? _dirSize(path.join(dir, f)) : st.size;
    }
  } catch {}
  return total;
}

/** Installed OPUS-MT packs: [{ lang, pair, sizeBytes, path }]. */
function listInstalled() {
  const out = [];
  try {
    for (const name of fs.readdirSync(OPUS_MODEL_DIR)) {
      const dir = path.join(OPUS_MODEL_DIR, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      if (!fs.existsSync(path.join(dir, 'model.bin'))) continue;   // incomplete
      const m = name.match(/^(.+)-en$/);
      out.push({ lang: m ? m[1] : name, pair: name, sizeBytes: _dirSize(dir), path: dir });
    }
  } catch { /* dir doesn't exist yet */ }
  return out.sort((a, b) => a.lang.localeCompare(b.lang));
}

/** Remove an installed pack (frees disk). */
function removePack(srcLang) {
  const dir = pairDir(srcLang);
  if (!fs.existsSync(dir)) return false;
  if (_server && _server.pair === `${srcLang}-en`) shutdownSidecar();  // release the file lock
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = {
  translateLines, isProvisioned, provision, shutdownSidecar, pairDir,
  listInstalled, removePack, OPUS_MODEL_DIR,
};
