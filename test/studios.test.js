/**
 * Studios + person details (STUDIOS_SPEC sections 1 and 2) over HTTP against
 * the real Express app. People and faces are written straight into the
 * tables (the sorting job is not needed to have people in files); covers use
 * the real ffmpeg when it is there.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-studios-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_SECURE_ASSETS = path.join(tmp, 'secure_assets.db');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const faces = require('../lib/faces/service');
const secureAssets = require('../lib/secure-assets');
const studios = require('../lib/studios');
const vault = require('../lib/vault');
const { encodeJpeg } = require('../lib/faces/jpeg');
const locate = require('../lib/ffmpeg-locate');
const { app } = require('../server/index');
const { createFakes } = require('./helpers/faces-fakes');

const noFfmpeg = spawnSync(locate.resolve('ffmpeg'), ['-version'], { windowsHide: true }).status !== 0 && 'ffmpeg not available';

const fk = createFakes();
const svc = faces.setInstance(faces.createService({
  modelStore: fk.modelStore, engineFactory: fk.engineFactory, analyze: fk.analyze, frames: fk.frames, tmpDir: tmp,
}));

let server, base;
const MODEL = 'stub-v1';

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
async function call(method, p, body) {
  const r = await fetch(base + p, method === 'GET' ? {} : json(method, body));
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}
const get = (p) => call('GET', p);
const post = (p, body) => call('POST', p, body);
const setFaces = (on) => post('/api/faces/settings', { enabled: on });

const sql = () => db.get();
let seq = 0;
/** A media row (and a real file) at media/<rel>. */
function addFile(rel, type = 'video', { trashed = 0, studio = null, content = null } = {}) {
  const fp = path.join(tmp, 'media', ...rel.split('/'));
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content || `file ${++seq}`);
  return Number(sql().prepare(`INSERT INTO media (filepath, filename, media_type, user_trashed, studio_id, faces_model, faces_indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(fp, path.basename(fp), type, trashed, studio, MODEL, new Date().toISOString()).lastInsertRowid);
}
function addPerson(name, { hidden = 0, aliases = null } = {}) {
  const t = new Date().toISOString();
  return Number(sql().prepare('INSERT INTO face_people (name, name_key, hidden, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, name == null ? null : name.toLowerCase(), hidden, aliases, t, t).lastInsertRowid);
}
function addFace(mediaId, personId, { hidden = 0 } = {}) {
  return Number(sql().prepare(`INSERT INTO face_groups (media_id, appearances, best_bbox, det_score, model, hidden, cluster_id, created_at)
    VALUES (?, 1, '[0,0,0.1,0.1]', 0.99, ?, ?, ?, ?)`).run(mediaId, MODEL, hidden, personId, new Date().toISOString()).lastInsertRowid);
}
async function mkStudio(name, fields = {}) {
  const r = await post('/api/studios', { name, ...fields });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
function jpegOf(w, h, rgb = [200, 40, 40]) {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) data.set(rgb, i * 3);
  return encodeJpeg({ width: w, height: h, data }, 85);
}
async function upload(id, buf, type = 'image/jpeg') {
  const r = await fetch(`${base}/api/studios/${id}/cover`, { method: 'POST', headers: { 'Content-Type': type }, body: buf });
  return { status: r.status, body: await r.json() };
}

test.before(async () => {
  db.init();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  await setFaces(true);
});

test.after(async () => {
  svc.cancel();
  await svc.settled();
  await new Promise((resolve) => server.close(resolve));
  try { secureAssets.close(); } catch {}
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('create, get, list shapes; NAME_TAKEN; name and field validation', async () => {
  const s = await mkStudio('  Acme   Films ', { aliases: 'ACME, Acme Pictures, acme pictures', urls: 'https://acme.example\n\nhttp://acme.test/x',
    description: 'About', notes: 'Private', yearStart: 2009, yearEnd: 2017, favorite: true });
  assert.strictEqual(s.name, 'Acme Films');
  assert.strictEqual(s.aliases, 'ACME, Acme Pictures');
  assert.strictEqual(s.urls, 'https://acme.example\nhttp://acme.test/x');
  assert.deepStrictEqual([s.yearStart, s.yearEnd, s.favorite, s.files, s.people, s.peopleCount, s.coverUrl, s.coverKind],
    [2009, 2017, true, 0, [], 0, null, null], 'writes answer with the full studio');
  const full = await get(`/api/studios/${s.id}`);
  assert.strictEqual(full.status, 200);
  assert.deepStrictEqual(Object.keys(full.body).sort(), ['aliases', 'coverKind', 'coverRef', 'coverUrl', 'createdAt', 'description', 'favorite',
    'files', 'id', 'name', 'notes', 'people', 'peopleCount', 'peoplePreview', 'photos', 'updatedAt', 'urls', 'videos', 'yearEnd', 'yearStart'].sort());
  assert.deepStrictEqual(full.body.people, []);
  const l = await get('/api/studios');
  assert.deepStrictEqual(Object.keys(l.body).sort(), ['counts', 'studios', 'total']);
  assert.deepStrictEqual(Object.keys(l.body.studios[0]).sort(), ['coverKind', 'coverUrl', 'favorite', 'files', 'id', 'name', 'people',
    'peoplePreview', 'photos', 'videos', 'yearEnd', 'yearStart'].sort());

  let r = await post('/api/studios', { name: 'acme films' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'NAME_TAKEN');
  assert.strictEqual(r.body.otherId, s.id);
  for (const [body, code] of [
    [{}, 'BAD_NAME'], [{ name: '   ' }, 'BAD_NAME'], [{ name: 'x'.repeat(201) }, 'BAD_NAME'], [{ name: 5 }, 'BAD_NAME'],
    [{ name: 'Y1', yearStart: 1799 }, 'BAD_YEARS'], [{ name: 'Y2', yearStart: 2101 }, 'BAD_YEARS'], [{ name: 'Y3', yearStart: 2000.5 }, 'BAD_YEARS'],
    [{ name: 'Y4', yearStart: 2010, yearEnd: 2009 }, 'BAD_YEARS'], [{ name: 'Y5', yearEnd: 2009 }, 'BAD_YEARS'],
    [{ name: 'U1', urls: 'javascript:alert(1)' }, 'BAD_URL'], [{ name: 'U2', urls: 'acme.example' }, 'BAD_URL'],
    [{ name: 'T1', notes: 'x'.repeat(5001) }, 'TOO_LONG'], [{ name: 'T2', description: 7 }, 'BAD_REQUEST'],
    [{ name: 'F1', favorite: 'yes' }, 'BAD_REQUEST'], [{ name: 'A1', aliases: 'a'.repeat(201) }, 'TOO_LONG'],
  ]) {
    r = await post('/api/studios', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.strictEqual(r.body.code, code, JSON.stringify(body));
  }
  assert.strictEqual((await post('/api/studios', { name: 'T3', notes: 'x'.repeat(5000) })).status, 200);
  assert.strictEqual((await get('/api/studios/999999')).status, 404);
  assert.strictEqual((await get('/api/studios/abc')).body.code, 'BAD_ID');

  // Update: rename (own name in another case is fine), clear fields, years checked against the stored ones.
  r = await post(`/api/studios/${s.id}`, { name: 'ACME FILMS', description: '', urls: null });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.name, r.body.description, r.body.urls, r.body.notes], ['ACME FILMS', null, null, 'Private']);
  r = await post(`/api/studios/${s.id}`, { yearStart: 2018 });
  assert.strictEqual(r.body.code, 'BAD_YEARS', 'start after the stored end');
  r = await post(`/api/studios/${s.id}`, { yearEnd: null });
  assert.deepStrictEqual([r.body.yearStart, r.body.yearEnd], [2009, null]);
  r = await post(`/api/studios/${s.id}`, { name: 'T3' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'NAME_TAKEN');
});

test('assign files, counts (trash and documents left out), file info, files by kind, studioId library filter', async () => {
  const s = await mkStudio('Counting Co');
  const v1 = addFile('count/v1.mp4', 'video');
  const v2 = addFile('count/v2.mp4', 'video');
  const p1 = addFile('count/p1.jpg', 'image');
  const g1 = addFile('count/g1.gif', 'gif');
  const tr = addFile('count/trashed.mp4', 'video', { trashed: 1 });
  const doc = addFile('count/doc.pdf', 'document');
  let r = await post('/api/media/studio', { ids: [v1, v2, p1, g1, tr, doc, v1], studioId: s.id });
  assert.deepStrictEqual(r.body, { changed: 6 });
  r = await post('/api/media/studio', { ids: [v1], studioId: s.id });
  assert.deepStrictEqual(r.body, { changed: 0 }, 'already there');
  r = await get(`/api/studios/${s.id}`);
  assert.deepStrictEqual([r.body.files, r.body.videos, r.body.photos], [4, 2, 2]);
  assert.strictEqual(r.body.coverUrl, `/thumb/${v1}`, 'automatic cover: the first file');
  assert.deepStrictEqual((await get(`/api/studios/${s.id}/files`)).body.ids.sort((a, b) => a - b), [v1, v2, p1, g1].sort((a, b) => a - b));
  assert.deepStrictEqual((await get(`/api/studios/${s.id}/files?kind=video`)).body.ids.sort(), [v1, v2].sort());
  assert.deepStrictEqual((await get(`/api/studios/${s.id}/files?kind=photo`)).body.ids.sort(), [p1, g1].sort());
  assert.strictEqual((await get(`/api/studios/${s.id}/files?kind=audio`)).body.code, 'BAD_KIND');
  const info = await get(`/api/media/${v1}`);
  assert.deepStrictEqual(info.body.studio, { id: s.id, name: 'Counting Co' });
  assert.strictEqual(info.body.studio_id, s.id);
  assert.strictEqual((await get(`/api/media/${addFile('count/loose.mp4')}`)).body.studio, null);

  // The library grid through the normal query.
  const q = async (spec) => (await post('/api/library/query', spec)).body;
  let res = await q({ studioId: s.id, sort: { field: 'name', dir: 'asc' } });
  assert.deepStrictEqual(res.page.ids.sort(), [v1, v2, p1, g1].sort());
  r = await post('/api/media/studio', { ids: [v2], studioId: null });
  assert.deepStrictEqual(r.body, { changed: 1 });
  res = await q({ studioId: s.id, sort: { field: 'name', dir: 'asc' } });
  assert.deepStrictEqual(res.page.ids.sort(), [v1, p1, g1].sort(), 'a cached set is never reused after a file leaves');
  res = await q({ studioId: s.id, filters: { mediaTypes: ['video'] } });
  assert.deepStrictEqual(res.page.ids, [v1], 'other filters still apply');
  assert.strictEqual((await post('/api/library/query', { studioId: 'x' })).status, 400);

  // Validation.
  for (const body of [{ ids: [], studioId: s.id }, { ids: [0], studioId: s.id }, { ids: 'x', studioId: s.id },
    { ids: Array.from({ length: 5001 }, (_, i) => i + 1), studioId: s.id }]) {
    r = await post('/api/media/studio', body);
    assert.strictEqual(r.body.code, 'BAD_IDS');
  }
  assert.strictEqual((await post('/api/media/studio', { ids: [v1], studioId: 'a' })).status, 400);
  assert.strictEqual((await post('/api/media/studio', { ids: [v1], studioId: 999999 })).status, 404);
});

test('people: explicit members with years UNION people seen in the files (no trash, no hidden faces or people)', async () => {
  const s = await mkStudio('People Place');
  const f1 = addFile('ppl/f1.mp4', 'video', { studio: s.id });
  const f2 = addFile('ppl/f2.jpg', 'image', { studio: s.id });
  const ft = addFile('ppl/trashed.jpg', 'image', { studio: s.id, trashed: 1 });
  const other = addFile('ppl/other.jpg', 'image');
  const alice = addPerson('Alice'), bob = addPerson('Bob'), cara = addPerson('Cara'), dan = addPerson('Dan');
  const hiddenP = addPerson('Hidden Hal', { hidden: 1 }), eve = addPerson('Eve');
  addFace(f1, alice); addFace(f2, alice);
  addFace(f1, bob);
  addFace(ft, cara);                 // only in a trashed file
  addFace(f2, dan, { hidden: 1 });   // only a hidden face
  addFace(f1, hiddenP);              // a person the user hid
  addFace(other, eve);               // not in the studio's files

  let r = await post(`/api/studios/${s.id}/people`, { personId: eve, yearStart: 2015, yearEnd: 2018 });
  assert.strictEqual(r.status, 200);
  r = await post(`/api/studios/${s.id}/people`, { personId: bob, yearStart: 2020 });
  const ppl = r.body.people;
  assert.deepStrictEqual(ppl.map(p => [p.name, p.explicit, p.yearStart, p.yearEnd, p.files]), [
    ['Eve', true, 2015, 2018, 0], ['Bob', true, 2020, null, 1], ['Alice', false, null, null, 2],
  ]);
  assert.deepStrictEqual(Object.keys(ppl[0]).sort(), ['cropUrl', 'explicit', 'files', 'id', 'name', 'yearEnd', 'yearStart']);
  assert.strictEqual(r.body.peopleCount, 3);

  // Update years: omitted keeps, null clears, bad ones refused.
  r = await post(`/api/studios/${s.id}/people`, { personId: eve, yearEnd: null });
  assert.deepStrictEqual([r.body.people[0].yearStart, r.body.people[0].yearEnd], [2015, null]);
  r = await post(`/api/studios/${s.id}/people`, { personId: eve, yearEnd: 2000 });
  assert.strictEqual(r.body.code, 'BAD_YEARS');
  r = await post(`/api/studios/${s.id}/people`, { personId: 999999 });
  assert.strictEqual(r.status, 404);
  r = await post(`/api/studios/${s.id}/people`, { personId: 'x' });
  assert.strictEqual(r.status, 400);

  // The list item: count and a preview of up to five.
  const extra = [];
  for (let i = 0; i < 4; i++) { const p = addPerson(`Extra ${i}`); extra.push(p); addFace(f2, p); }
  const item = (await get('/api/studios?q=people place')).body.studios[0];
  assert.strictEqual(item.people, 7);
  assert.strictEqual(item.peoplePreview.length, 5);
  assert.deepStrictEqual(Object.keys(item.peoplePreview[0]).sort(), ['cropUrl', 'id', 'name']);
  assert.deepStrictEqual(item.peoplePreview.slice(0, 3).map(p => p.name), ['Eve', 'Bob', 'Alice']);

  // Remove: Bob is no longer explicit but is still seen in a file.
  r = await post(`/api/studios/${s.id}/people/${bob}/remove`);
  assert.deepStrictEqual(r.body.people.find(p => p.id === bob), { id: bob, name: 'Bob', cropUrl: null, yearStart: null, yearEnd: null, explicit: false, files: 1 });
  r = await post(`/api/studios/${s.id}/people/${eve}/remove`);
  assert.ok(!r.body.people.some(p => p.id === eve));

  // The person page lists studios.
  await post(`/api/studios/${s.id}/people`, { personId: eve, yearStart: 2016 });
  const pe = (await get(`/api/faces/people/${eve}`)).body;
  assert.deepStrictEqual(pe.studios.map(x => [x.name, x.explicit, x.yearStart]), [['People Place', true, 2016]]);
  assert.deepStrictEqual(Object.keys(pe.studios[0]).sort(), ['coverUrl', 'explicit', 'files', 'id', 'name', 'yearEnd', 'yearStart']);
  const pa = (await get(`/api/faces/people/${alice}`)).body;
  assert.deepStrictEqual(pa.studios.map(x => [x.name, x.explicit, x.files]), [['People Place', false, 2]]);
});

test('face search off: studios still work, people parts come back empty, adding a member is FACES_OFF', async () => {
  const s = await mkStudio('Off Studio');
  const f = addFile('off/a.mp4', 'video', { studio: s.id });
  addFace(f, addPerson('Offy'));
  assert.strictEqual((await get(`/api/studios/${s.id}`)).body.peopleCount, 1);
  await setFaces(false);
  try {
    let r = await get(`/api/studios/${s.id}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual([r.body.people, r.body.peopleCount, r.body.peoplePreview, r.body.files], [[], 0, [], 1]);
    r = await get('/api/studios?q=off studio');
    assert.deepStrictEqual([r.body.studios[0].people, r.body.studios[0].peoplePreview], [0, []]);
    r = await post(`/api/studios/${s.id}/people`, { personId: 1 });
    assert.deepStrictEqual([r.status, r.body.code], [409, 'FACES_OFF']);
    r = await post(`/api/studios/${s.id}`, { notes: 'still editable' });
    assert.strictEqual(r.body.notes, 'still editable');
    assert.strictEqual((await post('/api/studios', { name: 'Made While Off' })).status, 200);
    assert.strictEqual((await post('/api/studios/auto/preview')).status, 200);
  } finally {
    await setFaces(true);
  }
});

