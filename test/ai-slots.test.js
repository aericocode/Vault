/**
 * Slot registry: grouping, dispatch and the gone/revive window.
 *
 * A stub /v1/models server stands in for LM Studio so the whole thing runs with
 * nothing installed. Changing what the stub reports between refreshes is how a
 * model being loaded or unloaded is simulated.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// setEnabled persists parked copies. Redirect the prefs file BEFORE anything
// requires lib/app-settings, which resolves its path once at load time, so a
// test run never writes to the real install.
process.env.VAULT_SETTINGS_FILE = path.join(os.tmpdir(), `vault-test-slots-${process.pid}.json`);

let served = [];        // what /v1/models lists (everything downloaded)
let servedV0 = null;    // rows for /api/v0/models, or null to 404 that route
let v0Status = 404;     // the code that route answers with when servedV0 is null
let v1Down = false;     // /v1/models answers 500, as when the whole server is gone
let hits = 0;           // every request the stub has answered, for the probe-count tests
let server;
let base;

test.before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    if (req.url.startsWith('/api/v0/models')) {
      if (!servedV0) { res.writeHead(v0Status); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: servedV0 }));
    }
    if (v1Down) { res.writeHead(500); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: served.map(id => ({ id })) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
});

test.after(() => server.close());

const slots = require('../lib/ai-slots');

/** Force a probe, bypassing the freshness cache. */
function reset() {
  slots._reset([base]);
  return slots.refresh({ force: true });
}

/** Model ids the registry decided are live, sorted. */
function live() {
  return slots.families()
    .flatMap(f => f.instances.filter(i => i.alive).map(i => i.id))
    .sort();
}

test.beforeEach(() => { servedV0 = null; v0Status = 404; v1Down = false; });

/* ── What counts as loaded ────────────────────────────────────────────────
   /v1/models lists everything DOWNLOADED, which on a real library is dozens
   of models. Only LM Studio's /api/v0/models says which are in VRAM. */

test('with /api/v0, only loaded non-embedding models are slots', async () => {
  served = ['big-a', 'big-b', 'chatty', 'nomic-embed-text-v1.5'];
  servedV0 = [
    { id: 'big-a', type: 'llm', state: 'not-loaded' },
    { id: 'big-b', type: 'llm', state: 'not-loaded' },
    { id: 'chatty', type: 'llm', state: 'loaded' },
    { id: 'nomic-embed-text-v1.5', type: 'embeddings', state: 'loaded' },
  ];
  await reset();
  assert.deepStrictEqual(live(), ['chatty'], 'four downloaded, one usable');
  assert.strictEqual(slots.totalActive(), 1);
  assert.strictEqual(slots.endpointStates()[0].loaded, 1,
    'the servers list says loaded, not downloaded');
});

test('nothing loaded means no slots, not every model', async () => {
  served = ['a', 'b', 'c'];
  servedV0 = served.map(id => ({ id, type: 'llm', state: 'not-loaded' }));
  await reset();
  assert.deepStrictEqual(live(), []);
  assert.strictEqual(slots.totalActive(), 0);
});

test('a copy is live when v0 lists it loaded in its own right', async () => {
  served = ['m', 'm:2'];
  servedV0 = [
    { id: 'm', type: 'llm', state: 'loaded' },
    { id: 'm:2', type: 'llm', state: 'loaded' },
  ];
  await reset();
  assert.deepStrictEqual(live(), ['m', 'm:2']);
  assert.strictEqual(slots.activeCount('m'), 2);
});

test('a copy is live when v0 only names its base as loaded', async () => {
  // The case that could not be checked against the real LM Studio without
  // loading a model in it: v0 may or may not give a second copy its own row.
  // Here it does not, and /v1/models is the only place `m:2` appears.
  served = ['m', 'm:2', 'm:3', 'other'];
  servedV0 = [
    { id: 'm', type: 'llm', state: 'loaded' },
    { id: 'other', type: 'llm', state: 'not-loaded' },
  ];
  await reset();
  assert.deepStrictEqual(live(), ['m', 'm:2', 'm:3']);
  assert.strictEqual(slots.activeCount('m'), 3);
});

