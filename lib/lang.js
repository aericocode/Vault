/**
 * Language canonicalization — one source of truth for turning the AI's varied
 * language values into a stable form.
 *
 * The raw `media.language` column is left UNTOUCHED (whisper writes ISO codes
 * like "ja"; the vision model free-writes names like "English"; both, plus case
 * variants, coexist). Everything user-facing runs through here instead:
 *   canonLang(raw) → ISO code | 'none' | null   (for grouping/counting)
 *   langName(raw)  → human name | 'None' | 'Unknown'   (for display)
 *
 * "none" (instrumental / no spoken language) is kept DISTINCT from "Unknown"
 * (couldn't be mapped) — they mean different things to a viewer.
 */

// code → display name (covers whisper's common outputs + the viewer's subtitle
// language set). Add rows here as new languages show up; everything else falls
// through to "Unknown", so this never has to be exhaustive.
const NAMES = {
  en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', es: 'Spanish',
  fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian',
  ar: 'Arabic', hi: 'Hindi', nl: 'Dutch', pl: 'Polish', tr: 'Turkish',
  th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', sv: 'Swedish', cs: 'Czech',
  uk: 'Ukrainian', el: 'Greek', he: 'Hebrew', fi: 'Finnish', da: 'Danish',
  hu: 'Hungarian', ro: 'Romanian', no: 'Norwegian', tl: 'Tagalog', fa: 'Persian',
  ms: 'Malay', ta: 'Tamil',
};

// Values that mean "no spoken language", not a failure to detect.
const NONE = new Set(['none', 'n/a', 'na', 'not applicable', 'null', 'instrumental', 'silent']);

// raw (lowercased) → canonical code. Codes map to themselves; full names and a
// few common aliases/regional variants fold in.
const LOOKUP = {};
for (const [code, name] of Object.entries(NAMES)) {
  LOOKUP[code] = code;
  LOOKUP[name.toLowerCase()] = code;
}
Object.assign(LOOKUP, {
  'zh-cn': 'zh', 'zh-tw': 'zh', 'mandarin': 'zh', 'cantonese': 'zh',
  'pt-br': 'pt', 'castilian': 'es', 'filipino': 'tl', 'flemish': 'nl',
  'farsi': 'fa',
});

/** Any raw language value → canonical ISO code, 'none', or null (unmappable). */
function canonLang(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (NONE.has(s)) return 'none';
  if (LOOKUP[s]) return LOOKUP[s];
  const base = s.split(/[-_]/)[0];            // en_US / en-GB → en
  if (LOOKUP[base]) return LOOKUP[base];
  return null;
}

/** Any raw language value → human-readable name for the UI. */
function langName(raw) {
  const c = canonLang(raw);
  if (c === 'none') return 'None';
  if (c && NAMES[c]) return NAMES[c];
  return 'Unknown';
}

module.exports = { canonLang, langName, NAMES };
