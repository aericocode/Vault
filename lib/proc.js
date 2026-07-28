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
    execFile(cmd, args, {
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

module.exports = { run, runPool };
