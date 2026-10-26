/**
 * Exporting a collection as an M3U8 playlist (PLAYLISTS_SPEC, build step 2):
 * the pure writer (lib/playlist/formats.js) byte for byte, relative
 * locations, file URIs, the safe default file name, and both routes over HTTP:
 *   GET  /api/collections/:id/export?links=full|vault
 *   POST /api/collections/:id/export/save  { links: full|relative|vault }
 *        (the Save As window is faked through server._setSaveDialogForTest)
 * including playlist order, folder dedupe, strict parameters, the refusal of
 * full and relative links in an encrypted library, the lock gate, and that
 * the file is only ever written where the window said.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-pl-export-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
// Never a real Save As window on the desktop, whatever a test does (spawnPicker)
process.env.VAULT_DISABLE_NATIVE_PICKER = '1';
delete process.env.VAULT_DB_PASSWORD;

const { buildM3U8, toM3U8, relativeLocation, fileUri, exportablePath } = require('../lib/playlist/formats');
const playlistExport = require('../lib/playlist/export');
const { safeFileName, stripExt } = playlistExport;
const db = require('../lib/database');
const vault = require('../lib/vault');
const server = require('../server/index');

// ── The M3U8 writer ────────────────────────────────────────────────────────

const FIXTURE = {
  title: 'Road & "trip"\r\nmix',
  baseUrl: 'http://127.0.0.1:8783',
  items: [
    { id: 7, title: 'First <one>', durationSec: 61.6, filePath: 'D:\\Media\\First <one>.mp4' },
    { id: 12, title: 'Two\nlines', durationSec: null, filePath: 'D:\\Media\\Sub\\a;b=c #1.mkv' },
    { id: 3, title: 'Café', durationSec: 0.2, filePath: 'E:\\Music\\Café 100%.mp3' },
  ],
};

test('M3U8 with Vault links, byte for byte', () => {
  const text = toM3U8({ ...FIXTURE, links: 'vault' });
  assert.strictEqual(text, [
    '#EXTM3U',
    '#PLAYLIST:Road & "trip" mix',
    '#EXTINF:62,First <one>',
    'http://127.0.0.1:8783/media/7',
    '#EXTINF:-1,Two lines',
    'http://127.0.0.1:8783/media/12',
    '#EXTINF:1,Café',
    'http://127.0.0.1:8783/media/3',
    '',
  ].join('\r\n'));
  // UTF-8, no BOM, only CRLF line breaks, and no Vault-only lines.
  assert.notStrictEqual(Buffer.from(text, 'utf8')[0], 0xef);
  assert.ok(!/[^\r]\n/.test(text) && !/\r(?!\n)/.test(text));
  assert.ok(!text.includes('#EXTVLT'));
});

test('M3U8 with full paths writes them as they are', () => {
  assert.strictEqual(toM3U8({ ...FIXTURE, links: 'full' }), [
    '#EXTM3U',
    '#PLAYLIST:Road & "trip" mix',
    '#EXTINF:62,First <one>',
    'D:\\Media\\First <one>.mp4',
    '#EXTINF:-1,Two lines',
    'D:\\Media\\Sub\\a;b=c #1.mkv',
    '#EXTINF:1,Café',
    'E:\\Music\\Café 100%.mp3',
    '',
  ].join('\r\n'));
  assert.ok(toM3U8({ title: 'L', links: 'full', items: [{ id: 1, title: 'x', filePath: '/home/me/x y.mp4' }] })
    .endsWith('\r\n/home/me/x y.mp4\r\n'));
});

test('M3U8 with relative paths: from the playlist folder, other drives get a full path', () => {
  const { text, fullPathCount } = buildM3U8({ ...FIXTURE, links: 'relative', playlistDir: 'D:\\Media' });
  assert.strictEqual(text, [
    '#EXTM3U',
    '#PLAYLIST:Road & "trip" mix',
    '#EXTINF:62,First <one>',
    'First <one>.mp4',
    '#EXTINF:-1,Two lines',
    'Sub\\a;b=c #1.mkv',
    '#EXTINF:1,Café',
    'E:\\Music\\Café 100%.mp3',
    '',
  ].join('\r\n'));
  assert.strictEqual(fullPathCount, 1);
  assert.strictEqual(buildM3U8({ ...FIXTURE, links: 'full' }).fullPathCount, 0);
  assert.strictEqual(buildM3U8({ ...FIXTURE, links: 'vault' }).fullPathCount, 0);
});

test('M3U8: a title or path cannot add a line', () => {
  const text = toM3U8({
    title: 'x\n#EXTINF:1,evil', links: 'full',
    items: [{ id: 1, title: 'a\r\n#EXTINF:1,b\r\nC:\\evil.mp4\u2028\u0000', durationSec: 5, filePath: '/home/me/new\nline.mp4' }],
  });
  assert.strictEqual(text, [
    '#EXTM3U',
    '#PLAYLIST:x #EXTINF:1,evil',
    '#EXTINF:5,a #EXTINF:1,b C:\\evil.mp4',
    'file:///home/me/new%0Aline.mp4',
    '',
  ].join('\r\n'));
  // Relative: the same path falls back to the file URI (counted as full).
  const r = buildM3U8({ title: '', links: 'relative', playlistDir: '/home/me',
    items: [{ id: 1, title: 't', filePath: '/home/me/new\nline.mp4' }] });
  assert.strictEqual(r.text, '#EXTM3U\r\n#EXTINF:-1,t\r\nfile:///home/me/new%0Aline.mp4\r\n');
  assert.strictEqual(r.fullPathCount, 1);
});

test('relative locations: same folder, subfolders, parents, case, prefixes, shares', () => {
  const R = relativeLocation;
  assert.strictEqual(R('D:\\Media\\a.mp4', 'D:\\Media'), 'a.mp4');
  assert.strictEqual(R('D:\\Media\\a.mp4', 'D:\\Media\\'), 'a.mp4');
  assert.strictEqual(R('D:\\Media\\Sub\\Deeper\\a.mp4', 'D:\\Media'), 'Sub\\Deeper\\a.mp4');
  assert.strictEqual(R('D:\\Media\\a.mp4', 'D:\\Lists\\Mine'), '..\\..\\Media\\a.mp4');
  assert.strictEqual(R('D:\\a.mp4', 'D:\\Lists'), '..\\a.mp4');
  assert.strictEqual(R('D:\\Media\\a.mp4', 'D:\\'), 'Media\\a.mp4');
  assert.strictEqual(R('D:\\Media\\Sub\\a.mp4', 'D:\\Media\\Other'), '..\\Sub\\a.mp4');
  // Windows compares names without case; the file keeps its own spelling.
  assert.strictEqual(R('d:\\MEDIA\\Sub\\A.mp4', 'D:\\media'), 'Sub\\A.mp4');
  assert.strictEqual(R('D:/Media/a.mp4', 'd:\\media'), 'a.mp4');
  // The fold is NTFS style (lib/watchers/rules.js foldCase), not JS toUpperCase:
  // é/É are the same name, but ß is not "SS", ﬁ is not "FI", ı is not "I".
  assert.strictEqual(R('D:\\Été\\Clip.mp4', 'D:\\été'), 'Clip.mp4');
  assert.strictEqual(R('\\\\nas\\Ünï\\a.mp4', '\\\\NAS\\ünÏ'), 'a.mp4');
  assert.strictEqual(R('D:\\Straße\\clip.mp4', 'D:\\Strasse'), '..\\Straße\\clip.mp4');
  assert.strictEqual(R('D:\\ﬁlms\\clip.mp4', 'D:\\FILMS'), '..\\ﬁlms\\clip.mp4');
  assert.strictEqual(R('D:\\ı\\clip.mp4', 'D:\\I'), '..\\ı\\clip.mp4');
  // A share name only toUpperCase would merge is another share: full path.
  assert.strictEqual(R('\\\\nas\\straße\\a.mp4', '\\\\nas\\STRASSE'), null);
  // Long-path prefixes on either side.
  assert.strictEqual(R('\\\\?\\D:\\Media\\a.mp4', 'D:\\Media'), 'a.mp4');
  assert.strictEqual(R('D:\\Media\\a.mp4', '\\\\?\\D:\\Lists'), '..\\Media\\a.mp4');
  assert.strictEqual(R('\\\\?\\UNC\\nas\\share\\v\\a.mp4', '\\\\nas\\share\\lists'), '..\\v\\a.mp4');
  // UNC: the same share is relative (server and share without case), another one is not.
  assert.strictEqual(R('\\\\nas\\share\\v\\a.mp4', '\\\\NAS\\Share\\v'), 'a.mp4');
  assert.strictEqual(R('\\\\nas\\other\\a.mp4', '\\\\nas\\share'), null);
  assert.strictEqual(R('\\\\nas2\\share\\a.mp4', '\\\\nas\\share'), null);
  // Another drive, or drive against share: no relative form.
  assert.strictEqual(R('E:\\a.mp4', 'D:\\Media'), null);
  assert.strictEqual(R('\\\\nas\\share\\a.mp4', 'D:\\Media'), null);
  assert.strictEqual(R('D:\\a.mp4', '\\\\nas\\share'), null);
  // Forms that cannot be made relative.
  assert.strictEqual(R('C:rel.mp4', 'C:\\x'), null);
  assert.strictEqual(R('\\\\?\\Volume{0b1c2d3e-0000-0000-0000-000000000000}\\a.mp4', 'D:\\'), null);
  assert.strictEqual(R('D:\\Media\\..\\a.mp4', 'D:\\Media'), null);
  assert.strictEqual(R('D:\\Media\\a.mp4', 'relative\\dir'), null);
  // Linux: case matters, "/" separators.
  assert.strictEqual(R('/home/me/v/a.mp4', '/home/me/lists'), '../v/a.mp4');
  assert.strictEqual(R('/home/me/V/a.mp4', '/home/me/v'), '../V/a.mp4');
  assert.strictEqual(R('/home/me/a.mp4', 'D:\\x'), null);
  // A name starting with "#" would read as a comment line: ".\" in front.
  assert.strictEqual(R('D:\\Media\\#1 hit.mp4', 'D:\\Media'), '.\\#1 hit.mp4');
  assert.strictEqual(R('D:\\Media\\#tag\\a.mp4', 'D:\\Media'), '.\\#tag\\a.mp4');
});

test('file URIs (used when a path cannot sit on a line as it is)', () => {
  assert.strictEqual(fileUri('C:\\Videos\\a b#1 50%.mp4'), 'file:///C:/Videos/a%20b%231%2050%25.mp4');
  assert.strictEqual(fileUri('C:\\Музыка\\日本.mp3'), 'file:///C:/%D0%9C%D1%83%D0%B7%D1%8B%D0%BA%D0%B0/%E6%97%A5%E6%9C%AC.mp3');
  assert.strictEqual(fileUri('\\\\server\\share\\dir\\a b.mp4'), 'file://server/share/dir/a%20b.mp4');
  assert.strictEqual(fileUri('\\\\?\\C:\\long\\x.mp4'), 'file:///C:/long/x.mp4');
  assert.strictEqual(fileUri('\\\\?\\UNC\\server\\share\\x.mp4'), 'file://server/share/x.mp4');
  assert.strictEqual(fileUri('/home/me/My Videos/x#y.mp4'), 'file:///home/me/My%20Videos/x%23y.mp4');
  assert.strictEqual(fileUri('C:\\a\\\uD800.mp4'), 'file:///C:/a/%EF%BF%BD.mp4');
});

test('paths with no proper form are refused, the usual ones are not', () => {
  for (const p of ['C:\\a.mp4', 'c:/a.mp4', '\\\\server\\share\\a.mp4', '\\\\?\\C:\\a.mp4',
    '\\\\?\\UNC\\server\\share\\a.mp4', '/home/me/a.mp4']) {
    assert.strictEqual(exportablePath(p), true, p);
  }
  for (const p of ['', null, undefined, 42, 'a.mp4', 'dir\\a.mp4', 'C:a.mp4', 'C:', '\\\\server',
    '\\\\server\\', '\\\\?\\Volume{0b1c2d3e-0000-0000-0000-000000000000}\\x.mp4',
    '\\\\.\\pipe\\x', '\\\\.\\C:\\x.mp4', '\\\\?\\UNC\\server', '\\\\?\\GLOBALROOT\\Device\\x', '//x/y.mp4']) {
    assert.strictEqual(exportablePath(p), false, String(p));
    assert.throws(() => fileUri(p), TypeError, String(p));
  }
  assert.throws(() => toM3U8({ items: [{ id: 1, filePath: 'C:rel.mp4' }], links: 'full' }), TypeError);
});

test('the writer refuses bad input', () => {
  assert.throws(() => toM3U8({ items: [], links: 'files' }), TypeError);
  assert.throws(() => toM3U8({ items: [], links: 'web', baseUrl: 'http://127.0.0.1:1' }), TypeError);
  assert.throws(() => toM3U8({ items: [], links: 'vault', baseUrl: 'http://127.0.0.1:1/x' }), TypeError);
  assert.throws(() => toM3U8({ items: [{ id: 'x' }], links: 'vault', baseUrl: 'http://127.0.0.1:1' }), TypeError);
  assert.throws(() => toM3U8({ items: [], links: 'relative' }), TypeError, 'relative needs the folder');
});

test('default file name: safe for Windows', () => {
  assert.strictEqual(safeFileName('Best of: 2024/25 <live>?'), 'Best of 2024 25 live');
  assert.strictEqual(safeFileName('  trailing dots... '), 'trailing dots');
  assert.strictEqual(safeFileName('CON'), '_CON');
  assert.strictEqual(safeFileName('nul.backup'), '_nul.backup');
  assert.strictEqual(safeFileName('CONIN$'), '_CONIN$');
  assert.strictEqual(safeFileName('conout$.list'), '_conout$.list');
  assert.strictEqual(safeFileName('CONIN$ and more'), 'CONIN$ and more');
  assert.strictEqual(safeFileName('Line\r\nbreak\ttab'), 'Line break tab');
  assert.strictEqual(safeFileName('***'), 'Playlist');
  assert.strictEqual(safeFileName(''), 'Playlist');
  assert.strictEqual(safeFileName('Café 日本'), 'Café 日本');
  assert.strictEqual(Array.from(safeFileName('x'.repeat(300))).length, 120);
  assert.strictEqual(stripExt('clip.final.mp4'), 'clip.final');
  assert.strictEqual(stripExt('.hidden'), '.hidden');
  assert.strictEqual(stripExt('noext'), 'noext');
});

// ── The routes ─────────────────────────────────────────────────────────────

let srv;
let base;
let port;
const m = [];      // media ids
let coll;          // a collection of m[0..3]
let other;         // a second collection in the folder, overlapping
let folder;
let mixed;         // holds a mix and a document as well
let empty;

const get = (p) => fetch(base + p);
const post = (p, body) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const exp = (id, q) => get(`/api/collections/${id}/export?${q}`);
const save = (id, body) => post(`/api/collections/${id}/export/save`, body);
const locs = (text) => text.split('\r\n').filter((l) => l && !l.startsWith('#'));
const LIB = ['C:\\Lib\\alpha one.mp4', 'C:\\Lib\\beta.mkv', 'C:\\Lib\\gamma #3.mp3', 'C:\\Lib\\delta.jpg'];

test.before(async () => {
  db.init();
  const d = db.get();
  const ins = d.prepare(`INSERT INTO media (filepath, filename, media_type, duration_seconds, filesize_bytes)
    VALUES (?, ?, ?, ?, ?)`);
  const rows = [
    ['C:\\Lib\\alpha one.mp4', 'alpha one.mp4', 'video', 10.4, 1000],
    ['C:\\Lib\\beta.mkv', 'beta.mkv', 'video', null, null],
    ['C:\\Lib\\gamma #3.mp3', 'gamma #3.mp3', 'audio', 200, 3000],
    ['C:\\Lib\\delta.jpg', 'delta.jpg', 'image', null, 400],
    ['C:\\Lib\\eps.mp4', 'eps.mp4', 'video', 5, 50],
  ];
  for (const r of rows) m.push(Number(ins.run(...r).lastInsertRowid));
  const mix = Number(ins.run('mix://abc', 'My mix', 'mix', 30, null).lastInsertRowid);
  const doc = Number(ins.run('C:\\Lib\\notes.pdf', 'notes.pdf', 'document', null, 10).lastInsertRowid);

  folder = db.createCollection('Box: one', { kind: 'folder' }).id;
  coll = db.createCollection('Trip', { parentId: folder }).id;
  other = db.createCollection('More', { parentId: folder }).id;
  mixed = db.createCollection('Mixed').id;
  empty = db.createCollection('Nothing').id;
  db.addToCollection(coll, [m[0], m[1], m[2], m[3]]);
  db.addToCollection(other, [m[2], m[4], m[0]]);
  db.addToCollection(mixed, [m[0], mix, doc, m[1]]);

  await new Promise((resolve) => { srv = server.app.listen(0, '127.0.0.1', resolve); });
  port = srv.address().port;
  base = `http://127.0.0.1:${port}`;
});
test.after(async () => {
  server._setSaveDialogForTest(null);
  await new Promise((resolve) => srv.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/** A fake window that "chooses" `out` (what the real script prints). */