test('list: counts, filters, search by name and other names, sorts, paging', async () => {
  sql().prepare('DELETE FROM studios').run();
  const a = await mkStudio('Alpha', { yearStart: 2010, favorite: true, aliases: 'First Light' });
  const b = await mkStudio('Bravo', { yearStart: 2001, yearEnd: 2005 });
  const c = await mkStudio('Charlie');
  for (let i = 0; i < 3; i++) addFile(`sort/b${i}.mp4`, 'video', { studio: b.id });
  addFile('sort/c0.mp4', 'video', { studio: c.id });
  sql().prepare("UPDATE studios SET cover_kind = 'upload' WHERE id = ?").run(c.id);
  let r = await get('/api/studios');
  assert.deepStrictEqual(r.body.counts, { all: 3, favorites: 1, nophoto: 2 });
  assert.deepStrictEqual(r.body.studios.map(s => s.name), ['Bravo', 'Charlie', 'Alpha'], 'default: most files');
  assert.deepStrictEqual((await get('/api/studios?sort=name')).body.studios.map(s => s.name), ['Alpha', 'Bravo', 'Charlie']);
  assert.deepStrictEqual((await get('/api/studios?sort=recent')).body.studios.map(s => s.name), ['Charlie', 'Bravo', 'Alpha']);
  assert.deepStrictEqual((await get('/api/studios?sort=years')).body.studios.map(s => s.name), ['Bravo', 'Alpha', 'Charlie']);
  r = await get('/api/studios?filter=favorites');
  assert.deepStrictEqual([r.body.total, r.body.studios.map(s => s.name), r.body.counts.all], [1, ['Alpha'], 3]);
  assert.deepStrictEqual((await get('/api/studios?filter=nophoto&sort=name')).body.studios.map(s => s.name), ['Alpha', 'Bravo']);
  assert.deepStrictEqual((await get('/api/studios?q=LIGHT')).body.studios.map(s => s.name), ['Alpha'], 'other names match');
  assert.deepStrictEqual((await get('/api/studios?q=rav')).body.studios.map(s => s.name), ['Bravo']);
  r = await get('/api/studios?sort=name&offset=1&limit=1');
  assert.deepStrictEqual([r.body.total, r.body.studios.map(s => s.name)], [3, ['Bravo']]);
  for (const [qs, code] of [['sort=size', 'BAD_SORT'], ['filter=x', 'BAD_FILTER'], ['limit=-1', 'BAD_REQUEST'], ['offset=x', 'BAD_REQUEST']]) {
    assert.strictEqual((await get(`/api/studios?${qs}`)).body.code, code, qs);
  }
  sql().prepare('UPDATE studios SET cover_kind = NULL WHERE id = ?').run(c.id);
});