test('a copy of an unloaded model is not smuggled in by its suffix', async () => {
  served = ['m', 'm:2'];
  servedV0 = [{ id: 'm', type: 'llm', state: 'not-loaded' }];
  await reset();
  assert.deepStrictEqual(live(), []);
});

test('without /api/v0 the old list is used, minus anything named embed', async () => {
  served = ['m', 'm:2', 'text-embedding-nomic-embed-text-v1.5', 'BGE-EMBED'];
  servedV0 = null;                 // 404, as on Ollama or an older LM Studio
  await reset();
  assert.deepStrictEqual(live(), ['m', 'm:2']);
});

test('a v0 answer without a state field falls back too', async () => {
  served = ['m', 'my-embedder'];
  servedV0 = [{ id: 'm', object: 'model' }, { id: 'my-embedder', object: 'model' }];
  await reset();
  assert.deepStrictEqual(live(), ['m'], 'no state means no loaded signal');
});

test('groups numbered copies into one family', async () => {
  served = ['m', 'm:2', 'm:3', 'llava:13b', 'foo:2'];
  await reset();
  const names = slots.families().map(f => f.family).sort();
  assert.deepStrictEqual(names, ['foo', 'llava:13b', 'm']);

  const m = slots.families().find(f => f.family === 'm');
  assert.deepStrictEqual(m.instances.map(i => i.id), ['m', 'm:2', 'm:3']);
  assert.deepStrictEqual(m.instances.map(i => i.suffix), [':1', ':2', ':3']);

  // An Ollama tag keeps its own family: `13b` is not an integer >= 2.
  assert.strictEqual(slots.families().find(f => f.family === 'llava:13b').instances[0].suffix, ':1');
});

/* ── The family rule (8.1) ────────────────────────────────────────────────
   `:N` is stripped whether or not the base is loaded. The old rule needed the
   base present, so ejecting it in LM Studio split three copies of one model
   into two families: the Backend tab showed two models where there was one,
   the next clone was numbered off a suffixed id (`…max:2:2`), and a mid-scan
   ejection looked like the chosen model disappearing rather than one copy. */

test('a copy stays in its family after the base is ejected', async () => {
  served = ['m:2', 'm:3'];
  await reset();
  const fams = slots.families();
  assert.deepStrictEqual(fams.map(f => f.family), ['m'], 'one family, not two');
  assert.deepStrictEqual(fams[0].instances.map(i => i.suffix), [':2', ':3']);
  assert.strictEqual(slots.activeCount('m'), 2, 'both copies are lanes of the family');
});

test('familyOf strips a numeric suffix with no sibling condition', () => {
  assert.strictEqual(slots.familyOf('m:2'), 'm');
  assert.strictEqual(slots.familyOf('m'), 'm');
  assert.strictEqual(slots.familyOf('pub/model-v1.5:7'), 'pub/model-v1.5');
  assert.strictEqual(slots.familyOf('llava:13b'), 'llava:13b', 'an Ollama tag is not a copy');
  assert.strictEqual(slots.familyOf('m:1'), 'm:1', 'numbering starts at 2');
});

test('pick spreads over the family: least in flight, round robin on ties', async () => {
  served = ['m', 'm:2', 'm:3'];
  await reset();

  // Every slot idle: three picks must hand out three different copies.
  const first = [];
  for (let i = 0; i < 3; i++) {
    const s = slots.pick('m');
    slots.acquire(s);
    first.push(s.modelId);
  }
  assert.deepStrictEqual([...first].sort(), ['m', 'm:2', 'm:3']);

  // All three now sit at one in flight, so the tie is broken by "waited
  // longest" and the order repeats rather than favouring one copy.
  const second = [];
  for (let i = 0; i < 3; i++) {
    const s = slots.pick('m');
    slots.acquire(s);
    second.push(s.modelId);
  }
  assert.deepStrictEqual(second, first, 'ties round robin in the same order');

  // Least-in-flight beats the tiebreak: free one copy and it is next, twice.
  const target = slots.pick('m');
  slots.release(target, { ok: true, ms: 10 });
  slots.release(target, { ok: true, ms: 10 });
  assert.strictEqual(slots.pick('m').modelId, target.modelId);
});

