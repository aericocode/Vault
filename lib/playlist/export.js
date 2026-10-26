/**
 * Export a collection as a playlist file (PLAYLISTS_SPEC, build step 2).
 *
 * Reads the collection from the library and hands it to the pure M3U8 writer
 * (lib/playlist/formats.js). The order is the one Play All plays:
 * db.getCollectionItems, which is collection_items.position for a collection
 * and the deduped tree-order union for a folder. The sort on screen does not
 * matter.
 *
 * Left out: custom mixes (media_type 'mix', a virtual mix:// row with no file
 * an outside player could open) and documents (never in the grid, so Play All
 * never plays them). Also left out: a file with no path on record (in either
 * link mode, since Vault could not serve it either) and, for full or relative
 * links, a path with no proper form (formats.exportablePath: relative,
 * drive-relative "C:x", "\\?\Volume{...}", device paths). All of these are
 * counted in `skipped`.
 *
 * Links: 'vault' | 'full' | 'relative'. Relative is computed from the folder
 * the playlist is saved in, so it only exists for the save route (the
 * preview route answers RELATIVE_NEEDS_SAVE).
 *
 * Errors carry a `code` for the route: BAD_LINKS, RELATIVE_NEEDS_SAVE, NOT_FOUND.
 */

'use strict';

const db = require('../database');
const { buildM3U8, exportablePath, M3U8 } = require('./formats');

const LINKS = new Set(['vault', 'full', 'relative']);
const SKIP_TYPES = new Set(['mix', 'document']);

function exportErr(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * Validate `links` strictly (an exact string, nothing else). `saving`: the
 * save route, the only one that knows a playlist folder for relative links.
 */
function checkLinks(links, { saving = false } = {}) {
  if (typeof links !== 'string' || !LINKS.has(links)) {
    throw exportErr("links must be 'full', 'relative' or 'vault'", 'BAD_LINKS');
  }
  if (links === 'relative' && !saving) {
    throw exportErr('relative links are worked out from where the playlist is saved, so only saving can make them', 'RELATIVE_NEEDS_SAVE');
  }
}

/** The collection (or folder) row, or a NOT_FOUND error. */
function collectionRow(collectionId) {
  const row = db.get().prepare('SELECT id, name, kind FROM collections WHERE id = ?').get(collectionId);
  if (!row) throw exportErr('collection not found', 'NOT_FOUND');
  return row;
}

/** File name without its extension ("clip.final.mp4" → "clip.final"). */
function stripExt(name) {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  return dot > 0 ? s.slice(0, dot) : s;
}

const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * A collection name made safe as a Windows file name (no extension):
 * characters Windows refuses become spaces, runs of space collapse, no
 * trailing dots or spaces, device names (CON, NUL, COM1, CONIN$...) get a leading
 * underscore, at most 120 characters. Empty → "Playlist".
 */
function safeFileName(name) {
  let s = String(name == null ? '' : name)
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = Array.from(s).slice(0, 120).join('');
  s = s.replace(/[. ]+$/, '');
  if (!s) return 'Playlist';
  const stem = s.split('.')[0].trim();
  if (RESERVED.test(stem)) s = `_${s}`;
  return s;
}

/**
 * Build the playlist text for one collection.
 * @param {number} collectionId
 * @param {{links:string, baseUrl?:string, playlistDir?:string}} opts
 *   playlistDir: the folder the playlist goes in (relative links only)
 * @returns {{ text, contentType, ext, fileName, name, count, skipped, fullPathCount }}
 */
function buildExport(collectionId, { links, baseUrl, playlistDir }) {
  checkLinks(links, { saving: playlistDir !== undefined });
  const coll = collectionRow(collectionId);
  const ids = db.getCollectionItems(coll.id);
  const rowStmt = db.get().prepare(
    'SELECT id, filepath, filename, media_type, duration_seconds FROM media WHERE id = ?'
  );
  const items = [];
  let skipped = 0;
  for (const id of ids) {
    const r = rowStmt.get(id);
    if (!r || SKIP_TYPES.has(r.media_type) || /^mix:\/\//i.test(r.filepath || '')
        || typeof r.filepath !== 'string' || r.filepath.trim() === ''
        || (links !== 'vault' && !exportablePath(r.filepath))) { skipped++; continue; }
    items.push({
      id: r.id,
      // What the app shows as the title is the file name; a playlist reads
      // better without the extension.
      title: stripExt(r.filename),
      durationSec: r.duration_seconds,
      filePath: r.filepath,
    });
  }
  const { text, fullPathCount } = buildM3U8({ title: coll.name, items, links, baseUrl, playlistDir });
  return {
    text,
    contentType: M3U8.contentType,
    ext: M3U8.ext,
    fileName: `${safeFileName(coll.name)}.${M3U8.ext}`,
    name: coll.name,
    count: items.length,
    skipped,
    fullPathCount,
  };
}

module.exports = { buildExport, checkLinks, collectionRow, safeFileName, stripExt };