test('covers: upload (plain), GET, wrong type, bad bytes, too big, frame of a studio file, clear', { skip: noFfmpeg }, async () => {
  const s = await mkStudio('Cover Plain');
  let r = await upload(s.id, jpegOf(1280, 720));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.coverKind, 'upload');
  assert.match(r.body.coverUrl, new RegExp(`^/api/studios/${s.id}/cover\\?v=\\d+$`));
  const file = studios.coverPath(s.id);
  assert.ok(fs.existsSync(file), 'plain library: a file under thumbnails/studios');
  const img = await fetch(base + r.body.coverUrl);
  assert.strictEqual(img.headers.get('content-type'), 'image/jpeg');
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.deepStrictEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  const back = await require('../lib/faces/frames').decodeImageBuffer(bytes);
  assert.deepStrictEqual([back.width, back.height], [640, 360], 're-encoded to 640 px');
  assert.strictEqual((await get('/api/studios?filter=nophoto')).body.studios.some(x => x.id === s.id), false);

  r = await upload(s.id, jpegOf(10, 10), 'image/gif');
  assert.deepStrictEqual([r.status, r.body.code], [415, 'BAD_IMAGE']);
  r = await upload(s.id, Buffer.from('not a picture'), 'image/png');
  assert.deepStrictEqual([r.status, r.body.code], [400, 'BAD_IMAGE']);
  r = await upload(s.id, Buffer.alloc(15 * 1024 * 1024 + 10), 'image/jpeg');
  assert.deepStrictEqual([r.status, r.body.code], [413, 'TOO_LARGE']);
  r = await post(`/api/studios/${s.id}/cover`, { what: 1 });
  assert.strictEqual(r.status, 400);

  // A frame: only from the studio's own files.
  const pic = addFile('cover/pic.jpg', 'image', { studio: s.id, content: jpegOf(300, 600, [10, 200, 10]) });
  const outside = addFile('cover/out.jpg', 'image', { content: jpegOf(30, 30) });
  r = await post(`/api/studios/${s.id}/cover`, { mediaId: outside, timeS: 0 });
  assert.deepStrictEqual([r.status, r.body.code], [400, 'NOT_IN_STUDIO']);
  r = await post(`/api/studios/${s.id}/cover`, { mediaId: pic, timeS: -1 });
  assert.strictEqual(r.status, 400);
  r = await post(`/api/studios/${s.id}/cover`, { mediaId: pic, timeS: 0 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.coverKind, r.body.coverRef], ['frame', `${pic}:0`]);
  const f = await require('../lib/faces/frames').decodeImageBuffer(Buffer.from(await (await fetch(base + r.body.coverUrl)).arrayBuffer()));
  assert.deepStrictEqual([f.width, f.height], [300, 600], 'never upscaled');
  assert.ok(f.data[1] > 150 && f.data[0] < 60, 'the green picture');

  r = await post(`/api/studios/${s.id}/cover`, { clear: true });
  assert.deepStrictEqual([r.body.coverKind, r.body.coverUrl], [null, `/thumb/${pic}`]);
  assert.ok(!fs.existsSync(file), 'cleared: the file is gone');
  const redirect = await fetch(`${base}/api/studios/${s.id}/cover`, { redirect: 'manual' });
  assert.strictEqual(redirect.status, 302);
  const empty = await mkStudio('No Files Yet');
  assert.strictEqual((await get(`/api/studios/${empty.id}/cover`)).body.code, 'NO_COVER');
});

