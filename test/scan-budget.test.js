/**
 * AI scan requests that fit the model (lib/token-budget.js, lib/vision-api.js,
 * lib/text-api.js, lib/llm-client.js postChat):
 *
 * - frames are budgeted from the context length the server reports, and the
 *   per-frame cost is learned from usage.prompt_tokens
 * - frames are capped by area, not width
 * - a request that is too big, or a reply cut off by length, is retried
 *   smaller (half the frames, then no transcript), then fails clearly
 * - the answer's JSON schema goes in response_format; a server that refuses
 *   or ignores it gets the prompt-only template, remembered per endpoint
 * - reasoning is switched off where the server allows, and a reply that is
 *   all thinking says so
 * - a cut-off answer whose leading fields arrived is kept and marked
 * - the stored media_elements shape is unchanged, and old and new rows both
 *   read and search
 *
 * The AI server is a fake OpenAI-compatible stub; no real model is involved.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');

// The server code under test logs a line or more per scan (and the database
// one per migration). Node's test runner reads this file's output through
// the same pipe as its own messages, and with a lot of plain output it now
// and then misreads one ("Unable to deserialize cloned data") and fails the
// whole file in a parallel run. So the console is quiet for this file; a
// test that checks what was logged catches it itself, and assertion
// failures are reported by the runner, not the console.
const _console = { log: console.log, warn: console.warn, error: console.error, info: console.info };
console.log = console.warn = console.error = console.info = () => {};
test.after(() => { Object.assign(console, _console); });
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-scan-budget-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_TEMP_AUDIO = path.join(tmp, 'temp-audio');
process.env.EMBEDDINGS = 'false';
delete process.env.VAULT_DB_PASSWORD;
delete process.env.AI_MODEL;
delete process.env.AI_CONTEXT_LENGTH;

const haveFfmpeg = cp.spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;

const db = require('../lib/database');
const slots = require('../lib/ai-slots');
const llm = require('../lib/llm-client');
const budget = require('../lib/token-budget');
const vision = require('../lib/vision-api');
const textApi = require('../lib/text-api');
const prompts = require('../config/prompts');
const failures = require('../lib/scan-failures');
const frames = require('../lib/frame-extractor');

/* ── The fake server ──────────────────────────────────────────────────── */

const ANSWER = {
  language: 'none',
  content_type: 'other',
  description: 'Colour bars with a tone.',
  tags: ['test card', 'colour bars'],
  themes: ['test'],
  locations: ['studio'],
  media_elements: {
    main_person: 'nobody', age: 'n/a', positioning: 'none', action: 'bars scroll',
    relationship: '', body_parts_involved: '', fluids_present: '', objects_used: '',
    facial_expression: '', clothing_or_attire: '', camera_angle: 'static', lighting: 'bright',
    personal_comments: 'a plain test card',
  },
  transcribed_text: [{ text: 'TEST', location: 'centre' }],
};

const srv = {};
function resetServer() {
  Object.assign(srv, {
    ctx: 65536,              // loaded_context_length reported; null = not reported
    realCtx: null,           // refuse requests over this many tokens, llama.cpp style
    perImage: 200,
    rejectFormat: false,
    rejectReasoning: false,
    script: [],              // per chat request: 'ok' | 'length' | 'thinking' | 'notJson' | 'hang'
    cutAt: 60,
    answer: ANSWER,
    promptTokensOverride: undefined,   // a usage reading to report instead of the real one
    overflowExtra: '',                 // more words in the overflow error
    reqs: [],
  });
}
resetServer();

let server, base;

function chatReply(res, body) {
  const content = body.messages[0].content;
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: content }];
  const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
  const images = parts.filter(p => p.type === 'image_url').length;
  const rec = {
    images, text, max_tokens: body.max_tokens, response_format: body.response_format || null,
    reasoning_effort: body.reasoning_effort ?? null, status: 200,
  };
  srv.reqs.push(rec);
  const json = (status, obj) => { rec.status = status; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (srv.rejectReasoning && body.reasoning_effort !== undefined) {
    return json(400, { error: { message: `Invalid 'reasoning_effort' value: '${body.reasoning_effort}'.`, param: 'reasoning_effort' } });
  }
  if (srv.rejectFormat && body.response_format) {
    return json(400, { error: "'response_format.type' must be 'json_schema' or 'text'" });
  }
  const promptTokens = Math.ceil(text.length / 4) + images * srv.perImage + 10;
  if (srv.realCtx && promptTokens > srv.realCtx) {
    return json(400, { error: `Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (${promptTokens} tokens) exceeds the available context size (${srv.realCtx} tokens), try increasing it${srv.overflowExtra}","type":"exceed_context_size_error","n_prompt_tokens":${promptTokens},"n_ctx":${srv.realCtx}}}` });
  }
  const mode = srv.script.length ? srv.script.shift() : 'ok';
  rec.mode = mode;
  if (mode === 'hang') return;           // until the client goes away
  const full = typeof srv.answer === 'string' ? srv.answer : JSON.stringify(srv.answer);
  const usage = (completion, reasoning = 0) => ({
    prompt_tokens: srv.promptTokensOverride !== undefined ? srv.promptTokensOverride : promptTokens, completion_tokens: completion, total_tokens: promptTokens + completion,
    completion_tokens_details: { reasoning_tokens: reasoning },
  });
  if (mode === 'length') {
    // Cut off by length means the answer used all of max_tokens.
    return json(200, { choices: [{ message: { role: 'assistant', content: full.slice(0, srv.cutAt) }, finish_reason: 'length' }], usage: usage(body.max_tokens || 900) });
  }
  if (mode === 'thinking') {
    return json(200, { choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'Let me think about the frames...' }, finish_reason: 'length' }], usage: usage(4000, 4000) });
  }
  if (mode === 'notJson') {
    return json(200, { choices: [{ message: { role: 'assistant', content: 'Sure! The video shows colour bars.' }, finish_reason: 'stop' }], usage: usage(12) });
  }
  return json(200, { choices: [{ message: { role: 'assistant', content: full }, finish_reason: 'stop' }], usage: usage(300) });
}