function fakeDialog(out, seen = {}) {
  return (res, env, onClose) => {
    seen.env = env;
    seen.opened = (seen.opened || 0) + 1;
    onClose({ code: 0, out, errOut: '', finish: (status, body) => res.status(status).json(body) });
  };
}

const onWindows = process.platform === 'win32' ? false : 'the save path checks are for Windows paths';

test('GET export: Vault links at the port the server listens on', async () => {
  const res = await exp(coll, 'links=vault');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^audio\/x-mpegurl; charset=utf-8/);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  assert.strictEqual(res.headers.get('x-vault-count'), '4');
  assert.strictEqual(await res.text(), [
    '#EXTM3U',
    '#PLAYLIST:Trip',
    '#EXTINF:10,alpha one',
    `http://127.0.0.1:${port}/media/${m[0]}`,
    '#EXTINF:-1,beta',
    `http://127.0.0.1:${port}/media/${m[1]}`,
    '#EXTINF:200,gamma #3',
    `http://127.0.0.1:${port}/media/${m[2]}`,
    '#EXTINF:-1,delta',
    `http://127.0.0.1:${port}/media/${m[3]}`,
    '',
  ].join('\r\n'));
});

test('GET export: the Host header does not change the Vault links', async () => {
  const http = require('node:http');
  const get = (host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/api/collections/${coll}/export?links=vault`,
      headers: { Host: host } }, (r) => {
      let s = ''; r.setEncoding('utf8'); r.on('data', (c) => { s += c; });
      r.on('end', () => resolve({ status: r.statusCode, text: s }));
    }).on('error', reject);
  });
  // A Host Vault does not answer to is refused before the route (lib/host-check.js)
  const evil = await get('evil.example:80');
  assert.strictEqual(evil.status, 403);
  assert.ok(!evil.text.includes('evil'));
  // One it does answer to still never shows up in the links
  const local = await get(`localhost:${port}`);
  assert.strictEqual(local.status, 200);
  assert.ok(!local.text.includes('localhost'));
  assert.ok(local.text.includes(`http://127.0.0.1:${port}/media/${m[0]}`));
});

test('GET export: full paths', async () => {
  const res = await exp(coll, 'links=full');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(locs(await res.text()), LIB);
});

test('GET export: relative links need the save route (400 RELATIVE_NEEDS_SAVE)', async () => {
  const res = await exp(coll, 'links=relative');
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).code, 'RELATIVE_NEEDS_SAVE');
});

