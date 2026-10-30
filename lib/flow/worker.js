/**
 * Flow's worker thread: the heavy parts of Flow run here, never on the
 * server's main thread (lib/flow/pool.js talks to it).
 *
 *   { type: 'measure', id, filePath, duration }   -> lib/flow/analyze.js measureFile
 *   { type: 'cancel', id }                        stops that measurement (ffmpeg is killed)
 *   { type: 'order', id, features, shape, waves, firstId, places } -> FlowOrder.planOrder + summary
 *                                                 (places: { id: place } or null)
 *
 * Answers { id, ok: true, result } or { id, ok: false, error, code }.
 */

const { parentPort } = require('worker_threads');
const analyze = require('./analyze');
const FlowOrder = require('../../player-lib/flow-order.js');

const running = new Map();     // id -> AbortController

// Tests only (VAULT_FLOW_TEST_HOOKS=1): a worker that dies or hangs on cue.
const HOOKS = process.env.VAULT_FLOW_TEST_HOOKS === '1';
function testHook(filePath) {
  if (!HOOKS || typeof filePath !== 'string' || !filePath.startsWith(':')) return null;
  if (filePath === ':crash') process.exit(3);
  if (filePath === ':hang') { for (;;) { /* stuck */ } }
  if (filePath.startsWith(':crash-once:')) {
    const fs = require('fs');
    const marker = filePath.slice(':crash-once:'.length);
    if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); process.exit(3); }
    return { version: 2, lufs: -20, has_music: 1, fromRetry: true };
  }
  if (filePath.startsWith(':hang-once:')) {
    const fs = require('fs');
    const marker = filePath.slice(':hang-once:'.length);
    if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); for (;;) { /* stuck */ } }
    return { version: 2, lufs: -20, has_music: 1, fromRetry: true };
  }
  return null;
}

parentPort.on('message', async (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'cancel') {
    const c = running.get(m.id);
    if (c) c.abort();
    return;
  }
  if (m.type === 'measure') {
    const ctl = new AbortController();
    running.set(m.id, ctl);
    try {
      const result = testHook(m.filePath) || await analyze.measureFile(m.filePath, { duration: m.duration, signal: ctl.signal });
      parentPort.postMessage({ id: m.id, ok: true, result });
    } catch (err) {
      parentPort.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err), code: ctl.signal.aborted ? 'ABORTED' : (err && err.code) || null });
    } finally {
      running.delete(m.id);
    }
    return;
  }
  if (m.type === 'order') {
    try {
      const plan = FlowOrder.planOrder(m.features, { shape: m.shape, waves: m.waves, firstId: m.firstId, places: m.places || null });
      const sum = FlowOrder.summary(m.features, plan.order);
      parentPort.postMessage({ id: m.id, ok: true, result: { order: plan.order, targets: plan.targets, handovers: sum.handovers, jumps: sum.jumps } });
    } catch (err) {
      parentPort.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err), code: null });
    }
  }
});
