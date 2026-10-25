/**
 * Every test file requires this first: it points the AI server at a port
 * nothing listens on, so no test can reach the user's own LM Studio (or
 * whatever LM_STUDIO_URLS names in the shell that runs the suite):
 * VAULT_OFFLINE does not block localhost. Tests that need an AI server start
 * their own stub and hand it to the registry themselves.
 */
process.env.LM_STUDIO_URLS = 'http://127.0.0.1:9/v1/chat/completions';
