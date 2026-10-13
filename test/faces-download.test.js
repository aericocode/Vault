/**
 * lib/faces/download.js: per-key consent, the offline switch, sha256 and
 * size checks with temp-then-rename (a bad download leaves no file), progress,
 * abort, and the file-backed model store. No network: fetch is a fake.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-faces-dl-'));
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';

const config = require('../config');
const { preflight, downloadModels, createFileModelStore } = require('../lib/faces/download');
const { netFetch } = require('../lib/net');

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const DET = Buffer.from('detector-bytes'.repeat(100));
const EMB = Buffer.from('embedder-bytes'.repeat(300));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function entries(dir, over = {}) {
  return [
    { key: 'face:detect', url: 'https://huggingface.co/x/det.onnx', sha256: sha(DET), size: DET.length, dest: path.join(dir, 'det.onnx'), ...over.detect },
    { key: 'face:embed', url: 'https://huggingface.co/x/emb.onnx', sha256: sha(EMB), size: EMB.length, dest: path.join(dir, 'emb.onnx'), ...over.embed },
  ];
}

const allow = (keys) => ({ ENV_ALLOWS: true, isAllowed: (k) => keys.includes(k) });

/** Fake fetch: serves bytes per URL in small chunks; records calls. */
function fakeFetch(bodies, calls = []) {
  return async (url, opts) => {
    calls.push({ url, purpose: opts.purpose });
    const buf = bodies[url];
    if (!buf) return new Response('nope', { status: 404 });
    let i = 0;
    const stream = new ReadableStream({
      pull(c) {
        if (opts.signal?.aborted) return c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (i >= buf.length) return c.close();
        c.enqueue(new Uint8Array(buf.subarray(i, i + 256)));
        i += 256;
      },
    });
    return new Response(stream, { status: 200 });
  };
}

function online(t) {
  const prev = config.net.offline;
  config.net.offline = false;
  const prevAllow = config.subtitles.allowModelDownload;
  config.subtitles.allowModelDownload = true;
  t.after(() => { config.net.offline = prev; config.subtitles.allowModelDownload = prevAllow; });
}

const dirOf = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };
const leftovers = (dir) => fs.readdirSync(dir).filter(n => n.includes('.part-'));

test('VAULT_OFFLINE blocks the download before any request, and netFetch blocks it too', async () => {
  const dir = dirOf('offline');
  assert.throws(() => preflight(entries(dir), { consent: allow(['face:detect', 'face:embed']) }), { code: 'NET_OFF' });
  await assert.rejects(netFetch('https://huggingface.co/x', { purpose: 'model' }), { code: 'NET_OFF' });
});

test('every key needs its own consent: CONSENT_NEEDED names the missing ones', (t) => {
  online(t);
  const dir = dirOf('consent');
  assert.throws(() => preflight(entries(dir), { consent: allow([]) }),
    (err) => err.code === 'CONSENT_NEEDED' && JSON.stringify(err.keys) === '["face:detect","face:embed"]');
  assert.throws(() => preflight(entries(dir), { consent: allow(['face:detect']) }),
    (err) => err.code === 'CONSENT_NEEDED' && JSON.stringify(err.keys) === '["face:embed"]');
  assert.throws(() => preflight(entries(dir), { consent: { ENV_ALLOWS: false, isAllowed: () => false } }), { code: 'DOWNLOADS_OFF' });
});

test('an entry without a sha256 is refused', (t) => {
  online(t);
  const dir = dirOf('nohash');
  assert.throws(() => preflight(entries(dir, { embed: { sha256: '' } }), { consent: allow(['face:detect', 'face:embed']) }), { code: 'BAD_ENTRY' });
});

test('downloads verified files via temp + rename, with progress, through purpose "model"', async (t) => {
  online(t);
  const dir = dirOf('ok');
  const list = entries(dir);
  const calls = [];
  const progress = [];
  const out = await downloadModels(list, {
    consent: allow(['face:detect', 'face:embed']),
    fetchImpl: fakeFetch({ [list[0].url]: DET, [list[1].url]: EMB }, calls),
    onProgress: (p) => progress.push(p),
  });
  assert.deepStrictEqual(out.downloaded, ['face:detect', 'face:embed']);
  assert.ok(fs.readFileSync(list[0].dest).equals(DET));
  assert.ok(fs.readFileSync(list[1].dest).equals(EMB));
  assert.deepStrictEqual(leftovers(dir), []);
  assert.ok(calls.every(c => c.purpose === 'model'));
  const last = progress.at(-1);
  assert.strictEqual(last.received, DET.length + EMB.length);
  assert.strictEqual(last.total, DET.length + EMB.length);

  // Already there: nothing is fetched again
  const again = [];
  await downloadModels(list, { consent: allow([]), fetchImpl: fakeFetch({}, again) });
  assert.strictEqual(again.length, 0);
});

test('a checksum mismatch leaves no file and no temp file', async (t) => {
  online(t);
  const dir = dirOf('bad');
  const list = entries(dir, { detect: { sha256: sha(Buffer.from('other')), size: undefined } });
  await assert.rejects(downloadModels(list, {
    consent: allow(['face:detect', 'face:embed']),
    fetchImpl: fakeFetch({ [list[0].url]: DET, [list[1].url]: EMB }),
  }), { code: 'CHECKSUM_MISMATCH' });
  assert.ok(!fs.existsSync(list[0].dest));
  assert.deepStrictEqual(leftovers(dir), []);
});

test('a wrong size or HTTP error fails cleanly', async (t) => {
  online(t);
  const dir = dirOf('size');
  const list = entries(dir, { detect: { size: 5 } });
  await assert.rejects(downloadModels(list, {
    consent: allow(['face:detect', 'face:embed']),
    fetchImpl: fakeFetch({ [list[0].url]: DET }),
  }), { code: 'SIZE_MISMATCH' });
  const list2 = entries(dirOf('http'));
  await assert.rejects(downloadModels(list2, { consent: allow(['face:detect', 'face:embed']), fetchImpl: fakeFetch({}) }),
    { code: 'DOWNLOAD_FAILED' });
  assert.deepStrictEqual(leftovers(dir), []);
});

test('abort stops the download and removes the temp file', async (t) => {
  online(t);
  const dir = dirOf('abort');
  const list = entries(dir);
  const ctrl = new AbortController();
  await assert.rejects(downloadModels(list, {
    consent: allow(['face:detect', 'face:embed']),
    signal: ctrl.signal,
    fetchImpl: fakeFetch({ [list[0].url]: DET, [list[1].url]: EMB }),
    onProgress: () => ctrl.abort(),
  }));
  assert.ok(!fs.existsSync(list[0].dest));
  assert.deepStrictEqual(leftovers(dir), []);
});

test('createFileModelStore reports ready, missing and paths from the files on disk', () => {
  const dir = dirOf('store');
  const list = entries(dir);
  const ms = createFileModelStore(() => list);
  assert.deepStrictEqual(ms.status(), { ready: false, missing: ['face:detect', 'face:embed'],
    paths: { 'face:detect': list[0].dest, 'face:embed': list[1].dest } });
  fs.writeFileSync(list[0].dest, DET);
  fs.writeFileSync(list[1].dest, EMB);
  assert.strictEqual(ms.status().ready, true);
  assert.strictEqual(createFileModelStore(() => []).status().ready, false);
});