test('covers: a video frame', { skip: noFfmpeg }, async () => {
  const s = await mkStudio('Cover Video');
  const clip = path.join(tmp, 'media', 'cover', 'clip.mp4');
  const ff = spawnSync(locate.resolve('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=10:d=3',
    '-c:v', 'mpeg4', clip], { windowsHide: true });
  assert.strictEqual(ff.status, 0, String(ff.stderr));
  const id = Number(sql().prepare("INSERT INTO media (filepath, filename, media_type, duration_seconds, studio_id) VALUES (?, 'clip.mp4', 'video', 3, ?)")
    .run(clip, s.id).lastInsertRowid);
  const r = await post(`/api/studios/${s.id}/cover`, { mediaId: id, timeS: 99 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.coverRef, `${id}:2.9`, 'clamped to the end of the video');
});

test('covers: an encrypted library keeps them in secure assets, never as plain files', { skip: noFfmpeg }, async () => {
  const plain = await mkStudio('Was Plain');
  assert.strictEqual((await upload(plain.id, jpegOf(64, 64))).status, 200);
  assert.ok(fs.existsSync(studios.coverPath(plain.id)));
  secureAssets.init('studios-test-pass');
  try {
    assert.ok(secureAssets.enabled());
    secureAssets.migrateFromDisk();
    assert.ok(!fs.existsSync(studios.coverPath(plain.id)), 'turning the vault on moves plain covers in');
    assert.ok(secureAssets.get(0, `studio-${plain.id}`));

    const s = await mkStudio('Cover Secure');
    const r = await upload(s.id, jpegOf(800, 800));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(!fs.existsSync(studios.coverPath(s.id)), 'no plain file');
    assert.ok(secureAssets.get(0, `studio-${s.id}`), 'in the encrypted store');
    const img = await fetch(base + r.body.coverUrl);
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers.get('cache-control'), 'no-store');
    const pic = addFile('secure/pic.jpg', 'image', { studio: s.id, content: jpegOf(50, 50) });
    assert.strictEqual((await post(`/api/studios/${s.id}/cover`, { mediaId: pic })).status, 200);
    assert.ok(!fs.existsSync(studios.coverPath(s.id)));

    // A lock while ffmpeg runs: nothing is written.
    const realFrames = require('../lib/faces/frames');
    studios.setFrames({ ...realFrames, decodeImageBuffer: async (...a) => { const f = await realFrames.decodeImageBuffer(...a); vault._locked = true; return f; } });
    try {
      secureAssets.del(0, `studio-${s.id}`);
      const locked = await upload(s.id, jpegOf(20, 20));
      assert.deepStrictEqual([locked.status, locked.body.code], [423, 'VAULT_LOCKED']);
    } finally { vault._locked = false; studios.setFrames(null); }
    assert.strictEqual(secureAssets.get(0, `studio-${s.id}`), null);
    assert.ok(!fs.existsSync(studios.coverPath(s.id)));

    const del = await call('DELETE', `/api/studios/${plain.id}`);
    assert.deepStrictEqual(del.body, { ok: true });
    assert.strictEqual(secureAssets.get(0, `studio-${plain.id}`), null, 'deleting a studio deletes its cover');
  } finally {
    secureAssets.close();
    secureAssets.init(null);
  }
  assert.ok(!secureAssets.enabled());
});

