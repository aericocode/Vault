/**
 * Reading playlists for Import (PLAYLISTS_SPEC, build step 3):
 * lib/playlist/parse.js against fixtures shaped like real VLC and PotPlayer
 * saves (test/fixtures/playlists/): M3U / M3U8 (BOM, CRLF / LF, #EXTINF,
 * #PLAYLIST, relative paths, file URIs, percent-encoding, ANSI fallback),
 * XSPF (VLC), PLS (gaps), DPL (PotPlayer), and web links listed as skipped.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parsePlaylist, decodeText, fileUriToPath, detectFormat, MAX_ENTRIES } = require('../lib/playlist/parse');
const { buildM3U8 } = require('../lib/playlist/formats');

const FIX = path.join(__dirname, 'fixtures', 'playlists');
const read = (name) => parsePlaylist(fs.readFileSync(path.join(FIX, name)), { fileName: name });
const paths = (pl) => pl.entries.map((e) => e.path);

test('VLC M3U8: titles, relative and full paths, a web link skipped, VLC options ignored', () => {
  const pl = read('vlc-saved.m3u8');
  assert.strictEqual(pl.format, 'm3u');
  assert.strictEqual(pl.encoding, 'utf-8');
  assert.strictEqual(pl.name, 'vlc-saved');          // no #PLAYLIST: the file name
  assert.deepStrictEqual(paths(pl), ['Videos/Café clip.mp4', 'C:\\Media\\Beta.mkv', null, '..\\Other\\up one.mp4']);
  assert.deepStrictEqual(pl.entries.map((e) => e.title), ['Café clip', 'Beta', 'Live radio', 'Up one']);
  assert.deepStrictEqual(pl.entries.map((e) => e.index), [0, 1, 2, 3]);
  assert.strictEqual(pl.entries[2].url, 'https://radio.example.com/stream.mp3');
  assert.deepStrictEqual(pl.skipped, [{ index: 2, raw: 'https://radio.example.com/stream.mp3', reason: 'web' }]);
});

test('ANSI .m3u: bytes that are not UTF-8 are read as Windows-1252', () => {
  const bytes = fs.readFileSync(path.join(FIX, 'ansi.m3u'));
  assert.ok(bytes.includes(0xe9) && !bytes.includes(0xc3), 'the fixture holds é as one ANSI byte');
  const pl = read('ansi.m3u');
  assert.strictEqual(pl.encoding, 'ansi');
  assert.deepStrictEqual(paths(pl), ['C:\\Media\\Été\\clip é.mp4', 'D:\\Plain\\one.avi']);
  assert.ok(pl.entries.every((e) => e.title === null));
});

test('M3U8 with a BOM and CRLF: #PLAYLIST name, file URIs decoded, plain "%" kept', () => {
  const pl = read('bom-uris.m3u8');
  assert.strictEqual(pl.encoding, 'utf-8-bom');
  assert.strictEqual(pl.name, 'Road trip');
  assert.deepStrictEqual(paths(pl), [
    'C:\\My Videos\\Café 100%.mp4',     // %20 %C3%A9 %25
    '\\\\nas\\media\\Clips\\a#b.mp4',   // UNC host, %23
    'D:\\x\\y.mp4',                     // file://localhost/
    '/home/me/clip.mp4',
    'C:\\Media\\100% real.mp4',         // a plain path is not percent-decoded
    null, null,
  ]);
  assert.deepStrictEqual(pl.skipped.map((s) => s.reason), ['link', 'bad']);
  assert.strictEqual(pl.entries[0].title, 'First');
  assert.strictEqual(pl.entries[2].title, null, 'a title belongs to the next location only');
});

test('VLC XSPF: locations, entities, extension blocks ignored, VLC\'s "Playlist" title gives way to the file name', () => {
  const pl = read('vlc.xspf');
  assert.strictEqual(pl.format, 'xspf');
  assert.strictEqual(pl.name, 'vlc');
  assert.deepStrictEqual(paths(pl), ['C:\\Media\\Café clip.mp4', '\\\\nas\\media\\Beta two.mkv', 'Sub/rel one.mp4', null]);
  assert.deepStrictEqual(pl.entries.map((e) => e.title), ['Café & friends', null, null, 'A web video']);
  assert.deepStrictEqual(pl.skipped, [{ index: 3, raw: 'https://www.youtube.com/watch?v=abc&t=1', reason: 'web' }]);
  const named = read('named.xspf');
  assert.strictEqual(named.name, 'Late <night>');
  assert.deepStrictEqual(paths(named), ['D:\\a.mp4']);
});

test('PLS: numbered entries in number order with a gap, titles, the name line', () => {
  const pl = read('gaps.pls');
  assert.strictEqual(pl.format, 'pls');
  assert.strictEqual(pl.name, 'Morning');
  assert.deepStrictEqual(paths(pl), ['C:\\Music\\one.mp3', '..\\Music\\three.mp3', null]);
  assert.deepStrictEqual(pl.entries.map((e) => e.title), ['One', 'Three', 'Live']);
  assert.strictEqual(pl.skipped[0].reason, 'web');
});

test('PotPlayer DPL: BOM, numbered N*file* / N*title* lines in number order, playname= is not a name', () => {
  const pl = read('potplayer.dpl');
  assert.strictEqual(pl.format, 'dpl');
  assert.strictEqual(pl.encoding, 'utf-8-bom');
  assert.strictEqual(pl.name, 'potplayer', 'playname= holds the file playing last, so the file name is used');
  assert.deepStrictEqual(paths(pl), ['D:\\Videos\\a clip.mp4', 'D:\\Videos\\b clip.mkv', null, 'Clips\\rel é.mp4']);
  assert.deepStrictEqual(pl.entries.map((e) => e.title), [null, 'My B title', null, 'Relative one']);
  assert.strictEqual(pl.skipped[0].raw, 'https://example.com/stream.m3u8');
  const named = parsePlaylist(Buffer.from('DAUMPLAYLIST\r\nplayname=Friday\r\n1*file*C:\\a.mp4\r\n'), { fileName: 'x.dpl' });
  assert.strictEqual(named.name, 'Friday');
});

test('our own M3U8 export reads back (full and relative paths)', () => {
  const items = [
    { id: 1, title: 'One', durationSec: 5, filePath: 'D:\\Media\\one.mp4' },
    { id: 2, title: 'Two', durationSec: 6, filePath: 'D:\\Media\\Sub\\two #2.mkv' },
  ];
  const full = parsePlaylist(Buffer.from(buildM3U8({ title: 'Mine', links: 'full', items }).text), { fileName: 'Mine.m3u8' });
  assert.strictEqual(full.name, 'Mine');
  assert.deepStrictEqual(paths(full), ['D:\\Media\\one.mp4', 'D:\\Media\\Sub\\two #2.mkv']);
  assert.deepStrictEqual(full.entries.map((e) => e.title), ['One', 'Two']);
  const rel = parsePlaylist(Buffer.from(buildM3U8({ title: 'Mine', links: 'relative', playlistDir: 'D:\\Media', items }).text), { fileName: 'Mine.m3u8' });
  assert.deepStrictEqual(paths(rel), ['one.mp4', 'Sub\\two #2.mkv']);
});

test('file URIs: drive, UNC, localhost, old C| form, bad escapes', () => {
  assert.strictEqual(fileUriToPath('file:///C:/a%20b/c.mp4'), 'C:\\a b\\c.mp4');
  assert.strictEqual(fileUriToPath('file:/c:/x.mp4'), 'C:\\x.mp4');
  assert.strictEqual(fileUriToPath('file:///C|/x.mp4'), 'C:\\x.mp4');
  assert.strictEqual(fileUriToPath('FILE://Server/Share/%E6%97%A5.mp4'), '\\\\Server\\Share\\日.mp4');
  assert.strictEqual(fileUriToPath('file:////server/share/x.mp4'), '\\\\server\\share\\x.mp4');
  assert.strictEqual(fileUriToPath('file://localhost/home/x.mp4'), '/home/x.mp4');
  assert.strictEqual(fileUriToPath('file:///C:/a%ZZ.mp4'), null);
  assert.strictEqual(fileUriToPath('file:///C:/a%00.mp4'), null);
  assert.strictEqual(fileUriToPath('file://server'), null);
});

test('text: UTF-16 byte order marks, format by content before the extension', () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('#EXTM3U\r\nC:\\é.mp4\r\n', 'utf16le')]);
  assert.deepStrictEqual(decodeText(le), { text: '#EXTM3U\r\nC:\\é.mp4\r\n', encoding: 'utf-16le' });
  assert.deepStrictEqual(paths(parsePlaylist(le, { fileName: 'a.m3u' })), ['C:\\é.mp4']);
  assert.strictEqual(detectFormat('[playlist]\nFile1=a.mp3', 'm3u'), 'pls');
  assert.strictEqual(detectFormat('DAUMPLAYLIST', 'm3u8'), 'dpl');
  assert.strictEqual(detectFormat('<?xml version="1.0"?><playlist/>', 'm3u'), 'xspf');
  assert.strictEqual(detectFormat('C:\\a.mp4', 'pls'), 'pls');
  assert.strictEqual(detectFormat('C:\\a.mp4', ''), 'm3u');
  const empty = parsePlaylist(Buffer.alloc(0), { fileName: 'Empty one.m3u' });
  assert.deepStrictEqual({ name: empty.name, n: empty.entries.length }, { name: 'Empty one', n: 0 });
});

test('a very long playlist stops at MAX_ENTRIES and says so', () => {
  const text = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => `C:\\m\\${i}.mp4`).join('\n');
  const t0 = Date.now();
  const pl = parsePlaylist(Buffer.from(text), { fileName: 'big.m3u' });
  assert.strictEqual(pl.entries.length, MAX_ENTRIES);
  assert.strictEqual(pl.truncated, true);
  assert.ok(Date.now() - t0 < 5000, 'parses in a few seconds at most');
});

test('IPTV #EXTINF attributes may hold commas; the title is what follows the first comma outside quotes', () => {
  const text = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="a.b" tvg-name="News, Live" group-title="TV, HD",News channel',
    'C:\\TV\\news.ts',
    '#EXTINF:12,Artist, Song (Live)',
    'C:\\Music\\song.mp3',
    '#EXTINF:5',
    'C:\\Music\\none.mp3',
  ].join('\n');
  const pl = parsePlaylist(Buffer.from(text), { fileName: 'tv.m3u' });
  assert.deepStrictEqual(pl.entries.map((e) => e.title), ['News channel', 'Artist, Song (Live)', null]);
});

test('a path written in double quotes loses the quotes', () => {
  const pl = parsePlaylist(Buffer.from('"C:\\My Videos\\a b.mp4"\n" D:\\x.mp4 "\n""\n'), { fileName: 'q.m3u' });
  assert.deepStrictEqual(paths(pl), ['C:\\My Videos\\a b.mp4', 'D:\\x.mp4', null]);
  assert.strictEqual(pl.skipped[0].reason, 'bad');
});

test('a hostile XSPF (unclosed tags by the hundred thousand) reads in time that grows with its size', () => {
  const head = '<?xml version="1.0"?><playlist><title>T</title><trackList>';
  const cases = {
    'unclosed <track>': '<track>',
    'unclosed <extension>': '<extension>',
    'unclosed comment': '<!--',
    'tracks without </location>': '<track><location>x</track>',
    'unclosed <location>': '<track><location>x',
    'nested <title>': '<track><title><title><title>',
  };
  for (const [what, unit] of Object.entries(cases)) {
    const bytes = Buffer.from(head + unit.repeat(100000));
    const t0 = Date.now();
    const pl = parsePlaylist(bytes, { fileName: 'h.xspf' });
    const ms = Date.now() - t0;
    assert.ok(ms < 500, `${what}: ${ms} ms for ${bytes.length} bytes`);
    assert.strictEqual(pl.entries.length, 0, what);
  }
  // Well-formed tracks still read, among junk.
  const ok = parsePlaylist(Buffer.from(`${head}<!-- <track><location>file:///C:/no.mp4</location></track> --><track><location>file:///C:/a.mp4</location><title>A</title></track><extension application="x"><track><location>file:///C:/no2.mp4</location></track></extension><track ><location>file:///C:/b.mp4</location></track><track/></trackList></playlist>`), { fileName: 'x.xspf' });
  assert.deepStrictEqual(paths(ok), ['C:\\a.mp4', 'C:\\b.mp4']);
  assert.strictEqual(ok.name, 'T');
});

test('the parser runs the same from its own source (the worker thread form)', () => {
  const { createParser } = require('../lib/playlist/parse');
  const again = (0, eval)(`(${createParser.toString()})()`);
  for (const name of fs.readdirSync(FIX)) {
    const bytes = fs.readFileSync(path.join(FIX, name));
    assert.deepStrictEqual(again.parsePlaylist(bytes, { fileName: name }), parsePlaylist(bytes, { fileName: name }), name);
  }
});
