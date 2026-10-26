/**
 * Read a playlist file (PLAYLISTS_SPEC, build step 3: Import).
 *
 * The source is a playlist someone made in VLC or PotPlayer: M3U / M3U8, XSPF
 * (VLC's own format), PLS, and DPL (PotPlayer's own format). Our own M3U8
 * exports read back too (full or relative paths), with nothing special done
 * for them.
 *
 * Pure: no I/O, Node stdlib only. The caller (lib/playlist/import.js) reads
 * the bytes of a file the user picked and calls
 *
 *   parsePlaylist(bytes, { fileName })
 *     → { name, format, entries, skipped, truncated }
 *
 *   entries   one per item, in playlist order:
 *             { index, raw, path, url, title }
 *               raw    the location as written in the file
 *               path   a file path (Windows or Linux; relative when the file
 *                      wrote it relative), or null
 *               url    a web or other non-file link, or null
 *               title  the title the playlist gave it, or null
 *   skipped   entries that are not files: { index, raw, reason }
 *               reason 'web'  (http / https: listed, never followed)
 *                      'link' (another scheme: rtsp, smb, mms, ...)
 *                      'bad'  (a file URI that cannot be read)
 *   name      the playlist's own name (#PLAYLIST, XSPF <title>, a PLS name
 *             line), else the file name without its extension
 *   truncated true when the file held more than MAX_ENTRIES entries
 *
 * Text: a byte order mark (UTF-8, UTF-16 LE / BE) wins. Without one the bytes
 * are read as UTF-8 when they are valid UTF-8, else as Windows-1252 (the
 * "ANSI" code page VLC and older players used for .m3u on Western systems).
 *
 * Locations: plain paths are taken as they are (a "%" in a file name stays a
 * "%"); file:// URIs are percent-decoded (UTF-8) into a path:
 *   file:///C:/My%20Videos/a.mp4      C:\My Videos\a.mp4
 *   file://server/share/a.mp4         \\server\share\a.mp4
 *   file://localhost/C:/a.mp4         C:\a.mp4
 *   file:///home/me/a.mp4             /home/me/a.mp4
 */

'use strict';

/*
 * Everything is inside createParser so the whole reader can also run in a
 * worker thread (lib/playlist/import.js passes `(${createParser})()` as the
 * worker's source: it needs no require, so it works the same in the
 * single-file app build).
 */
function createParser() {

const MAX_ENTRIES = 200000;

/* ── Text ───────────────────────────────────────────────────────────────── */

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const UTF8_LOOSE = new TextDecoder('utf-8');
let ANSI = null;
function ansiDecoder() {
  if (!ANSI) {
    try { ANSI = new TextDecoder('windows-1252'); } catch { ANSI = new TextDecoder('latin1'); }
  }
  return ANSI;
}

/**
 * Bytes → text and how they were read.
 * @returns {{ text: string, encoding: 'utf-8'|'utf-8-bom'|'utf-16le'|'utf-16be'|'ansi' }}
 */
function decodeText(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { text: UTF8_LOOSE.decode(b.subarray(3)), encoding: 'utf-8-bom' };
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'utf-16le' };
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'utf-16be' };
  }
  try {
    return { text: UTF8.decode(b), encoding: 'utf-8' };
  } catch {
    return { text: ansiDecoder().decode(b), encoding: 'ansi' };
  }
}

const lines = (text) => text.split(/\r\n|\r|\n/);

/* ── Locations ──────────────────────────────────────────────────────────── */

/** A URI scheme ("http:", "file:"), never a drive letter ("C:"). */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]+):/;

/** Percent-decode as UTF-8; null when the escapes do not make valid UTF-8. */
function percentDecode(s) {
  if (!s.includes('%')) return s;
  try { return decodeURIComponent(s); } catch { return null; }
}

/**
 * A file URI → a path, or null when it cannot be read.
 * Query and fragment are dropped (players add none to file URIs, and a "#"
 * in a name is written %23).
 */