test('folder auto-match: whole words, any case, . _ - and space, other names, deepest folder, files in a studio left alone', async () => {
  sql().prepare('DELETE FROM studios').run();
  sql().prepare('UPDATE media SET studio_id = NULL').run();
  const wh = await mkStudio('The White House');
  const nasa = await mkStudio('NASA', { aliases: 'Space Agency' });
  const other = await mkStudio('Elsewhere');
  const ids = {
    nasa1: addFile('auto/NASA/launch.mp4'),
    nasaSub: addFile('auto/NASA/raw/clip.mp4'),
    nasa2024: addFile('auto/nasa_2024/a.jpg', 'image'),
    nasal: addFile('auto/Nasal spray/ad.mp4'),
    nasaName: addFile('auto/misc/nasa.mp4'),           // a file NAME, not a folder
    space: addFile('auto/space-agency.clips/x.mp4'),
    wh: addFile('auto/the.white.house-2019/speech.mp4'),
    whNoSpace: addFile('auto/WhiteHouse/b.mp4'),
    whDeep: addFile('auto/NASA/The White House visit/c.mp4'),
    taken: addFile('auto/NASA/taken.mp4', 'video', { studio: other.id }),
    trashed: addFile('auto/NASA/trashed.mp4', 'video', { trashed: 1 }),
    doc: addFile('auto/NASA/notes.pdf', 'document'),
  };
  const before = sql().prepare('SELECT id, studio_id FROM media ORDER BY id').all();
  const r = await post('/api/studios/auto/preview');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(sql().prepare('SELECT id, studio_id FROM media ORDER BY id').all(), before, 'preview never writes');
  const m = r.body.matches;
  assert.deepStrictEqual(Object.keys(m[0]).sort(), ['alreadyInStudio', 'files', 'folder', 'studioId', 'studioName']);
  const dir = (rel) => path.join(tmp, 'media', ...rel.split('/'));
  const rows = m.map(x => [x.studioName, path.relative(path.join(tmp, 'media'), x.folder).split(path.sep).join('/'), x.files, x.alreadyInStudio]);
  assert.deepStrictEqual(rows, [
    ['NASA', 'auto/NASA', 2, 1],
    ['NASA', 'auto/nasa_2024', 1, 0],
    ['NASA', 'auto/space-agency.clips', 1, 0],
    ['The White House', 'auto/NASA/The White House visit', 1, 0],
    ['The White House', 'auto/the.white.house-2019', 1, 0],
  ]);

  // Apply only some pairs; a pair the preview did not offer changes nothing.
  const ap = await post('/api/studios/auto/apply', { pairs: [
    { folder: dir('auto/NASA'), studioId: nasa.id },
    { folder: dir('auto/the.white.house-2019'), studioId: wh.id },
    { folder: dir('auto/Nasal spray'), studioId: nasa.id },
  ] });
  assert.deepStrictEqual(ap.body, { changed: 3 });
  const sid = (id) => sql().prepare('SELECT studio_id FROM media WHERE id = ?').get(id).studio_id;
  assert.deepStrictEqual([sid(ids.nasa1), sid(ids.nasaSub), sid(ids.wh)], [nasa.id, nasa.id, wh.id]);
  assert.deepStrictEqual([sid(ids.nasal), sid(ids.nasa2024), sid(ids.whDeep), sid(ids.taken), sid(ids.trashed), sid(ids.doc), sid(ids.nasaName), sid(ids.whNoSpace)],
    [null, null, null, other.id, null, null, null, null]);
  assert.strictEqual((await post('/api/studios/auto/apply', { pairs: [{ folder: dir('auto/NASA'), studioId: 999999 }] })).status, 404);
  for (const body of [{}, { pairs: 'x' }, { pairs: [{ folder: 5, studioId: nasa.id }] }, { pairs: [{ folder: 'a', studioId: 0 }] }]) {
    assert.strictEqual((await post('/api/studios/auto/apply', body)).status, 400, JSON.stringify(body));
  }
});

