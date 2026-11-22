/**
 * Stand-in ffprobe and ffmpeg for the personal details check
 * (lib/share/meta.js), for share tests that are not about the check itself.
 *
 * Every share is checked, and with ffprobe or ffmpeg missing a share that
 * asks for removal is refused (PERSONAL_CHECK_OFF). Tests that start shares
 * for some other reason (the pack line, the automatic lock, the one-time
 * warning) must not depend on the machine having ffmpeg installed, so they
 * use these: meta.js's own seam (_setForTest), nothing on PATH is touched.
 *
 * The fake ffprobe answers "a video with nothing personal" for any file, so
 * nothing gets a cleaned copy; the fake ffmpeg fails loudly if it is ever run.
 *
 *   const fakeFf = require('./helpers/fake-ff');
 *   fakeFf.install();   // in test.before, or inside one test
 *   fakeFf.restore();   // in test.after, or that test's finally
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const meta = require('../../lib/share/meta');

let dir = null;

function install() {
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-fake-ff-'));
    fs.writeFileSync(path.join(dir, 'ffprobe.js'), [
      "process.stdout.write(JSON.stringify({ format: { format_name: 'mov,mp4', tags: { encoder: 'Lavf' } },",
      "  streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }));",
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'ffmpeg.js'), "process.stderr.write('fake ffmpeg: not expected in this test'); process.exit(1);");
  }
  meta._setForTest({
    probe: { exe: process.execPath, pre: [path.join(dir, 'ffprobe.js')] },
    ffmpeg: { exe: process.execPath, pre: [path.join(dir, 'ffmpeg.js')] },
  });
}

/** Back to Vault's own programs (whatever this machine has, or nothing). */
function restore() {
  meta._setForTest({ probe: null, ffmpeg: null });
  if (dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    dir = null;
  }
}

module.exports = { install, restore };
