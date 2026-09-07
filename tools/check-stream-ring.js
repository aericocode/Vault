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
 * The two-client block guards the Round 3 follow-up: two players on one media
 * id each get their own playhead, the ring keeps the union of their windows,
 * a segment somebody is blocked on is never evicted, and a client that stops
 * asking stops holding its window open.
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

/* ── Two clients on one media id ──────────────────────────────────────────── */

console.log('two clients');
{
  const ID = 8;
  const A = 'tab-a', B = 'tab-b';

  // A is deep into the file, B has just seeked back to 60.
  ring.note(ID, 144, A);
  ring.note(ID, 60, B);
  const heads = ring.peek(ID).playheads();
  check('each client keeps its own playhead',
    JSON.stringify(heads) === JSON.stringify([60, 144]), `heads=${heads}`);

  // The exact defect: B's segment arrives while A's playhead is at 144.
  ring.put(ID, 60, seg(60, 1024));
  check('a segment inside another client\'s window is not trimmed away',
    ring.has(ID, 60), `held=${nums(ID)}`);

  // A's own segments coexist with B's.
  for (const n of [144, 145]) ring.put(ID, n, seg(n, 1024));
  check('both clients keep their own segments',
    ring.has(ID, 60) && ring.has(ID, 144) && ring.has(ID, 145), `held=${nums(ID)}`);

  // Below the lowest playhead minus BEHIND is still nobody's business.
  ring.put(ID, 60 - ring.BEHIND - 1, seg(1, 1024));
  check('below the union window is still dropped',
    !ring.has(ID, 60 - ring.BEHIND - 1), `held=${nums(ID)}`);
  ring.forget(ID);
}

console.log('waiter pins');
{
  const ID = 9;
  const A = 'tab-a', B = 'tab-b';

  // B is blocked on 60 while A is at 144 and the producer floods the ring.
  ring.note(ID, 60, B);
  ring.hold(ID, 60);
  ring.note(ID, 144, A);
  ring.put(ID, 60, seg(60, 1024));
  for (let n = 144; n < 144 + 80; n++) ring.put(ID, n, seg(n, 1024));

  check('the pinned segment survives every cap', ring.has(ID, 60), `held=${nums(ID)}`);
  check('the pinned segment survives an explicit eviction sweep',
    (() => { const r = ring.peek(ID); for (let i = 0; i < 200; i++) r.evictOne(); return ring.has(ID, 60); })());
  check('a pinned-only ring stops evicting rather than dropping the pin',
    ring.peek(ID).evictOne() === false, `held=${nums(ID)}`);

  ring.release(ID, 60);
  check('release lets the ring shed the segment again',
    ring.peek(ID).evictOne() && !ring.has(ID, 60), `held=${nums(ID)}`);
  ring.forget(ID);
}

console.log('per-session cap with two clients');
{
  const ID = 10;
  ring.note(ID, 60, 'tab-b');
  ring.note(ID, 144, 'tab-a');
  for (let n = 45; n < 200; n++) ring.put(ID, n, seg(n, 1024));
  const held = nums(ID);
  check('the union window still respects MAX_SEGMENTS',
    held.length <= ring.MAX_SEGMENTS, `held=${held.length}`);
  check('what is kept clusters around both playheads, not the middle of the gap',
    held.includes(60) && held.includes(144), `held=${held}`);
  ring.forget(ID);
}

console.log('client expiry');
{
  const ID = 11;
  ring.note(ID, 10, 'gone');
  ring.note(ID, 100, 'here');
  check('two live clients', ring.peek(ID).clientCount() === 2);
  ring.peek(ID).clients.get('gone').lastRequest = Date.now() - ring.CLIENT_TTL_MS - 1000;
  check('a client that stopped asking stops counting',
    ring.peek(ID).clientCount() === 1);
  check('and stops holding its window open',
    JSON.stringify(ring.peek(ID).playheads()) === JSON.stringify([100]));

  // The close beacon path: one tab leaving must not free the other tab's ring.
  const left = ring.dropClient(ID, 'here');
  check('dropping the last client reports nobody left', left.remaining === 0);
  check('and reports that it really removed one', left.removed === true);
  ring.note(ID, 5, 'one');
  ring.note(ID, 6, 'two');
  check('dropping one of two clients reports the other still there',
    ring.dropClient(ID, 'one').remaining === 1);

  // A beacon for a token nobody knows looks like "nobody left" too, which is why
  // the route needs `removed` before it tears the session down. Same for a
  // client that was already pruned for going quiet.
  const stranger = ring.dropClient(ID, 'never-seen');
  check('an unknown token reports removed false', stranger.removed === false);
  ring.peek(ID).clients.get('two').lastRequest = Date.now() - ring.CLIENT_TTL_MS - 1000;
  const pruned = ring.dropClient(ID, 'two');
  check('a pruned client reports removed false, not a teardown',
    pruned.removed === false && pruned.remaining === 0);
  check('a beacon for a ring that does not exist reports removed false',
    ring.dropClient(9999, 'anything').removed === false);
  ring.forget(ID);
}

console.log('client cap');
{
  const ID = 13;
  for (let i = 0; i < 100; i++) ring.note(ID, i, `flood-${i}`);
  const r = ring.peek(ID);
  check('the client map stops at MAX_CLIENTS',
    r.clients.size === ring.MAX_CLIENTS, `size=${r.clients.size} cap=${ring.MAX_CLIENTS}`);
  const kept = [...r.clients.keys()].sort();
  const wanted = [];
  for (let i = 100 - ring.MAX_CLIENTS; i < 100; i++) wanted.push(`flood-${i}`);
  check('the newest tokens are the ones kept',
    JSON.stringify(kept) === JSON.stringify(wanted.sort()), `kept=${kept}`);
  const heads = r.playheads();
  check('playheads still report one per kept client, in order',
    heads.length === ring.MAX_CLIENTS
      && heads[0] === 100 - ring.MAX_CLIENTS
      && heads[heads.length - 1] === 99, `heads=${heads}`);
  check('the ring playhead is still the highest live one', r.playhead === 99);

  // Eviction is by age, not arrival order, so a player that keeps asking is
  // never the one a flood of one-shot tokens pushes out.
  ring.note(ID, 500, 'real-player');
  for (let i = 100; i < 200; i++) {
    ring.note(ID, i, `flood-${i}`);
    ring.note(ID, 500, 'real-player');
  }
  check('a client that keeps asking survives a flood', r.clients.has('real-player'));
  check('the cap holds through the flood',
    r.clients.size === ring.MAX_CLIENTS, `size=${r.clients.size}`);
  check('its window is still kept', r.playheads().includes(500), `heads=${r.playheads()}`);
  ring.forget(ID);
}

console.log('single client is unchanged');
{
  const ID = 12;
  for (let n = 0; n <= 40; n++) { ring.note(ID, n, 'solo'); ring.put(ID, n, seg(n, 1024)); }
  const held = nums(ID);
  check('one named client behaves exactly like the anonymous one',
    held.length === ring.BEHIND + 1 && held[0] === 40 - ring.BEHIND, `held=${held}`);
  ring.forget(ID);
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