test('GET export follows the saved playlist order, not the order files were added', async () => {
  db.reorderCollection(coll, { move: [m[3]], before: m[0] });     // delta to the top
  db.reorderCollection(coll, { move: [m[1]], before: null });     // beta to the end
  const res = await exp(coll, 'links=vault');
  assert.deepStrictEqual(locs(await res.text()),
    [m[3], m[0], m[2], m[1]].map((id) => `http://127.0.0.1:${port}/media/${id}`));
  db.reorderCollection(coll, { order: [m[0], m[1], m[2], m[3]] });
});

test('GET export of a folder: the deduped list Play All plays, in tree order', async () => {
  const res = await exp(folder, 'links=full');
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  // Trip (alpha, beta, gamma, delta) then More (gamma, eps, alpha): eps is the only new one.
  assert.deepStrictEqual(locs(text), [...LIB, 'C:\\Lib\\eps.mp4']);
  assert.deepStrictEqual(db.getCollectionItems(folder), [m[0], m[1], m[2], m[3], m[4]]);
  assert.ok(text.includes('#PLAYLIST:Box: one'));
});

test('GET export leaves out mixes and documents, and an empty collection is a valid playlist', async () => {
  let res = await exp(mixed, 'links=full');
  assert.strictEqual(res.headers.get('x-vault-count'), '2');
  assert.strictEqual(res.headers.get('x-vault-skipped'), '2');
  assert.deepStrictEqual(locs(await res.text()), ['C:\\Lib\\alpha one.mp4', 'C:\\Lib\\beta.mkv']);
  res = await exp(empty, 'links=vault');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), '#EXTM3U\r\n#PLAYLIST:Nothing\r\n');
});