test('folder name matching rules', () => {
  const terms = [
    { sid: 1, name: 'NASA', words: studios.wordsOf('NASA') },
    { sid: 2, name: 'The White House', words: studios.wordsOf('The White House') },
    { sid: 3, name: 'White', words: studios.wordsOf('White') },
  ];
  const hit = (seg) => { const t = studios.matchFolderName(seg, terms); return t ? t.sid : null; };
  assert.strictEqual(hit('Nasal spray'), null);
  assert.strictEqual(hit('nasa_2024'), 1);
  assert.strictEqual(hit('NASA'), 1);
  assert.strictEqual(hit('2024.nasa.launch'), 1);
  assert.strictEqual(hit('nasa-'), 1);
  assert.strictEqual(hit('NASAfootage'), null);
  assert.strictEqual(hit('the_white_house'), 2, 'the longer name wins');
  assert.strictEqual(hit('White_Castle'), 3);
  assert.strictEqual(hit('Whitehouse'), null);
  assert.strictEqual(hit(''), null);
});

test('merge: files and members move, B keeps its years, A goes, its names become other names; delete keeps files', async () => {
  const a = await mkStudio('Merge From', { aliases: 'MF', urls: 'https://from.example', description: 'from desc', favorite: true });
  const b = await mkStudio('Merge Into', { notes: 'into notes' });
  const fa = addFile('merge/a.mp4', 'video', { studio: a.id });
  const fb = addFile('merge/b.mp4', 'video', { studio: b.id });
  const both = addPerson('Both'), onlyA = addPerson('Only A');
  await post(`/api/studios/${a.id}/people`, { personId: both, yearStart: 2001 });
  await post(`/api/studios/${a.id}/people`, { personId: onlyA, yearStart: 2003, yearEnd: 2004 });
  await post(`/api/studios/${b.id}/people`, { personId: both, yearStart: 2010 });
  assert.strictEqual((await post(`/api/studios/${a.id}/merge`, { into: a.id })).status, 400);
  assert.strictEqual((await post(`/api/studios/${a.id}/merge`, { into: 999999 })).status, 404);
  assert.strictEqual((await post(`/api/studios/${a.id}/merge`, {})).status, 400);
  const r = await post(`/api/studios/${a.id}/merge`, { into: b.id });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.id, b.id);
  assert.strictEqual(r.body.files, 2);
  assert.deepStrictEqual(r.body.people.filter(p => p.explicit).map(p => [p.name, p.yearStart, p.yearEnd]), [['Only A', 2003, 2004], ['Both', 2010, null]]);
  assert.deepStrictEqual([r.body.aliases, r.body.urls, r.body.description, r.body.notes, r.body.favorite],
    ['MF, Merge From', 'https://from.example', 'from desc', 'into notes', true]);
  assert.strictEqual((await get(`/api/studios/${a.id}`)).status, 404);
  assert.strictEqual(sql().prepare('SELECT COUNT(*) AS n FROM studio_people WHERE studio_id = ?').get(a.id).n, 0);
  assert.deepStrictEqual([fa, fb].map(id => sql().prepare('SELECT studio_id FROM media WHERE id = ?').get(id).studio_id), [b.id, b.id]);

  // Delete (both spellings): files stay, members go.
  let d = await post(`/api/studios/${b.id}/delete`);
  assert.deepStrictEqual(d.body, { ok: true });
  assert.deepStrictEqual([fa, fb].map(id => sql().prepare('SELECT studio_id FROM media WHERE id = ?').get(id)?.studio_id), [null, null]);
  assert.strictEqual(sql().prepare('SELECT COUNT(*) AS n FROM studio_people WHERE studio_id = ?').get(b.id).n, 0);
  d = await call('DELETE', `/api/studios/${b.id}`);
  assert.strictEqual(d.status, 404);
});

