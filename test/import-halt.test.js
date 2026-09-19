/**
 * What the import queue does when a model call comes back "not available".
 *
 * Three different situations arrive down the same channel and the queue has to
 * tell them apart, because the user paid for two of them with a long scan:
 *
 * - one copy of several was ejected  -> carry on, say so, never a picker
 * - the chosen family is empty but something else is loaded -> ask which model
 * - nothing is loaded at all -> the plain "load it and press Resume" halt
 *
 * Reaching the worker loop for real would need a database, a scan and a model,
 * so the two decisions are exercised through their test seams against a stub
 * /v1/models server standing in for LM Studio.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.VAULT_SETTINGS_FILE = path.join(os.tmpdir(), `vault-test-halt-${process.pid}.json`);

let served = [];        // rows both model routes report, with `state`
let server;
let base;

test.before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: served.map(id => ({ id, type: 'llm', state: 'loaded' })) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
});

test.after(() => server.close());

const slots = require('../lib/ai-slots');
const llm = require('../lib/llm-client');
const queue = require('../lib/import-queue');

async function loaded(ids, choice = null) {
  served = ids;
  slots._reset([base]);
  await slots.refresh({ force: true });
  llm.setSessionModel(choice);
}

const ITEM = { id: 1, filepath: 'K:/scratch/a.mp4', filename: 'a.mp4' };

test.beforeEach(() => { queue.cancel(); });
test.after(() => llm.setSessionModel(null));

/* ── Halt matrix (8.5) ───────────────────────────────────────────────────── */

test('a sibling still loaded means carry on, with no picker', async () => {
  await loaded(['m', 'm:2', 'm:3'], 'm');
  slots.reportUnavailable(slots.pick('m:2'));

  assert.strictEqual(queue._retryOnSurvivingInstance(ITEM, 'unloaded'), true,
    'the file goes back on the queue and the run continues');
  assert.strictEqual(queue._needsModelChoice(), false, 'nothing to ask the user');
});

test('the chosen family emptied while another is loaded asks which model', async () => {
  await loaded(['m', 'other'], 'm');
  slots.reportUnavailable(slots.pick('m'));

  assert.strictEqual(queue._retryOnSurvivingInstance(ITEM, 'unloaded'), false,
    'no copy of the chosen family is left to retry on');
  assert.strictEqual(queue._needsModelChoice(), true, 'there is something else to choose');
});

test('nothing loaded at all is the plain unavailable halt', async () => {
  await loaded(['m'], 'm');
  slots.reportUnavailable(slots.pick('m'));

  assert.strictEqual(queue._retryOnSurvivingInstance(ITEM, 'unloaded'), false);
  assert.strictEqual(queue._needsModelChoice(), false,
    'a picker with nothing in it would be a worse message than the truth');
});

test('several families loaded and none picked still asks which model', async () => {
  // LM Studio answers 400 "multiple models are loaded" here, and the answer is
  // the same question it always was.
  await loaded(['alpha', 'beta'], null);
  assert.strictEqual(queue._needsModelChoice(), true);
});

/* ── What an ejected copy actually answers ───────────────────────────────── */

/* Observed live: ejecting a copy while it is generating fails the open request
   with a 400, not the 404/500 the JIT-unload path was written for. Read as an
   ordinary bad request it blames the file, which is the one outcome the whole
   carry-on path exists to prevent. */
test('LM Studio 400 "Model unloaded" is the model going, not a bad file', () => {
  const health = require('../lib/model-health');
  const err = Object.assign(new Error('API error: 400 Bad Request'), {
    status: 400,
    body: '{"error":"Model unloaded by user or API request."}',
  });
  assert.strictEqual(health.isModelUnavailable(err), true);
  assert.strictEqual(health.isModelChoiceNeeded(err), false, 'and it is not a picker');
  assert.match(health.describe(err), /unloaded while it was answering/);

  // Still conservative: a 400 that says nothing about the model is a bad file.
  const bad = Object.assign(new Error('API error: 400 Bad Request'), {
    status: 400, body: '{"error":"image too large"}',
  });
  assert.strictEqual(health.isModelUnavailable(bad), false);
});

/* ── The notice (8.5) ────────────────────────────────────────────────────── */

test('carrying on names the copy that went and how many are left', async () => {
  await loaded(['m', 'm:2', 'm:3'], 'm');
  assert.strictEqual(queue.notice(), null, 'nothing to say before anything happens');

  slots.reportUnavailable(slots.pick('m:3'));
  queue._retryOnSurvivingInstance(ITEM, 'unloaded');

  const n = queue.notice();
  assert.ok(n && n.at > 0, 'the panel gets a timestamped line');
  assert.ok(n.id, 'and an id, so the panel can remember a dismissal');
  assert.strictEqual(n.text, 'Copy :3 was unloaded in LM Studio. Continuing on 2 copies.');
  assert.strictEqual(queue.status().notice.text, n.text, 'and it rides on the queue status');
  assert.strictEqual(queue.status().pausedBy, null, 'the run never stopped');
});

/* The panel repaints every 1.5 s, so a line the user closed has to stay closed.
   It does that by id: the same id is the same event and stays dismissed, a new
   id is a new thing that happened and shows again. */
test('a second event gets a new id, and the line expires on its own', async () => {
  await loaded(['m', 'm:2', 'm:3'], 'm');
  slots.reportUnavailable(slots.pick('m:3'));
  queue._retryOnSurvivingInstance(ITEM, 'unloaded');
  const first = queue.notice();

  assert.strictEqual(queue.notice().id, first.id, 'polling does not churn the id');

  slots.reportUnavailable(slots.pick('m:2'));
  queue._retryOnSurvivingInstance({ ...ITEM, filepath: 'K:/scratch/b.mp4' }, 'unloaded');
  const second = queue.notice();
  assert.notStrictEqual(second.id, first.id, 'a fresh event is a fresh id');
  assert.strictEqual(second.text, 'Copy :2 was unloaded in LM Studio. Continuing on 1 copy.');

  // Ninety seconds on it is gone, whether or not anyone closed it. Backdating
  // `at` beats waiting them out.
  second.at = Date.now() - 90_001;
  assert.strictEqual(queue.notice(), null, 'expired');
  assert.strictEqual(queue.status().notice, null);
});

test('the notice outlives a registry change', async () => {
  await loaded(['m', 'm:2'], 'm');
  slots.reportUnavailable(slots.pick('m:2'));
  queue._retryOnSurvivingInstance(ITEM, 'unloaded');
  const id = queue.notice().id;

  // The ejection that raised the line is itself a registry change, and probes
  // land seconds later; clearing on one took the line away before it could be
  // read.
  served = ['m'];
  await slots.refresh({ force: true });
  assert.strictEqual(queue.notice()?.id, id, 'still there to be read');
});