function fileUriToPath(uri) {
  let rest = uri.replace(/^file:/i, '');
  rest = rest.replace(/[?#].*$/s, '');
  let host = '';
  if (rest.startsWith('//')) {
    const slash = rest.indexOf('/', 2);
    host = slash < 0 ? rest.slice(2) : rest.slice(2, slash);
    rest = slash < 0 ? '' : rest.slice(slash);
  }
  const decoded = percentDecode(rest);
  if (decoded == null) return null;
  host = percentDecode(host);
  if (host == null) return null;
  if (/[\u0000]/.test(decoded)) return null;
  if (host && host.toLowerCase() !== 'localhost') {
    // file://server/share/a.mp4 → \\server\share\a.mp4
    const segs = decoded.split('/').filter(Boolean);
    if (!segs.length) return null;
    return `\\\\${host}\\${segs.join('\\')}`;
  }
  // file:///C:/a.mp4, file:/C:/a.mp4, file:///C|/a.mp4 (old form)
  const drive = /^\/?([A-Za-z])[:|](\/.*)?$/s.exec(decoded);
  if (drive) return `${drive[1].toUpperCase()}:${(drive[2] || '/').replace(/\//g, '\\')}`;
  // file:////server/share/a.mp4 (UNC written with an empty host)
  if (/^\/\/[^/]/.test(decoded)) return `\\\\${decoded.slice(2).split('/').filter(Boolean).join('\\')}`;
  if (decoded.startsWith('/')) return decoded;
  return null;
}

/**
 * One location as written → { path, url } or { skip: reason }.
 * @param {string} raw
 * @param {{uriRefs?: boolean}} [o] uriRefs: the format stores URIs (XSPF), so
 *   a location without a scheme is a relative URI reference: percent-decoded,
 *   with forward slashes
 */
function readLocation(raw, { uriRefs = false } = {}) {
  let s = raw.trim();
  // "C:\My Videos\a.mp4" pasted with its quotes (Explorer's Copy as path)
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1).trim();
  if (!s) return { skip: 'bad' };
  const m = SCHEME.exec(s);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme === 'file') {
      const p = fileUriToPath(s);
      return p ? { path: p, url: null } : { skip: 'bad' };
    }
    return { skip: scheme === 'http' || scheme === 'https' ? 'web' : 'link', url: s };
  }
  if (uriRefs) {
    const p = percentDecode(s);
    if (p == null) return { skip: 'bad' };
    return { path: p, url: null };
  }
  return { path: s, url: null };
}

/* ── Formats ────────────────────────────────────────────────────────────── */

/** Collects entries in order, with skips and the cap. */
function collector() {
  const entries = [];
  const skipped = [];
  let truncated = false;
  return {
    entries, skipped,
    get truncated() { return truncated; },
    add(raw, title, opts) {
      if (entries.length >= MAX_ENTRIES) { truncated = true; return; }
      const index = entries.length;
      const loc = readLocation(raw, opts);
      const t = typeof title === 'string' && title.trim() ? title.trim() : null;
      if (loc.skip) {
        entries.push({ index, raw, path: null, url: loc.url || null, title: t });
        skipped.push({ index, raw, reason: loc.skip });
      } else {
        entries.push({ index, raw, path: loc.path, url: null, title: t });
      }
    },
  };
}

/**
 * The title in what follows "#EXTINF:": the text after the first comma that
 * is not inside double quotes. IPTV lists put attributes before it, and
 * those may hold commas:  -1 tvg-name="A, B" group-title="x",The title
 * (The first, not the last: a title may hold commas of its own,
 * "#EXTINF:12,Artist, Song".)
 */
function extinfTitle(rest) {
  let quoted = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) return rest.slice(i + 1);
  }
  return null;
}

/** M3U / M3U8 (plain or extended). */
function parseM3U(text) {
  const c = collector();
  let name = null;
  let title = null;
  for (const lineRaw of lines(text)) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (/^#EXTINF:/i.test(line)) { title = extinfTitle(line.slice(8)); continue; }
      const pl = /^#PLAYLIST:(.*)$/i.exec(line);
      if (pl && name == null && pl[1].trim()) name = pl[1].trim();
      continue;                         // #EXTM3U, #EXTVLCOPT, #EXTGRP, comments
    }
    c.add(line, title);
    title = null;
  }
  return { name, ...done(c) };
}

