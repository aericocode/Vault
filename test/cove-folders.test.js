/**
 * lib/cove/folders.js: Vault's top-most media folders, the Cove-side path
 * through the folder mappings, covered-by-root and overlap rules, the config
 * round trip that adds library roots, not-found reasons, and the scan payloads.
 */

const test = require('node:test');
const assert = require('node:assert');
const F = require('../lib/cove/folders');
const M = require('../lib/cove/mapping');
const { scanOptions } = require('../lib/cove/job');

const row = (filepath) => ({ filepath, media_type: 'video', user_trashed: 0 });

test('folders: the top-most folder that holds media, with every item under it counted', () => {
  const rows = [
    'D:\\M\\a\\x.mp4', 'D:\\M\\a\\b\\y.mp4', 'D:\\M\\a\\b\\c\\w.mp4', 'd:\\m\\A\\k.mp4',
    'D:\\M\\c\\z.mp4', 'E:\\Z\\q.mp3', '/posix/dir/f.mp4', '/posix/dir/sub/g.mp4', '/Posix/dir/h.mp4',
  ].map(row);
  const top = F.topFolders(rows).map(f => [f.vaultPath, f.items]);
  assert.deepStrictEqual(top, [
    ['/posix/dir', 2], ['/Posix/dir', 1],             // non-Windows paths compare case-sensitively
    ['D:\\M\\a', 4], ['D:\\M\\c', 1], ['E:\\Z', 1],    // drive-letter paths do not
  ]);
});

test('folders: mappings give the Cove-side path; unmapped folders keep theirs', () => {
  const maps = [{ from: 'D:\\Media', to: '/media' }, { from: 'E:\\X', to: 'F:\\Y' }];
  assert.deepStrictEqual(F.covePathFor('D:\\Media\\Clips', maps), { covePath: '/media/Clips', mapped: true });
  assert.deepStrictEqual(F.covePathFor('d:\\media', maps), { covePath: '/media', mapped: true });
  assert.deepStrictEqual(F.covePathFor('E:\\X\\sub', maps), { covePath: 'F:\\Y\\sub', mapped: true });
  assert.deepStrictEqual(F.covePathFor('D:\\Media2\\a', maps), { covePath: 'D:\\Media2\\a', mapped: false });
});

test('folders: in Cove, will add, missing, overlap', () => {
  const rows = ['D:\\Media\\Clips\\sub\\a.mp4', 'E:\\Archive\\Phone\\b.mp4', 'F:\\Gone\\c.mp4', 'G:\\New\\d.mp4', 'H:\\mapped\\e.mp4'].map(row);
  const roots = ['d:/media/clips', 'E:\\Archive\\Phone\\Inner', '/cove/elsewhere'];
  const exists = (p) => !p.startsWith('F:');
  const out = F.folderRows({ rows, maps: [{ from: 'H:\\mapped', to: '/cove/new' }], roots, exists });
  const by = Object.fromEntries(out.map(r => [r.vaultPath, r]));
  assert.strictEqual(by['D:\\Media\\Clips\\sub'].state, 'in', 'under a root, any case and separator');
  assert.strictEqual(by['E:\\Archive\\Phone'].state, 'overlap');
  assert.deepStrictEqual(by['E:\\Archive\\Phone'].innerRoots, ['E:\\Archive\\Phone\\Inner']);
  assert.match(by['E:\\Archive\\Phone'].note, /scan that part twice/);
  assert.strictEqual(by['F:\\Gone'].state, 'missing');
  assert.strictEqual(by['F:\\Gone'].note, 'This folder no longer exists.');
  assert.strictEqual(by['G:\\New'].state, 'add');
  assert.strictEqual(by['H:\\mapped'].state, 'add', 'a mapped folder is not checked on disk');
  assert.strictEqual(by['H:\\mapped'].covePath, '/cove/new');
  assert.ok(F.within(F.pathKey('/a/b'), F.pathKey('/a')) && !F.within(F.pathKey('/ab'), F.pathKey('/a')), 'folder boundary');
});

function fakeClient(cfg, { answer } = {}) {
  const calls = [];
  return {
    calls,
    perms: ['*'],
    async me() { calls.push(['ME']); return { permissions: this.perms }; },
    async getConfig() { calls.push(['GET']); return JSON.parse(JSON.stringify(cfg)); },
    async putConfig(body) { calls.push(['PUT', body]); return answer ? answer(body) : body; },
  };
}

