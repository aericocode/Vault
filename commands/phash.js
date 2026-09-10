/**
 * Visual duplicate detection via perceptual hashing.
 *
 *   node vault.js phash                 hash new items + report groups
 *   node vault.js phash --threshold 6   stricter matching (default 8)
 *   node vault.js phash --link          ALSO link groups as dupes
 *                                       (shared notes, ⧉ badge in viewer)
 *   node vault.js phash --force         re-hash everything
 *
 * Hashing is one-time per file (stored in media.phash). Images/gifs hash the
 * original file; videos hash their thumbnail frame (generated on demand via
 * the same ffmpeg path the viewer uses).
 */

const db = require('../lib/database');
const phash = require('../lib/phash');
const { runPool } = require('../lib/proc');

async function run(args) {
  const force = args.includes('--force');
  const link = args.includes('--link');
  const thIdx = args.findIndex(a => a === '--threshold');
  const threshold = thIdx >= 0 && args[thIdx + 1] ? parseInt(args[thIdx + 1], 10) : 8;

  db.init();
  const conn = db.get();
  const setHash = conn.prepare('UPDATE media SET phash = ? WHERE id = ?');

  const candidates = conn.prepare(`
    SELECT id, filepath, filename, media_type, filesize_bytes, phash, dupe_group, user_notes
    FROM media
    WHERE user_trashed = 0 AND media_type IN ('video', 'image', 'gif')
  `).all();

  const toHash = candidates.filter(r => force || !r.phash);
  console.log(`Library: ${candidates.length} visual items, ${toHash.length} need hashing (threshold ${threshold}${link ? ', WILL LINK' : ', report only'})`);

  // ── Hash pass (one-time per file) ─────────────────────────────────────────
  let done = 0, failed = 0;
  if (toHash.length > 0) {
    const thumbnails = require('../lib/thumbnails');
    await runPool(toHash.map(row => async () => {
      try {
        let source = row.filepath;
        if (row.media_type === 'video') {
          source = await thumbnails.getThumbnail(row); // representative frame
          if (!source) throw new Error('no thumbnail');
        }
        const hash = await phash.phashFile(source);
        setHash.run(hash, row.id);
        row.phash = hash;
        done++;
        if (done % 50 === 0) console.log(`  hashed ${done}/${toHash.length}…`);
      } catch (err) {
        failed++;
        console.log(`  ✗ ${row.filename}: ${err.message}`);
      }
    }), 4);
    console.log(`Hashed: ${done}, failed: ${failed}\n`);
  }

  // ── Grouping ──────────────────────────────────────────────────────────────
  const hashed = candidates.filter(r => r.phash);
  const groups = phash.groupBySimilarity(hashed, threshold);
  const byId = new Map(candidates.map(r => [r.id, r]));

  if (groups.length === 0) {
    console.log('No visual duplicate groups found.');
    db.close();
    return;
  }

  const fmtSize = (b) => b ? `${(b / 1024 / 1024).toFixed(1)}MB` : '?';
  let reclaimable = 0;
  console.log(`Found ${groups.length} visual duplicate group(s):\n`);
  groups.forEach((ids, gi) => {
    const rows = ids.map(id => byId.get(id)).sort((a, b) => (b.filesize_bytes || 0) - (a.filesize_bytes || 0));
    console.log(`Group ${gi + 1} (${rows.length} files):`);
    rows.forEach((r, i) => {
      const already = r.dupe_group ? ' [already in a dupe group]' : '';
      console.log(`  ${i === 0 ? 'KEEP?' : '     '} ${fmtSize(r.filesize_bytes).padStart(9)}  ${r.filepath}${already}`);
      if (i > 0) reclaimable += r.filesize_bytes || 0;
    });
    console.log('');
  });
  console.log(`Potentially reclaimable (all but largest per group): ${(reclaimable / 1024 / 1024).toFixed(1)}MB`);

  // ── Optional linking (opt-in: shares notes across the group) ─────────────
  if (link) {
    let linked = 0;
    for (const ids of groups) {
      const rows = ids.map(id => byId.get(id));
      // Reuse an existing group id if any member already has one
      const existing = rows.map(r => r.dupe_group).filter(Boolean);
      const groupId = existing.length ? Math.min(...existing) : Math.min(...ids);
      db.setDupeGroup(ids, groupId);

      // Share notes only when unambiguous (one distinct non-empty note set)
      const noteSets = [...new Set(rows.map(r => r.user_notes).filter(n => n && n !== '[]'))];
      if (noteSets.length === 1) db.setGroupNotes(groupId, noteSets[0]);
      linked += ids.length;
    }
    console.log(`\nLinked ${linked} files into ${groups.length} dupe group(s). Notes now shared, ⧉ badge in the viewer.`);
  } else {
    console.log('\nRe-run with --link to join these into dupe groups (shared notes, ⧉ badge).');
  }

  db.close();
}

module.exports = { run };
