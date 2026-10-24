'use strict';
/**
 * 3.9 reworded the tool-missing processing errors. The self-heal finds its
 * rows by prefix, so a row written by an older build (old wording) and a row
 * written now (new wording) must both be found. Dry run only: nothing probes
 * for Python and nothing is written.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-selfheal-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const perr = require('../lib/processing-errors');
const selfHeal = require('../lib/self-heal');

test.before(() => { db.init(); });
test.after(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('whisper rows in both the old and the new wording are found', () => {
  const ins = db.get().prepare("INSERT INTO media (filepath, filename, media_type, processing_error) VALUES (?, ?, 'audio', ?)");
  ins.run(path.join(tmp, 'a.mp3'), 'a.mp3', 'transcription unavailable — needs Python + faster-whisper (pip install faster-whisper)');
  ins.run(path.join(tmp, 'b.mp3'), 'b.mp3', perr.WHISPER_NO_PYTHON);
  ins.run(path.join(tmp, 'c.mp3'), 'c.mp3', perr.WHISPER_MISSING);
  ins.run(path.join(tmp, 'd.mp3'), 'd.mp3', 'some other failure');
  assert.strictEqual(selfHeal.countWhisperHealable(), 3);
});
