/**
 * Subtitles — cue shaping + VTT/SRT assembly (SUBTITLES_SPEC §4.3).
 *
 * Input: whisper segments [{start, end, text, words:[{start,end,word}]}].
 * Output: display-ready cues → WebVTT (stored) / SRT (derived on download).
 *
 * Shaping rules:
 *  - a cue holds ≤ 2 lines × ~MAX_LINE chars, split at WORD boundaries using
 *    the word timestamps (never mid-phrase guesses)
 *  - min cue duration MIN_CUE_S (stretched into following gap when possible)
 *  - micro-segments merge into the previous cue when the gap is tiny
 *  - cues carry an optional `voice` (speaker tag) — emitted as <v N>text</v>;
 *    detection is a v1.5 stage, but the format + renderer support it now
 */

const MAX_LINE = 42;          // chars per line
const MAX_LINES = 2;          // lines per cue
const MAX_CUE_CHARS = MAX_LINE * MAX_LINES;
const MIN_CUE_S = 0.7;        // minimum on-screen time
const MERGE_GAP_S = 0.4;      // micro-segment merge window
const MICRO_CHARS = 20;       // "micro" segment threshold

/* ── Text normalization ─────────────────────────────────────────────────── */

const _ENTITIES = {
  '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&#x27;': "'",
};

// Known subtitle markup tags to strip, in escaped (&lt;i&gt;) and literal (<i>)
// form. Strip these FIRST, then decode remaining entities — so a genuine
// "x &lt; y" in dialogue survives as "x < y" instead of looking like a tag.
const _TAG_ESC = /&lt;\/?(?:i|b|u|font[^&]*?)&gt;/gi;
const _TAG_LIT = /<\/?(?:i|b|u|font[^>]*?)>/gi;

/**
 * Clean model/subtitle artifacts out of cue text: strip italic/bold/underline/
 * font markup and ASS/SSA {\…} overrides, then decode HTML entities that turbo
 * sometimes emits (it was trained on subtitle files). Fixes "&lt;i&gt;What?".
 * NOTE: run on inner text only — WebVTT <v speaker> tags live in cue.voice.
 */
function normalizeCueText(s) {
  if (!s) return '';
  s = s.replace(_TAG_ESC, '').replace(_TAG_LIT, '');
  s = s.replace(/\{\\?[^}]*\}/g, '');       // {\an8} etc.
  s = s.replace(/&(?:lt|gt|amp|quot|apos|nbsp|#39|#x27);/gi, m => _ENTITIES[m.toLowerCase()] || m);
  return s.replace(/[ \t]+/g, ' ').trim();
}

/* ── Cue shaping ────────────────────────────────────────────────────────── */

/**
 * Turn whisper segments into display cues.
 * @returns [{ start, end, text, voice? }]
 */
function shapeCues(segments) {
  const cues = [];

  for (const seg of segments || []) {
    const text = normalizeCueText(seg.text || '');
    if (!text) continue;

    // Micro-segment: glue onto the previous cue when nearly contiguous
    const prev = cues[cues.length - 1];
    if (prev && text.length <= MICRO_CHARS &&
        (seg.start - prev.end) <= MERGE_GAP_S &&
        (prev.text.length + text.length + 1) <= MAX_CUE_CHARS &&
        (prev.voice || null) === (seg.voice || null)) {
      prev.text = `${prev.text} ${text}`;
      prev.end = seg.end;
      continue;
    }

    if (text.length <= MAX_CUE_CHARS || !Array.isArray(seg.words) || seg.words.length === 0) {
      // Fits in one cue (or no word timing to split with)
      cues.push({ start: seg.start, end: seg.end, text, voice: seg.voice || null });
      continue;
    }

    // Split the segment into ≤MAX_CUE_CHARS chunks at word boundaries,
    // timing each chunk by its first/last word. Words keep whisper's own
    // spacing (EN tokens carry a leading space, JA/zh tokens none), so join
    // with '' — join(' ') would shove spaces between Japanese characters.
    let chunk = [];
    let chunkLen = 0;
    const flush = () => {
      if (!chunk.length) return;
      cues.push({
        start: chunk[0].start,
        end: chunk[chunk.length - 1].end,
        text: normalizeCueText(chunk.map(w => w.word).join('')),
        voice: seg.voice || null,
      });
      chunk = [];
      chunkLen = 0;
    };
    for (const w of seg.words) {
      const wordLen = w.word.trim().length + (chunk.length ? 1 : 0);
      if (chunkLen + wordLen > MAX_CUE_CHARS && chunk.length) flush();
      chunk.push(w);
      chunkLen += wordLen;
    }
    flush();
  }

  // Enforce minimum duration by stretching into the following gap
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (cue.end - cue.start < MIN_CUE_S) {
      const limit = i + 1 < cues.length ? cues[i + 1].start : cue.start + MIN_CUE_S;
      cue.end = Math.max(cue.end, Math.min(cue.start + MIN_CUE_S, limit));
    }
  }

  return cues;
}