test('people: details validation and output, search by other names, merges move memberships, delete-all keeps studios', async () => {
  const p = addPerson('Detail Dee');
  addFace(addFile('details/d.jpg', 'image'), p);
  let r = await post(`/api/faces/people/${p}`, { aliases: 'DD, Dee Dee', urls: ['https://dee.example'], description: 'Bio', notes: 'n',
    yearStart: 1999, yearEnd: 2004, born: '1980-02-29' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.aliases, r.body.urls, r.body.description, r.body.notes, r.body.yearStart, r.body.yearEnd, r.body.born],
    ['DD, Dee Dee', 'https://dee.example', 'Bio', 'n', 1999, 2004, '1980-02-29']);
  for (const born of ['1981-02-29', '1980-13', '80', '1799', '1980/01/01', '1980-1-1', 5]) {
    r = await post(`/api/faces/people/${p}`, { born });
    assert.strictEqual(r.body.code, 'BAD_BORN', String(born));
  }
  for (const b of ['1980', '1980-05', null, '']) assert.strictEqual((await post(`/api/faces/people/${p}`, { born: b })).status, 200);
  for (const [body, code] of [[{ yearEnd: 1990 }, 'BAD_YEARS'], [{ yearStart: 2200 }, 'BAD_YEARS'], [{ urls: 'ftp://x' }, 'BAD_URL'],
    [{ notes: 'x'.repeat(5001) }, 'TOO_LONG']]) {
    r = await post(`/api/faces/people/${p}`, body);
    assert.strictEqual(r.body.code, code, JSON.stringify(body));
  }
  r = await get('/api/faces/people?q=dee dee');
  assert.deepStrictEqual(r.body.people.map(x => x.id), [p], 'people search matches other names');

  // A person merge moves memberships (the survivor keeps its own years where both were members).
  const s1 = await mkStudio('Merge People 1'), s2 = await mkStudio('Merge People 2');
  const keep = addPerson('Keeper');
  addFace(addFile('details/k.jpg', 'image'), keep);
  await post(`/api/studios/${s1.id}/people`, { personId: p, yearStart: 2000 });
  await post(`/api/studios/${s2.id}/people`, { personId: p, yearStart: 2001 });
  await post(`/api/studios/${s1.id}/people`, { personId: keep, yearStart: 2015 });
  r = await post('/api/faces/people/merge', { ids: [keep, p], into: keep });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.studios.map(x => [x.name, x.yearStart]), [['Merge People 2', 2001], ['Merge People 1', 2015]].sort((x, y) => x[1] - y[1]));
  assert.strictEqual(r.body.aliases, 'DD, Dee Dee, Detail Dee', 'the merged name becomes another name');
  assert.strictEqual(sql().prepare('SELECT COUNT(*) AS n FROM studio_people WHERE person_id = ?').get(p).n, 0);

  // Delete all face data: studios stay, memberships go.
  r = await post('/api/faces/delete-all');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(sql().prepare('SELECT COUNT(*) AS n FROM studio_people').get().n, 0);
  assert.strictEqual((await get(`/api/studios/${s1.id}`)).status, 200);
});