test('files with no path, or a path with no proper form, are left out and counted', async () => {
  const ins = db.get().prepare('INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, ?)');
  const noPath = Number(ins.run('', 'gone.mp4', 'video').lastInsertRowid);
  const vol = Number(ins.run('\\\\?\\Volume{0b1c2d3e-0000-0000-0000-000000000000}\\v.mp4', 'v.mp4', 'video').lastInsertRowid);
  const rel = Number(ins.run('C:rel.mp4', 'rel.mp4', 'video').lastInsertRowid);
  const pipe = Number(ins.run('\\\\.\\pipe\\p.mp4', 'p.mp4', 'video').lastInsertRowid);
  const odd = db.createCollection('Odd paths').id;
  db.addToCollection(odd, [m[0], noPath, vol, rel, pipe, m[4]]);
  try {
    let res = await exp(odd, 'links=full');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-vault-count'), '2');
    assert.strictEqual(res.headers.get('x-vault-skipped'), '4');
    const text = await res.text();
    for (const bad of ['Volume', 'rel.mp4', 'pipe', 'gone']) assert.ok(!text.includes(bad), bad);
    if (process.platform === 'win32') {
      for (const links of ['full', 'relative']) {
        const chosen = path.join(tmp, `odd-${links}.m3u8`);
        server._setSaveDialogForTest(fakeDialog(chosen));
        try {
          const j = await (await save(odd, { links })).json();
          assert.strictEqual(j.count, 2, links);
          assert.strictEqual(j.skipped, 4, links);
          assert.ok(!fs.readFileSync(chosen, 'utf8').includes('Volume'), links);
        } finally {
          server._setSaveDialogForTest(null);
        }
      }
    }
    // Vault links only need the id: just the row with no path at all is left out.
    res = await exp(odd, 'links=vault');
    assert.strictEqual(res.headers.get('x-vault-skipped'), '1');
    assert.deepStrictEqual(locs(await res.text()),
      [m[0], vol, rel, pipe, m[4]].map((id) => `http://127.0.0.1:${port}/media/${id}`));
  } finally {
    db.deleteCollection(odd);
    db.get().prepare(`DELETE FROM media WHERE id IN (${[noPath, vol, rel, pipe].join(',')})`).run();
  }
});

