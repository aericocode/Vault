/**
 * The M3U8 playlist file (PLAYLISTS_SPEC, build step 2: Export).
 *
 * Export exists so VLC / PotPlayer can play a collection, so this writes only
 * what players read: `#EXTM3U`, `#PLAYLIST:<name>`, then `#EXTINF:<secs>,<title>`
 * and the location for each file. UTF-8 without a BOM (the norm for .m3u8),
 * CRLF line endings.
 *
 * Pure: no I/O, Node stdlib only. lib/playlist/export.js reads the collection
 * and calls buildM3U8 with
 *
 *   { title, items: [{ id, title, durationSec|null, filePath|null }],
 *     links: 'vault' | 'full' | 'relative', baseUrl, playlistDir }
 *
 * Locations:
 *   'vault'     `${baseUrl}/media/<id>`: plays through Vault, which must be
 *               open and unlocked.
 *   'full'      the file's path as it is (Windows or Linux).
 *   'relative'  the path from `playlistDir` (the folder the playlist is saved
 *               in) to the file, Windows backslashes, `..\` as needed, names
 *               compared without case on Windows. A file on another drive or
 *               share than the playlist, or a path that cannot be made
 *               relative, gets its full path instead; buildM3U8 counts those
 *               in `fullPathCount`.
 *
 * Nothing taken from the library can add or break a line: CR, LF and the
 * other control characters are removed from titles, and a path holding one
 * (possible on Linux) is written as a percent-encoded file URI.
 */

'use strict';

// Windows (NTFS) style case fold for comparing names. lib/watchers/rules.js
// needs only 'path', so this module stays free of I/O.
const { foldCase } = require('../watchers/rules');

const LINKS = new Set(['vault', 'full', 'relative']);

// C0 controls, DEL, C1 controls, and the Unicode line / paragraph separators.
const CONTROL_RUN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// A lone UTF-16 surrogate (NTFS allows them in names); encodeURIComponent
// would throw on one.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** One line of text: control characters become a single space, ends trimmed. */
function oneLine(s) {
  return String(s == null ? '' : s).replace(CONTROL_RUN, ' ').trim();
}

/** Whole seconds for #EXTINF, or -1 when the length is unknown. */
function extinfSeconds(d) {
  const n = Number(d);
  if (d == null || !Number.isFinite(n) || n <= 0) return -1;
  return Math.max(1, Math.round(n));
}

/** Percent-encode one path segment (RFC 3986 pchar; UTF-8 for non-ASCII). */
function encodeSegment(seg) {
  return encodeURIComponent(seg.replace(LONE_SURROGATE, '\uFFFD'));
}

const encodePath = (segments) => segments.map(encodeSegment).join('/');
const splitRest = (s) => s.split(/[\\/]+/).filter((x) => x !== '');

/**
 * The shape of a path we can write, or null.
 *   C:\Videos\a.mp4              { drive: 'C', rest: ['Videos', 'a.mp4'] }
 *   \\server\share\x.mp4         { host: 'server', rest: ['share', 'x.mp4'] }
 *   \\?\C:\long\x.mp4            as C:\long\x.mp4
 *   \\?\UNC\server\share\x.mp4   as \\server\share\x.mp4
 *   /home/me/x.mp4               { posix: ['home', 'me', 'x.mp4'] }
 * Anything else (empty, relative, drive-relative "C:x.mp4", "\\server" with
 * no share, "\\?\Volume{GUID}\...", device paths "\\.\...", "//x") is null,
 * and lib/playlist/export.js leaves such files out of a path playlist
 * (counted as skipped).
 */
function pathForm(p) {
  if (typeof p !== 'string' || p === '') return null;
  let s = p;
  if (/^\\\\\?\\UNC\\/i.test(s)) s = '\\\\' + s.slice(8);           // \\?\UNC\server\share
  else if (/^\\\\\?\\[A-Za-z]:\\/.test(s)) s = s.slice(4);          // \\?\C:\
  else if (/^\\\\[?.]\\/.test(s)) return null;                      // other \\?\ and \\.\ forms

  const unc = /^\\\\([^\\/]+)[\\/]+([^\\/]+)(.*)$/s.exec(s);
  if (unc) return { host: unc[1], rest: [unc[2], ...splitRest(unc[3])] };
  if (/^\\\\/.test(s)) return null;                                 // \\server with no share
  const drive = /^([A-Za-z]):[\\/](.*)$/s.exec(s);
  if (drive) return { drive: drive[1].toUpperCase(), rest: splitRest(drive[2]) };
  if (/^\/(?!\/)/.test(s)) return { posix: s.split('/').slice(1).filter((x) => x !== '') };
  return null;
}

/** Can this path be written in a path playlist? */
const exportablePath = (p) => pathForm(p) !== null;

/** A file URI (RFC 8089 / 3986) for a path pathForm accepts. */
function fileUri(p) {
  const f = pathForm(p);
  if (!f) throw new TypeError('path has no file URI form');
  if (f.host !== undefined) return `file://${encodeSegment(f.host)}/${encodePath(f.rest)}`;
  if (f.drive !== undefined) return `file:///${f.drive}:/${encodePath(f.rest)}`;
  return `file:///${encodePath(f.posix)}`;
}

