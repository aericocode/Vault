/**
 * probe — backfill the codec columns the playback decision reads.
 *
 * Every library that existed before HLS remux streaming has rows with no
 * video_codec/audio_codec/container, and until they are filled the viewer has
 * to probe on first play. This walks the library once, one ffprobe at a time,
 * and pre-builds the keyframe index for anything that will have to be remuxed
 * so the first play does not pay for the keyframe scan either.
 *
 *   node vault.js probe          only rows this feature has never probed
 *   node vault.js probe --all    re-probe everything (after a probe-logic change)
 */

const fs = require('fs');
const db = require('../lib/database');
const mediaInfo = require('../lib/media-info');
const { decide, DEFAULT_CAPS } = require('../lib/stream/decide');

async function run(args = []) {
  const all = args.includes('--all');
  const noIndex = args.includes('--no-index');

  db.init();

  if (!mediaInfo.isAvailable()) {
    console.error('ffprobe was not found. Install ffmpeg (or drop ffprobe next to Vault) and try again.');
    process.exit(1);
  }

  const rows = db.rowsNeedingProbe(all);
  if (!rows.length) {
    console.log('Nothing to probe: every file already has its codec info.');
    db.close();
    return;
  }

  console.log(`Probing ${rows.length} file(s)${all ? ' (--all: re-probing everything)' : ''}...`);
  const service = require('../lib/stream/service');
  const startTime = Date.now();
  let probed = 0, indexed = 0, missing = 0, failed = 0;
  const modes = { native: 0, remux: 0, unsupported: 0 };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!fs.existsSync(row.filepath)) { missing++; continue; }
    try {
      const info = await mediaInfo.getStreamInfo(row.filepath);
      if (!info) { failed++; continue; }
      db.saveStreamInfo(row.id, info);
      probed++;

      const fresh = db.getById(row.id);
      const d = decide(fresh, new Set(DEFAULT_CAPS));
      modes[d.mode]++;
      if (d.mode === 'remux' && !noIndex) {
        try { await service.ensureIndex(fresh); indexed++; } catch { /* unindexable, not fatal */ }
      }
    } catch {
      failed++;
    }

    if ((i + 1) % 50 === 0 || i + 1 === rows.length) {
      const rate = (i + 1) / Math.max(1, (Date.now() - startTime) / 1000);
      console.log(`  ${i + 1}/${rows.length} (${rate.toFixed(1)}/s)`);
    }
  }

  console.log('');
  console.log(`Done: ${probed} probed, ${indexed} keyframe indexes built, ${missing} missing from disk, ${failed} failed.`);
  console.log(`Playback: ${modes.native} play as-is, ${modes.remux} need a remux, ${modes.unsupported} cannot play in a browser.`);
  db.close();
}

module.exports = { run };