test('release records stats on the slot it was given', async () => {
  served = ['m', 'm:2'];
  await reset();
  const s = slots.pick('m');
  slots.acquire(s);
  assert.strictEqual(s.inFlight, 1);
  slots.release(s, { ok: true, ms: 200 });
  slots.acquire(s);
  slots.release(s, { ok: true, ms: 400 });
  const view = slots.families()[0].instances.find(i => i.id === s.modelId);
  assert.strictEqual(view.done, 2);
  assert.strictEqual(view.avgMs, 300);
  assert.strictEqual(view.inFlight, 0);
});

test('an exact base:N pins that one copy', async () => {
  served = ['m', 'm:2', 'm:3'];
  await reset();
  for (let i = 0; i < 4; i++) {
    const s = slots.pick('m:3');
    assert.strictEqual(s.modelId, 'm:3');
    slots.acquire(s);
  }
});

test('an unknown family picks nothing, so callers fall back', async () => {
  served = ['m'];
  await reset();
  assert.strictEqual(slots.pick('not-loaded'), null);
  assert.strictEqual(slots.pick(null), null);
});

/* ── Mirroring the server (8.2) ───────────────────────────────────────────
   A copy that is not in the latest probe is not listed anywhere. Only its
   counters are banked, so a copy that comes back is the same copy to the user
   without an ejected one lingering in the table for a minute. */

test('a vanished copy leaves at once but its stats come back with it', async () => {
  served = ['m', 'm:2'];
  await reset();
  const s = slots.pick('m:2');
  slots.acquire(s);
  slots.release(s, { ok: true, ms: 500 });

  served = ['m'];
  await slots.refresh({ force: true });
  assert.strictEqual(slots.families()[0].instances.find(i => i.id === 'm:2'), undefined,
    'not listed, not even as a dead row');
  assert.deepStrictEqual(slots.instancesOf('m').map(i => i.id), ['m'],
    'the scan panel strip does not list it either');
  assert.strictEqual(slots.activeCount('m'), 1, 'it no longer counts as a lane');
  assert.ok(slots.registry().slots.every(i => i.id !== 'm:2'), 'and not in the registry payload');
  assert.ok(slots.registry().slots.every(i => i.goneAt === undefined), 'goneAt is gone');

  // Loaded again: the same copy, with the history it had.
  served = ['m', 'm:2'];
  await slots.refresh({ force: true });
  const back = slots.families()[0].instances.find(i => i.id === 'm:2');
  assert.strictEqual(back.alive, true);
  assert.strictEqual(back.done, 1, 'revived with its history intact');

  // Past the stats window there is nothing left to revive.
  served = ['m'];
  await slots.refresh({ force: true });
  for (const kept of slots._stats.values()) kept.at = Date.now() - slots.STATS_TTL_MS - 1;
  await slots.refresh({ force: true });
  served = ['m', 'm:2'];
  await slots.refresh({ force: true });
  assert.strictEqual(
    slots.families()[0].instances.find(i => i.id === 'm:2').done, 0, 'counters started over');
});

test('every payload carries when the picture was last checked', async () => {
  served = ['m'];
  await reset();
  const at = slots.lastCheckedAt();
  assert.ok(at > 0 && at <= Date.now(), 'lastCheckedAt is the probe time');
  assert.strictEqual(slots.registry().lastCheckedAt, at);
});

test('an endpoint that stops answering takes all of its slots with it', async () => {
  served = ['m', 'm:2'];
  await reset();
  assert.strictEqual(slots.activeCount('m'), 2);
  slots._reset(['http://127.0.0.1:1/v1/chat/completions']);
  await slots.refresh({ force: true });
  assert.strictEqual(slots.totalActive(), 0);
  assert.strictEqual(slots.endpointStates()[0].reachable, false);
});

