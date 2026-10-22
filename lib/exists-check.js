/**
 * "Is this file there?" for many paths, off the main thread.
 *
 * fs.existsSync on a path whose server is unreachable (\\host\share\a.jpg
 * with the host gone) blocks for up to ~40 s inside Windows; on the main
 * thread that is the whole server frozen. An fs.promises call would tie up
 * a libuv thread-pool thread instead (four in all), which stalls every other
 * file operation. So the checks run in a worker thread of their own: the
 * main thread only waits on a message, with a timeout. A batch that does not
 * answer in time comes back null, the worker is dropped (terminate) and the
 * next batch gets a fresh one.
 */

const { Worker } = require('worker_threads');

/*
 * Workers told to stop while stuck inside a system call (an unreachable
 * share) do not stop until the call returns, up to ~40 s, and Node waits for
 * them when the process exits. The server's shutdown asks hasStuckWorkers()
 * and, if any, ends the process without that wait (server/index.js).
 */
const _stuck = new Set();
function hasStuckWorkers() { return _stuck.size > 0; }

const WORKER_SRC = `
const { parentPort } = require('worker_threads');
const fs = require('fs');
parentPort.on('message', ({ id, paths }) => {
  const results = paths.map((p) => { try { return fs.existsSync(p); } catch { return false; } });
  parentPort.postMessage({ id, results });
});
`;

class ExistsChecker {
  constructor() {
    this.worker = null;
    this.seq = 0;
    this.waiting = new Map();     // id -> { resolve, timer }
  }

  _ensure() {
    if (this.worker) return this.worker;
    const w = new Worker(WORKER_SRC, { eval: true });
    w.unref();
    w.on('message', ({ id, results }) => {
      const job = this.waiting.get(id);
      if (!job) return;
      clearTimeout(job.timer);
      this.waiting.delete(id);
      job.resolve(results);
    });
    const fail = () => {
      if (this.worker === w) this.worker = null;
      // Only this worker's jobs: a replacement may already be answering others.
      for (const [id, job] of this.waiting) {
        if (job.w !== w) continue;
        clearTimeout(job.timer); job.resolve(null); this.waiting.delete(id);
      }
    };
    w.on('error', fail);
    w.on('exit', () => { _stuck.delete(w); fail(); });
    this.worker = w;
    return w;
  }

  /**
   * @param {string[]} paths
   * @param {number} timeoutMs
   * @returns {Promise<boolean[]|null>} null: no answer in time (the worker is replaced)
   */
  check(paths, timeoutMs = 10000) {
    if (!paths.length) return Promise.resolve([]);
    const w = this._ensure();
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        if (this.worker === w) this.worker = null;
        _stuck.add(w);
        w.terminate().catch(() => {});
        resolve(null);
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.waiting.set(id, { resolve, timer, w });
      w.postMessage({ id, paths });
    });
  }

  close() {
    const w = this.worker;
    this.worker = null;
    if (w) w.terminate().catch(() => {});
  }
}

module.exports = { ExistsChecker, hasStuckWorkers };
