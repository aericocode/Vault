/**
 * Share privately: packing and the archive checks (spec 6.1, 6.2). No network.
 *
 * PACKING. 7z format, AES-256 (7-Zip's 7zAES), headers encrypted (-mhe=on) so
 * the names inside cannot be read without the password, stored not
 * compressed (-mx=0), split with -v<bytes>b only when the total is over the
 * part size. The password goes to 7-Zip on stdin (lib/share/sevenzip.js).
 *
 * WHICH FILES, AND UNDER WHAT NAME. 7-Zip reads the files from a list file
 * (-i@list, UTF-8 via -scsUTF-8). Each line is an ABSOLUTE path, so no line
 * can start with "-" or "@" and be read as a switch, and 7-Zip stores the
 * base name only, never the library path. Two kinds of file do not go in by
 * their own path; they are linked (or, across drives, copied) into the
 * share's own stage/ folder under the name they get in the archive:
 *   - a repeated base name, which gets " (2)", " (3)" (lib/share/names.js);
 *   - a path holding a character the list file or 7-Zip's name matching
 *     would read differently: control characters (a line break would split
 *     the line), "*" and "?" (wildcards), and outside Windows a backslash.
 *     In the archive those characters become "_".
 * The archive path is given after "--", which ends 7-Zip's switches, and is
 * always <work folder>/<checked name>.7z.
 *
 * CLEANED COPIES. With "Remove from the packed copies" chosen, a file the
 * server's own check flagged (entry.clean, see withClean and
 * lib/share/meta.js) goes in as a copy with its personal details removed,
 * written as a brand-new file into stage/ under its archive name by the
 * cleaner given to pack(). It is never a link to the original. Those copies
 * are made first (phase 'cleaning'); a cleaner that fails fails the pack
 * (CLEAN_FAILED with the file's name), the original is never packed instead.
 *
 * THE CHECKS, run by Vault on the very part files that get uploaded:
 *   1. `t` with the password: 7-Zip tests every file, "Everything is Ok".
 *   2. `l` WITHOUT a password (stdin closed): must fail and must not show a
 *      single name. If it lists anything the share stops.
 *   3. `l -slt` with the password: exactly the expected names and sizes, each
 *      one encrypted with 7zAES. Nothing else is in the archive.
 *   4. The part files on disk: the expected names in order, count and sizes.
 *      Their size and modified time are kept, and checked again before each
 *      part is uploaded (lib/share/service.js), so a part changed after the
 *      checks is never sent.
 */

const fs = require('fs');
const path = require('path');
const sevenzip = require('./sevenzip');
const names = require('./names');
const temp = require('./temp');

const IS_WIN = process.platform === 'win32';
const SPACE_MARGIN = 0.05;   // free space needed: total plus 5 percent

function _err(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra || {});
}

/** Characters that must never reach the list file or 7-Zip's name matching. */
function _unsafePathChars(p) {
  return /[\x00-\x1f\x7f*?]/.test(p) || (!IS_WIN && p.includes('\\'));
}

function _cleanBaseName(base) {
  let s = base.replace(/[\x00-\x1f\x7f*?]/g, '_');
  if (!IS_WIN) s = s.replace(/\\/g, '_');
  return s || 'file';
}

/**
 * Work out what goes into the archive.
 * @param {{mediaId:number|null, filepath:string, size:number}[]} files
 * @param {{partBytes:number|null}} o   null = never split
 */
function plan(files, { partBytes = null } = {}) {
  const bases = files.map(f => _cleanBaseName(path.basename(f.filepath)));
  const unique = names.uniqueNames(bases);
  const entries = files.map((f, i) => {
    const base = path.basename(f.filepath);
    const stage = unique[i] !== base || _unsafePathChars(f.filepath) || !path.isAbsolute(f.filepath);
    return { mediaId: f.mediaId ?? null, src: f.filepath, archiveName: unique[i], size: f.size, stage };
  });
  return _sum(entries, partBytes);
}

