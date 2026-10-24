/**
 * The processing_error strings that mean "a TOOL was missing", in one place.
 *
 * These are not just messages: the boot-time self-heal (lib/self-heal.js) finds
 * the affected rows by matching them, so the text a processor writes and the
 * text the healer looks for must be the same string. When they lived only at
 * the throw site, a file errored for a missing ffmpeg stayed errored forever —
 * installing the tool the message asked for healed nothing.
 *
 * Matching is by PREFIX, deliberately: the tail of a message may gain detail
 * (which python, which install hint) without orphaning rows written by an older
 * build. A broad LIKE '%ffmpeg%' would also catch genuine per-file ffmpeg
 * failures and silently discard real errors, so the prefixes stay narrow enough
 * that only this app's own tool-missing writes can match.
 */

// lib/processors/video-processor.js — ffprobe could not be run at all.
// Shown in the file's Processing error, so it is written for the user.
const FFPROBE_MISSING =
  'Video tools (ffmpeg) are missing. Install them from the banner at the top, then restart Vault.';
const FFPROBE_MISSING_PREFIX = 'Video tools (ffmpeg) are missing';
// What builds before 3.9 wrote. Rows carrying it are still in people's
// libraries, so the healer and the failure report keep matching it.
const FFPROBE_MISSING_LEGACY_PREFIX = 'ffprobe not found on PATH';

// lib/processors/audio-processor.js — no Python and/or no faster-whisper.
const WHISPER_MISSING_PREFIX = 'Transcription is not set up';
const WHISPER_MISSING =
  `${WHISPER_MISSING_PREFIX}. Python is installed, but its speech-to-text package is not. Press Generate in this file's subtitles panel to see how to add it.`;
const WHISPER_NO_PYTHON =
  `${WHISPER_MISSING_PREFIX}. It needs Python, which was not found. Press Generate in this file's subtitles panel to see how to set it up.`;
// Pre-3.9 wording (it had an em dash and a pip command); see above.
const WHISPER_MISSING_LEGACY_PREFIX = 'transcription unavailable — needs Python + faster-whisper';

// Every prefix a tool-missing row may carry, current first.
const FFPROBE_MISSING_PREFIXES = Object.freeze([FFPROBE_MISSING_PREFIX, FFPROBE_MISSING_LEGACY_PREFIX]);
const WHISPER_MISSING_PREFIXES = Object.freeze([WHISPER_MISSING_PREFIX, WHISPER_MISSING_LEGACY_PREFIX]);

/**
 * Message for a machine that cannot transcribe, told apart by WHY.
 * @param {{python?: boolean}} check - result of video-transcriber.checkTranscriber()
 * @returns {string}
 */
function whisperMissingMessage(check) {
  return check && check.python ? WHISPER_MISSING : WHISPER_NO_PYTHON;
}

/**
 * The description lib/processors/audio-processor.js used to write when it saved
 * an un-transcribed audio file as a SUCCESS. Rows carrying it are the legacy
 * backfill set for the self-heal. The suffix is composed in exactly one place in
 * this codebase, so an exact-suffix LIKE is as tight as a full-string match
 * while still catching the ID3-tag variant ("Title: x. Artist: y. - …").
 */
const AUDIO_PLACEHOLDER_SUFFIX = ' - transcription unavailable';

module.exports = {
  FFPROBE_MISSING,
  FFPROBE_MISSING_PREFIX,
  FFPROBE_MISSING_PREFIXES,
  WHISPER_MISSING,
  WHISPER_NO_PYTHON,
  WHISPER_MISSING_PREFIX,
  WHISPER_MISSING_PREFIXES,
  whisperMissingMessage,
  AUDIO_PLACEHOLDER_SUFFIX,
};