const CONFIG = {
  covePaths: [
    { path: 'D:\\Library', excludeVideo: false, excludeImage: true, excludeAudio: false, excludeText: false },
    { path: '/z/second', excludeVideo: true, excludeImage: false, excludeAudio: false, excludeText: true },
  ],
  downloaderSiteCredentials: [{ id: 'c1', site: 'x.com', username: 'u', password: null, hasPassword: true }],
  security: { enabled: true, username: 'owner', knownProxies: ['10.0.0.1'] },
  ui: { title: 'Mine', keybindingOverrides: { a: 'b' } }, port: 5073, enableFfmpegHwAccel: null,
  pluginConfigurations: { p: { k: [1, 2] } },
};

test('addRoots: appends after the existing roots and sends everything else back exactly as read', async () => {
  const c = fakeClient(CONFIG);
  const added = await F.addRoots(c, ['E:\\New', 'd:\\library\\inside', 'D:\\', 'E:\\new\\', '/fresh']);
  assert.deepStrictEqual(added, ['E:\\New', '/fresh'], 'covered, overlapping and repeated paths are skipped');
  assert.deepStrictEqual(c.calls.map(x => x[0]), ['ME', 'GET', 'PUT'], 'may it write settings, then read right before the write');
  const sent = c.calls[2][1];
  const { covePaths, ...rest } = sent;
  const { covePaths: before, ...restBefore } = CONFIG;
  assert.deepStrictEqual(rest, restBefore, 'every other field untouched');
  assert.deepStrictEqual(covePaths.slice(0, 2), before, 'existing roots first, unchanged, in order');
  assert.deepStrictEqual(covePaths.slice(2), [
    { path: 'E:\\New', excludeVideo: false, excludeImage: false, excludeAudio: false, excludeText: false },
    { path: '/fresh', excludeVideo: false, excludeImage: false, excludeAudio: false, excludeText: false },
  ]);
});

test('addRoots: nothing to add sends nothing; a redacted or reshuffled config is refused', async () => {
  let c = fakeClient(CONFIG);
  assert.deepStrictEqual(await F.addRoots(c, ['D:\\Library\\x']), []);
  assert.deepStrictEqual(c.calls.map(x => x[0]), ['ME', 'GET']);

  c = fakeClient({ ...CONFIG, covePaths: [{ path: '[redacted]' }] });
  await assert.rejects(F.addRoots(c, ['/n']), /only showed part/);
  assert.deepStrictEqual(c.calls.map(x => x[0]), ['ME', 'GET']);

  c = fakeClient(CONFIG, { answer: (body) => ({ ...body, covePaths: [...body.covePaths].reverse() }) });
  await assert.rejects(F.addRoots(c, ['/n']), /saved its library settings differently/);
});

test('addRoots: a principal that may not write settings never gets its config sent back', async () => {
  const c = fakeClient(CONFIG);
  c.perms = ['system.read', 'files.read', 'library.scan'];
  await assert.rejects(F.addRoots(c, ['/n']), (e) => e.code === 'NO_PERMISSION' && /system\.settings\.write/.test(e.message));
  assert.deepStrictEqual(c.calls.map(x => x[0]), ['ME'], 'not even read');
});

test('UNC paths: kept as \\\\server\\share on the Cove side, one key for both sides', () => {
  assert.strictEqual(F.pathKey('\\\\NAS\\Share\\b\\'), '//nas/share/b');
  assert.strictEqual(F.pathKey('//nas/share/b'), '//nas/share/b');
  assert.notStrictEqual(F.pathKey('\\\\NAS\\Share'), F.pathKey('/NAS/Share'), 'a UNC path is not a posix path');
  const maps = [{ from: 'E:\\Stuff\\', to: '\\\\NAS\\Share' }];
  assert.deepStrictEqual(F.covePathFor('E:\\Stuff\\b', maps), { covePath: '\\\\NAS\\Share\\b', mapped: true });
  const rows = [row('E:\\Stuff\\b\\x.mp4')];
  const covered = F.folderRows({ rows, maps, roots: ['\\\\nas\\share'], exists: () => true });
  assert.strictEqual(covered[0].state, 'in', 'mapped UNC folder under a UNC root, any case');
  const notCovered = F.folderRows({ rows, maps, roots: ['\\\\nas\\other'], exists: () => true });
  assert.strictEqual(notCovered[0].state, 'add');
  assert.strictEqual(notCovered[0].covePath, '\\\\NAS\\Share\\b');
  const unmapped = F.folderRows({ rows: [row('\\\\srv\\media\\a\\x.mp4')], maps: [], roots: ['\\\\SRV\\Media\\A'], exists: () => true });
  assert.deepStrictEqual([unmapped[0].vaultPath, unmapped[0].state], ['\\\\srv\\media\\a', 'in']);
  const unmappedAdd = F.folderRows({ rows: [row('\\\\srv\\media\\b\\x.mp4')], maps: [], roots: ['\\\\SRV\\Media\\A'], exists: () => true });
  assert.strictEqual(unmappedAdd[0].state, 'add');
});