function _sum(entries, partBytes) {
  const totalBytes = entries.reduce((n, e) => n + e.size, 0);
  const split = !!(partBytes && totalBytes > partBytes);
  // 7-Zip adds a little per volume; the count is a good estimate, the real
  // one comes from the disk after packing.
  const parts = split ? Math.ceil(totalBytes / partBytes) : 1;
  // Staged files may be copies (another drive), so they count twice. A
  // cleaned copy (personal details removed, lib/share/meta.js) is always a
  // real copy, even on the same drive.
  const stagedBytes = entries.filter(e => e.stage || e.clean).reduce((n, e) => n + e.size, 0);
  const cleanBytes = entries.filter(e => e.clean).reduce((n, e) => n + e.size, 0);
  const needBytes = Math.ceil(totalBytes * (1 + SPACE_MARGIN)) + stagedBytes;
  return { entries, totalBytes, split, partBytes: split ? partBytes : null, parts, needBytes, stagedBytes, cleanBytes, basePartBytes: partBytes };
}

/**
 * The same plan with the files at these positions packed as cleaned copies
 * (flags[i] true). Names, sizes and the split stay as they were; the free
 * space needed grows by the files that become copies.
 */
function withClean(p, flags) {
  const entries = p.entries.map((e, i) => ({ ...e, clean: !!(flags && flags[i]) }));
  return _sum(entries, p.basePartBytes !== undefined ? p.basePartBytes : p.partBytes);
}

/** The part files 7-Zip wrote for `archiveName`, in order, from the disk. */
function listParts(workDir, archiveName, split) {
  const all = fs.readdirSync(workDir);
  let fileNames;
  if (split) {
    const prefix = `${archiveName}.7z.`;
    fileNames = all.filter(n => n.startsWith(prefix) && /^\d{3,}$/.test(n.slice(prefix.length)))
      .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
    // Numbering must run 001, 002, ... with no gap.
    fileNames.forEach((n, i) => {
      if (Number(n.slice(prefix.length)) !== i + 1) throw _err('PARTS_MISMATCH', 'The packed parts are not complete.');
    });
  } else {
    fileNames = all.filter(n => n === `${archiveName}.7z`);
  }
  return fileNames.map((fileName, i) => {
    const st = fs.statSync(path.join(workDir, fileName));
    return { partNo: i + 1, fileName, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
  });
}

function _stagePath(stageDir, e) {
  const dst = path.join(stageDir, e.archiveName);
  if (!temp.isInside(stageDir, path.resolve(dst)) || path.dirname(path.resolve(dst)) !== path.resolve(stageDir)) {
    throw _err('BAD_NAME', 'A file name could not be used.');
  }
  return dst;
}

async function _stageEntries(entries, workDir, handle, alive, { cleaner, onProgress } = {}) {
  const stageDir = path.join(workDir, 'stage');
  const out = [];
  // First the cleaned copies ("Removing personal details"): each one is a new
  // file written by the cleaner into stage/, never a link to the original.
  // A finished file is a sign of life; the cleaner reports its own output.
  const toClean = entries.filter(e => e.clean);
  if (toClean.length) {
    if (typeof cleaner !== 'function') throw _err('CLEAN_FAILED', 'Vault could not remove personal details.', { fileName: toClean[0].archiveName });
    fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    let done = 0;
    for (const e of toClean) {
      if (handle && handle.cancelled) throw _err('CANCELLED', 'Packing was cancelled.');
      const dst = _stagePath(stageDir, e);
      try {
        await cleaner(e, dst);
      } catch (err) {
        if ((handle && handle.cancelled) || (err && err.code === 'CANCELLED')) throw _err('CANCELLED', 'Packing was cancelled.');
        throw _err('CLEAN_FAILED', 'Vault could not remove personal details.', { fileName: e.archiveName });
      }
      done += 1;
      if (onProgress) onProgress({ phase: 'cleaning', percent: Math.floor((done / toClean.length) * 100) });
      alive();
    }
    if (onProgress) onProgress({ phase: 'staging', percent: 0 });
  }
  for (const e of entries) {
    if (handle && handle.cancelled) throw _err('CANCELLED', 'Packing was cancelled.');
    if (e.clean) { out.push(_stagePath(stageDir, e)); continue; }
    alive();
    if (!e.stage) { out.push(e.src); continue; }
    fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    const dst = _stagePath(stageDir, e);
    try {
      fs.linkSync(e.src, dst);   // same drive: no copy, no extra space
    } catch {
      await fs.promises.copyFile(e.src, dst, fs.constants.COPYFILE_EXCL);
    }
    out.push(dst);
  }
  return out;
}

/**
 * Pack the planned entries into <workDir>/<archiveName>.7z[.NNN].
 * onActivity (optional): a sign of life, for each file staged and on every
 * chunk 7-Zip writes.
 * @returns {Promise<{partNo,fileName,size,mtimeMs}[]>}
 */
async function pack({ entries, workDir, archiveName, password, partBytes = null, split = false, onProgress, onActivity, handle, program, cleaner }) {
  const alive = () => { if (onActivity) { try { onActivity(); } catch {} } };
  if (!names.isSafeArchiveName(archiveName)) throw _err('BAD_NAME', 'The archive name cannot be used.');
  if (!sevenzip.passwordFitsStdin(password)) throw _err('BAD_PASSWORD', 'That password cannot be used.');
  const archivePath = path.join(workDir, `${archiveName}.7z`);
  if (path.dirname(archivePath) !== workDir) throw _err('BAD_NAME', 'The archive name cannot be used.');

  // The list (original paths) and stage/ (links or copies of the files) are
  // plaintext about the library: deleted on EVERY way out of here, success,
  // failure, cancel or a lock, with a few tries. What still cannot be deleted
  // (a file held open) is deleted with the work folder, or by the clean-up in
  // lib/share/service.js, which keeps trying.
  try {
    onProgress && onProgress({ phase: entries.some(e => e.clean) ? 'cleaning' : 'staging', percent: 0 });
    const lines = await _stageEntries(entries, workDir, handle, alive, { cleaner, onProgress });
    for (const l of lines) {
      if (!path.isAbsolute(l) || /[\r\n]/.test(l)) throw _err('BAD_NAME', 'A file name could not be used.');
    }
    const listFile = path.join(workDir, 'list.txt');
    fs.writeFileSync(listFile, lines.join('\n') + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });

    const args = ['a', '-t7z', '-mx=0', '-mhe=on', '-mtc=off', '-mta=off',
      '-sccUTF-8', '-scsUTF-8', '-p', '-bsp1', '-bso1', '-bse1'];
    if (split) args.push(`-v${Math.trunc(partBytes)}b`);
    args.push(`-i@${listFile}`, '--', archivePath);

    if (handle && handle.cancelled) throw _err('CANCELLED', 'Packing was cancelled.');
    onProgress && onProgress({ phase: 'packing', percent: 0 });
    const r = await sevenzip.runSevenZip(args, {
      password, cwd: workDir, handle, program,
      onPercent: (p) => onProgress && onProgress({ phase: 'packing', percent: p }),
      onOutput: alive,
    });
    if (r.killed || (handle && handle.cancelled)) throw _err('CANCELLED', 'Packing was cancelled.');
    // Exit 1 is a 7-Zip warning (a file could not be read, for one). Any
    // warning fails the share: the archive might be missing something.
    if (r.code !== 0) throw _err('PACK_FAILED', 'Packing failed. A file may be in use or unreadable, or the drive is full.');
  } finally {
    await removeScratch(workDir);
  }
  return listParts(workDir, archiveName, split);
}

