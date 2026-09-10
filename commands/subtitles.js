/**
 * Subtitles CLI — manage OPUS-MT translation language packs and generate
 * subtitles without the viewer.
 *
 *   node vault.js subtitles langs                 list installed packs
 *   node vault.js subtitles install <ja[,ko,fr]>  pre-fetch pack(s)
 *   node vault.js subtitles remove <ja>           delete a pack
 *   node vault.js subtitles gen <id|all>          generate for media
 *
 * Packs auto-install on first use (a Japanese video translates → ja-en is
 * fetched automatically). These commands are for pre-fetching, auditing disk
 * use, and reclaiming space. Source→English only (that's what OPUS-MT-*-en
 * covers, and the pipeline targets English).
 */

const translator = require('../lib/subtitles/translator');

function fmtSize(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

async function run(args) {
  const [sub, target] = args;

  if (!sub || sub === 'help') {
    console.log('Usage: node vault.js subtitles <langs|install|remove|gen> [ja[,ko] | id|all]');
    console.log('  langs                list installed translation packs + disk use');
    console.log('  install <ja[,ko,…]>  pre-fetch OPUS-MT pack(s) (else they auto-install on first use)');
    console.log('  remove <ja>          delete a pack to reclaim disk');
    console.log('  gen <id|all>         generate subtitles for media id (or every video/audio)');
    return;
  }

  if (sub === 'langs') {
    const packs = translator.listInstalled();
    console.log(`OPUS-MT translation packs  (${translator.OPUS_MODEL_DIR})`);
    if (!packs.length) {
      console.log('  (none installed, they auto-install the first time a foreign-language file is translated)');
      return;
    }
    let total = 0;
    for (const p of packs) {
      total += p.sizeBytes;
      console.log(`  ${p.lang.padEnd(6)} → en   ${fmtSize(p.sizeBytes).padStart(8)}   ${p.pair}`);
    }
    console.log(`  ${''.padEnd(6)}         ${fmtSize(total).padStart(8)}   total`);
    return;
  }

  if (sub === 'install') {
    if (!target) { console.error('Usage: subtitles install <ja[,ko,fr]>'); process.exit(1); }
    for (const lang of target.split(',').map(s => s.trim()).filter(Boolean)) {
      if (translator.isProvisioned(lang)) { console.log(`  ✓ ${lang}-en already installed`); continue; }
      process.stdout.write(`  ⏳ Installing ${lang}-en … `);
      try {
        await translator.provision(lang, () => {});
        console.log('done');
      } catch (err) {
        console.log(`FAILED: ${err.message.split('\n')[0]}`);
      }
    }
    translator.shutdownSidecar();
    return;
  }

  if (sub === 'remove') {
    if (!target) { console.error('Usage: subtitles remove <ja>'); process.exit(1); }
    for (const lang of target.split(',').map(s => s.trim()).filter(Boolean)) {
      console.log(translator.removePack(lang) ? `  ✓ removed ${lang}-en` : `  – ${lang}-en not installed`);
    }
    return;
  }

  if (sub === 'gen') {
    const db = require('../lib/database');
    db.init();
    const service = require('../lib/subtitles/service');
    let rows;
    if (target === 'all') {
      // Skip files already known to have no speech — bulk gen shouldn't reload
      // the model just to re-fail. A single `gen <id>` ignores the flag (manual
      // override).
      rows = db.get().prepare("SELECT * FROM media WHERE media_type IN ('video','audio') AND user_trashed = 0 AND COALESCE(subtitle_no_speech, 0) = 0").all();
    } else {
      const id = Number(target);
      const row = id ? db.getById(id) : null;
      if (!row) { console.error('Usage: subtitles gen <id|all>'); process.exit(1); }
      rows = [row];
    }
    console.log(`Generating subtitles for ${rows.length} file(s)…`);
    for (const row of rows) {
      try {
        const res = await service.generateForMedia(row, {
          onProgress: (stage) => process.stdout.write(`\r  ${row.filename}: ${stage}                    `),
        });
        console.log(`\r  ✓ ${row.filename}: ${res.noSpeech ? 'no speech detected' : res.language + (res.tracks.includes('en') && res.language !== 'en' ? ' + en' : '')}                    `);
      } catch (err) {
        console.log(`\r  ✗ ${row.filename}: ${err.message}                    `);
      }
    }
    require('../lib/video-transcriber').cleanupAll();
    translator.shutdownSidecar();
    db.close();
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  process.exit(1);
}

module.exports = { run };