test.before(async () => {
  db.init();
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/api/v0/models')) {
        const row = { id: 'vis', type: 'vlm', state: 'loaded', max_context_length: 262144 };
        if (srv.ctx) row.loaded_context_length = srv.ctx;
        res.end(JSON.stringify({ data: [row] }));
      } else {
        res.end(JSON.stringify({ data: [{ id: 'vis' }] }));
      }
      return;
    }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => chatReply(res, JSON.parse(raw)));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  await llm.setEndpoints([base]);
});

test.after(async () => {
  slots.stop();
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

async function fresh(o = {}) {
  resetServer();
  Object.assign(srv, o);
  budget._reset();
  llm._resetFeatures();
  await slots.refresh({ force: true });
}

/** A file that reads as a JPEG of the given size (header only: the stub never decodes it). */
function fakeJpeg(file, width, height) {
  const sof = Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xFF, 0xD8]), sof, Buffer.from([0xFF, 0xD9])]));
  return file;
}
const frameDir = path.join(tmp, 'frames');
fs.mkdirSync(frameDir, { recursive: true });
const FRAMES = Array.from({ length: 35 }, (_, i) => fakeJpeg(path.join(frameDir, `frame_${String(i + 1).padStart(3, '0')}.jpg`), 600, 338));

const LONG_TRANSCRIPT = `BEGINMARK ${'hello there this is the start of the talk. '.repeat(100)} MIDDLEMARK ${'and then more of the same words go on. '.repeat(100)} ENDMARK`;

/* ── Budget arithmetic ───────────────────────────────────────────────── */

test('frames are budgeted from the context length; the answer gets the room that is left', () => {
  budget._reset();
  const est = budget.estimateFrameTokens(600, 338);
  assert.strictEqual(est, Math.max(256, 22 * 13) + 16);
  const p = budget.plan({ key: 'm', context: 8192, textChars: 3000, available: 35, minFrames: 3, frameWidth: 600, frameHeight: 338 });
  const text = Math.ceil(3000 / 3) + 64;
  assert.strictEqual(p.frames, Math.floor((Math.floor(8192 * 0.95) - text - budget.ANSWER_RESERVE) / est));
  assert.strictEqual(p.maxTokens, Math.min(budget.ANSWER_GUARD, 8192 - (text + p.frames * est)));
  // A big context sends everything, and the guard caps the answer.
  const big = budget.plan({ key: 'm', context: 131072, textChars: 3000, available: 35, minFrames: 3 });
  assert.strictEqual(big.frames, 35);
  assert.strictEqual(big.maxTokens, budget.ANSWER_GUARD);
  // Never fewer than minFrames, even when nothing fits.
  assert.strictEqual(budget.plan({ key: 'm', context: 2048, textChars: 3000, available: 35, minFrames: 3 }).frames, 3);
  // Unknown context: the safe default.
  assert.strictEqual(budget.plan({ key: 'm', context: null, textChars: 0, available: 1, minFrames: 1 }).context, budget.DEFAULT_CONTEXT);
});

test('an even pick keeps the first and last frame and the order', () => {
  const list = Array.from({ length: 35 }, (_, i) => i);
  assert.deepStrictEqual(budget.pickEvenly(list, 5), [0, 9, 17, 26, 34]);
  assert.deepStrictEqual(budget.pickEvenly(list, 40), list);
  assert.deepStrictEqual(budget.pickEvenly([1, 2, 3], 1), [2]);
});

test('frames are capped by area: landscape as before, vertical no bigger', () => {
  assert.deepStrictEqual(frames.scaledSize(1920, 1080), { width: 600, height: 338 });
  assert.deepStrictEqual(frames.scaledSize(1280, 720), { width: 600, height: 338 });
  const v = frames.scaledSize(1080, 1920);
  assert.strictEqual(v.width, 338);
  assert.ok(v.width * v.height <= 600 * 338 + 600, `vertical area ${v.width * v.height}`);
  assert.deepStrictEqual(frames.scaledSize(300, 200), { width: 300, height: 200 }, 'never upscaled');
  assert.match(frames.scaleFilter(), /^scale='round\(iw\*min\(1,min\(600\/iw,sqrt\(202500\/\(iw\*ih\)\)\)\)\)':-1$/);
});