/** Delete list.txt and stage/ from a work folder (see pack()). True when none is left. */
async function removeScratch(workDir, opts) {
  return temp.removeScratchAt(workDir, opts);
}

/** Parse `7z l -slt` output into the entries after the "----------" line. */
function parseSlt(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex(l => /^-{10,}$/.test(l.trim()));
  const head = {};
  for (const l of (start >= 0 ? lines.slice(0, start) : lines)) {
    const m = /^([A-Za-z ]+?) = (.*)$/.exec(l);
    if (m && !(m[1] in head)) head[m[1]] = m[2];
  }
  const items = [];
  if (start < 0) return { head, items };
  let cur = null;
  for (const l of lines.slice(start + 1)) {
    if (!l.trim()) { if (cur) { items.push(cur); cur = null; } continue; }
    const m = /^([A-Za-z ]+?) = (.*)$/.exec(l);
    if (!m) continue;
    if (!cur) cur = {};
    cur[m[1]] = m[2];
  }
  if (cur) items.push(cur);
  return { head, items: items.filter(i => 'Path' in i) };
}

/**
 * The checks of step 2. Never throws for a failed check: each result says
 * ok or not, and `ok` is true only when all of them passed.
 * @param {object} o
 * @param {{archiveName:string, size:number}[]} o.expected   names in the archive
 * @param {{fileName,size,mtimeMs}[]} o.parts                 from pack()
 * @param {()=>void} [o.onActivity]  a sign of life: before each step and on
 *        every chunk 7-Zip writes. The test step reads the whole archive, so
 *        it shows its progress on stderr (-bsp2); stdout, which the result
 *        is read from, is the same as without it.
 */