/* ── Speaker assignment (diarization → voiced segments) ─────────────────── */

/**
 * Build a `(time) → speaker` lookup over diarization turns: the turn
 * containing `time`, else the nearest one (diarization trims turn edges
 * tighter than whisper times words, so gap words snap to the closest turn).
 * @param {Array} turns - [{start, end, speaker}] (need not be pre-sorted)
 */
function buildSpeakerAt(turns) {
  const sorted = (turns || []).filter(t => t && t.end > t.start).sort((a, b) => a.start - b.start);
  return (time) => {
    if (!sorted.length) return null;
    let lo = 0, hi = sorted.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].start <= time) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    const cur = sorted[idx];
    if (time >= cur.start && time < cur.end) return cur.speaker;
    const distCur = time < cur.start ? cur.start - time : time - cur.end;
    const next = sorted[idx + 1];
    if (next && (next.start - time) < distCur) return next.speaker;
    return cur.speaker;
  };
}

/**
 * Merge diarization turns into whisper segments (SUBTITLES_SPEC §4.4).
 *
 * Each word is assigned the speaker whose turn contains its midpoint; segments
 * are then split into same-speaker runs, so a cue never straddles a speaker
 * change (shapeCues() keeps the resulting `voice` on every cue it emits).
 * `resolveName(rawSpeaker) → label|null` maps a diarization speaker id to the
 * displayed voice — the full-gen path (assignVoices) numbers by first
 * appearance; the "Fix here" path maps to the track's existing speaker names.
 *
 * @param {Array} segments - whisper segments [{start, end, text, words}]
 * @param {Array} turns - diarization turns [{start, end, speaker}]
 * @param {Function} resolveName - rawSpeaker → display label (or null)
 * @returns voiced segments, or null when there are no turns
 */
function voiceSegments(segments, turns, resolveName) {
  const sorted = (turns || []).filter(t => t && t.end > t.start).sort((a, b) => a.start - b.start);
  if (!sorted.length) return null;
  const speakerAt = buildSpeakerAt(sorted);

  // Majority speaker by overlapped duration (fallback for word-less segments)
  const majoritySpeaker = (start, end) => {
    const acc = new Map();
    for (const t of sorted) {
      if (t.end <= start) continue;
      if (t.start >= end) break;
      const ov = Math.min(end, t.end) - Math.max(start, t.start);
      if (ov > 0) acc.set(t.speaker, (acc.get(t.speaker) || 0) + ov);
    }
    if (!acc.size) return speakerAt((start + end) / 2);
    return [...acc.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };

  const out = [];
  for (const seg of segments || []) {
    const words = Array.isArray(seg.words)
      ? seg.words.filter(w => w && w.word && w.end != null && w.start != null)
      : [];

    if (!words.length) {
      out.push({ ...seg, voice: resolveName(majoritySpeaker(seg.start, seg.end)) || null });
      continue;
    }

    // Split into same-speaker word runs. Words keep whisper's own spacing
    // (EN " word" / JA no space), so runs re-join with ''.
    let run = [], runSpk = null;
    const flush = () => {
      if (!run.length) return;
      out.push({
        start: run[0].start,
        end: run[run.length - 1].end,
        text: run.map(w => w.word).join('').trim(),
        words: run,
        voice: resolveName(runSpk) || null,
      });
      run = [];
    };
    for (const w of words) {
      const spk = speakerAt((w.start + w.end) / 2);
      if (run.length && spk !== runSpk) flush();
      runSpk = spk;
      run.push(w);
    }
    flush();
  }
  return out;
}

/**
 * Number diarization speakers "Speaker 1..N" by order of first appearance
 * (matching the renderer's first-seen-gets-white palette). Deterministic for a
 * given set of turns — the "Fix here" full-file fallback relies on this so a
 * fresh diarization reproduces the same names the initial generation used.
 * @returns { name: (rawSpeaker) => label|null, count }
 */
function speakerNamer(turns) {
  const sorted = (turns || []).filter(t => t && t.end > t.start).sort((a, b) => a.start - b.start);
  const nameOf = new Map();
  for (const t of sorted) {
    if (!nameOf.has(t.speaker)) nameOf.set(t.speaker, `Speaker ${nameOf.size + 1}`);
  }
  return { name: (raw) => (raw == null ? null : nameOf.get(raw) || null), count: nameOf.size };
}

/**
 * Full-generation speaker assignment. Returns null for a monologue (<2
 * speakers) — voice tags would add noise, so callers keep the plain cues.
 */
function assignVoices(segments, turns) {
  const { name, count } = speakerNamer(turns);
  if (count < 2) return null;
  return voiceSegments(segments, turns, name);
}

/** Wrap cue text into ≤MAX_LINES display lines at word boundaries. */
function wrapCueText(text) {
  if (text.length <= MAX_LINE) return text;
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line.length + 1 + w.length) > MAX_LINE && lines.length < MAX_LINES - 1) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/* ── Time formatting ────────────────────────────────────────────────────── */

function vttTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = (s % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${rest}`;
}

function srtTime(sec) {
  return vttTime(sec).replace('.', ',');
}

/* ── Serializers ────────────────────────────────────────────────────────── */

/**
 * Cues → WebVTT. Voice-tagged cues emit `<v Sn>text</v>` so the renderer can
 * color/position speakers (SUBTITLES_SPEC §4.4).
 */
function toVTT(cues, { lang = '', kind = '' } = {}) {
  const header = ['WEBVTT'];
  if (lang) header.push(`X-LANG: ${lang}`);
  if (kind) header.push(`X-KIND: ${kind}`);
  const body = cues.map((cue, i) => {
    const text = wrapCueText(cue.text);
    const payload = cue.voice ? `<v ${cue.voice}>${text}</v>` : text;
    return `${i + 1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${payload}`;
  });
  return header.join('\n') + '\n\n' + body.join('\n\n') + '\n';
}

/** VTT file header (written once, then cue blocks are appended — streaming). */
function vttHeader(lang = '', kind = '') {
  const h = ['WEBVTT'];
  if (lang) h.push(`X-LANG: ${lang}`);
  if (kind) h.push(`X-KIND: ${kind}`);
  return h.join('\n') + '\n\n';
}

/** One appendable, unnumbered VTT cue block (valid WebVTT — the index line is
 *  optional, which is what lets us append without renumbering the whole file). */
function cueToVTTBlock(cue) {
  const text = wrapCueText(cue.text);
  const payload = cue.voice ? `<v ${cue.voice}>${text}</v>` : text;
  return `${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${payload}\n\n`;
}

/** Cues → SRT (voice tags stripped — SRT has no styling standard). */
function toSRT(cues) {
  return cues.map((cue, i) =>
    `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${wrapCueText(cue.text)}`
  ).join('\n\n') + '\n';
}

/**
 * Parse a stored VTT back into cues (server-side SRT derivation + tests).
 * Handles the subset this module writes: numbered cues, optional <v> tags.
 */
function parseVTT(vtt) {
  const cues = [];
  const blocks = String(vtt).replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    const timeIdx = lines.findIndex(l => l.includes('-->'));
    if (timeIdx === -1) continue;
    const m = lines[timeIdx].match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
    if (!m) continue;
    let text = lines.slice(timeIdx + 1).join('\n');
    let voice = null;
    const vm = text.match(/^<v\s+([^>]+)>([\s\S]*?)(<\/v>)?$/);
    if (vm) { voice = vm[1].trim(); text = vm[2]; }
    cues.push({ start: parseVttTime(m[1]), end: parseVttTime(m[2]), text: text.replace(/<\/v>\s*$/, '').trim(), voice });
  }
  return cues;
}

function parseVttTime(t) {
  const parts = t.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** Cues (or raw segments) → plain transcript text for `transcribed_text`. */
function toPlainText(cuesOrSegments) {
  return (cuesOrSegments || []).map(c => (c.text || '').replace(/\n/g, ' ').trim()).filter(Boolean).join(' ');
}

/** Cues → timestamped plain text ("[m:ss] line …") for AI-chat dossiers. */
function toTimestampedText(cues) {
  return (cues || []).map(c => {
    const m = Math.floor(c.start / 60);
    const s = String(Math.floor(c.start % 60)).padStart(2, '0');
    return `[${m}:${s}] ${(c.text || '').replace(/\n/g, ' ').trim()}`;
  }).join('\n');
}

module.exports = {
  shapeCues, assignVoices, voiceSegments, buildSpeakerAt, speakerNamer,
  wrapCueText, toVTT, toSRT, parseVTT, toPlainText, toTimestampedText,
  vttHeader, cueToVTTBlock, normalizeCueText, vttTime, srtTime,
  MAX_LINE, MAX_LINES, MIN_CUE_S,
};
