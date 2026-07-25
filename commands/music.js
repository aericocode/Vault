/**
 * Music ID CLI — fingerprint + scan without the viewer.
 *
 *   node video-tagger.js music check-tools
 *   node video-tagger.js music fingerprint <id|all> [--force]
 *   node video-tagger.js music scan <id|all>
 *   node video-tagger.js music status
 *
 * Same pipeline as the viewer buttons (lib/musicid/service.js): fingerprint,
 * then match against song references and other fingerprinted files.
 */

const db = require('../lib/database');

async function run(args) {
  db.init();
  const repo = require('../lib/musicid/repo');
  const service = require('../lib/musicid/service');
  const fpx = require('../lib/musicid/fingerprint');

  const [sub, target] = args;
  const force = args.includes('--force');

  if (!sub || sub === 'help') {
    console.log('Usage: node video-tagger.js music <check-tools|fingerprint|scan|status|import-seed|export-seedpack|import-seedpack> [id|all|file] [--force]');
    return;
  }

  if (sub === 'import-seed') {
    if (!target) { console.error('Usage: music import-seed <file.json>'); process.exit(1); }
    const r = repo.importSeedFile(require('path').resolve(target));
    if (!r) { console.error('File missing or not the expected { artists: [...] } shape.'); process.exit(1); }
    console.log(`Imported ${r.imported} entries (${r.skipped} skipped). Seed total: ${repo.seedCount()}.`);
    return;
  }

  // Seed PACKS carry reference FINGERPRINTS (vault-songseed.json) — unlike
  // import-seed above, which is the names-only autocomplete catalog.
  if (sub === 'export-seedpack') {
    if (!target) { console.error('Usage: music export-seedpack <file.json> [--unknown]'); process.exit(1); }
    const seedpack = require('../lib/musicid/seedpack');
    const pack = seedpack.exportSeedPack({ includeUnknown: args.includes('--unknown') });
    const fps = pack.songs.reduce((n, s) => n + s.fingerprints.length, 0);
    require('fs').writeFileSync(require('path').resolve(target), JSON.stringify(pack, null, 1));
    console.log(`Exported ${pack.songs.length} song(s), ${fps} reference fingerprint(s) → ${target}`);
    return;
  }

  if (sub === 'import-seedpack') {
    if (!target) { console.error('Usage: music import-seedpack <file.json>'); process.exit(1); }
    const seedpack = require('../lib/musicid/seedpack');
    let pack;
    try { pack = JSON.parse(require('fs').readFileSync(require('path').resolve(target), 'utf8')); }
    catch (e) { console.error(`Can't read pack: ${e.message}`); process.exit(1); }
    const r = seedpack.importSeedPack(pack);
    console.log(`Songs: ${r.songs_added} added, ${r.songs_existing} already known.`);
    console.log(`Fingerprints: ${r.fps_added} added, ${r.fps_skipped} duplicates skipped` +
      (r.fps_invalid ? `, ${r.fps_invalid} invalid` : '') + '.');
    if (!r.new_ref_ids.length) { console.log('Nothing new — no rescan needed.'); return; }

    // CLI rescans inline (the viewer does this in the background)
    const rows = db.get().prepare('SELECT DISTINCT media_id FROM media_fingerprints').all();
    console.log(`\nRescanning ${rows.length} fingerprinted file(s) against the new references…`);
    let links = 0;
    for (const { media_id } of rows) {
      const found = service.scanAgainstReferences(media_id, { onlyRefIds: r.new_ref_ids });
      for (const f of found) {
        const m = db.getById(media_id);
        console.log(`  [${media_id}] ${(m?.filename || '').slice(0, 60)} → 🎵 ${f.artist} - ${f.title}`);
        links++;
      }
    }
    console.log(`\nDone. ${links} new match(es).`);
    return;
  }

  if (sub === 'check-tools') {
    const t = await fpx.checkTools();
    console.log(`fpcalc: ${t.fpcalcVersion || 'NOT FOUND'}`);
    console.log(`ffmpeg: ${t.ffmpegVersion || 'NOT FOUND'}`);
    t.errors.forEach(e => console.error('  - ' + e));
    process.exitCode = t.ok ? 0 : 1;
    return;
  }

  if (sub === 'status') {
    const s = repo.getStats();
    console.log('Music ID status:');
    for (const [k, v] of Object.entries(s)) console.log(`  ${k.padEnd(20)} ${v}`);
    return;
  }

  if (sub === 'fingerprint' || sub === 'scan') {
    if (!target) {
      console.error(`Usage: music ${sub} <media-id|all>${sub === 'fingerprint' ? ' [--force]' : ''}`);
      process.exit(1);
    }

    let rows;
    if (target === 'all') {
      rows = db.get().prepare(
        "SELECT id, filename, filepath, media_type, duration_seconds FROM media WHERE media_type IN ('video','audio') ORDER BY id"
      ).all();
      if (sub === 'fingerprint' && !force) {
        rows = rows.filter(r => !repo.mediaHasFingerprints(r.id));
      }
      if (sub === 'scan') {
        rows = rows.filter(r => repo.mediaHasFingerprints(r.id));
      }
    } else {
      const row = db.getById(Number(target));
      if (!row) { console.error(`Media #${target} not found`); process.exit(1); }
      rows = [row];
    }

    if (!rows.length) { console.log('Nothing to do.'); return; }

    if (sub === 'fingerprint') {
      const tools = await fpx.checkTools();
      if (!tools.ok) {
        tools.errors.forEach(e => console.error('  - ' + e));
        process.exit(1);
      }
      console.log(`Fingerprinting ${rows.length} file(s)…\n`);
      let ok = 0, fail = 0;
      for (const r of rows) {
        const t0 = Date.now();
        process.stdout.write(`  [${r.id}] ${r.filename.slice(0, 60)} … `);
        try {
          const { chunks, skippedSilent } = await fpx.fingerprintMedia(r.filepath, {
            totalDuration: r.duration_seconds || null,
          });
          repo.saveMediaFingerprints(r.id, chunks.map(c => ({
            ...c, fingerprint: fpx.encodeFingerprint(c.fingerprint),
          })));
          const found = service.scanMedia(r.id);
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(`${chunks.length} chunks (${skippedSilent} silent skipped, ${secs}s)` +
            (found.length ? ` → 🎵 ${found.map(f => `${f.artist} - ${f.title}`).join('; ')}` : ''));
          ok++;
        } catch (e) {
          console.log(`FAILED: ${e.message}`);
          fail++;
        }
      }
      console.log(`\nDone. ${ok} succeeded, ${fail} failed.`);
      return;
    }

    // scan
    console.log(`Scanning ${rows.length} file(s) against references + each other…\n`);
    let links = 0;
    for (const r of rows) {
      const found = service.scanMedia(r.id);
      if (found.length) {
        console.log(`  [${r.id}] ${r.filename.slice(0, 60)} → ${found.map(f => `${f.artist} - ${f.title}`).join('; ')}`);
        links += found.length;
      }
    }
    console.log(`\nDone. ${links} new link(s).`);
    return;
  }

  console.error(`Unknown music subcommand: ${sub}`);
  process.exit(1);
}

module.exports = { run };