test('an unexpected error is a plain JSON 500 on both routes, with no stack trace', async () => {
  const real = playlistExport.buildExport;
  playlistExport.buildExport = () => { throw new TypeError('boom at C:\\secret\\source.js'); };
  server._setSaveDialogForTest(fakeDialog(path.join(tmp, 'never.m3u8')));
  try {
    for (const res of [await exp(coll, 'links=full'), await save(coll, { links: 'full' })]) {
      assert.strictEqual(res.status, 500);
      assert.match(res.headers.get('content-type'), /^application\/json/);
      const body = await res.text();
      assert.ok(!/boom|secret|at |\.js/.test(body), body);
      assert.ok(JSON.parse(body).error);
    }
    assert.ok(!fs.existsSync(path.join(tmp, 'never.m3u8')));
    // The dialog itself failing to start (it throws) is a JSON 500 too.
    playlistExport.buildExport = real;
    server._setSaveDialogForTest(() => { throw new Error('EPERM C:\\Temp\\vault-pick.ps1'); });
    const res = await save(coll, { links: 'vault' });
    assert.strictEqual(res.status, 500);
    assert.ok(!/EPERM|Temp/.test(await res.text()));
  } finally {
    playlistExport.buildExport = real;
    server._setSaveDialogForTest(null);
  }
});

test('GET export: strict parameters (400 with a code), unknown collection 404', async () => {
  for (const q of ['', 'links=files', 'links=Full', 'links=web', 'links=full&links=vault', 'links=__proto__', 'links=toString']) {
    const res = await exp(coll, q);
    assert.strictEqual(res.status, 400, q);
    assert.strictEqual((await res.json()).code, 'BAD_LINKS', q);
  }
  let res = await exp(999999, 'links=vault');
  assert.strictEqual(res.status, 404);
  assert.strictEqual((await res.json()).code, 'NOT_FOUND');
  res = await exp('abc', 'links=vault');
  assert.strictEqual(res.status, 400);
});