test('setEnabled parks a copy without unloading it', async () => {
  served = ['m', 'm:2'];
  await reset();
  assert.strictEqual(slots.activeCount('m'), 2);
  slots.setEnabled(base, 'm:2', false);
  assert.strictEqual(slots.activeCount('m'), 1);
  for (let i = 0; i < 3; i++) {
    const s = slots.pick('m');
    assert.strictEqual(s.modelId, 'm', 'a parked copy is never picked');
    slots.acquire(s);
  }
  const parked = slots.families()[0].instances.find(i => i.id === 'm:2');
  assert.strictEqual(parked.enabled, false);
  assert.strictEqual(parked.alive, true, 'parked is not the same as unloaded');
  slots.setEnabled(base, 'm:2', true);
  assert.strictEqual(slots.activeCount('m'), 2);
});

test('reportUnavailable retires just the one copy', async () => {
  served = ['m', 'm:2'];
  await reset();
  const s = slots.pick('m:2');
  slots.reportUnavailable(s);
  assert.strictEqual(slots.activeCount('m'), 1, 'the sibling is still a lane');
  assert.strictEqual(slots.families()[0].instances.length, 1, 'and it is not listed');
  assert.strictEqual(slots.lastGone().suffix, ':2', 'the panel can name the copy that went');
});

/* ── Probing is event-driven (8.6) ────────────────────────────────────────
   Everything that reads the registry often — the Backend tab's 5 s poll, the
   model dropdown, the scan panel — must cost nothing. An idle Vault with the
   tab open made a /v1/models request every few seconds before this. */

test('an unforced refresh makes no network call', async () => {
  served = ['m', 'm:2'];
  await reset();
  const before = hits;
  const r1 = await slots.refresh();
  const r2 = await slots.refresh({ force: false });
  assert.strictEqual(hits, before, 'nothing was asked of the server');
  assert.strictEqual(r1.slots.length, 2, 'it still answers, from the registry');
  assert.strictEqual(r2.lastCheckedAt, slots.lastCheckedAt());

  // Forced is the only thing that costs a request.
  await slots.refresh({ force: true });
  assert.ok(hits > before, 'Refresh really looks');
});

test('a slot error retires the copy without a probe, then confirms once', async () => {
  served = ['m', 'm:2', 'm:3'];
  await reset();
  const before = hits;
  slots.reportUnavailable(slots.pick('m:2'));
  slots.reportUnavailable(slots.pick('m:3'));
  assert.strictEqual(hits, before, 'the error is the evidence: nothing is asked');
  assert.strictEqual(slots.activeCount('m'), 1, 'the survivor keeps its lane');

  // One confirming probe, shared by both errors, a moment later.
  served = ['m'];
  await new Promise(r => setTimeout(r, slots.ERROR_PROBE_MS + 400));
  assert.strictEqual(hits - before, 2, 'one probe (its two routes), not one per error');
});

/* The discovery sweep is the one periodic call left, and it only runs while a
   scan is working. AI_DISCOVERY_MS is read once at require time, so the cadence
   is measured in a child process with its own stub server. */
async function bootProbes(discoveryMs, waitMs) {
  const { spawnSync } = require('node:child_process');
  const modulePath = path.join(__dirname, '..', 'lib', 'ai-slots.js');
  const script = `
    const http = require('http');
    let hits = 0;
    const s = http.createServer((req, res) => {
      hits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm', type: 'llm', state: 'loaded' }] }));
    });
    s.listen(0, '127.0.0.1', () => {
      const url = 'http://127.0.0.1:' + s.address().port + '/v1/chat/completions';
      const slots = require(${JSON.stringify(modulePath)});
      slots._reset([url]);
      slots.boot({ activeProbe: () => true });     // pretend a scan is running
      setTimeout(() => {
        console.log(JSON.stringify({ discovery: slots.DISCOVERY_MS, probes: hits / 2 }));
        process.exit(0);
      }, ${waitMs});
    });`;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, AI_DISCOVERY_MS: String(discoveryMs) },
  });
  return JSON.parse(String(r.stdout).trim().split('\n').pop());
}

