/**
 * Runnable check for the in-memory segment ring.
 *
 *   node tools/check-stream-ring.js
 *
 * Round 3 replaced the persistent segment cache with RAM, so the thing that
 * used to be guarded (a bytes column that must not drift from the disk) is
 * gone, and what has to be guarded now is that the ring cannot grow without
 * bound: a retention window behind the playhead, 48 segments per session, and
 * 256 MB across every session in the process.
 *
 * Pure synthetic buffers. No database, no ffmpeg, no files.
 */

const ring = require('../lib/stream/ring');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok    ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
}

const seg = (n, size) => Buffer.alloc(size, n & 0xff);
const nums = (id) => [...(ring.peek(id) ? ring.peek(id).segs.keys() : [])].sort((a, b) => a - b);

/* ── Retention window ─────────────────────────────────────────────────────── */

console.log('retention window');
{
  const ID = 1;
  for (let n = 0; n <= 40; n++) {
    ring.note(ID, n);                       // the client is watching in order
    ring.put(ID, n, seg(n, 1024));
  }
  const held = nums(ID);
  check('nothing further behind than BEHIND is kept',
    held[0] === 40 - ring.BEHIND, `lowest=${held[0]} playhead=40 BEHIND=${ring.BEHIND}`);
  check('the segment just made is kept', held[held.length - 1] === 40);
  check('the window is exactly BEHIND+1 wide', held.length === ring.BEHIND + 1, `held=${held.length}`);
  ring.forget(ID);
}

/* ── Producer running ahead of a stalled playhead ─────────────────────────── */

console.log('per-session cap');
{
  const ID = 2;
  ring.note(ID, 0);                          // the client asked for 0 and stopped
  for (let n = 0; n < 200; n++) ring.put(ID, n, seg(n, 1024));
  const held = nums(ID);
  check('never more than MAX_SEGMENTS', held.length === ring.MAX_SEGMENTS,
    `held=${held.length} cap=${ring.MAX_SEGMENTS}`);
  check('the segment the playhead is on survives', held.includes(0));
  check('the furthest ahead is the one dropped', !held.includes(199),
    `highest=${held[held.length - 1]}`);
  ring.forget(ID);
}

/* ── Eviction order: behind the playhead goes before ahead of it ──────────── */

console.log('eviction order');
{
  const ID = 3;
  ring.note(ID, 10);
  for (const n of [5, 6, 7, 12, 13]) ring.put(ID, n, seg(n, 1024));
  const r = ring.peek(ID);
  r.evictOne();
  check('the oldest below the playhead goes first', !nums(ID).includes(5), `held=${nums(ID)}`);
  r.evictOne(); r.evictOne();
  check('everything behind goes before anything ahead',
    JSON.stringify(nums(ID)) === JSON.stringify([12, 13]), `held=${nums(ID)}`);
  r.evictOne();
  check('then the furthest ahead', JSON.stringify(nums(ID)) === JSON.stringify([12]), `held=${nums(ID)}`);
  ring.forget(ID);
}

/* ── Seeking ──────────────────────────────────────────────────────────────── */

console.log('seeking');
{
  const ID = 7;
  ring.note(ID, 40);
  ring.note(ID, 38);
  check('a small step back does not move the window', ring.peek(ID).playhead === 40);
  ring.note(ID, 2);
  check('a seek out of the window moves it', ring.peek(ID).playhead === 2);
  ring.put(ID, 2, seg(2, 1024));
  check('the segment the seek asked for survives being stored', ring.has(ID, 2));
  ring.forget(ID);
}

/* ── Global cap across sessions ───────────────────────────────────────────── */

console.log('global cap');
{
  const A = 4, B = 5;
  const MB = 1024 * 1024;
  // A was requested first, so it is the least recently requested of the two and
  // is the one that gives bytes back when the total goes over.
  ring.note(A, 0);
  for (let n = 0; n < 40; n++) ring.put(A, n, seg(n, 4 * MB));
  ring.note(B, 0);
  for (let n = 0; n < 40; n++) ring.put(B, n, seg(n, 4 * MB));

  check('total is inside the global cap', ring.totalBytes <= ring.MAX_TOTAL_BYTES,
    `${ring.totalBytes} > ${ring.MAX_TOTAL_BYTES}`);
  check('the reported total matches what the rings hold',
    ring.peek(A).bytes + ring.peek(B).bytes === ring.totalBytes);
  check('the session being written to keeps more than the idle one',
    ring.peek(B).segs.size > ring.peek(A).segs.size,
    `A=${ring.peek(A).segs.size} B=${ring.peek(B).segs.size}`);
  check('the idle session still holds its playhead segment', nums(A).includes(0), `A=${nums(A)}`);

  const status = ring.status();
  check('status reports both rings', status.rings.length === 2);
  check('status ringBytes matches', status.ringBytes === ring.totalBytes);

  ring.forget(A);
  check('forget frees the bytes it held', ring.totalBytes === ring.peek(B).bytes);
  ring.clearAll();
  check('clearAll empties everything', ring.totalBytes === 0 && ring.size === 0);
}

/* ── Idle bookkeeping ─────────────────────────────────────────────────────── */

console.log('idle');
{
  const ID = 6;
  ring.note(ID, 0);
  ring.put(ID, 0, seg(0, 1024));
  check('a fresh ring is not idle', ring.idleIds(60000).length === 0);
  ring.peek(ID).lastRequest = Date.now() - 61000;
  check('a stale ring is idle', ring.idleIds(60000).includes(ID));
  ring.clearAll();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