test('area cap: ffmpeg produces the sizes the arithmetic says', { skip: !haveFfmpeg && 'ffmpeg not installed' }, () => {
  for (const [w, h] of [[1920, 1080], [1080, 1920], [640, 480]]) {
    const out = path.join(tmp, `scaled_${w}x${h}.jpg`);
    const r = cp.spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}`, '-frames:v', '1', '-vf', frames.scaleFilter(), out], { windowsHide: true });
    assert.strictEqual(r.status, 0, String(r.stderr));
    assert.deepStrictEqual(vision.jpegSize(out), frames.scaledSize(w, h));
  }
});

test('the transcript is sampled from the start, middle and end', () => {
  const s = prompts.sampleTranscript(LONG_TRANSCRIPT, 3000);
  assert.ok(s.length <= 3000, `length ${s.length}`);
  assert.match(s, /BEGINMARK/);
  assert.match(s, /\[\.\.\.\]/);
  assert.match(s, /ENDMARK/);
  assert.strictEqual(prompts.sampleTranscript('short one', 3000), 'short one');
  // The prompt carries the sample, not the head.
  const p = prompts.getPrompt('video', 'v.mp4', { transcription: LONG_TRANSCRIPT, transcriptionLanguage: 'en', structured: true });
  assert.match(p, /ENDMARK/);
  assert.match(p, /audio_summary/);
});

test('prompt: one positioning field, short description, a fluids note that fits the type, no template when structured', () => {
  const video = prompts.getPrompt('video', 'v.mp4', { structured: true });
  assert.doesNotMatch(video, /posture_or_pose/);
  assert.match(video, /positioning: /);
  assert.match(video, /description: brief 1-2 sentence summary of the scene\./);
  assert.doesNotMatch(video, /ONLY provide raw JSON/);
  assert.match(video, /more than one frame/);
  const image = prompts.getPrompt('image', 'i.jpg', {});
  assert.doesNotMatch(image, /frames?\b.*fluids|multiple frames|more than one frame/);
  assert.match(image, /ONLY provide raw JSON/, 'prompt-only path keeps a template');
  assert.match(image, /"media_elements": \{"main_person"/);
  for (const p of [video, image]) {
    assert.doesNotMatch(p, /noticable|Estimate the exact of/);
    assert.strictEqual((p.match(/strapon/g) || []).length, 1);
    // The owner's explicit vocabulary is still there.
    for (const w of ['penis', 'vagina', 'semen', 'sperm on thighs', 'orgasmic moaning', 'g-string', 'uncensored']) assert.ok(p.includes(w), w);
  }
});

test('the response schema bounds the answer', () => {
  const rf = prompts.responseFormat('video', {});
  const s = rf.json_schema.schema;
  assert.strictEqual(rf.type, 'json_schema');
  assert.deepStrictEqual(s.properties.content_type.enum, prompts.CONTENT_TYPES);
  for (const k of ['themes', 'locations', 'tags', 'transcribed_text']) assert.ok(s.properties[k].maxItems > 0, k);
  assert.deepStrictEqual(s.properties.media_elements.required, prompts.MEDIA_ELEMENT_FIELDS.map(f => f.type));
  assert.deepStrictEqual(Object.keys(s.properties).slice(0, 4), ['language', 'content_type', 'description', 'tags']);
  const withAudio = prompts.responseFormat('video', { transcription: 'x', transcriptionLanguage: 'en' }).json_schema.schema;
  assert.ok(withAudio.properties.media_elements.required.includes('audio_summary'));
});

/* ── Against the fake server ─────────────────────────────────────────── */

test('the request carries a schema, no reasoning, and only the frames that fit', async () => {
  await fresh({ ctx: 6000 });
  const out = await vision.analyze(FRAMES, 'v.mp4', 'video');
  const r = srv.reqs[0];
  assert.ok(r.response_format && r.response_format.type === 'json_schema');
  assert.strictEqual(r.reasoning_effort, 'none');
  assert.doesNotMatch(r.text, /ONLY provide raw JSON/);
  const expect = budget.plan({ key: 'never-used', context: 6000, textChars: r.text.length, available: 35, minFrames: 3, frameWidth: 600, frameHeight: 338 });
  assert.strictEqual(r.images, expect.frames);
  assert.ok(r.images < 35);
  assert.strictEqual(r.max_tokens, expect.maxTokens);
  assert.strictEqual(out._scan.framesSent, r.images);
  // Stored shape: [{type, details}], empty entries left out.
  assert.ok(Array.isArray(out.media_elements));
  assert.deepStrictEqual(out.media_elements[0], { type: 'main_person', details: 'nobody' });
  assert.ok(!out.media_elements.some(e => e.type === 'relationship'));
  assert.ok(!Object.keys(out).includes('_scan'), 'scan info is not an enumerable field');
});

test('the per-frame cost is learned from usage, so the next file sends more frames', async () => {
  await fresh({ ctx: 6000, perImage: 150 });
  await vision.analyze(FRAMES, 'a.mp4', 'video');
  const learned = budget.learned('vis');
  assert.ok(learned.frameTokens >= 140 && learned.frameTokens <= 150, `learned ${learned.frameTokens}`);
  await vision.analyze(FRAMES, 'b.mp4', 'video');
  assert.ok(srv.reqs[1].images > srv.reqs[0].images, `${srv.reqs[0].images} then ${srv.reqs[1].images}`);
});

test('too big for the context: retried with half the frames, then succeeds; the context is learned', async () => {
  await fresh({ ctx: null, realCtx: 4500 });       // the server does not report its context
  const out = await vision.analyze(FRAMES, 'v.mp4', 'video');
  assert.strictEqual(srv.reqs[0].status, 400);
  assert.ok(srv.reqs.length >= 2);
  // At most half, and already planned against the context the refusal named.
  assert.ok(srv.reqs[1].images <= Math.floor(srv.reqs[0].images / 2), `${srv.reqs[0].images} then ${srv.reqs[1].images}`);
  assert.strictEqual(srv.reqs.at(-1).status, 200);
  assert.ok(Array.isArray(out.media_elements));
  assert.strictEqual(budget.learned('vis').context, 4500);
  // The next file starts within the learned context: no refusal.
  const before = srv.reqs.length;
  await vision.analyze(FRAMES, 'w.mp4', 'video');
  assert.strictEqual(srv.reqs.length, before + 1);
  assert.strictEqual(srv.reqs.at(-1).status, 200);
});

test('cut off by length: half the frames, then no transcript, then a clear failure', async () => {
  await fresh({ ctx: 65536, script: ['length', 'length', 'length'], cutAt: 30 });
  await assert.rejects(
    vision.analyze(FRAMES, 'v.mp4', 'video', { transcription: LONG_TRANSCRIPT, transcriptionLanguage: 'en' }),
    (err) => {
      assert.match(err.message, /^the reply was cut off before it finished, even after retrying with \d+ pictures/);
      assert.strictEqual(failures.classify(err.message), 'cut-off');
      assert.ok(!err.modelUnavailable);
      return true;
    });
  assert.strictEqual(srv.reqs.length, 3, 'two retries at most');
  assert.strictEqual(srv.reqs[1].images, Math.floor(srv.reqs[0].images / 2));
  assert.match(srv.reqs[0].text, /AUDIO TRANSCRIPTION/);
  assert.match(srv.reqs[1].text, /AUDIO TRANSCRIPTION/);
  assert.doesNotMatch(srv.reqs[2].text, /AUDIO TRANSCRIPTION/);
  assert.strictEqual(srv.reqs[2].images, srv.reqs[1].images);
  // The answer reserve went up, so the next file starts smaller.
  assert.ok(budget.learned('vis').reserve > budget.ANSWER_RESERVE);
});

test('too big even at the minimum: a clear failure in its own group', async () => {
  await fresh({ ctx: null, realCtx: 300 });
  await assert.rejects(vision.analyze(FRAMES, 'v.mp4', 'video'), (err) => {
    assert.match(err.message, /^too big for the model's context even with 3 pictures \(context 300 tokens\)/);
    assert.strictEqual(failures.classify(err.message), 'too-big');
    return true;
  });
  assert.strictEqual(srv.reqs.length, 3);
});

test('a cut-off answer whose leading fields arrived is kept, marked, and nothing is made up', async () => {
  const full = JSON.stringify(ANSWER);
  await fresh({ script: ['length', 'length', 'length'], cutAt: full.indexOf('"positioning"') + 5 });
  const out = await vision.analyze(FRAMES, 'v.mp4', 'video');
  assert.strictEqual(out._scan.partial, true);
  assert.strictEqual(out.content_type, 'other');
  assert.strictEqual(out.description, ANSWER.description);
  assert.deepStrictEqual(out.tags, ANSWER.tags);
  assert.deepStrictEqual(out.media_elements, [{ type: 'main_person', details: 'nobody' }, { type: 'age', details: 'n/a' }]);
  assert.ok(!('transcribed_text' in out), 'a field that never arrived is not invented');
});

test('repairTruncatedJson keeps only what fully arrived', () => {
  assert.deepStrictEqual(llm.repairTruncatedJson('{"a": 1, "b": [1, 2, 3'), { a: 1, b: [1, 2] });
  assert.deepStrictEqual(llm.repairTruncatedJson('```json\n{"a": "x", "b": "half a sent'), { a: 'x' });
  assert.deepStrictEqual(llm.repairTruncatedJson('{"a": {"x": "1, 2", "y": "z'), { a: { x: '1, 2' } });
  assert.strictEqual(llm.repairTruncatedJson('{"a": "nothing complete'), null);
});

test('a server that refuses response_format gets the template, and is not asked again', async () => {
  await fresh({ rejectFormat: true });
  const out = await vision.analyze(FRAMES, 'v.mp4', 'video');
  assert.strictEqual(srv.reqs[0].status, 400);
  assert.ok(srv.reqs[0].response_format);
  assert.strictEqual(srv.reqs[1].response_format, null);
  assert.match(srv.reqs[1].text, /ONLY provide raw JSON/);
  assert.ok(Array.isArray(out.media_elements));
  assert.ok(llm.endpointRejects(base, 'response_format'));
  assert.ok(!llm.endpointRejects('http://127.0.0.1:1/v1/chat/completions', 'response_format'), 'per endpoint');
  await vision.analyze(FRAMES, 'w.mp4', 'video');
  assert.strictEqual(srv.reqs.length, 3, 'one request for the second file');
  assert.strictEqual(srv.reqs[2].response_format, null);
});

test('one prose reply to a schema: that file retries with the template, the endpoint keeps the schema', async () => {
  await fresh({ script: ['notJson'] });
  const out = await vision.analyze(FRAMES, 'v.mp4', 'video');
  assert.ok(srv.reqs[0].response_format);
  assert.strictEqual(srv.reqs[1].response_format, null);
  assert.match(srv.reqs[1].text, /ONLY provide raw JSON/);
  assert.strictEqual(out.content_type, 'other');
  assert.ok(!llm.endpointRejects(base, 'response_format'), 'one bad reply is just a bad reply');
  await vision.analyze(FRAMES, 'w.mp4', 'video');
  assert.ok(srv.reqs[2].response_format, 'the next file still sends the schema');
});

test('prose replies to a schema twice in a row: prompt-only for a while, then the schema is tried again', async () => {
  await fresh({ script: ['notJson', 'ok', 'notJson', 'ok'] });
  await vision.analyze(FRAMES, 'a.mp4', 'video');
  assert.ok(!llm.endpointRejects(base, 'response_format'));
  await vision.analyze(FRAMES, 'b.mp4', 'video');
  assert.ok(llm.endpointRejects(base, 'response_format'), 'two in a row');
  await vision.analyze(FRAMES, 'c.mp4', 'video');
  assert.strictEqual(srv.reqs.at(-1).response_format, null);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 21 * 60 * 1000;
    assert.ok(!llm.endpointRejects(base, 'response_format'), 'tried again later');
  } finally { Date.now = realNow; }
});