test('AI_DISCOVERY_MS sets the sweep, and 0 leaves only the boot probe', async () => {
  const off = await bootProbes(0, 400);
  assert.strictEqual(off.discovery, 0);
  assert.strictEqual(off.probes, 1, 'boot looked once and nothing ticked after it');

  const on = await bootProbes(100, 400);
  assert.strictEqual(on.discovery, 100);
  assert.ok(on.probes >= 3, `the sweep ran while the queue was active (saw ${on.probes})`);
});

test('a success puts a copy the registry had written off back', async () => {
  served = ['m', 'm:2'];
  await reset();
  const s = slots.pick('m:2');
  slots.reportUnavailable(s);
  assert.strictEqual(slots.activeCount('m'), 1);
  slots.acquire(s);
  slots.release(s, { ok: true, ms: 10 });
  assert.strictEqual(slots.activeCount('m'), 2, 'an answer is proof it is loaded');
});

test('onChange fires when the set of live slots moves', async () => {
  served = ['m'];
  await reset();
  let fired = 0;
  slots.onChange(() => { fired++; });
  served = ['m', 'm:2'];
  await slots.refresh({ force: true });
  assert.ok(fired >= 1, 'a new instance notified its listeners');
});

/* ── How many lanes the queue may open ────────────────────────────────────
   The count that sizes the import queue is the SELECTED family's, never the
   whole registry's. Against a real LM Studio in auto mode with nothing picked,
   counting the registry is how "37 instances" happens. */

test('auto with several families selects nothing and offers no lanes', async () => {
  const llm = require('../lib/llm-client');
  llm.setSessionModel(null);
  served = ['alpha', 'beta'];
  servedV0 = [
    { id: 'alpha', type: 'llm', state: 'loaded' },
    { id: 'beta', type: 'llm', state: 'loaded' },
  ];
  await reset();
  assert.strictEqual(slots.totalActive(), 2, 'both are loaded');
  assert.strictEqual(llm.currentFamily(), null, 'auto cannot choose between them');
  assert.strictEqual(slots.activeCount(llm.currentFamily()), 0,
    'so the queue is offered no slots and keeps its default lanes');

  // Picking one narrows it to that family, not to everything loaded.
  llm.setSessionModel('alpha');
  assert.strictEqual(llm.currentFamily(), 'alpha');
  assert.strictEqual(slots.activeCount(llm.currentFamily()), 1);
  llm.setSessionModel(null);
});

test('auto with one family loaded resolves to it', async () => {
  const llm = require('../lib/llm-client');
  llm.setSessionModel(null);
  served = ['alpha', 'alpha:2', 'shelved'];
  servedV0 = [
    { id: 'alpha', type: 'llm', state: 'loaded' },
    { id: 'shelved', type: 'llm', state: 'not-loaded' },
  ];
  await reset();
  assert.strictEqual(llm.currentFamily(), 'alpha');
  assert.strictEqual(slots.activeCount(llm.currentFamily()), 2);
});

/* ── Pinning one copy ─────────────────────────────────────────────────────
   Naming `m:2` exactly is not the same as naming the family `m`: pick() only
   ever returns that one slot, so the queue must size itself for one. */

test('a pinned copy offers one lane, not the whole family', async () => {
  const llm = require('../lib/llm-client');
  served = ['m', 'm:2', 'm:3'];
  servedV0 = [
    { id: 'm', type: 'llm', state: 'loaded' },
    { id: 'm:2', type: 'llm', state: 'loaded' },
    { id: 'm:3', type: 'llm', state: 'loaded' },
  ];
  await reset();

  llm.setSessionModel('m');
  assert.strictEqual(llm.currentPin(), null, 'a family is not a pin');
  assert.strictEqual(slots.activeCount(llm.currentFamily()), 3);

  llm.setSessionModel('m:2');
  assert.strictEqual(llm.currentFamily(), 'm', 'it still belongs to the family');
  assert.strictEqual(llm.currentPin(), 'm:2');
  assert.strictEqual(slots.activeCountForId('m:2'), 1, 'one copy, one lane');
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(slots.pick('m:2').modelId, 'm:2', 'and pick agrees');
  }

  // Parking the pinned copy leaves no lanes at all.
  slots.setEnabled(base, 'm:2', false);
  assert.strictEqual(slots.activeCountForId('m:2'), 0);
  slots.setEnabled(base, 'm:2', true);
  llm.setSessionModel(null);
});

