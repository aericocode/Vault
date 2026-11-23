/**
 * Vault's own child processes on Linux, for the graceful shutdown
 * (server/index.js _gracefulExit).
 *
 * Ctrl+C in a terminal reaches every process in the terminal's foreground
 * group, so ffmpeg, mpv and the Python helpers stop together with Vault. A
 * Vault started with no terminal (a double-click on Linux) and stopped by
 * Exit Vault or a plain SIGTERM has no such signal for them: they carry on
 * as orphans (an ffmpeg render for minutes, writing into a temp folder the
 * shutdown is about to wipe). Windows needs none of this: Node puts every
 * child it starts in a job object that ends them when Vault's process ends.
 *
 * So on Linux the shutdown asks each of Vault's own direct children to stop
 * (SIGTERM) and waits a short while for them to go. They are found in /proc:
 * a process whose parent is Vault.
 *  - A child started detached is left alone: it runs in a session of its own
 *    (setsid), which is how a program meant to outlive Vault is started.
 *  - A child that has already exited (a zombie, state Z) is not signalled.
 *  - A pid read here cannot belong to anyone else by the time it is
 *    signalled: Node only reaps an exited child on a turn of the event loop,
 *    and nothing awaits between the read and the kill, so an unreaped child
 *    keeps its pid.
 *  - No /proc (macOS): nothing is found and nothing is signalled.
 */

const fs = require('fs');
const path = require('path');

/** One /proc/<pid>/stat line, or null when it cannot be read. */
function readStat(procDir, pid) {
  let text;
  try { text = fs.readFileSync(path.join(procDir, String(pid), 'stat'), 'utf8'); } catch { return null; }
  // "pid (comm) state ppid pgrp session ...": comm may hold spaces and
  // brackets, so the fields are read from after the LAST ')'.
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const f = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(f[1]);
  const sid = Number(f[3]);
  if (!f[0] || !Number.isInteger(ppid) || !Number.isInteger(sid)) return null;
  return { pid: Number(pid), state: f[0], ppid, sid };
}

/** Pids of `pid`'s own children that are still running and not detached. */
function listOwnChildren({ procDir = '/proc', pid = process.pid } = {}) {
  let names;
  try { names = fs.readdirSync(procDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const s = readStat(procDir, name);
    if (!s || s.ppid !== pid) continue;
    if (s.state === 'Z' || s.state === 'X') continue;   // exited, not reaped yet
    if (s.sid === s.pid) continue;                      // detached: its own session
    out.push(s.pid);
  }
  return out;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * SIGTERM every child listOwnChildren finds, then wait up to waitMs for
 * them to go (counted in steps, not by the clock, which can jump). Linux only.
 * @returns {Promise<{asked:number, left:number}>}
 */
async function stopOwnChildren({
  procDir = '/proc', pid = process.pid, platform = process.platform,
  kill = (p, sig) => process.kill(p, sig), waitMs = 2000, stepMs = 50,
} = {}) {
  if (platform !== 'linux') return { asked: 0, left: 0 };
  const kids = listOwnChildren({ procDir, pid });
  for (const k of kids) { try { kill(k, 'SIGTERM'); } catch { /* gone already */ } }
  let left = kids;
  for (let i = 0; i < Math.ceil(waitMs / stepMs) && left.length; i++) {
    await sleep(stepMs);
    const still = new Set(listOwnChildren({ procDir, pid }));
    left = left.filter(k => still.has(k));
  }
  return { asked: kids.length, left: left.length };
}

module.exports = { listOwnChildren, stopOwnChildren, readStat };