test('a schema reply that came back right resets the count', async () => {
  await fresh({ script: ['notJson', 'ok', 'ok', 'notJson', 'ok'] });
  await vision.analyze(FRAMES, 'a.mp4', 'video');   // prose, then the template
  await vision.analyze(FRAMES, 'b.mp4', 'video');   // schema answered fine
  await vision.analyze(FRAMES, 'c.mp4', 'video');   // prose once more
  assert.ok(!llm.endpointRejects(base, 'response_format'));
});

test('reasoning_effort refused: sent without it, and not again for that endpoint', async () => {
  await fresh({ rejectReasoning: true });
  await vision.analyze(FRAMES, 'v.mp4', 'video');
  assert.strictEqual(srv.reqs[0].status, 400);
  assert.strictEqual(srv.reqs[1].reasoning_effort, null);
  await vision.analyze(FRAMES, 'w.mp4', 'video');
  assert.strictEqual(srv.reqs.length, 3);
  // Thinking cannot be switched off there, so the answer is allowed more room.
  assert.ok(llm.endpointRejects(base, 'reasoning_effort'));
});

test('a reply that is all thinking fails clearly, and reasoning is never returned', async () => {
  await fresh({ script: ['thinking'] });
  await assert.rejects(vision.analyze(FRAMES, 'v.mp4', 'video'), (err) => {
    assert.strictEqual(err.message, 'the model spent its whole reply thinking and gave no answer');
    assert.strictEqual(failures.classify(err.message), 'thinking');
    return true;
  });
  assert.strictEqual(llm.stripThinking('<think>hmm</think>{"a":1}'), '{"a":1}');
  assert.strictEqual(llm.stripThinking('<think>still going'), '');
});