test('an encrypted library refuses full and relative links on both routes, and still exports Vault links', async () => {
  let dialogOpened = false;
  server._setSaveDialogForTest(() => { dialogOpened = true; });
  const real = vault.isEncrypted;
  vault.isEncrypted = () => true;
  try {
    let res = await exp(coll, 'links=full');
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).code, 'FILES_ENCRYPTED');
    for (const links of ['full', 'relative']) {
      res = await save(coll, { links });
      assert.strictEqual(res.status, 403, links);
      assert.strictEqual((await res.json()).code, 'FILES_ENCRYPTED', links);
    }
    assert.strictEqual(dialogOpened, false, 'the save window never opened');
    res = await exp(coll, 'links=vault');
    assert.strictEqual(res.status, 200);
    assert.ok(!(await res.text()).includes('C:\\Lib'));
  } finally {
    vault.isEncrypted = real;
    server._setSaveDialogForTest(null);
  }
});

// The same refusal on a really encrypted library (vault.setPassword, the
// header check in vault.isEncrypted), in a child process so this file's
// library stays plain. Every path the child touches is in its own temp dir.
let Cipher = null;
try { Cipher = require('better-sqlite3-multiple-ciphers'); } catch { /* skipped below */ }
test('a really encrypted library refuses file paths (child process)', {
  skip: Cipher ? false : 'better-sqlite3-multiple-ciphers is not installed',
}, async () => {
  const cp = require('node:child_process');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-pl-enc-'));
  const env = { ...process.env, VAULT_OFFLINE: '1',
    VAULT_DB: path.join(work, 'library.db'), VAULT_SETTINGS_FILE: path.join(work, 'settings.json'),
    VAULT_THUMBS: path.join(work, 'thumbs'), VAULT_SECURE_ASSETS: path.join(work, 'secure.db'),
    VAULT_TRASH: path.join(work, 'trash'), VAULT_SUBS: path.join(work, 'subs') };
  for (const k of ['VAULT_DB_PASSWORD', 'VIDEO_TAGGER_DB_PASSWORD', 'MEDIA_TAGGER_DB_PASSWORD']) delete env[k];
  const code = `(async () => {
    const out = {};
    const db = require('./lib/database'); const vault = require('./lib/vault');
    const { app, _setSaveDialogForTest } = require('./server/index');
    db.init();
    const id = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type) VALUES ('C:\\\\\\\\x\\\\\\\\a.mp4', 'a.mp4', 'video')").run().lastInsertRowid);
    const c = db.createCollection('E').id; db.addToCollection(c, [id]);
    out.before = vault.isEncrypted();
    await vault.setPassword('pl-export-test-pass');
    out.after = vault.isEncrypted();
    let opened = false;
    _setSaveDialogForTest(() => { opened = true; });
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const b = 'http://127.0.0.1:' + srv.address().port;
    const g = await fetch(b + '/api/collections/' + c + '/export?links=full');
    out.getFull = [g.status, (await g.json()).code];
    out.save = [];
    for (const links of ['full', 'relative']) {
      const p = await fetch(b + '/api/collections/' + c + '/export/save', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ links }) });
      out.save.push([p.status, (await p.json()).code]);
    }
    out.opened = opened;
    const v = await fetch(b + '/api/collections/' + c + '/export?links=vault');
    out.getVault = [v.status, (await v.text()).includes('/media/' + id)];
    await new Promise((r) => srv.close(r));
    await vault.lock({ force: true });
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  })().catch((e) => { console.log('@@' + JSON.stringify({ error: e.message })); process.exit(1); });`;
  try {
    // Async on purpose: a spawnSync blocks this process's event loop for the
    // whole child run, and the in-process server then drops its idle
    // keep-alive socket just as the next test reuses it (ECONNRESET).
    const r = await new Promise((resolve) => {
      cp.execFile(process.execPath, ['-e', code], {
        cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
      }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr }));
    });
    const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('@@'));
    assert.ok(line, `child produced no result (exit ${r.status}): ${r.stderr}`);
    assert.deepStrictEqual(JSON.parse(line.slice(2)), {
      before: false, after: true,
      getFull: [403, 'FILES_ENCRYPTED'],
      save: [[403, 'FILES_ENCRYPTED'], [403, 'FILES_ENCRYPTED']],
      opened: false,
      getVault: [200, true],
    });
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
});

test('both routes are 423 while the vault is locked', async () => {
  vault.bootLocked();
  try {
    assert.strictEqual((await exp(coll, 'links=vault')).status, 423);
    assert.strictEqual((await save(coll, { links: 'vault' })).status, 423);
  } finally {
    vault._locked = false;
  }
});

// ── The save route, with the Save As window faked ──────────────────────────