/* A lone `foo:2` now belongs to family `foo` (8.1), so naming it exactly is a
   PIN on the one copy, the same as it would be with `foo` also loaded. That is
   the point: ejecting the base must not change what `foo:2` means. */
test('a lone numbered id belongs to its base family and pins one copy', async () => {
  const llm = require('../lib/llm-client');
  served = ['foo:2'];
  servedV0 = [{ id: 'foo:2', type: 'llm', state: 'loaded' }];
  await reset();
  llm.setSessionModel('foo:2');
  assert.strictEqual(llm.currentFamily(), 'foo');
  assert.strictEqual(llm.currentPin(), 'foo:2');
  assert.strictEqual(slots.activeCount('foo'), 1);
  assert.strictEqual(slots.activeCountForId('foo:2'), 1, 'one lane, not the whole family');
  llm.setSessionModel(null);
});

/* ── Which copy has which file ───────────────────────────────────────────
   The media id rides in async context from the import queue down to whatever
   AI call happens, so the scan panel can label an in-flight row without
   processFile and every processor under it growing a parameter for it. */

test('the attribution is read while the call is open and gone after', async () => {
  served = ['m', 'm:2'];
  servedV0 = [
    { id: 'm', type: 'llm', state: 'loaded' },
    { id: 'm:2', type: 'llm', state: 'loaded' },
  ];
  await reset();
  let midCall = null;
  await slots.fileContext.run({ mediaId: 4242 }, async () => {
    const id = slots.fileContext.getStore().mediaId;
    const slot = slots.pick('m');
    slots.acquire(slot);
    slots.noteFile(id, slot);
    await new Promise(r => setTimeout(r, 10));      // context survives the await
    assert.strictEqual(slots.fileContext.getStore().mediaId, 4242);
    midCall = slots.slotForFile(4242);
    slots.release(slot, { ok: true, ms: 10 });
    slots.clearFile(id);
  });
  assert.deepStrictEqual(midCall, { suffix: ':1', id: 'm' });
  assert.strictEqual(slots.slotForFile(4242), null, 'cleared when the call ends');
  assert.strictEqual(slots.slotForFile(99), null, 'an unknown file says nothing');
});