test('the scan cut-off still stops a retry', async () => {
  await fresh({ ctx: null, realCtx: 4500, script: ['hang', 'hang', 'hang'] });
  const ac = new AbortController();
  const run = slots.runScan({ mediaId: 77, scan: true, vision: true, signal: ac.signal },
    () => vision.analyze(FRAMES, 'v.mp4', 'video'));
  const end = Date.now() + 5000;
  // The first request is refused as too big; abort while the retry is waiting.
  while (!(srv.reqs.length >= 2) && Date.now() < end) await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(srv.reqs[0].status, 400);
  ac.abort();
  await assert.rejects(run, (err) => err.scanCutOff === true && err.modelUnavailable === true);
  assert.strictEqual(srv.reqs.length, 2, 'no further request after the cut');
});

test('callers without prepare (the subtitle translator) are sent exactly what they asked for', async () => {
  await fresh();
  srv.answer = '1. hello';
  const r = await llm.postChat([{ role: 'user', content: 'translate' }], { temperature: 0.1, maxTokens: 1234 });
  assert.strictEqual(r.content, '1. hello');
  assert.strictEqual(r.finishReason, 'stop');
  assert.strictEqual(srv.reqs[0].max_tokens, 1234);
  assert.strictEqual(srv.reqs[0].response_format, null);
  assert.strictEqual(srv.reqs[0].reasoning_effort, null);
  // A cut-off reply is handed back with its finish reason, not thrown away.
  srv.script = ['length'];
  srv.cutAt = 4;
  const cut = await llm.postChat([{ role: 'user', content: 'translate' }], { maxTokens: 10 });
  assert.strictEqual(cut.content, '1. h');
  assert.strictEqual(cut.finishReason, 'length');
});

test('document text: schema, budgeted text, and half the text after a refusal', async () => {
  await fresh({ ctx: null, realCtx: 2000 });
  srv.answer = { description: 'a doc', document_type: 'notes', language: 'english', themes: [], tags: ['x'], has_sensitive_data: false, sentiment: 'neutral' };
  const text = 'word '.repeat(4000);
  const out = await textApi.analyze(text, 'notes.txt');
  assert.strictEqual(out.document_type, 'notes');
  assert.strictEqual(srv.reqs[0].response_format.json_schema.name, 'document_analysis');
  assert.strictEqual(srv.reqs[0].reasoning_effort, 'none');
  assert.strictEqual(srv.reqs[0].status, 400);
  assert.ok(srv.reqs[1].text.length < srv.reqs[0].text.length);
  assert.strictEqual(srv.reqs.at(-1).status, 200);
});

/* ── Saved rows ──────────────────────────────────────────────────────── */

