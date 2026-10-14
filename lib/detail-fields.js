/**
 * The "details" fields studios and people share (STUDIOS_SPEC sections 1, 2):
 * other names, links, description, notes, years active and (people only) born.
 *
 * readDetails() turns a request body into a column patch, or throws a 400
 * carrying { status, code } like the faces routes. Empty text means "clear".
 */

const MAX_TEXT = 5000;
const MAX_NAME = 200;
const MAX_URL = 2000;
const YEAR_MIN = 1800;
const YEAR_MAX = 2100;

function httpError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code }, extra);
}
const bad = (code, message) => httpError(400, code, message);

/** Free text: string or null; '' (after trimming) is null. */
function cleanText(v, field, max = MAX_TEXT) {
  if (v === null) return null;
  if (typeof v !== 'string') throw bad('BAD_REQUEST', `${field} must be text`);
  const s = v.trim();
  if (s.length > max) throw bad('TOO_LONG', `${field} is ${max.toLocaleString('en-US')} characters at most`);
  return s || null;
}

/** Comma separated text or a list of names -> "a, b" (duplicates dropped), or null. */
function cleanAliases(v) {
  if (v === null) return null;
  let parts;
  if (typeof v === 'string') parts = v.split(',');
  else if (Array.isArray(v) && v.every(x => typeof x === 'string')) parts = v;
  else throw bad('BAD_REQUEST', 'aliases must be text (names separated by commas) or a list of names');
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const s = p.replace(/\s+/g, ' ').trim();
    if (!s) continue;
    if (s.length > MAX_NAME) throw bad('TOO_LONG', `other names are ${MAX_NAME} characters at most`);
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  const joined = out.join(', ');
  if (joined.length > MAX_TEXT) throw bad('TOO_LONG', `aliases is ${MAX_TEXT.toLocaleString('en-US')} characters at most`);
  return joined || null;
}

/** The names in a stored aliases value. */
function aliasList(aliases) {
  return String(aliases || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** Links: one per line (or a list), each http:// or https://. -> "a\nb" or null. */
function cleanUrls(v) {
  if (v === null) return null;
  let parts;
  if (typeof v === 'string') parts = v.split(/\r?\n/);
  else if (Array.isArray(v) && v.every(x => typeof x === 'string')) parts = v;
  else throw bad('BAD_REQUEST', 'urls must be text (one link per line) or a list of links');
  const out = [];
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    if (s.length > MAX_URL || !/^https?:\/\/[^\s/]+\S*$/i.test(s)) {
      throw bad('BAD_URL', 'Links must start with http:// or https://');
    }
    if (!out.includes(s)) out.push(s);
  }
  const joined = out.join('\n');
  if (joined.length > MAX_TEXT) throw bad('TOO_LONG', `urls is ${MAX_TEXT.toLocaleString('en-US')} characters at most`);
  return joined || null;
}

function cleanYear(v, field) {
  if (v === null) return null;
  if (!Number.isInteger(v) || v < YEAR_MIN || v > YEAR_MAX) {
    throw bad('BAD_YEARS', `${field} must be a year from ${YEAR_MIN} to ${YEAR_MAX}`);
  }
  return v;
}

/** 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD', a real date, year 1800..2100. */
function cleanBorn(v) {
  if (v === null) return null;
  if (typeof v !== 'string') throw bad('BAD_BORN', 'born must be a date like 1980, 1980-05 or 1980-05-17');
  const s = v.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  const bornErr = () => bad('BAD_BORN', 'born must be a date like 1980, 1980-05 or 1980-05-17');
  if (!m) throw bornErr();
  const y = Number(m[1]);
  if (y < YEAR_MIN || y > YEAR_MAX) throw bornErr();
  if (m[2] !== undefined) {
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) throw bornErr();
    if (m[3] !== undefined) {
      const d = Number(m[3]);
      const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      if (d < 1 || d > days) throw bornErr();
    }
  }
  return s;
}

/**
 * Column patch for the detail fields present in `body`. Years are checked
 * against the row's current values too: an end year needs a start year and
 * cannot come before it.
 * @param {object} body request body
 * @param {object|null} current the row now (null on create)
 * @param {{ born?: boolean }} opts born is a people-only field
 */
function readDetails(body, current, { born = false } = {}) {
  const patch = {};
  if (body.aliases !== undefined) patch.aliases = cleanAliases(body.aliases);
  if (body.urls !== undefined) patch.urls = cleanUrls(body.urls);
  if (body.description !== undefined) patch.description = cleanText(body.description, 'description');
  if (body.notes !== undefined) patch.notes = cleanText(body.notes, 'notes');
  if (body.yearStart !== undefined) patch.year_start = cleanYear(body.yearStart, 'yearStart');
  if (body.yearEnd !== undefined) patch.year_end = cleanYear(body.yearEnd, 'yearEnd');
  if (born && body.born !== undefined) patch.born = cleanBorn(body.born);
  checkYears(
    patch.year_start !== undefined ? patch.year_start : (current ? current.year_start : null),
    patch.year_end !== undefined ? patch.year_end : (current ? current.year_end : null));
  return patch;
}

function checkYears(start, end) {
  if (end == null) return;
  if (start == null) throw bad('BAD_YEARS', 'Set the first year too.');
  if (end < start) throw bad('BAD_YEARS', 'The last year cannot come before the first year.');
}

/** API shape of the shared detail columns. */
function detailsOut(row, { born = false } = {}) {
  const out = {
    aliases: row.aliases ?? null,
    urls: row.urls ?? null,
    description: row.description ?? null,
    notes: row.notes ?? null,
    yearStart: row.year_start ?? null,
    yearEnd: row.year_end ?? null,
  };
  if (born) out.born = row.born ?? null;
  return out;
}

/**
 * Detail columns for a merge: the survivor keeps what it has and takes
 * what it lacks from the merged one; other names and links are combined.
 * `extraAliases` (e.g. the merged one's name) join the other names.
 */
function mergeDetails(keep, from, { born = false, extraAliases = [] } = {}) {
  const patch = {};
  const fill = (col) => { if (keep[col] == null && from[col] != null) patch[col] = from[col]; };
  fill('description');
  fill('notes');
  if (born) fill('born');
  if (keep.year_start == null && from.year_start != null) { patch.year_start = from.year_start; patch.year_end = from.year_end; }
  const names = [...aliasList(keep.aliases), ...aliasList(from.aliases), ...extraAliases];
  try {
    const a = cleanAliases(names);
    if (a !== (keep.aliases ?? null)) patch.aliases = a;
  } catch { /* too long combined: keep the survivor's own */ }
  const links = [...String(keep.urls || '').split('\n'), ...String(from.urls || '').split('\n')].filter(Boolean);
  try {
    const u = cleanUrls(links);
    if (u !== (keep.urls ?? null)) patch.urls = u;
  } catch { /* keep the survivor's own */ }
  return patch;
}

module.exports = {
  MAX_TEXT, MAX_NAME, YEAR_MIN, YEAR_MAX, httpError,
  cleanText, cleanAliases, cleanUrls, cleanYear, cleanBorn, aliasList,
  readDetails, detailsOut, mergeDetails, DETAIL_COLUMNS: ['aliases', 'urls', 'description', 'notes', 'year_start', 'year_end'],
};
