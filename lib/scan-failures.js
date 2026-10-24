/**
 * Failed scans, grouped by WHY, for the scan panel's Failed tab.
 *
 * "AI scan 14/15 · 1 failed" said nothing about which file or why, and a big
 * batch can fail by the thousand for one shared cause. So every
 * processing_error is sorted into a small set of plain reasons (with "Other"
 * for anything new), and the panel shows one line per reason with a count and
 * the first few files, never the whole list.
 *
 * The reasons are read from the database (processing_error), not from what
 * the queue remembered at the time: a file fixed since (Force refresh, a
 * retry that worked, a rescan from the sidebar) drops out of its group on the
 * next look, and one that failed differently moves. The queue only keeps the
 * ids that failed in this run; this module reads them in chunks, yielding to
 * the event loop between chunks, so 100k failures never stall the server.
 */

const { FFPROBE_MISSING_PREFIXES, WHISPER_MISSING_PREFIXES } = require('./processing-errors');

// Current and pre-3.9 wording, lowercased once (classify() lowercases the error).
const TOOL_MISSING_PREFIXES = [...FFPROBE_MISSING_PREFIXES, ...WHISPER_MISSING_PREFIXES].map((p) => p.toLowerCase());

const UNSCANNED = 'unscanned';

/**
 * In the order they are tried: the first match wins, so the specific ones
 * (a missing tool says "not found on PATH") come before the general ones
 * ("not found" = the file is gone).
 */
const REASONS = [
  {
    key: 'tool-missing',
    label: 'A tool Vault needs is missing',
    explain: 'The video tools (ffmpeg) or the transcription tools are not installed. Install them, then retry.',
    test: (e) => TOOL_MISSING_PREFIXES.some((p) => e.startsWith(p)) || /not found on path|ffmpeg is not installed/.test(e),
  },
  {
    key: 'interrupted',
    label: 'Kept interrupting the scan',
    explain: 'The model stopped answering three times on this file. Check the model is loaded, then retry.',
    test: (e) => e.startsWith('repeatedly interrupted'),
  },
  {
    key: 'missing-file',
    label: 'File not found',
    explain: 'The file was moved, renamed or deleted, or its drive is not connected.',
    test: (e) => /enoent|no such file|cannot find the (?:file|path)|file not found|source file missing/.test(e),
  },
  {
    key: 'media-info',
    label: 'Could not read media info',
    explain: 'The file may be damaged, still being copied, or use a codec ffmpeg cannot read. If it was still copying, use Force refresh.',
    test: (e) => /could not read media info|error probing|invalid data found|moov atom not found/.test(e),
  },
  {
    key: 'no-frames',
    label: 'Could not take pictures from the file',
    explain: 'No frames could be read. The file may be damaged, cut short or use an unsupported codec.',
    test: (e) => /no frames|frame extraction/.test(e),
  },
  {
    key: 'unsupported',
    label: 'File type not supported',
    explain: 'Vault has no way to analyse this kind of file.',
    test: (e) => /no processor for file type|unsupported file type/.test(e),
  },
  {
    key: 'model-unavailable',
    label: 'The scan model was not available',
    explain: 'No model answered when this file was scanned. Retry once the scan model is loaded.',
    test: (e) => /multiple models|model not found|model_not_found|no models? (?:are )?loaded|is not loaded|model unloaded|nothing is listening|lost the connection/.test(e),
  },
  {
    key: 'no-answer',
    label: 'The model returned no usable answer',
    explain: 'Often a timeout on very long videos, or a reply that was cut off. Retrying usually works.',
    test: (e) => /could not be parsed|json|empty response|timed? ?out|timeout|aborted|unexpected end/.test(e),
  },
  {
    key: 'model-rejected',
    label: 'The model refused the request',
    explain: 'The model could not take this file, for example too many pictures for its context length, or a model that cannot read pictures.',
    test: (e) => /api error: 4\d\d|context|too large|too long|exceeds|does not support|image input/.test(e),
  },
  {
    key: 'model-error',
    label: 'The model server had an error',
    explain: 'LM Studio returned an error or the connection dropped while it answered. Retrying usually works.',
    test: (e) => /api error: 5\d\d|fetch failed|econnreset|socket|server error/.test(e),
  },
];

