/**
 * Async subprocess helper.
 *
 * The tagger previously used execSync for every ffmpeg/ffprobe call, which
 * blocks Node's event loop — with parallel workers this serialized the whole
 * scan (no vision response could even be processed while a frame extracted).
 * execFile with an args array also avoids shell quoting, so filenames with
 * quotes/spaces/etc. can't break the command.
 */

const { execFile } = require('child_process');

/* A child started inside an AI scan stops when the scan is cut off for
   playback (AI scan Auto, lib/ai-slots.js scanSignal): execFile kills it on
   the abort, and once cut nothing new is spawned. Outside a scan: null. */
function _scanSignal() {
  try { return require('./ai-slots').scanSignal(); } catch { return null; }
}

function _exec(cmd, args, opts, onDone) {
  const signal = _scanSignal();
  if (signal && signal.aborted) {
    onDone(require('./ai-slots').cutError());
    return;
  }
  execFile(cmd, args, signal ? { ...opts, signal } : opts, (err, stdout, stderr) => {
    if (err && signal && signal.aborted) {
      const cut = require('./ai-slots').cutError();
      cut.stderr = stderr;
      return onDone(cut, stdout, stderr);
    }
    onDone(err, stdout, stderr);
  });
}

/**
 * Run a command asynchronously.
 * @param {string} cmd - executable (e.g. 'ffmpeg')
 * @param {string[]} args - arguments (no shell quoting needed)
 * @param {object} [options]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function run(cmd, args, options = {}) {
  // ffmpeg/ffprobe may live next to the exe rather than on PATH — nearly every
  // spawn in the app funnels through here, so this one line covers them all.
  cmd = require('./ffmpeg-locate').resolve(cmd);
  return new Promise((resolve, reject) => {
    _exec(cmd, args, {
      encoding: 'utf-8',
      windowsHide: true,
      maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
      timeout: options.timeout || 300000,
    }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Run a command and collect its stdout as raw bytes (ffmpeg writing a picture
 * to pipe:1, so nothing touches the disk).
 * @returns {Promise<Buffer>}
 */
function runBuffer(cmd, args, options = {}) {
  cmd = require('./ffmpeg-locate').resolve(cmd);
  return new Promise((resolve, reject) => {
    _exec(cmd, args, {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
      timeout: options.timeout || 60000,
    }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr ? stderr.toString() : '';
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Run tasks with limited concurrency.
 * @param {Array<() => Promise<any>>} tasks - task factories
 * @param {number} concurrency
 * @returns {Promise<any[]>} results in task order (rejections become undefined)
 */
async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = await tasks[i]();
      } catch {
        results[i] = undefined;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.max(1, Math.min(concurrency, tasks.length)); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

module.exports = { run, runBuffer, runPool };