test('gates: CSRF, vault lock', async () => {
  let r = await fetch(`${base}/api/studios`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{"name":"x"}' });
  assert.strictEqual(r.status, 403);
  r = await fetch(`${base}/api/studios/1/delete`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
  assert.strictEqual(r.status, 403);
  vault._locked = true;
  try {
    for (const [m, p] of [['GET', '/api/studios'], ['POST', '/api/studios'], ['GET', '/api/studios/1/cover'], ['POST', '/api/media/studio'],
      ['POST', '/api/studios/auto/preview']]) {
      r = await fetch(base + p, m === 'GET' ? {} : json(m, {}));
      assert.strictEqual(r.status, 423, p);
    }
  } finally { vault._locked = false; }
});

test('merge moves a chosen cover when the survivor has none; a pruned person leaves its studios', { skip: noFfmpeg }, async () => {
  const a = await mkStudio('Cover From'), b = await mkStudio('Cover Into');
  assert.strictEqual((await upload(a.id, jpegOf(40, 40))).status, 200);
  const r = await post(`/api/studios/${a.id}/merge`, { into: b.id });
  assert.deepStrictEqual([r.body.coverKind, r.body.coverRef], ['upload', `studio-${b.id}`]);
  assert.ok(fs.existsSync(studios.coverPath(b.id)));
  assert.ok(!fs.existsSync(studios.coverPath(a.id)));
  assert.strictEqual((await fetch(base + r.body.coverUrl)).status, 200);

  // An unnamed person whose last file is deleted is pruned: memberships go with it.
  const anon = addPerson(null);
  const f = addFile('prune/x.jpg', 'image');
  addFace(f, anon);
  sql().prepare("INSERT INTO studio_people (studio_id, person_id, created_at) VALUES (?, ?, 'now')").run(b.id, anon);
  db.deleteRecords([f]);
  assert.strictEqual(sql().prepare('SELECT COUNT(*) AS n FROM face_people WHERE id = ?').get(anon).n, 0);
  assert.strictEqual(sql().prepare('SELECT COUNT(*) AS n FROM studio_people WHERE person_id = ?').get(anon).n, 0);
});