/** PLS: [playlist], FileN= / TitleN=, numbered (gaps allowed). */
function parsePLS(text) {
  const files = new Map();
  const titles = new Map();
  let name = null;
  for (const lineRaw of lines(text)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    const f = /^File(\d+)$/i.exec(key);
    if (f) { if (!files.has(Number(f[1]))) files.set(Number(f[1]), val); continue; }
    const t = /^Title(\d+)$/i.exec(key);
    if (t) { titles.set(Number(t[1]), val); continue; }
    if (/^(PlaylistName|X-GNOME-Title|Name)$/i.test(key) && val && name == null) name = val;
  }
  const c = collector();
  for (const n of [...files.keys()].sort((a, b) => a - b)) c.add(files.get(n), titles.get(n));
  return { name, ...done(c) };
}

/** PotPlayer DPL: "DAUMPLAYLIST", then "N*file*path", "N*title*text", ... */
function parseDPL(text) {
  const files = new Map();
  const titles = new Map();
  let playname = null;
  for (const lineRaw of lines(text)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const item = /^(\d+)\*([a-z0-9_]+)\*(.*)$/i.exec(line);
    if (item) {
      const n = Number(item[1]);
      const key = item[2].toLowerCase();
      if (key === 'file' && !files.has(n)) files.set(n, item[3]);
      else if (key === 'title') titles.set(n, item[3]);
      continue;
    }
    const kv = /^playname=(.*)$/i.exec(line);
    if (kv) playname = kv[1].trim();
    // topindex=, saveplaypos=, playtime= ...: player state, not wanted here
  }
  const c = collector();
  for (const n of [...files.keys()].sort((a, b) => a - b)) c.add(files.get(n), titles.get(n));
  // PotPlayer writes the file playing last as playname= (a path), not a
  // name for the list. Only a value that is not a path or link is a name.
  const name = playname && !/[\\/]/.test(playname) && !SCHEME.test(playname) && !/\.[A-Za-z0-9]{2,5}$/.test(playname)
    ? playname : null;
  return { name, ...done(c) };
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(s) {
  const t = s.trim();
  if (t.startsWith('<![CDATA[') && t.endsWith(']]>')) return t.slice(9, -3);
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
    }
    return XML_ENTITIES[e.toLowerCase()] ?? all;
  });
}
/*
 * The XSPF reader scans with indexOf only, each search starting where the
 * last one ended, so its time grows with the file's size whatever the file
 * holds (unclosed tags included). Regular expressions with lazy bodies went
 * quadratic on a file full of unclosed <track> tags. Element names are
 * matched as written (XML is case-sensitive; XSPF's are lower case).
 */