test('drive and filesystem roots: never collected into, never added; files on them get their own row', () => {
  const rows = ['D:\\loose.mp4', 'D:\\M\\x.mp4', 'D:\\M\\sub\\y.mp4', 'D:\\Other\\z.mp4', '/top.mp4', '/srv/a/b.mp4', '\\\\nas\\s\\q.mp4', '\\\\nas\\s\\d\\r.mp4'].map(row);
  const top = F.topFolders(rows).map(f => [f.vaultPath, f.items, f.root]);
  assert.deepStrictEqual(top, [
    ['/', 1, true], ['\\\\nas\\s\\', 1, true], ['\\\\nas\\s\\d', 1, false], ['/srv/a', 1, false],
    ['D:\\', 1, true], ['D:\\M', 2, false], ['D:\\Other', 1, false],
  ]);
  const out = F.folderRows({ rows, maps: [], roots: [], exists: () => true });
  const d = out.find(r => r.vaultPath === 'D:\\');
  assert.strictEqual(d.state, 'root');
  assert.strictEqual(d.note, 'These files sit directly on D:\\. Adding all of D:\\ to Cove would scan the whole drive, so move them into a folder or add them in Cove yourself.');
  assert.strictEqual(out.find(r => r.vaultPath === '/').state, 'root');
  assert.strictEqual(out.find(r => r.vaultPath === 'D:\\M').state, 'add');
  // A drive Cove already has as a root covers its loose files.
  assert.strictEqual(F.folderRows({ rows: [row('D:\\loose.mp4')], maps: [], roots: ['D:\\'], exists: () => true })[0].state, 'in');
});

test('addRoots never adds a drive or filesystem root', async () => {
  const c = fakeClient({ ...CONFIG, covePaths: [] });
  assert.deepStrictEqual(await F.addRoots(c, ['D:\\', '/', '\\\\nas\\share']), []);
  assert.ok(!c.calls.some(x => x[0] === 'PUT'));
});

test('not-found reasons and Cove\'s extensions', () => {
  const exts = F.extensionSet({ videoExtensions: ['.mp4'], imageExtensions: [], audioExtensions: ['.MP3'] });
  assert.ok(exts.has('.mp4') && exts.has('.mp3') && exts.has('.png'), 'an empty list falls back to Cove\'s defaults');
  const exists = (p) => !p.includes('gone');
  assert.strictEqual(F.notFoundReason('D:\\gone\\a.mp4', exts, exists), 'File no longer exists');
  assert.strictEqual(F.notFoundReason('D:\\x\\a.ts', exts, exists), 'Cove doesn\'t support this file type');
  assert.strictEqual(F.notFoundReason('D:\\x\\a.MP4', exts, exists), 'Cove hasn\'t picked this file up yet');
});

test('scan payloads: covers only by default, every generator on request', () => {
  const covers = scanOptions(['/a'], 'covers');
  assert.strictEqual(covers.scanGenerateCovers, true);
  assert.strictEqual(covers.scanGenerateThumbnails, true, 'images: their thumbnail is the cover');
  assert.deepStrictEqual(Object.entries(covers).filter(([k, v]) => v === true).map(([k]) => k).sort(),
    ['scanGenerateCovers', 'scanGenerateThumbnails']);
  assert.deepStrictEqual(covers.paths, ['/a']);
  assert.deepStrictEqual(scanOptions(['/a'], 'all'), { paths: ['/a'], scanGenerators: true });
});

test('putConfig and startScan are sent exactly once, even after a 429', async () => {
  const { CoveClient } = require('../lib/cove/client');
  for (const call of [(c) => c.putConfig({ covePaths: [] }), (c) => c.startScan({ paths: ['/a'] })]) {
    for (const answer of [{ status: 429 }, { status: 503 }, 'drop']) {
      let sent = 0;
      const c = new CoveClient({
        baseUrl: 'http://127.0.0.1:1', retryBaseMs: 1, rateLimitWaitMs: 1, sleep: async () => {},
        fetch: async () => { sent++; if (answer === 'drop') throw new Error('socket hang up'); return new Response(null, { status: answer.status }); },
      });
      await assert.rejects(call(c));
      assert.strictEqual(sent, 1, JSON.stringify(answer));
    }
  }
});