test('save: full paths, written where the window said and nowhere the request says', { skip: onWindows }, async () => {
  const chosen = path.join(tmp, 'out', 'Chosen name.m3u8');
  fs.mkdirSync(path.dirname(chosen), { recursive: true });
  const decoy = path.join(tmp, 'decoy.m3u8');
  const seen = {};
  server._setSaveDialogForTest(fakeDialog(chosen, seen));
  try {
    const res = await save(coll, {
      links: 'full',
      path: decoy, filePath: decoy, target: decoy, fileName: decoy, name: decoy, dir: tmp, playlistDir: tmp,
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { path: chosen, count: 4, skipped: 0, fullPathCount: 0 });
    assert.ok(!fs.existsSync(decoy), 'nothing at the path the request named');
    // The window was offered the collection's own name, and nothing from the body.
    assert.deepStrictEqual(seen.env, { VAULT_SAVE_NAME: 'Trip.m3u8' });
    const written = fs.readFileSync(chosen);
    assert.notStrictEqual(written[0], 0xef, 'no BOM');
    assert.strictEqual(written.toString('utf8'), await (await exp(coll, 'links=full')).text());
  } finally {
    server._setSaveDialogForTest(null);
  }
});

test('save: relative paths from the folder the window chose; other drives get a full path', { skip: onWindows }, async () => {
  // Files near the playlist (they need not exist), plus one on another drive.
  const lists = path.join(tmp, 'Lists', 'Mine');
  fs.mkdirSync(lists, { recursive: true });
  const near = [path.join(tmp, 'Media', 'a b.mp4'), path.join(tmp, 'Lists', 'Mine', 'Sub', 'c.mp4'), path.join(tmp, 'Lists', 'Mine', 'd.mp4')];
  const drive = path.parse(tmp).root[0].toUpperCase();
  const otherDrive = `${drive === 'Q' ? 'R' : 'Q'}:\\Elsewhere\\far.mp4`;
  const ins = db.get().prepare('INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, ?)');
  const ids = [...near, otherDrive].map((p) => Number(ins.run(p, path.win32.basename(p), 'video').lastInsertRowid));
  const rc = db.createCollection('Relative').id;
  db.addToCollection(rc, ids);
  // The window's answer in another letter case still counts as the same folder.
  const chosen = path.join(lists, 'mix.m3u8');
  server._setSaveDialogForTest(fakeDialog(chosen.toUpperCase().replace(/\.M3U8$/, '.m3u8')));
  try {
    const res = await save(rc, { links: 'relative' });
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.count, 4);
    assert.strictEqual(j.fullPathCount, 1);
    assert.deepStrictEqual(locs(fs.readFileSync(chosen, 'utf8')),
      ['..\\..\\Media\\a b.mp4', 'Sub\\c.mp4', 'd.mp4', otherDrive]);
  } finally {
    server._setSaveDialogForTest(null);
    db.deleteCollection(rc);
    db.get().prepare(`DELETE FROM media WHERE id IN (${ids.join(',')})`).run();
  }
});

test('save: Vault links for a folder, and overwriting a file the window confirmed', { skip: onWindows }, async () => {
  const chosen = path.join(tmp, 'out', 'box.M3U8');
  fs.writeFileSync(chosen, 'old');
  const seen = {};
  server._setSaveDialogForTest(fakeDialog(`${chosen}\r\n`, seen));
  try {
    const res = await save(folder, { links: 'vault' });
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.count, 5);
    assert.strictEqual(j.fullPathCount, 0);
    assert.strictEqual(seen.env.VAULT_SAVE_NAME, 'Box one.m3u8');
    const text = fs.readFileSync(chosen, 'utf8');
    assert.ok(text.startsWith('#EXTM3U\r\n#PLAYLIST:Box: one\r\n'));
    assert.ok(text.includes(`\r\nhttp://127.0.0.1:${port}/media/${m[4]}\r\n`));
  } finally {
    server._setSaveDialogForTest(null);
  }
});