test('processFile stores [{type, details}], the frames sent, and marks a kept cut-off answer', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
  const { processFile, PARTIAL_MODEL_USED } = require('../commands/scan');
  const img = path.join(tmp, 'tall.jpg');
  cp.spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920', '-frames:v', '1', img], { windowsHide: true });

  await fresh();
  const ok = await slots.runScan({ mediaId: 1, scan: true, vision: true }, () => processFile({ path: img, name: 'tall.jpg', mediaType: 'image' }, { reprocess: true, retryErrors: true }));
  assert.ok(ok.success, ok.error);
  let row = db.getByPath(img);
  const els = JSON.parse(row.media_elements);
  assert.ok(Array.isArray(els) && els.every(e => typeof e.type === 'string' && typeof e.details === 'string'));
  assert.strictEqual(row.model_used, 'lm-studio');
  assert.strictEqual(row.frames_analyzed, 1);
  assert.match(srv.reqs[0].text, /single static image/);

  const full = JSON.stringify(ANSWER);
  await fresh({ script: ['length', 'length', 'length'], cutAt: full.indexOf('"media_elements"') + 2 });
  const part = await slots.runScan({ mediaId: 1, scan: true, vision: true }, () => processFile({ path: img, name: 'tall.jpg', mediaType: 'image' }, { reprocess: true, retryErrors: true }));
  assert.ok(part.success && part.partial);
  row = db.getByPath(img);
  assert.strictEqual(row.model_used, PARTIAL_MODEL_USED);
  assert.strictEqual(row.description, ANSWER.description);
  assert.strictEqual(row.processing_error, null);
  assert.strictEqual(db.get().prepare('SELECT COUNT(*) AS n FROM media WHERE model_used = ?').get(PARTIAL_MODEL_USED).n, 1);
});

test('old rows (positioning + posture_or_pose) and new rows (positioning only) both read and search', async () => {
  const save = (name, elements) => {
    db.saveMedia({ filepath: path.join(tmp, name), filename: name, mediaType: 'video', description: 'x', tags: [], themes: [], locations: [], contentType: 'other', mediaElements: elements, model: 'lm-studio', error: null });
    return db.getByPath(path.join(tmp, name));
  };
  const oldRow = save('old.mp4', [{ type: 'positioning', details: 'kneeling quokka' }, { type: 'posture_or_pose', details: 'arched wombat' }]);
  const newRow = save('new.mp4', vision.normalizeAnalysis({ media_elements: { positioning: 'reclining numbat', age: '30s' } }).media_elements);
  assert.deepStrictEqual(JSON.parse(newRow.media_elements), [{ type: 'positioning', details: 'reclining numbat' }, { type: 'age', details: '30s' }]);

  const { desiredForRow } = require('../lib/cove/mapping');
  const oldFields = Object.values(desiredForRow(oldRow).fields).map(f => f.value);
  const newFields = Object.values(desiredForRow(newRow).fields).map(f => f.value);
  assert.ok(oldFields.includes('kneeling quokka') && oldFields.includes('arched wombat'));
  assert.ok(newFields.includes('reclining numbat'));

  const q = require('../lib/library-query');
  const find = async (word) => [...(await q.allIds(q.normalizeSpec({ search: { text: word } }))).ids];
  assert.ok((await find('wombat')).includes(oldRow.id));
  assert.ok((await find('numbat')).includes(newRow.id));
});

test('failure wording: plain, grouped, no em dashes', () => {
  for (const key of ['too-big', 'cut-off', 'thinking']) {
    const info = failures.reasonInfo(key);
    assert.strictEqual(info.key, key);
    assert.doesNotMatch(info.label + info.explain, /—/);
  }
  assert.strictEqual(failures.classify('API error: 400 Bad Request - {"error":"request (9000 tokens) exceeds the available context size (8192 tokens)"}'), 'too-big');
  assert.strictEqual(failures.classify('Unexpected end of JSON input'), 'no-answer', 'old rows stay where they were');
});

/* ── Follow-up fixes ─────────────────────────────────────────────────── */

test('a literal <think> inside the answer is text, not reasoning', async () => {
  // In the description: kept whole, one request, not mistaken for a cut-off reply.
  await fresh();
  srv.answer = { ...ANSWER, description: 'A sign reads <think> before you post.' };
  let out = await vision.analyze(FRAMES, 'v.mp4', 'video');
  assert.strictEqual(out.description, 'A sign reads <think> before you post.');
  assert.strictEqual(srv.reqs.length, 1);
  assert.strictEqual(out._scan.partial, false);

  // In transcribed_text: a whole answer, not a "cut short" one.
  await fresh();
  srv.answer = { ...ANSWER, transcribed_text: [{ text: '<think>', location: 'top' }, { text: 'END', location: 'bottom' }] };
  out = await vision.analyze(FRAMES, 'v.mp4', 'video');
  assert.strictEqual(out._scan.partial, false);
  assert.deepStrictEqual(out.transcribed_text.map(t => t.text), ['<think>', 'END']);
  assert.strictEqual(srv.reqs.length, 1);

  // A matched pair inside a string is not deleted.
  await fresh();
  srv.answer = { ...ANSWER, description: 'Caption: <think>be kind</think> end.' };
  out = await vision.analyze(FRAMES, 'v.mp4', 'video');
  assert.strictEqual(out.description, 'Caption: <think>be kind</think> end.');

  // A reasoning block that LEADS the reply is still removed.
  await fresh();
  srv.answer = `<think>Looking at the frames first.</think>\n${JSON.stringify(ANSWER)}`;
  out = await vision.analyze(FRAMES, 'v.mp4', 'video');
  assert.strictEqual(out.description, ANSWER.description);
  assert.strictEqual(srv.reqs.length, 1);

  // A leading <think> that never closes: the whole reply was thinking.
  await fresh();
  srv.answer = '<think>still going over the frames';
  await assert.rejects(vision.analyze(FRAMES, 'v.mp4', 'video'), /spent its whole reply thinking/);

  assert.strictEqual(llm.stripThinking('{"a":"<think>x</think>"}'), '{"a":"<think>x</think>"}');
  assert.strictEqual(llm.stripThinking('  <think>a</think>  {"a":1}'), '{"a":1}');
});