/** Root (drive, or server + share, or "/") and the segments under it. */
function rooted(p) {
  const f = pathForm(p);
  if (!f) return null;
  if (f.drive !== undefined) return { root: `${f.drive}:`, segs: f.rest, win: true };
  if (f.host !== undefined) return { root: `\\\\${f.host}\\${f.rest[0]}`, segs: f.rest.slice(1), win: true };
  return { root: '/', segs: f.posix, win: false };
}

/**
 * The location of `filePath` relative to the folder `playlistDir`, or null
 * when it cannot be relative (another drive or share, a different kind of
 * path, a "." or ".." segment, or a form pathForm refuses).
 *   relativeLocation('D:\\Media\\a.mp4', 'D:\\Media')          'a.mp4'
 *   relativeLocation('D:\\Media\\sub\\a.mp4', 'D:\\Media')     'sub\\a.mp4'
 *   relativeLocation('D:\\Media\\a.mp4', 'D:\\Lists\\Mine')    '..\\..\\Media\\a.mp4'
 *   relativeLocation('E:\\a.mp4', 'D:\\Lists')                 null
 * A result that starts with "#" (a comment line in M3U) gets ".\" in front.
 */
function relativeLocation(filePath, playlistDir) {
  const f = rooted(filePath);
  const d = rooted(playlistDir);
  if (!f || !d || f.win !== d.win) return null;
  // NTFS-style fold on Windows: é/É meet, ß/ẞ, ﬁ/FI and ı/I stay apart.
  const same = f.win ? (a, b) => foldCase(a) === foldCase(b) : (a, b) => a === b;
  if (!same(f.root, d.root)) return null;
  if ([...f.segs, ...d.segs].some((s) => s === '.' || s === '..')) return null;
  if (f.segs.length === 0) return null;
  const dirOfFile = f.segs.slice(0, -1);
  let common = 0;
  while (common < dirOfFile.length && common < d.segs.length && same(dirOfFile[common], d.segs[common])) common++;
  const sep = f.win ? '\\' : '/';
  const up = Array(d.segs.length - common).fill('..');
  let rel = [...up, ...f.segs.slice(common)].join(sep);
  if (rel.startsWith('#')) rel = `.${sep}${rel}`;
  return rel;
}

/** A line can hold this location as it is (no control characters, no edge spaces). */
const lineSafe = (s) => !HAS_CONTROL.test(s) && !/^\s|\s$/.test(s);

function checkInput(pl) {
  if (!pl || typeof pl !== 'object') throw new TypeError('playlist must be an object');
  if (!LINKS.has(pl.links)) throw new TypeError("links must be 'vault', 'full' or 'relative'");
  if (!Array.isArray(pl.items)) throw new TypeError('items must be an array');
  if (pl.links === 'vault') {
    if (typeof pl.baseUrl !== 'string' || !/^https?:\/\/[^\s/]+$/.test(pl.baseUrl)) {
      throw new TypeError('baseUrl must be http(s)://host:port with no path');
    }
  }
  if (pl.links === 'relative' && typeof pl.playlistDir !== 'string') {
    throw new TypeError('relative links need the playlist folder');
  }
}

function vaultUrl(pl, it) {
  const id = Number(it.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError(`bad media id ${it.id}`);
  return `${pl.baseUrl}/media/${id}`;
}

/** The full-path location: the path as it is, or a file URI when a line cannot hold it. */
function fullLocation(it) {
  const p = it.filePath;
  if (!exportablePath(p)) throw new TypeError(`media ${it.id} has no usable file path`);
  return lineSafe(p) ? p : fileUri(p);
}

/**
 * M3U8 text and how many entries a relative playlist had to write as full
 * paths. Ends with a line break.
 * @returns {{ text: string, fullPathCount: number }}
 */
function buildM3U8(pl) {
  checkInput(pl);
  const lines = ['#EXTM3U'];
  const title = oneLine(pl.title);
  if (title) lines.push(`#PLAYLIST:${title}`);
  let fullPathCount = 0;
  for (const it of pl.items) {
    lines.push(`#EXTINF:${extinfSeconds(it.durationSec)},${oneLine(it.title)}`);
    if (pl.links === 'vault') {
      lines.push(vaultUrl(pl, it));
    } else if (pl.links === 'full') {
      lines.push(fullLocation(it));
    } else {
      const rel = exportablePath(it.filePath) ? relativeLocation(it.filePath, pl.playlistDir) : null;
      if (rel !== null && lineSafe(rel)) {
        lines.push(rel);
      } else {
        lines.push(fullLocation(it));
        fullPathCount++;
      }
    }
  }
  return { text: lines.join('\r\n') + '\r\n', fullPathCount };
}

/** Just the text. */
const toM3U8 = (pl) => buildM3U8(pl).text;

const M3U8 = { ext: 'm3u8', contentType: 'audio/x-mpegurl; charset=utf-8' };

module.exports = { buildM3U8, toM3U8, relativeLocation, fileUri, exportablePath, oneLine, extinfSeconds, M3U8 };