async function runChecks({ workDir, archiveName, password, expected, parts, split, handle, program, onActivity }) {
  const first = path.join(workDir, parts.length ? parts[0].fileName : `${archiveName}.7z`);
  const result = {
    test: { ok: false },
    listWithoutPassword: { ok: false },
    contents: { ok: false },
    parts: { ok: false, count: parts.length, bytes: parts.reduce((n, p) => n + p.size, 0) },
  };
  const cancelled = () => (handle && handle.cancelled);
  const alive = () => { if (onActivity) { try { onActivity(); } catch {} } };

  // 4 first: if the parts are not what packing produced, nothing else counts.
  try {
    const now = listParts(workDir, archiveName, split);
    result.parts.ok = now.length > 0 && now.length === parts.length
      && now.every((p, i) => p.fileName === parts[i].fileName && p.size === parts[i].size && p.mtimeMs === parts[i].mtimeMs);
  } catch { result.parts.ok = false; }

  // 1. Test with the password.
  if (cancelled()) throw _err('CANCELLED', 'Checking was cancelled.');
  alive();
  const t = await sevenzip.runSevenZip(['t', '-sccUTF-8', '-bso1', '-bse1', '-bsp2', '--', first], { password, cwd: workDir, handle, program, onOutput: alive });
  if (cancelled() || t.killed) throw _err('CANCELLED', 'Checking was cancelled.');
  result.test.ok = t.code === 0 && /^Everything is Ok\s*$/m.test(t.stdout);

  // 2. List without a password: stdin closed, so 7-Zip cannot be given one.
  alive();
  const nl = await sevenzip.runSevenZip(['l', '-slt', '-sccUTF-8', '-bso1', '-bse1', '--', first], { password: null, cwd: workDir, handle, program, onOutput: alive });
  if (cancelled() || nl.killed) throw _err('CANCELLED', 'Checking was cancelled.');
  const leaked = parseSlt(nl.stdout).items.length > 0
    || expected.some(e => nl.stdout.includes(`Path = ${e.archiveName}`));
  result.listWithoutPassword.ok = nl.code !== 0 && !leaked;
  result.listWithoutPassword.leaked = leaked;

  // 3. List with the password: exactly what was meant to go in, encrypted.
  alive();
  const wl = await sevenzip.runSevenZip(['l', '-slt', '-sccUTF-8', '-bso1', '-bse1', '--', first], { password, cwd: workDir, handle, program, onOutput: alive });
  if (cancelled() || wl.killed) throw _err('CANCELLED', 'Checking was cancelled.');
  if (wl.code === 0) {
    const { head, items } = parseSlt(wl.stdout);
    const want = new Map(expected.map(e => [e.archiveName, e.size]));
    const volumesOk = !split || Number(head.Volumes) === parts.length;
    // An empty file has no data stream, so 7-Zip shows it unencrypted with no
    // method; its name is still inside the encrypted headers.
    const encrypted = (i) => (i.Encrypted === '+' && /7zAES/.test(i.Method || '') && /^Copy\b/.test(i.Method || ''))
      || (Number(i.Size) === 0 && i.Encrypted === '-' && !(i.Method || '').trim());
    result.contents.ok = volumesOk && items.length === want.size && items.every(i =>
      want.has(i.Path) && Number(i.Size) === want.get(i.Path) && encrypted(i));
    result.contents.files = items.length;
  }

  result.ok = result.test.ok && result.listWithoutPassword.ok && result.contents.ok && result.parts.ok;
  return result;
}

/** Are the parts on disk still exactly what the checks saw? */
function partsUnchanged(workDir, parts) {
  try {
    return parts.every(p => {
      const st = fs.statSync(path.join(workDir, p.fileName));
      return st.isFile() && st.size === p.size && Math.trunc(st.mtimeMs) === p.mtimeMs;
    });
  } catch {
    return false;
  }
}

module.exports = { plan, withClean, pack, runChecks, listParts, parseSlt, partsUnchanged, removeScratch, SPACE_MARGIN };