test('a document that mentions <think> is analysed, not failed as bad JSON', async () => {
  await fresh();
  srv.answer = { description: 'Notes about the <think> tag in prompts.', document_type: 'notes', language: 'english', themes: [], tags: ['think'], has_sensitive_data: false, sentiment: 'neutral' };
  const out = await textApi.analyze('The <think> tag wraps reasoning. '.repeat(20), 'notes.txt');
  assert.strictEqual(out.description, 'Notes about the <think> tag in prompts.');
  assert.strictEqual(srv.reqs.length, 1);
});

test('callers without prepare get the content exactly as the server sent it', async () => {
  await fresh();
  srv.answer = '<think>x</think>1. hello';
  const r = await llm.postChat([{ role: 'user', content: 'translate' }], { maxTokens: 50 });
  assert.strictEqual(r.content, '<think>x</think>1. hello', 'the translator strips thinking itself, as before');
});

test('salvage needs the right types; wrong types are dropped on every path', async () => {
  // Cut off, with only wrong-type tags and themes: not kept.
  const bad = { language: 'none', content_type: 'other', description: 'x', tags: [1, 2], themes: [{ a: 1 }], locations: [] };
  const full = JSON.stringify(bad).slice(0, -1) + ', "media_elements": {"main_person": "som';
  await fresh({ script: ['length', 'length', 'length'], cutAt: full.length });
  srv.answer = full;
  await assert.rejects(vision.analyze(FRAMES, 'v.mp4', 'video'), /cut off/);
  assert.strictEqual(vision.salvageable({ content_type: 'other', description: 'x', tags: [1, 2, 'z'] }), true, 'one real string tag is enough');
  assert.strictEqual(vision.salvageable({ content_type: 'a sentence', description: 'x', tags: ['z'] }), false, 'content_type must be a choice');
  assert.strictEqual(vision.salvageable({ content_type: 'other', description: 7, tags: ['z'] }), false);
  assert.strictEqual(vision.salvageable({ content_type: 'other', description: '  ', tags: ['z'] }), false);

  // A whole answer with junk in it: only the right types are kept.
  await fresh();
  srv.answer = {
    language: 'none', content_type: 'other', description: 7,
    tags: [1, ' beach ', '', null, 'x'.repeat(500)], themes: [{ a: 1 }, 'sea'], locations: 'home',
    media_elements: { main_person: 'one woman', age: 30, action: '', lighting: { a: 1 } },
    transcribed_text: [{ text: 1, location: 'x' }, { text: 'HELLO', location: 'top' }, 'loose', { text: 'NOLOC' }],
  };
  const out = await vision.analyze(FRAMES, 'v.mp4', 'video');
  assert.deepStrictEqual(out.tags, ['beach', 'x'.repeat(200)]);
  assert.deepStrictEqual(out.themes, ['sea']);
  assert.deepStrictEqual(out.locations, []);
  assert.ok(typeof out.description !== 'number', 'a description that is not a string is not kept as one');
  assert.deepStrictEqual(out.media_elements, [{ type: 'main_person', details: 'one woman' }]);
  assert.ok(out.transcribed_text.every(t => typeof t.text === 'string' && t.text && typeof t.location === 'string'));
  assert.deepStrictEqual(out.transcribed_text.map(t => t.text), ['HELLO']);
  assert.deepStrictEqual(vision.normalizeAnalysis({ media_elements: [{ type: 'age', details: '30s' }, { type: 5, details: 'x' }, 'junk'] }).media_elements,
    [{ type: 'age', details: '30s' }], 'the old array shape is checked the same way');
});

test('hostile usage readings are ignored; plan always answers in whole numbers', async () => {
  for (const reading of [1e12, -5, 0, 3.5, 'abc', null, 9_000_000]) {
    await fresh({ ctx: 6000, promptTokensOverride: reading });
    await vision.analyze(FRAMES, 'a.mp4', 'video');
    assert.strictEqual(budget.learned('vis').frameTokens, null, `reading ${reading}`);
    srv.promptTokensOverride = undefined;
    await vision.analyze(FRAMES, 'b.mp4', 'video');
    assert.strictEqual(srv.reqs[1].images, srv.reqs[0].images, `the next file is planned as before after ${reading}`);
  }

  budget._reset();
  budget.learnFromOverflow('k', { nPrompt: 1e12, nCtx: -3, textChars: NaN, frames: 10 });
  assert.deepStrictEqual([budget.learned('k').frameTokens, budget.learned('k').context], [null, null]);
  budget.learnFromUsage('k', { promptTokens: 5000, textChars: 0, frames: 1 });   // 5000 a frame: not plausible
  assert.strictEqual(budget.learned('k').frameTokens, null);
  for (const o of [{}, { textChars: NaN, available: 35, minFrames: 3 }, { textChars: undefined, context: NaN, available: 'x' },
    { key: 'k', textChars: Infinity, available: 35, minFrames: 3, maxFrames: NaN, frameWidth: -1, frameHeight: 'y', reserve: NaN }]) {
    const p = budget.plan(o);
    assert.ok(Number.isInteger(p.frames) && p.frames >= 0, `frames for ${JSON.stringify(o)}`);
    assert.ok(Number.isInteger(p.maxTokens) && p.maxTokens >= budget.MIN_ANSWER, `maxTokens for ${JSON.stringify(o)}`);
  }
  // Unknown text size is planned as a long one, not as nothing.
  assert.ok(budget.plan({ key: 'q', context: 8192, textChars: NaN, available: 35, minFrames: 3 }).frames
    < budget.plan({ key: 'q', context: 8192, textChars: 100, available: 35, minFrames: 3 }).frames);
});

