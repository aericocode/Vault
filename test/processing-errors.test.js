'use strict';
/**
 * The tool-missing processing errors are shown to users (a file's Processing
 * error) AND matched by prefix by the self-heal and the scan-failure report.
 * 3.9 reworded them, so rows written by older builds must still match.
 */
const test = require('node:test');
const assert = require('node:assert');
const perr = require('../lib/processing-errors');
const sf = require('../lib/scan-failures');

test('current messages are plain: no em dash, no install commands', () => {
  for (const msg of [perr.FFPROBE_MISSING, perr.WHISPER_MISSING, perr.WHISPER_NO_PYTHON]) {
    assert.ok(!/[–—]/.test(msg), msg);
    assert.ok(!/pip install|winget|on PATH/i.test(msg), msg);
    assert.match(msg, /^[A-Z].*\.$/, 'a full sentence: ' + msg);
  }
});

test('every message starts with its own current prefix', () => {
  assert.ok(perr.FFPROBE_MISSING.startsWith(perr.FFPROBE_MISSING_PREFIX));
  assert.ok(perr.WHISPER_MISSING.startsWith(perr.WHISPER_MISSING_PREFIX));
  assert.ok(perr.WHISPER_NO_PYTHON.startsWith(perr.WHISPER_MISSING_PREFIX));
  assert.strictEqual(perr.FFPROBE_MISSING_PREFIXES[0], perr.FFPROBE_MISSING_PREFIX);
  assert.strictEqual(perr.WHISPER_MISSING_PREFIXES[0], perr.WHISPER_MISSING_PREFIX);
});

test('prefixes are safe inside a SQL LIKE (no wildcards)', () => {
  for (const p of [...perr.FFPROBE_MISSING_PREFIXES, ...perr.WHISPER_MISSING_PREFIXES]) {
    assert.ok(!/[%_]/.test(p), p);
  }
});

test('rows written by pre-3.9 builds still count as a missing tool', () => {
  const legacy = [
    'ffprobe not found on PATH. Install ffmpeg (winget install ffmpeg), then restart Vault',
    'transcription unavailable — needs Python + faster-whisper (pip install faster-whisper)',
    'transcription unavailable — needs Python + faster-whisper (install Python 3.8+, then: pip install faster-whisper)',
  ];
  for (const msg of legacy) {
    assert.strictEqual(sf.classify(msg), 'tool-missing', msg);
    assert.ok([...perr.FFPROBE_MISSING_PREFIXES, ...perr.WHISPER_MISSING_PREFIXES].some((p) => msg.startsWith(p)), msg);
  }
  for (const msg of [perr.FFPROBE_MISSING, perr.WHISPER_MISSING, perr.WHISPER_NO_PYTHON]) {
    assert.strictEqual(sf.classify(msg), 'tool-missing', msg);
  }
});
