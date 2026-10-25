/**
 * lib/cove/mapping.js: the pure rules behind `vault export-cove`. Path
 * normalization and --map, matching (stamp, path, name+size, ambiguity), the
 * Vault row -> Cove values mapping, the additive plan, collection names and
 * Cove's permission wildcards.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const M = require('../lib/cove/mapping');

const row = (o) => ({
  id: 1, filepath: 'D:\\Media\\a.mp4', media_type: 'video', filesize_bytes: 100,
  tags: null, themes: null, locations: null, media_elements: null, description: null,
  language: null, explicit: 0, content_type: null, quality_flag: null, processed_at: null,
  user_notes: '', user_rating: 0, user_starred: 0, last_position: 0, ...o,
});
const item = (o) => ({ kind: 'video', id: 10, details: null, customFields: null, tagIds: [], files: [], parentVideoId: null, ...o });

test('paths: slashes collapsed, case folded, basename either separator', () => {
  assert.strictEqual(M.normPath('D:\\Media\\\\Sub//File.MP4'), 'd:/media/sub/file.mp4');
  assert.strictEqual(M.normPath('/media/x/'), '/media/x');
  assert.strictEqual(M.baseName('D:\\Media\\Sub\\File.mp4'), 'File.mp4');
  assert.strictEqual(M.baseName('/media/f.jpg'), 'f.jpg');
});

test('--map rewrites a prefix on a folder boundary, longest first, case-insensitive', () => {
  const maps = M.parseMaps(['D:\\Media=/media', 'D:\\Media\\Movies=/movies']);
  assert.strictEqual(M.applyMaps('d:\\media\\clip.mp4', maps), '/media/clip.mp4');
  assert.strictEqual(M.applyMaps('D:\\Media\\Movies\\x\\y.mkv', maps), '/movies/x/y.mkv');
  assert.strictEqual(M.applyMaps('D:\\Media2\\z.mp4', maps), 'D:/Media2/z.mp4', 'Media2 is not under Media');
  assert.strictEqual(M.applyMaps('E:\\Other\\z.mp4', maps), 'E:/Other/z.mp4');
  assert.throws(() => M.parseMaps(['nonsense']), /--map/);
  assert.throws(() => M.parseMaps(['=x']), /--map/);
});

test('vaultKind: gif is an image, documents and mixes are not carried over', () => {
  assert.strictEqual(M.vaultKind('video'), 'video');
  assert.strictEqual(M.vaultKind('gif'), 'image');
  assert.strictEqual(M.vaultKind('image'), 'image');
  assert.strictEqual(M.vaultKind('audio'), 'audio');
  assert.strictEqual(M.vaultKind('document'), null);
  assert.strictEqual(M.vaultKind('mix'), null);
});

test('matching: path first, name+size only when unique on both sides, never a guess', () => {
  const cove = [
    item({ id: 1, files: [{ path: '/media/a.mp4', basename: 'a.mp4', size: 100 }] }),
    item({ id: 2, files: [{ path: '/elsewhere/B.mp4', basename: 'B.mp4', size: 200 }] }),
    item({ id: 3, files: [{ path: '/x/dup.mp4', basename: 'dup.mp4', size: 300 }] }),
    item({ id: 4, files: [{ path: '/y/dup.mp4', basename: 'dup.mp4', size: 300 }] }),
    item({ id: 5, kind: 'image', files: [{ path: '/media/a.mp4', basename: 'a.mp4', size: 100 }] }),
    item({ id: 6, files: [{ path: '/z/twin.mp4', basename: 'twin.mp4', size: 400 }] }),
    // A clip shares its parent's file: never a match target.
    item({ id: 7, parentVideoId: 1, files: [{ path: '/media/a.mp4', basename: 'a.mp4', size: 100 }] }),
  ];
  const rows = [
    row({ id: 11, filepath: 'D:\\Media\\a.mp4', filesize_bytes: 100 }),
    row({ id: 12, filepath: 'D:\\Old\\b.mp4', filesize_bytes: 200 }),
    row({ id: 13, filepath: 'D:\\Old\\dup.mp4', filesize_bytes: 300 }),
    row({ id: 14, filepath: 'D:\\Old\\nothing.mp4', filesize_bytes: 1 }),
    row({ id: 15, filepath: 'D:\\One\\twin.mp4', filesize_bytes: 400 }),
    row({ id: 16, filepath: 'D:\\Two\\twin.mp4', filesize_bytes: 400 }),
  ];
  const r = M.matchItems(rows, M.buildCoveIndex(cove), M.parseMaps(['D:\\Media=/media']));
  const got = Object.fromEntries(r.matches.map(m => [m.row.id, [m.item.id, m.how]]));
  assert.deepStrictEqual(got, { 11: [1, 'path'], 12: [2, 'name_size'] });
  assert.deepStrictEqual(r.unmatched.map(u => u.vaultId), [14]);
  assert.deepStrictEqual(r.ambiguous.map(a => a.vaultId).sort(), [13, 15, 16]);
});

test('matching: a vault_id stamp wins over the path, and one Cove item is never given twice', () => {
  const cove = [
    item({ id: 1, customFields: { vault_id: 42 }, files: [{ path: '/new/place.mp4', basename: 'place.mp4', size: 5 }] }),
    item({ id: 2, files: [{ path: 'D:/m/same.mp4', basename: 'same.mp4', size: 9 }] }),
  ];
  const rows = [
    row({ id: 42, filepath: 'D:\\gone\\old.mp4', filesize_bytes: 5 }),
    row({ id: 43, filepath: 'D:\\m\\same.mp4', filesize_bytes: 9 }),
    row({ id: 44, filepath: 'D:\\M\\SAME.mp4', filesize_bytes: 9 }),
  ];
  const r = M.matchItems(rows, M.buildCoveIndex(cove), []);
  assert.deepStrictEqual(r.matches.map(m => [m.row.id, m.item.id, m.how]), [[42, 1, 'vault_id'], [43, 2, 'path']]);
  assert.strictEqual(r.ambiguous.length, 1);
  assert.strictEqual(r.ambiguous[0].vaultId, 44);
});

test('desiredForRow: every mapped column, empties skipped', () => {
  const d = M.desiredForRow(row({
    id: 7,
    tags: JSON.stringify(['Beach', 'beach ', 'Sunset', '', 'Vault AI']),
    themes: JSON.stringify(['summer', 'Summer']),
    locations: '[]',
    media_elements: JSON.stringify([
      { type: 'camera', details: 'close-up' }, { type: 'camera', details: 'pan' },
      { type: 'lighting', details: '' }, { type: 'body language', details: 'relaxed' },
      { type: 'themes', details: 'clash' },
    ]),
    description: '  A day at the beach. ',
    language: 'English', explicit: 0, processed_at: '2026-01-01', content_type: 'vlog', quality_flag: '',
    user_notes: JSON.stringify([{ text: 'first' }, { text: '  ' }, { text: 'second' }]),
    user_rating: 4, user_starred: 1, last_position: 12.5,
  }));
  assert.deepStrictEqual(d.tags, ['Beach', 'Sunset'], 'deduped, empty and the parent tag name dropped');
  assert.strictEqual(d.details, 'A day at the beach.');
  assert.strictEqual(d.rating, 80);
  assert.strictEqual(d.favorite, true);
  assert.strictEqual(d.lastPosition, 12.5);
  const vals = Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, v.value]));
  assert.deepStrictEqual(vals, {
    vault_id: 7,
    vault_ai_themes: ['summer'],
    vault_ai_camera: 'close-up; pan',
    vault_ai_body_language: 'relaxed',
    vault_ai_element_themes: 'clash',
    vault_ai_language: 'English',
    vault_ai_content_type: 'vlog',
    vault_ai_explicit: false,
    vault_notes: 'first\n\nsecond',
  });
  assert.strictEqual(d.fields.vault_ai_body_language.def.label, 'AI: Body Language');
  assert.strictEqual(d.fields.vault_ai_themes.def.isMultiValue, true);
  assert.strictEqual(d.fields.vault_notes.def.type, 'longText');
});

test('desiredForRow: unanalysed rows carry no explicit flag; ratings outside 1-5 are unrated', () => {
  const d = M.desiredForRow(row({ explicit: 0, processed_at: null, user_rating: 0 }));
  assert.ok(!('vault_ai_explicit' in d.fields));
  assert.strictEqual(d.rating, null);
  assert.strictEqual(M.coveRating(5), 100);
  assert.strictEqual(M.coveRating(1), 20);
  assert.strictEqual(M.coveRating(6), null);
  assert.strictEqual(M.coveRating('3'), 60);
});

test('notesText handles note objects, plain strings and legacy free text', () => {
  assert.strictEqual(M.notesText(''), '');
  assert.strictEqual(M.notesText('[]'), '');
  assert.strictEqual(M.notesText(null), '');
  assert.strictEqual(M.notesText(JSON.stringify(['a', { text: 'b' }])), 'a\n\nb');
  assert.strictEqual(M.notesText('just some text'), 'just some text');
});

test('slugKey mirrors Cove key normalization', () => {
  assert.strictEqual(M.slugKey('vault_ai_Camera Angle'), 'vault_ai_camera_angle');
  assert.strictEqual(M.slugKey('  _Body--Language!_ '), 'body_language');
  assert.strictEqual(M.titleCase('camera_angle'), 'Camera Angle');
});

test('planChanges: additive only, Cove values win', () => {
  const desired = M.desiredForRow(row({
    id: 9, tags: JSON.stringify(['Old', 'New']), description: 'from vault',
    language: 'French', user_rating: 5, user_starred: 1, last_position: 30,
  }));
  const tagIdByName = new Map([['old', 100], ['new', null]]);
  const it = item({ id: 3, tagIds: [100, 555], details: 'user wrote this', customFields: { vault_ai_language: 'German', other: 'x' } });

  const p = M.planChanges(desired, it, tagIdByName, { rating: 40, isFavorite: false, resumeTime: 0 }, { resume: true });
  assert.deepStrictEqual(p.addTags, ['New']);
  assert.strictEqual(p.details, null, 'Cove details kept');
  assert.deepStrictEqual(Object.keys(p.fields), ['vault_id'], 'existing language kept');
  assert.strictEqual(p.rating, null, 'existing rating kept');
  assert.strictEqual(p.favorite, true);
  assert.strictEqual(p.resumeAt, 30);

  const p2 = M.planChanges(desired, item({ details: '  ' }), tagIdByName, { rating: null, isFavorite: true, resumeTime: 12 }, { resume: true });
  assert.strictEqual(p2.details, 'from vault', 'blank details count as empty');
  assert.strictEqual(p2.rating, 100);
  assert.strictEqual(p2.favorite, false, 'already a favorite');
  assert.strictEqual(p2.resumeAt, null, 'Cove already has a resume point');

  const p3 = M.planChanges(desired, it, tagIdByName, { rating: 0 }, {});
  assert.strictEqual(p3.resumeAt, null, '--resume is off by default');

  const done = M.planChanges(M.desiredForRow(row({ id: 9 })), item({ customFields: { VAULT_ID: 9 } }), new Map(), null);
  assert.ok(M.isEmptyPlan(done), 'case-insensitive key lookup, nothing left to do');
});

test('needsEngagement only for rated, starred or resumable rows', () => {
  assert.strictEqual(M.needsEngagement(M.desiredForRow(row({})), 'video'), false);
  assert.strictEqual(M.needsEngagement(M.desiredForRow(row({ user_rating: 2 })), 'image'), true);
  assert.strictEqual(M.needsEngagement(M.desiredForRow(row({ last_position: 5 })), 'video', { resume: true }), true);
  assert.strictEqual(M.needsEngagement(M.desiredForRow(row({ last_position: 5 })), 'image', { resume: true }), false);
});

test('collectionGroupNames: folder chain prefix, folders themselves get no group, cycles stop', () => {
  const names = M.collectionGroupNames([
    { id: 1, name: 'Trips', parent_id: null, kind: 'folder' },
    { id: 2, name: 'Europe', parent_id: 1, kind: 'folder' },
    { id: 3, name: 'Paris', parent_id: 2, kind: 'collection' },
    { id: 4, name: 'Loose', parent_id: null, kind: 'collection' },
    { id: 5, name: 'A', parent_id: 6, kind: 'folder' },
    { id: 6, name: 'B', parent_id: 5, kind: 'folder' },
    { id: 7, name: 'Loop', parent_id: 5, kind: 'collection' },
  ]);
  assert.deepStrictEqual([...names.entries()], [[3, 'Trips / Europe / Paris'], [4, 'Loose'], [7, 'B / A / Loop']]);
});

test('hasPermission follows Cove wildcards', () => {
  assert.ok(M.hasPermission(['*'], 'files.read'));
  assert.ok(M.hasPermission(['files.read'], 'files.read'));
  assert.ok(M.hasPermission(['videos.*'], 'videos.write'));
  assert.ok(M.hasPermission(['*.read'], 'files.read'));
  assert.ok(!M.hasPermission(['videos.read'], 'videos.write'));
  assert.ok(!M.hasPermission(undefined, 'files.read'));
});

test('uniqueGroupNames: same names split deterministically by collection id', () => {
  const r = M.uniqueGroupNames(new Map([[9, 'Dup'], [3, 'dup'], [5, 'Dup (2)'], [7, 'Solo'], [8, 'Dup']]));
  assert.deepStrictEqual([...r.names.entries()], [[3, 'dup'], [5, 'Dup (2)'], [7, 'Solo'], [8, 'Dup (3)'], [9, 'Dup (4)']]);
  assert.deepStrictEqual([...r.shared].sort(), [3, 8, 9]);
});

test('unsafeFieldReplace: anything a whole-set replace would lose', () => {
  const defs = new Map([
    ['a', { key: 'a', entityTypes: ['image'], isMultiValue: false }],
    ['m', { key: 'm', entityTypes: ['image'], isMultiValue: true }],
    ['v', { key: 'v', entityTypes: ['video'], isMultiValue: false }],
  ]);
  assert.strictEqual(M.unsafeFieldReplace({ a: 'x', m: ['1', '2'], v: null }, defs, 'image'), null);
  assert.match(M.unsafeFieldReplace({ v: 'x' }, defs, 'image'), /"v".*images/);
  assert.match(M.unsafeFieldReplace({ gone: 1 }, defs, 'image'), /"gone"/);
  assert.match(M.unsafeFieldReplace({ a: ['x'] }, defs, 'image'), /list of values for "a"/);
  assert.strictEqual(M.unsafeFieldReplace(null, defs, 'image'), null);
});

test('mapHits counts the Vault paths each --map covers', () => {
  const maps = M.parseMaps(['D:\\Media=/media', 'D:Media=/media']);
  const hits = M.mapHits(['D:\\Media\\a.mp4', 'd:\\media\\b\\c.jpg', 'E:\\x.mp4'], maps);
  assert.deepStrictEqual(hits.map(h => [h.from, h.hits]), [['D:/Media', 2], ['D:Media', 0]]);
});

test('fieldReplaceBlocker: only an entity showing no values at all may be replaced', () => {
  const defs = new Map([['vault_id', { key: 'vault_id', entityTypes: ['image'], isMultiValue: false }],
    ['mine', { key: 'mine', entityTypes: ['image'], isMultiValue: false }]]);
  assert.strictEqual(M.fieldReplaceBlocker(null, defs, 'image'), null);
  assert.strictEqual(M.fieldReplaceBlocker({}, defs, 'image'), null);
  assert.strictEqual(M.fieldReplaceBlocker({ mine: '' }, defs, 'image'), null, 'an empty value holds nothing to lose');
  // A vault_ key can hide rows too (switched to single-value, or user-made).
  assert.match(M.fieldReplaceBlocker({ vault_ai_themes: 'a' }, defs, 'image'), /already has custom fields in Cove \(vault_ai_themes\)/);
  assert.match(M.fieldReplaceBlocker({ vault_id: 3, mine: 'x' }, defs, 'image'), /\(vault_id, mine\)/);
});