/** Where the next start tag `<name` (then ">", "/" or white space) is, from `from`, or -1. */
function findOpen(xml, name, from) {
  const needle = `<${name}`;
  let i = xml.indexOf(needle, from);
  while (i >= 0) {
    const ch = xml[i + needle.length];
    if (ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') return i;
    i = xml.indexOf(needle, i + needle.length);
  }
  return -1;
}

/**
 * Text with every `<!-- ... -->` and every `<extension ...> ... </extension>`
 * (or `<extension/>`) taken out: VLC's per-track vlc:id and its vlc:node tree
 * say nothing a library needs. An unclosed one runs to the end of the text.
 */
function stripBlocks(xml) {
  const cut = (text, open, close, isOpen) => {
    let out = '';
    let pos = 0;
    for (;;) {
      const i = isOpen ? isOpen(text, pos) : text.indexOf(open, pos);
      if (i < 0) { out += text.slice(pos); break; }
      out += text.slice(pos, i);
      const gt = text.indexOf('>', i);
      if (close === null || (gt >= 0 && text[gt - 1] === '/')) {    // a self-closed tag
        if (gt < 0) break;
        pos = gt + 1;
        continue;
      }
      const end = text.indexOf(close, i);
      if (end < 0) break;
      pos = end + close.length;
      if (close !== '-->') {
        const gt2 = text.indexOf('>', pos);
        if (gt2 < 0) break;
        pos = gt2 + 1;
      }
    }
    return out;
  };
  const noComments = cut(xml, '<!--', '-->');
  return cut(noComments, '<extension', '</extension', (t, from) => findOpen(t, 'extension', from));
}

/**
 * The text of the first <name>...</name> in `xml`, or null. Called on a
 * track's body or the part before the track list, never the whole file.
 */
function firstTag(xml, name) {
  const i = findOpen(xml, name, 0);
  if (i < 0) return null;
  const gt = xml.indexOf('>', i);
  if (gt < 0) return null;
  if (xml[gt - 1] === '/') return '';
  const end = xml.indexOf('</' + name, gt + 1);
  if (end < 0) return null;
  return xmlText(xml.slice(gt + 1, end));
}

/** XSPF: <track><location>file URI</location><title>..</title></track>. */
function parseXSPF(text) {
  const xml = stripBlocks(text);
  const listAt = findOpen(xml, 'trackList', 0);
  const name = (firstTag(listAt >= 0 ? xml.slice(0, listAt) : xml, 'title') || '').trim() || null;
  const c = collector();
  let pos = listAt >= 0 ? listAt : 0;
  for (;;) {
    const i = findOpen(xml, 'track', pos);
    if (i < 0) break;
    const gt = xml.indexOf('>', i);
    if (gt < 0) break;
    const end = xml.indexOf('</track', gt + 1);
    if (end < 0) break;                 // an unclosed track ends the list
    // Searched within the track only, so a track missing its </location> costs its own length.
    const body = xml.slice(gt + 1, end);
    const loc = firstTag(body, 'location');
    if (loc != null) c.add(loc, firstTag(body, 'title'), { uriRefs: true });
    pos = end + 7;
  }
  return { name, ...done(c) };
}

function done(c) {
  return { entries: c.entries, skipped: c.skipped, truncated: c.truncated };
}

/* ── Entry point ────────────────────────────────────────────────────────── */

const FORMATS = { m3u: parseM3U, m3u8: parseM3U, pls: parsePLS, dpl: parseDPL, xspf: parseXSPF };
const EXTENSIONS = Object.keys(FORMATS);

/** The format: by the content's first line when it is clear, else the extension. */
function detectFormat(text, ext) {
  const head = text.replace(/^\uFEFF/, '').trimStart().slice(0, 200);
  if (/^DAUMPLAYLIST/i.test(head)) return 'dpl';
  if (/^\[playlist\]/i.test(head)) return 'pls';
  if (/^<\?xml|^<playlist\b/i.test(head)) return 'xspf';
  if (/^#EXTM3U/i.test(head)) return 'm3u';
  return FORMATS[ext] ? (ext === 'm3u8' ? 'm3u' : ext) : 'm3u';
}

const GENERIC_NAME = /^(?:playlist|untitled|new playlist)$/i;

/** "D:\Lists\Road trip.m3u8" → "Road trip" */
function baseName(fileName) {
  const s = String(fileName || '').split(/[\\/]/).pop() || '';
  const dot = s.lastIndexOf('.');
  return (dot > 0 ? s.slice(0, dot) : s).trim();
}

/**
 * @param {Buffer|Uint8Array} bytes  the file's contents
 * @param {{fileName?: string}} [opts] the file's name (for the format and the
 *   fallback name)
 */
function parsePlaylist(bytes, { fileName = '' } = {}) {
  const { text, encoding } = decodeText(bytes);
  const ext = (/\.([A-Za-z0-9]+)$/.exec(String(fileName)) || [])[1];
  const format = detectFormat(text, ext ? ext.toLowerCase() : '');
  const out = FORMATS[format](text.replace(/^\uFEFF/, ''));
  let name = out.name && out.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  // VLC titles every XSPF it saves "Playlist": the file name says more.
  if (name && GENERIC_NAME.test(name) && baseName(fileName)) name = null;
  name = name || baseName(fileName) || 'Playlist';
  return { name, format, encoding, entries: out.entries, skipped: out.skipped, truncated: out.truncated };
}

return { parsePlaylist, decodeText, fileUriToPath, readLocation, detectFormat, EXTENSIONS, MAX_ENTRIES };
}

module.exports = { ...createParser(), createParser };
