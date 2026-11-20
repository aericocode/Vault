/**
 * Every test file requires this first: it points the AI server at a port
 * nothing listens on, so no test can reach the user's own LM Studio (or
 * whatever LM_STUDIO_URLS names in the shell that runs the suite):
 * VAULT_OFFLINE does not block localhost. Tests that need an AI server start
 * their own stub and hand it to the registry themselves.
 */
process.env.LM_STUDIO_URLS = 'http://127.0.0.1:9/v1/chat/completions';

// Context use numbers (lib/context-use.js) go to a temp file, never beside
// the real settings file.
// The same for the list of servers known to be LM Studio (lib/ai-slots.js).
if (!process.env.VAULT_LM_SEEN_FILE) {
  process.env.VAULT_LM_SEEN_FILE = require('path').join(require('os').tmpdir(), `vault-test-lm-seen-${process.pid}.json`);
  const seenFile = process.env.VAULT_LM_SEEN_FILE;
  process.on('exit', () => { try { require('fs').unlinkSync(seenFile); } catch {} });
}
if (!process.env.VAULT_CONTEXT_USE_FILE) {
  process.env.VAULT_CONTEXT_USE_FILE = require('path').join(require('os').tmpdir(), `vault-test-context-use-${process.pid}.json`);
}