test('save: cancel writes nothing; a broken or odd answer from the window is refused', async () => {
  server._setSaveDialogForTest(fakeDialog('::CANCEL::'));
  try {
    let res = await save(coll, { links: 'vault' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { canceled: true });

    const bad = [
      '',                                         // the shim broke
      'relative\\x.m3u8',                         // not absolute
      '/tmp/x.m3u8',                              // not a Windows path
      path.join(tmp, 'wrong.txt'),                // wrong extension
      path.join(tmp, 'x.xspf'),                   // not M3U8
      `${path.join(tmp, 'a.m3u8')}\n${path.join(tmp, 'b.m3u8')}`,   // two lines
    ];
    for (const out of bad) {
      server._setSaveDialogForTest(fakeDialog(out));
      res = await save(coll, { links: 'relative' });
      assert.strictEqual(res.status, 500, JSON.stringify(out));
    }
    assert.ok(!fs.existsSync(path.join(tmp, 'wrong.txt')));
    assert.ok(!fs.existsSync(path.join(tmp, 'x.xspf')));
    assert.ok(!fs.existsSync(path.join(tmp, 'a.m3u8')));
  } finally {
    server._setSaveDialogForTest(null);
  }
});

test('save: strict parameters, unknown collection, before any window opens', async () => {
  const seen = {};
  server._setSaveDialogForTest(fakeDialog('::CANCEL::', seen));
  try {
    for (const body of [{ links: 'files' }, { links: ['full'] }, { links: 'http' }, { links: 'Relative' }, {}, { format: 'm3u8' }]) {
      const res = await save(coll, body);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
      assert.strictEqual((await res.json()).code, 'BAD_LINKS', JSON.stringify(body));
    }
    const res = await save(999999, { links: 'vault' });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(seen.opened, undefined, 'no window for a bad request');
  } finally {
    server._setSaveDialogForTest(null);
  }
});

test('save: the library locked or encrypted while the window was open writes nothing', { skip: onWindows }, async () => {
  const chosen = path.join(tmp, 'out', 'late.m3u8');
  const real = vault.isEncrypted;
  try {
    for (const links of ['full', 'relative']) {
      // Encrypted while the window was open: path links are refused at write time.
      server._setSaveDialogForTest((res, env, onClose) => {
        vault.isEncrypted = () => true;
        onClose({ code: 0, out: chosen, errOut: '', finish: (s, b) => res.status(s).json(b) });
      });
      const res = await save(coll, { links });
      assert.strictEqual(res.status, 403, links);
      assert.ok(!fs.existsSync(chosen), links);
      vault.isEncrypted = real;
    }

    // Locked while the window was open.
    server._setSaveDialogForTest((r, env, onClose) => {
      vault._locked = true;
      onClose({ code: 0, out: chosen, errOut: '', finish: (s, b) => r.status(s).json(b) });
    });
    const res = await save(coll, { links: 'vault' });
    assert.strictEqual(res.status, 423);
    assert.ok(!fs.existsSync(chosen));
  } finally {
    vault.isEncrypted = real;
    vault._locked = false;
    server._setSaveDialogForTest(null);
  }
});

test('the request guards cover the playlist routes: the app passes, another site does not', async () => {
  const seen = {};
  server._setSaveDialogForTest(fakeDialog('::CANCEL::', seen));
  // The CSRF guard allows the configured port's origin (this test server
  // listens on a random one); a different port is still refused below.
  const ownPort = require('../config').server.port;
  const own = `http://127.0.0.1:${ownPort}`;
  const send = (p, method, headers, body) => fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    // Vault's own page: Origin is this server, Sec-Fetch-Site same-origin
    const app = { Origin: own, 'Sec-Fetch-Site': 'same-origin' };
    let res = await send(`/api/collections/${coll}/export/save`, 'POST', app, { links: 'vault' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { canceled: true });
    assert.strictEqual(seen.opened, 1);
    res = await send(`/api/collections/${coll}/order`, 'POST', app, { move: [m[1]], before: null });
    assert.strictEqual(res.status, 200);
    const moved = (await res.json()).order;
    assert.strictEqual(moved[moved.length - 1], m[1]);
    res = await send(`/api/collections/${coll}/export?links=vault`, 'GET', { 'Sec-Fetch-Site': 'same-origin' });
    assert.strictEqual(res.status, 200);
    // Put the order back for the tests that read it
    res = await send(`/api/collections/${coll}/order`, 'POST', app, { order: [m[0], m[1], m[2], m[3]] });
    assert.strictEqual(res.status, 200);

    // Another site's page: refused before the route, and no window opens
    for (const h of [
      { Origin: 'https://evil.example' },
      { Origin: 'null' },
      { Origin: `http://127.0.0.1:${ownPort + 1}` },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
    ]) {
      res = await send(`/api/collections/${coll}/export/save`, 'POST', h, { links: 'vault' });
      assert.strictEqual(res.status, 403, JSON.stringify(h));
      res = await send(`/api/collections/${coll}/order`, 'POST', h, { move: [m[0]], before: null });
      assert.strictEqual(res.status, 403, JSON.stringify(h));
    }
    res = await send(`/api/collections/${coll}/export?links=vault`, 'GET', { 'Sec-Fetch-Site': 'cross-site' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).code, 'CROSS_SITE');
    assert.strictEqual(seen.opened, 1, 'no window for a refused request');
  } finally {
    server._setSaveDialogForTest(null);
  }
  // The order no refused request could change
  const after = await exp(coll, 'links=vault');
  assert.deepStrictEqual(locs(await after.text()).map((u) => Number(u.split('/').pop())), [m[0], m[1], m[2], m[3]]);
});

// ── The dialog's toast (player-lib/collection-export.js, run in a VM) ──────

test('the toast after a save says what was left out and what uses a full path', () => {
  const vm = require('node:vm');
  const ctx = { localStorage: { getItem: () => null, setItem: () => {} }, fetch: async () => ({ ok: false }), document: {} };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'collection-export.js'), 'utf8');
  vm.runInContext(`${src}\n;globalThis.__t = collExportSavedText;`, ctx);
  const t = ctx.__t;
  assert.strictEqual(t({ path: 'D:\\L\\a.m3u8', skipped: 0, fullPathCount: 0 }), 'Saved playlist to D:\\L\\a.m3u8.');
  assert.strictEqual(t({ path: 'D:\\a.m3u8', skipped: 1 }), 'Saved playlist to D:\\a.m3u8. 1 file left out.');
  assert.strictEqual(t({ path: 'D:\\a.m3u8', skipped: 2, fullPathCount: 1 }),
    'Saved playlist to D:\\a.m3u8. 2 files left out. 1 file uses a full path instead.');
  assert.strictEqual(t({ path: 'D:\\a.m3u8', fullPathCount: 3 }),
    'Saved playlist to D:\\a.m3u8. 3 files use a full path instead.');
  assert.ok(!/\u2014/.test(src), 'no em dashes in the dialog');
});