test('postChat attributes the file it was called for, unaided', async () => {
  const llm = require('../lib/llm-client');
  // One stub answering both routes, so a real postChat runs end to end. No
  // /api/v0 here, which is the fallback path.
  const both = http.createServer((req, res) => {
    if (req.url.startsWith('/api/v0/models')) { res.writeHead(404); return res.end('{}'); }
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'm' }, { id: 'm:2' }] }));
    }
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    }, 60);
  });
  await new Promise(r => both.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${both.address().port}/v1/chat/completions`;
  await llm.setEndpoints([url]);
  llm.setSessionModel('m');

  let midCall = null;
  await slots.fileContext.run({ mediaId: 7 }, async () => {
    const call = llm.postChat([{ role: 'user', content: 'hi' }]);
    await new Promise(r => setTimeout(r, 20));      // poll while it is in flight
    midCall = slots.slotForFile(7);
    await call;
  });
  assert.ok(midCall, 'postChat noted the file without being handed its id');
  assert.strictEqual(midCall.suffix, ':1');
  assert.strictEqual(midCall.id, 'm');
  assert.strictEqual(slots.slotForFile(7), null, 'and released it afterwards');

  llm.setSessionModel(null);
  both.close();
});

test.after(() => { slots.stop(); });

/* ── A v0 route that goes quiet mid-load ──────────────────────────────────
   Verified live: while `lms load` runs, LM Studio stops answering
   /api/v0/models for a few seconds while /v1/models keeps listing every
   DOWNLOADED model. Falling back there invented 34 instances out of this
   user's library, which then sat in the model picker for a minute.

   The skip that fixes it is bounded twice over, because "report nothing" must
   never let a dead server look alive: /v1/models has to still answer in the
   same probe, and only V0_SKIP_PROBES (4) failures in a row are tolerated. */

async function seeV0() {
  served = ['m', 'big-model-nobody-loaded', 'another-download'];
  servedV0 = [
    { id: 'm', type: 'llm', state: 'loaded' },
    { id: 'big-model-nobody-loaded', type: 'llm', state: 'not-loaded' },
    { id: 'another-download', type: 'llm', state: 'not-loaded' },
  ];
  await reset();
  assert.deepStrictEqual(live(), ['m'], 'setup: only the loaded one counts');
}

test('a v0 route that stops answering leaves the picture alone', async () => {
  await seeV0();

  servedV0 = null;                  // 404, as during a load
  await slots.refresh({ force: true });
  assert.deepStrictEqual(live(), ['m'], 'downloads must not become instances');
  assert.strictEqual(slots.endpointStates()[0].reachable, true, 'the server is still there');

  servedV0 = [
    { id: 'm', type: 'llm', state: 'loaded' },
    { id: 'm:2', type: 'llm', state: 'loaded' },
    { id: 'big-model-nobody-loaded', type: 'llm', state: 'not-loaded' },
    { id: 'another-download', type: 'llm', state: 'not-loaded' },
  ];
  served = ['m', 'm:2', 'big-model-nobody-loaded', 'another-download'];
  await slots.refresh({ force: true });
  assert.deepStrictEqual(live(), ['m', 'm:2'], 'the copy is picked up once v0 is back');
});

test('both routes failing is a dead server, not a quiet v0', async () => {
  await seeV0();

  // LM Studio closed or crashed. Nothing answers, so the endpoint has to go
  // unreachable and take its slots with it, exactly as it did before the skip
  // existed. Anything else keeps the balancer dispatching to a dead socket.
  servedV0 = null;
  v0Status = 500;
  v1Down = true;
  await slots.refresh({ force: true });

  const state = slots.endpointStates()[0];
  assert.strictEqual(state.reachable, false, 'endpoint is down');
  assert.ok(state.error, 'and says why');
  assert.deepStrictEqual(live(), [], 'no slot survives a dead server');
  assert.strictEqual(slots.activeCount('m'), 0);
});

test('a permanently broken v0 falls through after the cap', async () => {
  await seeV0();

  // v0 is 500ing for good while the server itself answers. Four probes in a
  // row are tolerated; the fifth gives up and uses the old /v1/models
  // behaviour, so a broken v0 cannot freeze the picture for ever.
  servedV0 = null;
  v0Status = 500;
  for (let i = 0; i < 4; i++) {
    await slots.refresh({ force: true });
    assert.deepStrictEqual(live(), ['m'], `probe ${i + 1} still skips`);
  }
  await slots.refresh({ force: true });
  assert.deepStrictEqual(
    live(),
    ['another-download', 'big-model-nobody-loaded', 'm'],
    'the fifth falls back to the whole /v1/models list',
  );

  // One good answer and the streak is forgotten, so the next hiccup gets the
  // full allowance again.
  servedV0 = [
    { id: 'm', type: 'llm', state: 'loaded' },
    { id: 'big-model-nobody-loaded', type: 'llm', state: 'not-loaded' },
    { id: 'another-download', type: 'llm', state: 'not-loaded' },
  ];
  await slots.refresh({ force: true });
  assert.deepStrictEqual(live(), ['m']);
  servedV0 = null;
  await slots.refresh({ force: true });
  assert.deepStrictEqual(live(), ['m'], 'the allowance reset with the v0 success');
});