const OTHER = {
  key: 'other',
  label: 'Other',
  explain: 'Something else went wrong. Copy list has the full message for each file.',
};

const BY_KEY = new Map([...REASONS, OTHER].map(r => [r.key, r]));

/** The reason key for one processing_error. */
function classify(error) {
  const e = String(error || '').trim().toLowerCase();
  if (!e) return OTHER.key;
  for (const r of REASONS) if (r.test(e)) return r.key;
  return OTHER.key;
}

/** label + explanation for a key. */
function reasonInfo(key) {
  const r = BY_KEY.get(key) || OTHER;
  return { key: r.key, label: r.label, explain: r.explain };
}

/** Is this row still failed? 'unscanned' and empty mean it was reset or fixed. */
function isFailedError(err) {
  return typeof err === 'string' && err !== '' && err !== UNSCANNED;
}

function _folderOf(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i > 0 ? s.slice(0, i) : '';
}

/**
 * Group rows by reason. Biggest group first, Other always last.
 * @param {Iterable<{id, filepath, filename, processing_error}>} rows
 * @param {{ sample?: number }} [o] files kept per group
 */
function groupRows(rows, { sample = 5 } = {}) {
  const groups = new Map();
  let total = 0;
  for (const row of rows) {
    if (!isFailedError(row.processing_error)) continue;
    total++;
    const key = classify(row.processing_error);
    let g = groups.get(key);
    if (!g) { g = { ...reasonInfo(key), count: 0, sample: [] }; groups.set(key, g); }
    g.count++;
    if (g.sample.length < sample) {
      g.sample.push({
        id: row.id,
        filename: row.filename,
        folder: _folderOf(row.filepath),
        error: String(row.processing_error).slice(0, 300),
      });
    }
  }
  const list = [...groups.values()].sort((a, b) =>
    (a.key === OTHER.key) - (b.key === OTHER.key) || b.count - a.count || a.label.localeCompare(b.label));
  return { total, groups: list };
}

const CHUNK = 900;                    // under SQLite's 999 bound-parameter floor
const _yield = () => new Promise(r => setImmediate(r));

/**
 * Read rows for `ids` in chunks, yielding between chunks.
 * `each(row)` sees every row found (fixed ones included).
 */
async function readRows(handle, ids, each) {
  const list = Array.isArray(ids) ? ids : [...ids];
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const rows = handle.prepare(
      `SELECT id, filepath, filename, processing_error FROM media WHERE id IN (${chunk.map(() => '?').join(',')})`
    ).all(...chunk);
    for (const r of rows) each(r);
    if (i + CHUNK < list.length) await _yield();
  }
}

/**
 * The Failed tab's payload for a set of ids.
 * @returns {Promise<{ total, groups, cleared: number[] }>} `cleared` = ids
 *   that are no longer failed (fixed, reset or deleted), so the caller can
 *   forget them
 */
async function collect(handle, ids, { sample = 5 } = {}) {
  const want = new Set(ids);
  const seen = new Set();
  const failed = [];
  const cleared = [];
  await readRows(handle, want, (r) => {
    seen.add(r.id);
    if (isFailedError(r.processing_error)) failed.push(r); else cleared.push(r.id);
  });
  for (const id of want) if (!seen.has(id)) cleared.push(id);     // the row is gone
  const out = groupRows(failed, { sample });
  return { ...out, cleared };
}

/** Ids among `ids` that are still failed, optionally only those of one reason. */
async function idsFor(handle, ids, key = null) {
  const out = [];
  await readRows(handle, ids, (r) => {
    if (!isFailedError(r.processing_error)) return;
    if (key && classify(r.processing_error) !== key) return;
    out.push(r.id);
  });
  return out;
}

/** "path<TAB>reason: message" per failed file, for Copy list. */
async function asText(handle, ids) {
  const lines = [];
  await readRows(handle, ids, (r) => {
    if (!isFailedError(r.processing_error)) return;
    const info = reasonInfo(classify(r.processing_error));
    lines.push(`${r.filepath}\t${info.label}: ${String(r.processing_error).replace(/\s+/g, ' ').trim()}`);
  });
  return lines.join('\r\n');
}

module.exports = {
  classify, reasonInfo, groupRows, collect, idsFor, asText, isFailedError,
  REASONS, OTHER,
};