test('a context error that mentions reasoning does not switch reasoning or the schema off', async () => {
  await fresh({ ctx: null, realCtx: 4500, overflowExtra: ' (reasoning_effort and response_format are not supported causes here)' });
  await vision.analyze(FRAMES, 'v.mp4', 'video');
  assert.strictEqual(srv.reqs[0].status, 400);
  assert.ok(!llm.endpointRejects(base, 'reasoning_effort'));
  assert.ok(!llm.endpointRejects(base, 'response_format'));
  assert.ok(srv.reqs.every(r => r.reasoning_effort === 'none' && r.response_format));
});

/* ── Context use (lib/context-use.js) ─────────────────────────────────── */

function captureLog(fn) {
  const lines = [];
  const { log, warn, error } = console;
  console.log = console.warn = console.error = (...a) => lines.push(a.join(' '));
  return Promise.resolve().then(fn).finally(() => { console.log = log; console.warn = warn; console.error = error; }).then(() => lines, (e) => { e.lines = lines; throw e; });
}

test('each scan records what the server counted, once, from its largest reply, and it survives a restart', async () => {
  const contextUse = require('../lib/context-use');
  contextUse._reset();
  try { fs.rmSync(contextUse._file()); } catch {}
  await fresh({ ctx: 65536, script: ['length', 'ok'], cutAt: 30 });
  const lines = await captureLog(() => vision.analyze(FRAMES, 'secret-name.mp4', 'video'));
  const prompt = (r) => Math.ceil(r.text.length / 4) + r.images * srv.perImage + 10;
  const totals = [prompt(srv.reqs[0]) + srv.reqs[0].max_tokens, prompt(srv.reqs[1]) + 300];
  const s = contextUse.summary('vis');
  assert.strictEqual(s.count, 1, 'one scan, however many replies');
  assert.strictEqual(s.maxTotal, Math.max(...totals));
  assert.strictEqual(s.context, 65536, 'the context the model is loaded with');
  assert.strictEqual(s.maxFrames, srv.reqs[totals[0] >= totals[1] ? 0 : 1].images);
  assert.strictEqual(s.p95, null, 'too few scans for a percentile');
  const line = lines.find(l => /Context use:/.test(l));
  assert.match(line, /Context use: \d+ prompt \+ \d+ answer = \d+ of 65536 tokens, \d+ pictures \(vis/);
  assert.ok(line.includes(`= ${s.maxTotal} of 65536 tokens`), line);
  assert.doesNotMatch(lines.join('\n'), /Context use:.*secret-name/, 'no file name on the line');
  // A copy of the model (vis:2) counts as the same model.
  contextUse.record({ model: 'vis:2', promptTokens: 100, completionTokens: 10, frames: 1, context: 65536 });
  assert.strictEqual(contextUse.summary('vis').count, 2);
  // Saved, and read back after a restart.
  contextUse._saveNow();
  contextUse._reset();
  assert.deepStrictEqual(contextUse.summary('vis'), { ...s, count: 2 });
  const saved = fs.readFileSync(contextUse._file(), 'utf8');
  assert.doesNotMatch(saved, /secret-name/);
});

test('context use: the 95 in 100 figure, and readings that are not counts are ignored', () => {
  const contextUse = require('../lib/context-use');
  contextUse._reset();
  try { fs.rmSync(contextUse._file()); } catch {}
  assert.strictEqual(contextUse.summary('m'), null, 'nothing recorded: nothing to show');
  assert.strictEqual(contextUse.record({ model: 'm', promptTokens: 'lots', completionTokens: 5 }), null);
  assert.strictEqual(contextUse.record({ model: 'm', promptTokens: -1 }), null);
  for (let i = 1; i <= 100; i++) contextUse.record({ model: 'm', promptTokens: i * 100, completionTokens: 0, frames: 2, context: 20000 });
  const s = contextUse.summary('m');
  assert.strictEqual(s.count, 100);
  assert.strictEqual(s.maxTotal, 10000);
  assert.strictEqual(s.p95, 9500);
  assert.strictEqual(contextUse.summary('never-scanned').model, 'm', 'falls back to the model scanned last');
});

test('a scan failure logs one line that says why: HTTP status, finish, model, context, pictures', async () => {
  await fresh({ ctx: 65536, script: ['length', 'length', 'length'], cutAt: 30 });
  let lines = [];
  await assert.rejects(captureLog(() => vision.analyze(FRAMES, 'v.mp4', 'video')), (e) => { lines = e.lines; return true; });
  const fail = lines.filter(l => /Vision API error/.test(l));
  assert.strictEqual(fail.length, 1);
  assert.match(fail[0], /\[HTTP 200, finish length, model vis, context 65536, pictures \d+, attempt 3\]$/);

  await fresh({ ctx: 65536, rejectFormat: true });
  srv.rejectFormat = false;
  srv.script = [];
  // A plain HTTP failure: the status is on the line.
  srv.realCtx = 10;      // every request too big, and the minimum still too big
  lines = [];
  await assert.rejects(captureLog(() => vision.analyze(FRAMES, 'w.mp4', 'video')), (e) => { lines = e.lines; return true; });
  assert.match(lines.find(l => /Vision API error/.test(l)), /\[HTTP 400, model vis, context 65536, pictures \d+, attempt 3\]$/);
});
