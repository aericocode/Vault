/**
 * Share privately: the "personal details" check and the cleaned copies
 * (setting "Check files for personal details", off by default; with it off
 * nothing here is ever called and no file is opened for it).
 *
 * WHAT COUNTS AS PERSONAL. Location (GPS, a place); the device (make, model,
 * serial numbers, a lens serial, the computer's name, a camera's maker notes);
 * names (author, artist, owner, copyright, creator, "by" fields); free text
 * (comment, description, title). In ANY field, also a value that looks like a
 * drive or user-folder path (C:\..., \\server\..., /Users/..., /home/...), an
 * email address or coordinates. NOT personal: encoder, muxer and software
 * names, dates and times, technical stream facts.
 *
 * STATUS (detect): 'personal' (something found), 'clean' (looked everywhere
 * this check knows and found nothing), 'unchecked' (a type Vault does not
 * read: webp, heic, gif, pdf...; packed as it is and step 1 says so) or
 * 'failed' (a type Vault does read, JPEG, PNG or anything ffprobe opens, but
 * the check did not finish: the tool exited non-zero, hit its time limit or
 * output cap, a parser gave up, a cap below was passed, the file changed while
 * it was read, or anything threw). 'failed' is never treated or cached as
 * clean: with "Remove from the packed copies" the share stops and names the
 * file; with "Share as they are" it is packed as it is.
 *
 * WHERE IT LOOKS:
 *   JPEG   every APPn and COM segment wherever it sits (before the picture data
 *          and between progressive scans): EXIF (every directory, GPS
 *          included, and whether maker notes are there), XMP (also the
 *          extended parts), IPTC in Photoshop's APP13, COM, Ducky (APP12); any
 *          other APPn for paths, emails and coordinates in its text. The data
 *          after the end-of-image marker (up to LIMITS.tail, else 'failed') is
 *          scanned too, and any JPEG found in it (up to LIMITS.embedded) has
 *          its segments read like the main picture's.
 *   PNG    tEXt, zTXt, iTXt (XMP and ImageMagick's raw profiles too), eXIf;
 *          the text of every chunk not needed to draw it (private ones such as
 *          prVt, iCCP and sPLT names); the data after IEND (same cap).
 *   others ffprobe (lib/ffmpeg-locate.js finds it, as everywhere in Vault):
 *          container tags, each stream's tags, chapter titles, GPS tracks, MKV
 *          attachment names and types. For MP4/MOV also Adobe's XMP, read from
 *          the file: a top-level uuid box, moov/udta/XMP_ and each
 *          trak/udta/XMP_. A cover picture's own label ("Cover (front)",
 *          "Other") is not personal; its title and comment are still scanned
 *          for paths, emails and coordinates. A picture ffprobe reads (webp,
 *          heic, gif...) is flagged only when its tags show something;
 *          otherwise it is 'unchecked', because ffprobe does not show its EXIF
 *          or XMP.
 *   Not looked inside: JPEG picture data (no text can be read there), the
 *   contents of MKV attachments (fonts) and of a cover picture when the file
 *   is otherwise clean (a cover is dropped from any cleaned copy, below).
 *
 * CLEANED COPIES (cleanCopy): only for a file this check flagged, and only
 * into the share's own work folder. The original is opened read-only (fs
 * reads, ffmpeg input); the copy is a brand-new file (O_EXCL, or ffmpeg -n
 * on a fresh random name), checked to have one link only, then renamed to its
 * name in the archive and given the original's modified date.
 *   video and audio: ffmpeg stream copy of the video (cover pictures left
 *     out), audio and subtitle streams and the MKV attachments (fonts that
 *     styled subtitles need; each gets back a plain file name, else
 *     "attachment-N.ext", and its type), no re-encode; global, stream and
 *     chapter metadata dropped (chapters keep their times, not their titles);
 *     data streams (GPS and other timed metadata tracks) dropped; bitexact, so
 *     no encoder tag is written. The copy must have as many video, audio,
 *     subtitle and attachment streams as the original and no cover.
 *   JPEG: read and written in 1 MB blocks (never the whole file in memory, no
 *     long block of the event loop; at most LIMITS.jpegMax). Every APPn and COM
 *     dropped, before and between the scans, and anything after the end of
 *     the picture; kept: the ICC colour profile, a minimal JFIF header,
 *     Adobe's colour transform marker, and the orientation as a new EXIF
 *     block that holds nothing else. Picture data is copied byte for byte.
 *   PNG: text chunks, eXIf, every chunk not needed to draw it and anything
 *     after IEND dropped; kept every chunk needed to draw it (colour,
 *     transparency, animation) and the orientation as a new eXIf that holds
 *     nothing else.
 * The copy is then checked again with the same checker; if it still shows
 * something, if that check failed, if the tool failed, or if the copy is
 * missing, empty or far too small, cleanCopy throws CLEAN_FAILED and the share
 * fails (never a quiet fall back to the original). "Far too small" for video
 * and audio: under half of the original less its covers (each cover's bytes
 * measured by ffmpeg, never read from a header), less up to 16 KB for tags;
 * the same rule for every file, so a copy cut short is refused even when a
 * cover went or its header claims the full length.
 *
 * UNTRUSTED INPUT. Every read is bounded (LIMITS) and every offset checked;
 * passing a cap makes the check 'failed', never 'clean'. Parsing is linear
 * (no backtracking regular expressions over file data) and works in blocks
 * with awaits between them, so a hostile file cannot stall the event loop.
 * ffprobe and ffmpeg run with an args array (no shell), the path as
 * "file:<absolute path>" (a name starting with "-" or holding ":" or "|" is
 * never read as an option or a protocol), with a time limit and killed on
 * cancel. At most LIMITS.concurrency checks run at once.
 *
 * PERSONAL DATA. Found values live in memory only (the session cache below,
 * keyed by path and by size, modified time, change time, file id and volume;
 * only finished checks are kept), are never logged, never written to the
 * database, a share row or an error message. They are shortened, and control
 * and direction characters are removed, before they leave here.
 * forget() drops all of it (lock, exit, setting or feature off).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');
const ffLocate = require('../ffmpeg-locate');

const KB = 1024;
const MB = 1024 * KB;
const LIMITS = Object.freeze({
  jpegMax: 128 * MB,      // a bigger JPEG is not checked ("the check failed") nor cleaned
  tail: 16 * MB,          // bytes after a JPEG's or PNG's end looked at; more: the check failed
  jpegMarkers: 200000,    // markers in a JPEG's picture data (scans, tables, APPn between scans)
  embedded: 8,            // pictures found after a JPEG's end marker whose headers are read
  segments: 2000,         // JPEG segments before the picture data
  ifdEntries: 1000,       // entries in one TIFF directory
  ifds: 24,               // TIFF directories in one EXIF block
  tags: 200000,           // tags and values looked at per file, all kinds
  value: 4096,            // characters of one value looked at
  pngChunks: 400000,
  pngText: 8 * MB,        // bytes of PNG text chunks read
  pngOther: 8 * MB,       // bytes of unknown ancillary PNG chunks read
  inflate: 2 * MB,        // a compressed PNG text, unpacked
  inflateTotal: 16 * MB,  // everything unpacked in one file
  xmp: 2 * MB,
  xmpTags: 1000000,       // XML tags walked in one XMP packet
  isoBoxes: 100000,       // MP4/MOV boxes walked
  binScan: 64 * MB,       // bytes of binary data scanned for paths, emails, coordinates, per file
  findings: 32,           // raw findings kept per file
  shown: 60,              // characters of one value shown on step 1
  group: 90,              // characters of one line (a category) shown
  probeMs: 30 * 1000,
  probeOut: 8 * MB,
  cleanIdleMs: 5 * 60 * 1000,
  concurrency: 3,
  cache: 20000,
  checks: 8,              // step 1 checks kept at once
  checkIdleMs: 10 * 60 * 1000,
  wantedMs: 20 * 1000,    // a step 1 check nobody asked about for this long stops
});

const CATS = ['Location', 'Device', 'Name', 'Title', 'Comment', 'Folder path', 'Email', 'Picture'];

function _err(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra || {});
}

/* ── Text: what may be shown ──────────────────────────────────────────── */

// Control characters, the C1 range, zero-width and direction marks, line and
// paragraph separators, BOM, interlinear annotation: never shown.
const CTRL_RX = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
const LONE_SURROGATE_RX = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** A value as text, bounded, with every character that could hide or reorder text removed. */
function tidy(v) {
  let s;
  if (typeof v === 'string') s = v;
  else if (Buffer.isBuffer(v)) s = v.subarray(0, LIMITS.value * 4).toString('utf8');
  else if (v == null) s = '';
  else s = String(v);
  if (s.length > LIMITS.value) s = s.slice(0, LIMITS.value);
  return s.replace(LONE_SURROGATE_RX, ' ').replace(CTRL_RX, ' ').replace(/\s+/g, ' ').trim();
}

/** At most n characters (whole characters, never half a pair), "..." when cut. */
function shorten(s, n) {
  const a = Array.from(String(s));
  return a.length > n ? `${a.slice(0, Math.max(1, n - 3)).join('')}...` : a.join('');
}

/* ── Patterns that count in any field ─────────────────────────────────── */

const RX_WIN = /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?=[^\\/\s])[^\r\n"'<>|*?]{1,200}/;
const RX_UNC = /\\\\[A-Za-z0-9][A-Za-z0-9._$-]{0,62}\\[^\s\\][^\r\n"'<>|*?]{0,200}/;
const RX_NIX = /(?<![A-Za-z0-9._~-])\/(?:Users|home|Volumes|media|mnt|root|private\/var|var\/mobile|storage\/emulated|sdcard|run\/media)\/[^\s"'<>]{1,200}/;
const RX_EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z])/;
const RX_ISO6709 = /[+-]\d{1,2}\.\d{2,}[+-]\d{1,3}\.\d{2,}/;
const RX_DECPAIR = /(?<![\d.])-?\d{1,2}\.\d{4,}\s*[,;]\s*-?\d{1,3}\.\d{4,}(?![\d.])/;
const RX_DMS = /\d{1,3}\s*(?:°|deg)\s*\d{1,2}\s*['′]\s*(?:\d{1,2}(?:\.\d+)?\s*["″]\s*)?[NSEW]\b/;

/**
 * ffmpeg's own signature and nothing else: the WHOLE value is "Lavc" or "Lavf"
 * and a version, as libavcodec writes into every JPEG's COM unless asked for
 * bitexact output ("Lavc62.23.103") and libavformat into encoder tags
 * ("Lavf61.7.100"; "Lavc62.23" in an MP3's LAME header, cut to 9 characters).
 * A version always has a dot: a bare "Lavc60" is nothing ffmpeg writes, so it
 * is flagged. Only letters, digits and dots, so it cannot hold a name,
 * a path or a place: not personal. Anything more ("Lavc62.23.103 by Sam", a
 * second line) is still the field it is in. Tested on the tidied value (NULs,
 * line breaks and spaces at either end gone), and only when the raw value is
 * short, so text far past the signature is never cut off unseen.
 */
const ENCODER_SIG_RX = /^Lav[cf]\d{1,3}(?:\.\d{1,5}){1,3}$/i;
const ENCODER_SIG_RAW_MAX = 64;

/** The raw value, tidied, is all of `rx`, and the raw value is at most `max` characters. */
function _wholeIs(v, rx, max) {
  const s = typeof v === 'string' ? v : (v == null ? '' : String(v));
  return s.length <= max && rx.test(tidy(s));
}

/** A raw value that is ffmpeg's signature and nothing else (see ENCODER_SIG_RX). */
function isEncoderSig(v) {
  return _wholeIs(v, ENCODER_SIG_RX, ENCODER_SIG_RAW_MAX);
}

/**
 * Fixed markers libavcodec's JPEG encoder writes as a COM of their own: only
 * "CS=ITU601" (a limited-range picture), no other CS= value exists in it.
 * Exactly that, case and all, the same short raw length as the signature.
 */
const FFMPEG_MARKER_RX = /^CS=ITU601$/;

/**
 * SOFTWARE SIGNATURES: the WHOLE value is what one program writes into a free
 * text field (a JPEG COM, a PNG Comment, "encoded by"): its name, then only
 * its version, build or platform, or the fixed words that program itself
 * writes there. Anything else after the name (free words, "by Sam", a second
 * line, a path) means the field is what it says it is. Same discipline as the
 * ffmpeg signature: tested on the tidied value, only when the raw value is at
 * most SOFTWARE_RAW_MAX characters, so padding cannot push a tail out of view.
 * Each pattern below is the string that program writes:
 *   CREATOR: gd-jpeg v1.0 (using IJG JPEG v62), quality = 90   (libgd, PHP; or ", default quality")
 *   Created with GIMP / Created with The GIMP / Created with GIMP on a Mac   (GIMP's default comment, JPEG and PNG)
 *   LEAD Technologies Inc. V1.01   (LEADTOOLS)
 *   Handmade Software, Inc. Image Alchemy v1.11
 *   Optimized by JPEGmini 3.13.3.15 0x0f7cbd26
 *   Intel(R) JPEG Library, version 1,5,4,36 / version [1.51.12.44]
 *   AppleMark   (QuickTime and older macOS)
 *   Compressed by jpeg-recompress
 *   ACD Systems Digital Imaging   (ACDSee)
 *   File written by Adobe Photoshop¨ 4.0   (Photoshop 4 and 5; the ® in Mac Roman reads as ¨ or as a broken character)
 *   Adobe Photoshop CC 2019 (Windows), Adobe Photoshop 25.0 (Macintosh), Adobe ImageReady, ...
 *   LAME3.100, LAME3.99r, LAME3.90. (its MP3 header, copied into tags), LAME 3.100,
 *   LAME 64bits version 3.100 (http://lame.sf.net)
 *   iTunes v7.6.2, iTunes 12.9.5.5; HandBrake 1.6.1 2023012300; mkvmerge v81.0 64-bit;
 *   libebml v1.4.5 + libmatroska v1.7.1; Exact Audio Copy (Secure mode), Exact Audio Copy V1.6;
 *   Nero AAC codec 1.5.4.0; dBpoweramp Release 17.2; x264 - core 164 r3095 baee400;
 *   ImageMagick 7.1.1-21; foobar2000 v1.6.16; fre:ac v1.1.7; Paint.NET v3.36; Winamp 5.666; ...
 * A version is digits with dots (an optional v before, a -build and one
 * letter after). A program that writes something not shown here is flagged
 * as the field it is in: a cleaned copy too many, never a leak.
 */
const SOFTWARE_RAW_MAX = 128;
const SW_VER = String.raw`v?\d{1,6}(?:\.\d{1,6}){0,4}(?:-\d{1,6})?[a-z]?`;
const SW_PLATFORM = String.raw`(?: \((?:Windows|Macintosh|Mac OS X|Linux)\))?`;
const SOFTWARE_SIG_RX = new RegExp(`^(?:${[
  String.raw`CREATOR: gd-jpeg v\d{1,2}\.\d{1,2} \(using IJG JPEG v\d{1,3}[a-z]?\),(?: quality = \d{1,3}| default quality)`,
  String.raw`Created with (?:The )?GIMP(?: on a Mac)?`,
  String.raw`LEAD Technologies Inc\. V\d{1,2}\.\d{1,3}`,
  String.raw`Handmade Software, Inc\. Image Alchemy v\d{1,2}\.\d{1,3}`,
  String.raw`Optimized by JPEGmini \d{1,2}(?:\.\d{1,4}){1,3}[a-z]?(?: Internal)? 0x[0-9a-f]{8}`,
  String.raw`Intel\(R\) JPEG Library, version (?:\d{1,3}(?:,\d{1,3}){3}|\[\d{1,3}(?:\.\d{1,3}){3}\])`,
  'AppleMark',
  'Compressed by jpeg-recompress',
  'ACD Systems Digital Imaging',
  String.raw`File written by Adobe Photoshop[¨®�]? \d{1,2}\.\d{1,2}`,
  String.raw`Adobe (?:Photoshop(?: Lightroom(?: Classic)?| Elements)?|ImageReady|Illustrator|Fireworks)(?: CS\d{0,2}| CC)?(?: ${SW_VER})?${SW_PLATFORM}`,
  String.raw`LAME(?:\d{1,2}\.\d{1,3}[a-z.]?| ${SW_VER}| \d{2}bits version ${SW_VER}(?: \(http://lame\.sf\.net\))?)?`,
  String.raw`HandBrake(?: ${SW_VER}(?: \d{10})?)?`,
  String.raw`mkvmerge(?: ${SW_VER}(?: (?:32|64)-bit)?)?`,
  String.raw`libebml v\d{1,3}(?:\.\d{1,3}){1,3} \+ libmatroska v\d{1,3}(?:\.\d{1,3}){1,3}`,
  String.raw`Exact Audio Copy(?: V\d{1,2}(?:\.\d{1,3})?(?: (?:pre)?beta \d{1,2})?)?(?: \((?:Secure|Burst|Paranoid)(?: mode)?\))?`,
  String.raw`Nero(?: AAC codec| Burning ROM| Recode| Digital)?(?: ${SW_VER})?`,
  String.raw`dBpoweramp(?: (?:Release|Reference|Music Converter|CD Ripper|Batch Ripper))?(?: R?${SW_VER})?`,
  String.raw`x26[45](?: - core \d{1,4}(?: r\d{1,5})?(?: [0-9a-f]{7})?| ${SW_VER})?`,
  String.raw`(?:Photoshop|IrfanView|XnView|Paint\.NET|Picasa|ImageMagick|GraphicsMagick|libvips|mozjpeg|libjpeg(?:-turbo)?|Exiv2|iTunes|FFmpeg|fre:ac|foobar2000|Winamp|Audacity|Mp3tag|MediaMonkey)(?: ${SW_VER})?${SW_PLATFORM}`,
].join('|')})$`, 'i');

/** A raw free-text value that is only the software that wrote the file (see SOFTWARE_SIG_RX). */
function isSoftware(v) {
  return _wholeIs(v, SOFTWARE_SIG_RX, SOFTWARE_RAW_MAX) || isEncoderSig(v);
}

/** The same, for a JPEG COM or a PNG Comment, which Vault reads raw: also ffmpeg's fixed markers. */
function isSoftwareRaw(v) {
  return isSoftware(v) || _wholeIs(v, FFMPEG_MARKER_RX, ENCODER_SIG_RAW_MAX);
}

/* ── What one file showed ─────────────────────────────────────────────── */

class Found {
  constructor() {
    this.items = [];      // { cat, value }
    this.n = 0;           // tags and values looked at
    this.over = false;    // a limit was reached: not everything was looked at
    this.bad = false;     // the file is not what it says (truncated, malformed)
    this.make = '';
    this.model = '';
    this.device = [];     // serials, host, maker notes
    this.gps = null;      // { lat, lon } in degrees, or true for "some GPS data"
    this.budget = LIMITS.binScan;   // characters and bytes the pattern scan may still look at
    this.inflated = 0;    // bytes unpacked from compressed PNG text so far
  }

  /** One more tag looked at; false (and over) past the limit. */
  tick() {
    this.n += 1;
    if (this.n > LIMITS.tags) { this.over = true; return false; }
    return true;
  }

  /** n more characters or bytes for the pattern scan; false (and over) past the budget. */
  spend(n) {
    this.budget -= n;
    if (this.budget < 0) { this.over = true; return false; }
    return true;
  }

  add(cat, value) {
    const v = tidy(value);
    if (!v || this.items.length >= LIMITS.findings) return;
    // The same text already shown (or a longer one holding it): once is enough.
    if (this.items.some(it => it.value === v || it.value.includes(v))) return;
    this.items.push({ cat, value: v });
  }

  /** A field that is personal by itself (a name, a comment...). Blank values do not count. */
  field(cat, value) {
    const v = tidy(value);
    if (!v || /^[\s._\-0]*$/.test(v)) return;
    this.add(cat, v);
  }

  /** A field that is not personal by itself: only a path, an email or coordinates in it count. */
  scan(value) {
    if (!this.tick()) return;
    const v = tidy(value);
    if (v.length < 5 || !this.spend(v.length)) return;
    this._match(v);
  }

  /** Long text (a text node, the rest of a broken packet): scanned in windows, all of it. */
  scanLong(value) {
    const s = String(value || '');
    if (s.length <= LIMITS.value) { this.scan(s); return; }
    for (let i = 0; i < s.length && !this.over; i += LIMITS.value - 256) this.scan(s.slice(i, i + LIMITS.value));
  }

  _match(v) {
    let m;
    if ((m = RX_WIN.exec(v)) || (m = RX_UNC.exec(v)) || (m = RX_NIX.exec(v))) this.add('Folder path', m[0].trim());
    if (v.includes('@') && (m = RX_EMAIL.exec(v))) this.add('Email', m[0]);
    if ((m = RX_ISO6709.exec(v))) this.add('Location', iso6709(m[0]) || m[0]);
    else if ((m = RX_DECPAIR.exec(v)) || (m = RX_DMS.exec(v))) this.add('Location', m[0]);
  }

  /**
   * Every printable run of a binary block (an unknown segment or chunk, the
   * bytes after a picture's end), all of it, within the per-file budget.
   */
  scanBinary(buf) {
    if (!this.spend(buf.length)) return;
    const s = buf.toString('latin1');
    const re = /[\x20-\x7e]{6,}/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const v = m[0];
      if (v.length <= LIMITS.value) this._match(v);
      else for (let i = 0; i < v.length; i += LIMITS.value - 256) this._match(v.slice(i, i + LIMITS.value));
    }
  }

  setMake(v) { const t = tidy(v); if (t && !this.make) this.make = t; }
  setModel(v) { const t = tidy(v); if (t && !this.model) this.model = t; }
  addDevice(v) { const t = tidy(v); if (t && !this.device.includes(t) && this.device.length < 8) this.device.push(t); }
  addSerial(v, lens = false) {
    const t = tidy(v);
    if (!t || /^[\s0]*$/.test(t)) return;
    this.addDevice(`${lens ? 'lens serial' : 'serial'} ${shorten(t, 7)}`);
  }

  /** Grouped for the page: [{ label, value }], in a fixed order, each line short. */
  findings() {
    const raw = this.items.slice();
    const dev = [];
    const make = this.make;
    const model = this.model;
    if (make || model) {
      dev.push(make && model && !model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]) ? `${make} ${model}` : (model || make));
    }
    dev.push(...this.device);
    raw.unshift(...dev.map(value => ({ cat: 'Device', value })));
    if (this.gps) raw.unshift({ cat: 'Location', value: this.gps === true ? 'GPS data' : `${this.gps.lat.toFixed(2)}, ${this.gps.lon.toFixed(2)}` });
    const out = [];
    for (const cat of CATS) {
      const vals = [];
      for (const it of raw) {
        if (it.cat !== cat) continue;
        const v = shorten(tidy(it.value), LIMITS.shown);
        if (v && !vals.includes(v)) vals.push(v);
      }
      if (vals.length) out.push({ label: cat, value: shorten(vals.join(', '), LIMITS.group) });
    }
    return out;
  }

  personal() {
    return this.items.length > 0 || !!this.gps || !!this.make || !!this.model || this.device.length > 0;
  }
}

/** "+52.3700+004.8900+000.000/" as "52.37, 4.89" (degrees forms only); null when not. */
function iso6709(s) {
  const m = /^\s*([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/.exec(String(s));
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}

/* ── TIFF / EXIF ──────────────────────────────────────────────────────── */

const TIFF_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
// GPS tags that say where (latitude, longitude, altitude, destination, area).
const GPS_WHERE = new Set([1, 2, 3, 4, 5, 6, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1c]);

/**
 * Read a TIFF block (the EXIF of a JPEG after "Exif\0\0", a PNG eXIf).
 * Fills `found`; returns { orientation } (1..8 or null). Never throws: a
 * broken block sets found.bad.
 */
function parseTiff(buf, found, depth = 0) {
  const out = { orientation: null };
  if (!Buffer.isBuffer(buf) || buf.length < 8 || depth > 2) { found.bad = true; return out; }
  const le = buf[0] === 0x49 && buf[1] === 0x49;
  const be = buf[0] === 0x4d && buf[1] === 0x4d;
  if (!le && !be) { found.bad = true; return out; }
  const u16 = (o) => (o >= 0 && o + 2 <= buf.length ? (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : null);
  const u32 = (o) => (o >= 0 && o + 4 <= buf.length ? (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)) : null);
  if (u16(2) !== 42) { found.bad = true; return out; }
  const seen = new Set();
  const queue = [{ off: u32(4), kind: 'ifd0' }];
  const gps = {};
  let gpsWhere = false;
  let ifds = 0;
  const rational = (at, i) => {
    const n = u32(at + i * 8);
    const d = u32(at + i * 8 + 4);
    return n == null || !d ? NaN : n / d;
  };
  while (queue.length) {
    const { off, kind } = queue.shift();
    if (!off) continue;
    if (off < 8 || off + 2 > buf.length) { found.bad = true; if (kind === 'gps') gpsWhere = true; continue; }
    if (seen.has(off)) continue;
    seen.add(off);
    if (++ifds > LIMITS.ifds) { found.over = true; break; }
    const n = u16(off);
    if (n > LIMITS.ifdEntries || off + 2 + n * 12 > buf.length) { found.bad = true; if (kind === 'gps') gpsWhere = true; continue; }
    for (let i = 0; i < n; i++) {
      if (!found.tick()) break;
      const e = off + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = TIFF_SIZES[type];
      if (!size || count == null) continue;
      const bytes = size * count;
      const at = bytes <= 4 ? e + 8 : u32(e + 8);
      if (at == null) continue;
      // A value out of the block: nothing to read (and nothing a reader would show).
      if (at + Math.min(bytes, 8) > buf.length) {
        if (kind === 'gps' && GPS_WHERE.has(tag)) gpsWhere = true;
        if (tag === 0x8825) gpsWhere = true;
        continue;
      }
      const raw = () => buf.subarray(at, Math.min(buf.length, at + Math.min(bytes, LIMITS.value * 2)));
      const ascii = () => raw().toString('utf8').replace(/\0+$/, '').replace(/\0/g, ' ');
      if (kind === 'ifd0' || kind === 'ifd1') {
        if (tag === 0x0112 && kind === 'ifd0' && type === 3) {
          const o = u16(at);
          if (o >= 1 && o <= 8) out.orientation = o;
        } else if (tag === 0x8769 && (type === 4 || type === 13)) queue.push({ off: u32(at), kind: 'exif' });
        else if (tag === 0x8825 && (type === 4 || type === 13)) queue.push({ off: u32(at), kind: 'gps' });
        else if (tag === 0xa005) { /* interoperability: technical only */ }
        else if (tag === 0x010f) found.setMake(ascii());
        else if (tag === 0x0110) found.setModel(ascii());
        else if (tag === 0x013b) found.field('Name', ascii());
        else if (tag === 0x8298) found.field('Name', ascii());
        else if (tag === 0x010e) found.field('Comment', ascii());
        else if (tag === 0x010d) found.field('Title', ascii());
        else if (tag === 0x013c) { const v = tidy(ascii()); if (v) found.addDevice(v); }
        else if (tag >= 0x9c9b && tag <= 0x9c9f) {
          const v = raw().toString('utf16le').replace(/\0+$/, '');
          found.field({ 0x9c9b: 'Title', 0x9c9c: 'Comment', 0x9c9d: 'Name', 0x9c9e: 'Comment', 0x9c9f: 'Title' }[tag], v);
        } else if (tag === 0x02bc) parseXmp(raw().toString('utf8'), found);
        else if (tag === 0x83bb) parseIptc(raw(), found);
        else if (tag === 0x927c) found.addDevice('camera maker notes');
        else if (type === 2) found.scan(ascii());
      } else if (kind === 'exif') {
        if (tag === 0x927c) found.addDevice('camera maker notes');
        else if (tag === 0x9286) found.field('Comment', userComment(raw(), le));
        else if (tag === 0xa430) found.field('Name', ascii());
        else if (tag === 0xa431) found.addSerial(ascii());
        else if (tag === 0xa435) found.addSerial(ascii(), true);
        else if (tag === 0x8825 && (type === 4 || type === 13)) queue.push({ off: u32(at), kind: 'gps' });
        else if (type === 2) found.scan(ascii());
      } else if (kind === 'gps') {
        if (GPS_WHERE.has(tag)) gpsWhere = true;
        if (tag === 1 && type === 2) gps.latRef = ascii().trim().toUpperCase();
        else if (tag === 3 && type === 2) gps.lonRef = ascii().trim().toUpperCase();
        else if (tag === 2 && type === 5 && count >= 3) gps.lat = rational(at, 0) + rational(at, 1) / 60 + rational(at, 2) / 3600;
        else if (tag === 4 && type === 5 && count >= 3) gps.lon = rational(at, 0) + rational(at, 1) / 60 + rational(at, 2) / 3600;
        else if (tag === 0x1c || tag === 0x1b) { /* area or method: shown as GPS data */ }
      }
    }
    const next = u32(off + 2 + n * 12);
    if (kind === 'ifd0' && next) queue.push({ off: next, kind: 'ifd1' });
  }
  if (gpsWhere) {
    let lat = gps.lat;
    let lon = gps.lon;
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      if (gps.latRef === 'S') lat = -lat;
      if (gps.lonRef === 'W') lon = -lon;
      if (!found.gps || found.gps === true) found.gps = { lat, lon };
    } else if (!found.gps) found.gps = true;
  }
  return out;
}

/** EXIF UserComment: an 8-byte character code, then the text. */
function userComment(b, le) {
  if (!b || b.length <= 8) return '';
  const code = b.subarray(0, 8).toString('latin1');
  const body = b.subarray(8);
  if (code.startsWith('UNICODE')) {
    if (le) return body.toString('utf16le');
    const sw = Buffer.from(body);
    if (sw.length % 2) return '';
    sw.swap16();
    return sw.toString('utf16le');
  }
  return body.toString('utf8');
}

/** A minimal EXIF (TIFF) block holding only the orientation. */
function orientationTiff(o) {
  const t = Buffer.alloc(26);
  t.write('II', 0, 'latin1');
  t.writeUInt16LE(42, 2);
  t.writeUInt32LE(8, 4);
  t.writeUInt16LE(1, 8);           // one entry
  t.writeUInt16LE(0x0112, 10);     // Orientation
  t.writeUInt16LE(3, 12);          // SHORT
  t.writeUInt32LE(1, 14);          // count
  t.writeUInt16LE(o, 18);          // value (padded to 4 bytes)
  t.writeUInt32LE(0, 22);          // no next directory
  return t;
}

/* ── IPTC and Photoshop resources ─────────────────────────────────────── */

const IPTC_FIELDS = {
  5: 'Title', 80: 'Name', 90: 'Location', 92: 'Location', 95: 'Location', 101: 'Location',
  105: 'Title', 110: 'Name', 116: 'Name', 118: 'Name', 120: 'Comment', 122: 'Name',
};

function parseIptc(buf, found) {
  let p = 0;
  while (p + 5 <= buf.length) {
    if (buf[p] !== 0x1c) { if (buf[p] === 0) { p++; continue; } found.bad = true; break; }
    const rec = buf[p + 1];
    const ds = buf[p + 2];
    let len = buf.readUInt16BE(p + 3);
    p += 5;
    if (len & 0x8000) {
      const k = len & 0x7fff;
      if (k < 1 || k > 4 || p + k > buf.length) { found.bad = true; break; }
      len = buf.readUIntBE(p, k);
      p += k;
    }
    if (p + len > buf.length) { found.bad = true; break; }
    if (!found.tick()) break;
    if (rec === 2 && ds !== 0) {
      const v = buf.subarray(p, p + Math.min(len, LIMITS.value)).toString('utf8');
      if (IPTC_FIELDS[ds]) found.field(IPTC_FIELDS[ds], v);
      else found.scan(v);
    }
    p += len;
  }
}

function parseIrb(buf, found) {
  let p = 0;
  let count = 0;
  while (p + 12 <= buf.length) {
    if (++count > 1000) { found.over = true; break; }
    if (buf.toString('latin1', p, p + 4) !== '8BIM') { if (buf[p] === 0) break; found.bad = true; break; }
    const id = buf.readUInt16BE(p + 4);
    const nlen = buf[p + 6];
    let q = p + 7 + nlen;
    if ((nlen + 1) % 2) q += 1;
    if (q + 4 > buf.length) { found.bad = true; break; }
    const size = buf.readUInt32BE(q);
    q += 4;
    if (q + size > buf.length) { found.bad = true; break; }
    const data = buf.subarray(q, q + size);
    if (id === 0x0404) parseIptc(data, found);
    else if (id === 0x0422 || id === 0x0423) parseTiff(data, found, 1);
    else if (id === 0x0424) parseXmp(data.toString('utf8'), found);
    p = q + size + (size % 2);
  }
}

/* ── XMP ──────────────────────────────────────────────────────────────── */

const XMP_FIELDS = [
  ['exif:GPSLatitude', 'gpslat'], ['exif:GPSLongitude', 'gpslon'], ['exif:GPSAltitude', 'Location'],
  ['exif:GPSAreaInformation', 'Location'], ['exif:GPSDestLatitude', 'Location'],
  ['photoshop:City', 'Location'], ['photoshop:State', 'Location'], ['photoshop:Country', 'Location'],
  ['Iptc4xmpCore:Location', 'Location'], ['Iptc4xmpExt:City', 'Location'], ['Iptc4xmpExt:Sublocation', 'Location'],
  ['Iptc4xmpExt:ProvinceState', 'Location'], ['Iptc4xmpExt:CountryName', 'Location'],
  ['tiff:Make', 'make'], ['tiff:Model', 'model'], ['aux:SerialNumber', 'serial'], ['exifEX:BodySerialNumber', 'serial'],
  ['aux:LensSerialNumber', 'lensserial'], ['exifEX:LensSerialNumber', 'lensserial'],
  ['exifEX:CameraOwnerName', 'Name'], ['aux:OwnerName', 'Name'],
  ['dc:creator', 'Name'], ['dc:rights', 'Name'], ['xmpRights:Owner', 'Name'], ['photoshop:Credit', 'Name'],
  ['photoshop:CaptionWriter', 'Name'], ['photoshop:AuthorsPosition', 'Name'], ['xmpDM:artist', 'Name'],
  ['xmpDM:composer', 'Name'], ['tiff:Artist', 'Name'], ['tiff:Copyright', 'Name'],
  ['dc:title', 'Title'], ['photoshop:Headline', 'Title'],
  ['dc:description', 'Comment'], ['exif:UserComment', 'Comment'], ['tiff:ImageDescription', 'Comment'], ['xmpDM:logComment', 'Comment'],
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  s = String(s);
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]{2,4});/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
    }
    return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
  });
}

/** "52,22.200N" (XMP's GPS form) in degrees, or NaN. */
function xmpCoord(s) {
  const m = /^\s*(\d{1,3}),(\d{1,2}(?:\.\d+)?)(?:,(\d{1,2}(?:\.\d+)?))?\s*([NSEW])\s*$/i.exec(String(s));
  if (!m) return NaN;
  let v = Number(m[1]) + Number(m[2]) / 60 + (m[3] ? Number(m[3]) / 3600 : 0);
  if (/[SW]/i.test(m[4])) v = -v;
  return v;
}

const XMP_FIELD_MAP = new Map(XMP_FIELDS);
const XMP_DEPTH = 256;

function _isSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/**
 * An XMP packet (XML), read in ONE linear pass: no regular expression runs
 * over the packet, every search moves forward only, so a broken or hostile
 * packet (unclosed elements, an unclosed quote, millions of tags) costs time
 * in proportion to its size, never more. The text and attribute values of
 * the fields above count by field (the innermost open field takes the text);
 * every text and attribute value is also scanned for paths, emails and
 * coordinates. A packet over LIMITS.xmp is not looked at past the limit and
 * counts as over (the check failed).
 */
function parseXmp(text, found) {
  let s = String(text || '');
  if (s.length > LIMITS.xmp) { s = s.slice(0, LIMITS.xmp); found.over = true; }
  const n = s.length;
  if (!n) return;
  let lat = NaN;
  let lon = NaN;
  const stack = [];            // open elements: { name, cat }
  const fields = [];           // the cats of the open field elements, innermost last
  const open = new Map();      // name -> how many of it are on the stack
  const value = (cat, v) => {   // v: entities already decoded
    if (!found.tick()) return;
    if (!tidy(v)) return;
    if (cat === 'gpslat') { lat = xmpCoord(v); if (!found.gps) found.gps = true; }
    else if (cat === 'gpslon') { lon = xmpCoord(v); if (!found.gps) found.gps = true; }
    else if (cat === 'make') found.setMake(v);
    else if (cat === 'model') found.setModel(v);
    else if (cat === 'serial') found.addSerial(v);
    else if (cat === 'lensserial') found.addSerial(v, true);
    else found.field(cat, v);
  };
  const textAt = (a, b) => {
    let k = a;
    while (k < b && _isSpace(s.charCodeAt(k))) k++;
    if (k >= b) return;
    const t = decodeEntities(s.slice(a, b));
    if (fields.length) value(fields[fields.length - 1], t);
    found.scanLong(t);
  };
  const attr = (name, raw) => {
    if (name.startsWith('xmlns') || !raw) return;
    const v = decodeEntities(raw);
    const cat = XMP_FIELD_MAP.get(name);
    if (cat) value(cat, v);
    found.scanLong(v);
  };
  const attrs = (a, b) => {
    let i = a;
    while (i < b && !found.over) {
      while (i < b && _isSpace(s.charCodeAt(i))) i++;
      const ns = i;
      while (i < b && s[i] !== '=' && s[i] !== '"' && s[i] !== "'" && !_isSpace(s.charCodeAt(i))) i++;
      const an = s.slice(ns, i);
      while (i < b && _isSpace(s.charCodeAt(i))) i++;
      if (s[i] !== '=' || i >= b) { if (i === ns) i++; continue; }
      i++;
      while (i < b && _isSpace(s.charCodeAt(i))) i++;
      const q = s[i];
      if (q !== '"' && q !== "'") continue;
      const vs = ++i;
      while (i < b && s[i] !== q) i++;
      attr(an, s.slice(vs, i));
      i++;
    }
  };
  const openEl = (name) => {
    if (stack.length >= XMP_DEPTH) return;   // deeper than this: not tracked (its text goes to the field open above it)
    const cat = XMP_FIELD_MAP.get(name) || null;
    stack.push({ name, cat });
    if (cat) fields.push(cat);
    open.set(name, (open.get(name) || 0) + 1);
  };
  const closeEl = (name) => {
    if (!open.get(name)) return;   // not open (or too deep to be tracked): nothing to close
    for (;;) {
      const top = stack.pop();
      open.set(top.name, open.get(top.name) - 1);
      if (top.cat) fields.pop();
      if (top.name === name) return;
    }
  };
  let p = 0;
  let tags = 0;
  while (p < n && !found.over) {
    const lt = s.indexOf('<', p);
    textAt(p, lt < 0 ? n : lt);
    if (lt < 0) break;
    if (++tags > LIMITS.xmpTags) { found.over = true; break; }
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4);
      found.scanLong(s.slice(lt + 4, e < 0 ? n : e));
      p = e < 0 ? n : e + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt + 9);
      textAt(lt + 9, e < 0 ? n : e);
      p = e < 0 ? n : e + 3;
      continue;
    }
    if (s.startsWith('<?', lt)) {
      const e = s.indexOf('?>', lt + 2);
      found.scanLong(s.slice(lt + 2, e < 0 ? n : e));
      p = e < 0 ? n : e + 2;
      continue;
    }
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) { found.scanLong(decodeEntities(s.slice(lt + 1))); break; }
    p = gt + 1;
    let i = lt + 1;
    if (s[i] === '!') continue;   // a declaration
    const closing = s[i] === '/';
    if (closing) i++;
    let j = i;
    while (j < gt && s[j] !== '/' && !_isSpace(s.charCodeAt(j))) j++;
    const name = s.slice(i, j);
    if (closing) { closeEl(name); continue; }
    const selfClosing = s[gt - 1] === '/';
    attrs(j, selfClosing ? gt - 1 : gt);
    if (!selfClosing && name) openEl(name);
  }
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
      && (found.gps === true || !found.gps)) found.gps = { lat, lon };
}

/* ── JPEG ─────────────────────────────────────────────────────────────── */

const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT_ID = 'http://ns.adobe.com/xmp/extension/\0';

function _startsWith(buf, s) {
  return buf.length >= s.length && buf.toString('latin1', 0, s.length) === s;
}

/** Ducky (APP12, Photoshop "Save for Web"): its comment and copyright. */
function parseDucky(buf, found) {
  let p = 5;   // "Ducky"
  let guard = 0;
  while (p + 4 <= buf.length && guard++ < 16) {
    const tag = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    p += 4;
    if (tag === 0 || p + len > buf.length) break;
    if ((tag === 2 || tag === 3) && len > 4) {
      const b = Buffer.from(buf.subarray(p + 4, p + len));
      if (b.length % 2 === 0) { b.swap16(); found.field(tag === 2 ? 'Comment' : 'Name', b.toString('utf16le')); }
    }
    p += len;
  }
}

/** One APPn or COM payload of a JPEG. Returns the orientation from EXIF, if any. */
function jpegSegment(marker, payload, found, ctx) {
  if (marker === 0xfe) {
    const v = payload.toString('utf8');
    if (isSoftwareRaw(v)) found.scan(v); else found.field('Comment', v);
    return;
  }
  if (marker === 0xe1 && _startsWith(payload, 'Exif')) {
    const r = parseTiff(payload.subarray(6), found);
    if (ctx.orientation == null && r.orientation) ctx.orientation = r.orientation;
    return;
  }
  if (marker === 0xe1 && _startsWith(payload, XMP_ID)) { parseXmp(payload.subarray(XMP_ID.length).toString('utf8'), found); return; }
  if (marker === 0xe1 && _startsWith(payload, XMP_EXT_ID)) {
    const part = payload.subarray(XMP_EXT_ID.length + 40);
    ctx.xmpExtBytes = (ctx.xmpExtBytes || 0) + part.length;
    if (ctx.xmpExtBytes <= LIMITS.xmp) ctx.xmpExt.push(part); else found.over = true;
    return;
  }
  if (marker === 0xe2 && (_startsWith(payload, 'ICC_PROFILE\0') || _startsWith(payload, 'MPF\0'))) return;
  if (marker === 0xe0 && (_startsWith(payload, 'JFIF\0') || _startsWith(payload, 'JFXX\0'))) return;
  if (marker === 0xee && _startsWith(payload, 'Adobe')) return;
  if (marker === 0xed && _startsWith(payload, 'Photoshop 3.0\0')) {
    ctx.irbBytes = (ctx.irbBytes || 0) + payload.length - 14;
    if (ctx.irbBytes <= LIMITS.xmp) ctx.irb.push(payload.subarray(14)); else found.over = true;
    return;
  }
  if (marker === 0xec && _startsWith(payload, 'Ducky')) { parseDucky(payload, found); return; }
  found.scanBinary(payload);
}

/**
 * A file read one block (1 MB) at a time with positional reads: what the
 * JPEG walk sees of the file. Every read is an await, so a long file never
 * holds the event loop for more than one block's work.
 */
class _Blocks {
  constructor(fh, size) {
    this.fh = fh;
    this.size = size;
    this.base = 0;
    this.buf = Buffer.alloc(0);
    this.store = null;   // one block reused for every read (payloads handed out are copies)
  }

  has(pos, n) { return pos >= this.base && pos + n <= this.base + this.buf.length; }

  /** [pos, pos + n) in hand; false when the file is shorter. */
  async need(pos, n) {
    if (this.has(pos, n)) return true;
    if (pos < 0 || pos + n > this.size) return false;
    const len = Math.min(Math.max(n, MB), this.size - pos);
    if (!this.store || this.store.length < len) this.store = Buffer.allocUnsafe(Math.max(len, MB));
    this.buf = Buffer.alloc(0);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await this.fh.read(this.store, got, len - got, pos + got);
      if (!bytesRead) return false;
      got += bytesRead;
    }
    this.base = pos;
    this.buf = this.store.subarray(0, len);
    return true;
  }

  at(pos) { return this.buf[pos - this.base]; }
  u16(pos) { return this.buf.readUInt16BE(pos - this.base); }
  copy(pos, end) { return Buffer.from(this.buf.subarray(pos - this.base, end - this.base)); }

  /**
   * Where the next marker in picture data is, at or after pos: an 0xFF that
   * is not stuffing (FF 00), a restart (FF D0..D7) or fill (FF FF). -1 when
   * the file ends first. The search runs synchronously inside the block in
   * hand (no await per byte) and reads the next block only when needed.
   */
  async nextMarker(pos) {
    while (pos < this.size) {
      if (!this.has(pos, 2) && !(await this.need(pos, Math.min(2, this.size - pos)))) return -1;
      const buf = this.buf;
      let k = pos - this.base;
      for (;;) {
        k = buf.indexOf(0xff, k);
        if (k < 0) { pos = this.base + buf.length; break; }
        if (k + 1 >= buf.length) { pos = this.base + k; if (pos + 2 > this.size) return -1; break; }
        const m = buf[k + 1];
        if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) { k += 2; continue; }
        if (m === 0xff) { k += 1; continue; }
        return this.base + k;
      }
      // pos is at the end of the block, or at an 0xFF whose next byte is in the next block.
      if (pos < this.size && !(await this.need(pos, Math.min(2, this.size - pos)))) return -1;
    }
    return -1;
  }
}

const _isApp = m => (m >= 0xe0 && m <= 0xef) || m === 0xfe;

/**
 * Walk a JPEG from its start marker to its end marker: every segment before
 * the picture data, the picture data, and every marker between the scans.
 * onApp(marker, payload, pos) for each APPn and COM ANYWHERE (before the
 * first scan or between scans; payload is a copy). keep: also list, in
 * order, the other segments and the picture data as { pos, end } ranges
 * (what the cleaner copies). headerOnly: stop at the first scan.
 * Returns { ok, items, eoi } (eoi: where the end marker is); ok false when
 * the file is not a JPEG it can follow to its end, with found.bad (broken,
 * no end marker) or found.over (a limit) set. Never reads past `size`.
 */
async function _jpegWalk(fh, size, found, { start = 0, onApp = null, keep = false, headerOnly = false, handle = null } = {}) {
  const r = new _Blocks(fh, size);
  const items = keep ? [] : null;
  const push = (pos, end) => {
    if (!items || end <= pos) return;
    const last = items[items.length - 1];
    if (last && last.end === pos) last.end = end; else items.push({ pos, end });
  };
  const bad = () => { found.bad = true; return { ok: false }; };
  if (!(await r.need(start, 3)) || r.at(start) !== 0xff || r.at(start + 1) !== 0xd8) return bad();
  let pos = start + 2;
  let segs = 0;
  // Before the picture data.
  for (;;) {
    if (!(await r.need(pos, 2))) return bad();
    if (r.at(pos) !== 0xff) return bad();
    const m = r.at(pos + 1);
    if (m === 0xff) { pos += 1; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { pos += 2; continue; }
    if (m === 0xd9) return bad();
    if (++segs > LIMITS.segments) { found.over = true; return { ok: false }; }
    if (!(await r.need(pos, 4))) return bad();
    const len = r.u16(pos + 2);
    if (len < 2 || pos + 2 + len > size) return bad();
    if (_isApp(m)) {
      if (!(await r.need(pos, 2 + len))) return bad();
      if (onApp) onApp(m, r.copy(pos + 4, pos + 2 + len), pos);
    } else push(pos, pos + 2 + len);
    pos += 2 + len;
    if (found.over) return { ok: false };
    if (m === 0xda) break;
  }
  if (headerOnly) return { ok: true, items, eoi: null };
  // The picture data, and the markers between scans (tables, restarts, more
  // scans, and any APPn or COM someone put there).
  let dataStart = pos;
  let markers = 0;
  for (;;) {
    if (handle && handle.cancelled) throw _err('CANCELLED', 'Packing was cancelled.');
    const i = await r.nextMarker(pos);
    if (i < 0 || !(await r.need(i, 2))) return bad();   // no end marker
    const m = r.at(i + 1);
    if (++markers > LIMITS.jpegMarkers) { found.over = true; return { ok: false }; }
    push(dataStart, i);
    if (m === 0xd9) return { ok: true, items, eoi: i };
    if (m === 0x01) { push(i, i + 2); pos = i + 2; dataStart = pos; continue; }
    if (!(await r.need(i, 4))) return bad();
    const len = r.u16(i + 2);
    if (len < 2 || i + 2 + len > size) return bad();
    if (_isApp(m)) {
      if (!(await r.need(i, 2 + len))) return bad();
      if (onApp) onApp(m, r.copy(i + 4, i + 2 + len), i);
      if (found.over) return { ok: false };
    } else push(i, i + 2 + len);
    pos = i + 2 + len;
    dataStart = pos;
  }
}

/** What the EXIF/XMP/IPTC parts of one JPEG's segments showed, once all are in. */
function _jpegCtx() {
  return { orientation: null, xmpExt: [], xmpExtBytes: 0, irb: [], irbBytes: 0 };
}
function _jpegCtxDone(ctx, found) {
  if (ctx.irb.length) parseIrb(Buffer.concat(ctx.irb), found);
  if (ctx.xmpExt.length) parseXmp(Buffer.concat(ctx.xmpExt).toString('utf8'), found);
}

const SOI3 = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Bytes [start, end) of a file, one block at a time with a small overlap
 * (a run across two blocks is seen whole): every printable run scanned for
 * paths, emails and coordinates. onBlock(buf, pos, own) for each block, own
 * being how many of its bytes are not the overlap.
 */
async function _scanRange(fh, start, end, found, onBlock = null) {
  for (let p = start; p < end && !found.over; p += MB) {
    const stop = Math.min(end, p + MB + 4 * KB);
    const b = await _readAt(fh, p, stop - p);
    if (!b) { found.bad = true; return; }
    found.scanBinary(b);
    if (onBlock) onBlock(b, p, Math.min(MB, end - p));
  }
}

/**
 * After a JPEG's end marker: up to LIMITS.tail bytes scanned in full, and
 * the segments of every picture found in them (a gain map, a depth map, a
 * second frame) read like the main picture's. More than that: over (the
 * check failed). A broken picture there does not make the file broken: its
 * bytes were all scanned anyway, and a cleaned copy never keeps them.
 */
async function _jpegTail(fh, size, start, found) {
  const len = size - start;
  if (len <= 0) return;
  if (len > LIMITS.tail) { found.over = true; return; }
  const pics = [];
  await _scanRange(fh, start, size, found, (b, p, own) => {
    for (let k = b.indexOf(SOI3); k >= 0 && k < own; k = b.indexOf(SOI3, k + 1)) {
      pics.push(p + k);
      if (pics.length > LIMITS.embedded) { found.over = true; return; }
    }
  });
  for (const at of pics) {
    if (found.over) return;
    const wasBad = found.bad;
    const ctx = _jpegCtx();
    await _jpegWalk(fh, size, found, { start: at, headerOnly: true, onApp: (m, payload) => jpegSegment(m, payload, found, ctx) });
    _jpegCtxDone(ctx, found);
    found.bad = wasBad;
  }
}

async function _detectJpeg(fh, size, found) {
  const ctx = _jpegCtx();
  if (size > LIMITS.jpegMax) { found.over = true; return ctx; }
  const w = await _jpegWalk(fh, size, found, { onApp: (m, payload) => jpegSegment(m, payload, found, ctx) });
  _jpegCtxDone(ctx, found);
  if (w.ok) await _jpegTail(fh, size, w.eoi + 2, found);
  return ctx;
}

/**
 * The cleaned JPEG as pieces: Buffers (new blocks) and { from: [start, end] }
 * ranges of the original. Kept: the picture's own segments and data byte for
 * byte, the ICC profile, a minimal JFIF header, Adobe's colour marker, and
 * the orientation as a new EXIF block holding nothing else. Every other APPn
 * and COM, before or between the scans, goes, and so does everything after
 * the end marker. Throws BAD_JPEG when it cannot follow the file to its end.
 */
async function _jpegPieces(fh, size, handle = null) {
  if (size > LIMITS.jpegMax) throw _err('BAD_JPEG', 'Too large.');
  const found = new Found();
  let orientation = null;
  let jfif = null;
  let adobe = null;
  const icc = [];
  const w = await _jpegWalk(fh, size, found, {
    keep: true, handle,
    onApp: (m, payload, pos) => {
      const range = { from: [pos, pos + 4 + payload.length] };
      if (m === 0xe1 && _startsWith(payload, 'Exif') && orientation == null) {
        orientation = parseTiff(payload.subarray(6), new Found()).orientation || 0;
      } else if (m === 0xe2 && _startsWith(payload, 'ICC_PROFILE\0')) icc.push(range);
      else if (m === 0xe0 && _startsWith(payload, 'JFIF\0') && !jfif && payload.length >= 12) {
        const j = Buffer.alloc(18);
        j.writeUInt16BE(0xffe0, 0);
        j.writeUInt16BE(16, 2);
        j.write('JFIF\0', 4, 'latin1');
        payload.copy(j, 9, 5, 12);   // version, units, densities
        j[16] = 0; j[17] = 0;         // no thumbnail
        jfif = j;
      } else if (m === 0xee && _startsWith(payload, 'Adobe') && payload.length === 12 && !adobe) adobe = range;
      // every other APPn and COM goes
    },
  });
  if (!w.ok) throw _err('BAD_JPEG', 'Broken JPEG.');
  const pieces = [Buffer.from([0xff, 0xd8])];
  if (jfif) pieces.push(jfif);
  if (orientation && orientation >= 2 && orientation <= 8) {
    const t = orientationTiff(orientation);
    const a = Buffer.alloc(4 + 6);
    a.writeUInt16BE(0xffe1, 0);
    a.writeUInt16BE(2 + 6 + t.length, 2);
    a.write('Exif\0\0', 4, 'latin1');
    pieces.push(a, t);
  }
  pieces.push(...icc);
  if (adobe) pieces.push(adobe);
  for (const it of w.items) pieces.push({ from: [it.pos, it.end] });
  pieces.push(Buffer.from([0xff, 0xd9]));
  return pieces;
}

/** A Buffer seen through the file-handle read the walk uses. */
function _bufHandle(buf) {
  return {
    read: async (b, off, len, pos) => {
      const n = Math.max(0, Math.min(len, buf.length - pos));
      if (n) buf.copy(b, off, pos, pos + n);
      return { bytesRead: n };
    },
  };
}

/**
 * The cleaned JPEG of a whole Buffer, as a list of Buffers (tests, small
 * files). Rejects with BAD_JPEG like the cleaner.
 */
async function jpegStrip(buf) {
  if (!Buffer.isBuffer(buf) || !(buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8)) throw _err('BAD_JPEG', 'Not a JPEG.');
  const pieces = await _jpegPieces(_bufHandle(buf), buf.length);
  return pieces.map(p => (Buffer.isBuffer(p) ? p : buf.subarray(p.from[0], p.from[1])));
}

/* ── PNG ──────────────────────────────────────────────────────────────── */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_TEXT = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf']);
// Ancillary chunks a viewer needs to draw the picture as it was (colour,
// transparency, density, animation). Unknown ancillary chunks go.
const PNG_KEEP = new Set(['tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'mDCv', 'cLLI', 'cLLi',
  'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT']);
const PNG_QUIET_KEYS = /^(software|creation time|date:.*|png:.*|icc:.*|signature|thumb::.*|exif:(date.*|offset.*|subsec.*|exif.*|pixel.*|color.*|components.*|compression|orientation|resolution.*|x.*resolution|y.*resolution|flashpix.*|scene.*|exposure.*|f.*number|iso.*|shutter.*|aperture.*|focal.*|flash|white.*|metering.*|brightness.*|light.*|sensing.*|contrast|saturation|sharpness|gain.*|digital.*|custom.*|subject.*distance.*|interop.*|thumbnail.*|jpeg.*|ycbcr.*|bits.*|photometric.*|samples.*|planar.*|software|version|max.*))$/i;

/** Unpacked, at most LIMITS.inflate, and LIMITS.inflateTotal per file (over past it); null when it cannot be. */
function _inflate(b, found) {
  if (found.inflated >= LIMITS.inflateTotal) { found.over = true; return null; }
  let out;
  try {
    out = zlib.inflateSync(b, { maxOutputLength: Math.min(LIMITS.inflate, LIMITS.inflateTotal - found.inflated) });
  } catch { return null; }
  found.inflated += out.length;
  return out;
}

/** ImageMagick's "Raw profile type X": "\nexif\n   1234\nhex hex...". */
function _rawProfile(text) {
  // Read forward by hand (a pattern with two \s* in a row backtracks badly on a long blank run).
  const s = String(text);
  const ws = c => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  let i = 0;
  while (i < s.length && ws(s[i])) i++;
  while (i < s.length && /[A-Za-z0-9-]/.test(s[i])) i++;
  while (i < s.length && ws(s[i])) i++;
  const d0 = i;
  while (i < s.length && s[i] >= '0' && s[i] <= '9') i++;
  if (i === d0 || i - d0 > 12) return null;
  const hex = s.slice(i).replace(/[^0-9a-fA-F]/g, '');
  if (hex.length % 2 || hex.length / 2 > LIMITS.inflate) return null;
  return Buffer.from(hex, 'hex');
}

function pngText(key, text, found) {
  const k = tidy(key);
  const lk = k.toLowerCase();
  if (lk === 'xml:com.adobe.xmp' || lk === 'raw profile type xmp') {
    parseXmp(lk.startsWith('raw') ? (_rawProfile(text) || Buffer.alloc(0)).toString('utf8') : text, found);
    return;
  }
  if (lk === 'raw profile type exif' || lk === 'raw profile type app1') {
    const b = _rawProfile(text);
    if (!b) { found.bad = true; return; }
    parseTiff(_startsWith(b, 'Exif') ? b.subarray(6) : b, found, 1);
    return;
  }
  if (lk === 'raw profile type iptc' || lk === 'raw profile type 8bim') {
    const b = _rawProfile(text);
    if (!b) { found.bad = true; return; }
    if (_startsWith(b, '8BIM')) parseIrb(b, found); else parseIptc(b, found);
    return;
  }
  if (!found.tick()) return;
  if (lk === 'title') found.field('Title', text);
  else if (lk === 'author' || lk === 'copyright' || lk === 'exif:artist' || lk === 'exif:copyright') found.field('Name', text);
  else if (lk === 'description' || lk === 'exif:imagedescription' || lk === 'exif:usercomment') found.field('Comment', text);
  else if (lk === 'comment') { if (isSoftwareRaw(text)) found.scan(text); else found.field('Comment', text); }
  else if (lk === 'source' || lk === 'exif:hostcomputer') { const v = tidy(text); if (v) found.addDevice(v); }
  else if (lk === 'exif:make') found.setMake(text);
  else if (lk === 'exif:model') found.setModel(text);
  else if (lk === 'exif:bodyserialnumber' || lk === 'exif:serialnumber') found.addSerial(text);
  else if (lk === 'exif:lensserialnumber') found.addSerial(text, true);
  else if (lk.startsWith('exif:gps')) { if (tidy(text) && !/version/i.test(lk) && !found.gps) found.gps = true; }
  else if (PNG_QUIET_KEYS.test(lk)) found.scan(text);
  // Any other key is free text someone wrote into the file.
  else found.field('Comment', text);
}

async function _readAt(fh, pos, len) {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(b, got, len - got, pos + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got === len ? b : null;
}

// The chunks that are the picture itself.
const PNG_DRAW = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

/**
 * Walk a PNG's chunks: [{ type, pos, len }] up to IEND. Sets found.bad / over.
 * onText(type, data) for each chunk of a type in `read` (default: the text
 * chunks and eXIf). scan (the check): also every chunk that is neither the
 * picture, nor one PNG_KEEP keeps, nor a text chunk (a private chunk, an
 * unknown one), all of its bytes scanned for paths, emails and coordinates
 * (LIMITS.pngOther in all), the names in iCCP and sPLT, and everything after
 * IEND (LIMITS.tail; more is over). A cleaned copy keeps none of those.
 */
async function _pngChunks(fh, size, found, onText, read = PNG_TEXT, { scan = false } = {}) {
  const list = [];
  let pos = 8;
  let textBytes = 0;
  let otherBytes = 0;
  let ended = false;
  while (pos + 12 <= size) {
    if (list.length >= LIMITS.pngChunks) { found.over = true; break; }
    const h = await _readAt(fh, pos, 8);
    if (!h) { found.bad = true; break; }
    const len = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    if (len > 0x7fffffff || !/^[A-Za-z]{4}$/.test(type) || pos + 12 + len > size) { found.bad = true; break; }
    list.push({ type, pos, len });
    if (onText && read.has(type)) {
      textBytes += len;
      if (textBytes > LIMITS.pngText) { found.over = true; break; }
      const data = await _readAt(fh, pos + 8, len);
      if (!data) { found.bad = true; break; }
      onText(type, data);
    } else if (scan && (type === 'iCCP' || type === 'sPLT')) {
      const head = await _readAt(fh, pos + 8, Math.min(len, 80));
      if (!head) { found.bad = true; break; }
      const z = head.indexOf(0);
      found.scan(head.toString('latin1', 0, z < 0 ? head.length : z));
    } else if (scan && !PNG_DRAW.has(type) && !PNG_KEEP.has(type) && !PNG_TEXT.has(type)) {
      otherBytes += len;
      if (otherBytes > LIMITS.pngOther) { found.over = true; break; }
      await _scanRange(fh, pos + 8, pos + 8 + len, found);
    }
    if (found.over) break;
    pos += 12 + len;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended && !found.over) found.bad = true;
  if (scan && ended && pos < size) {
    if (size - pos > LIMITS.tail) found.over = true;
    else await _scanRange(fh, pos, size, found);
  }
  return list;
}

function _pngTextChunk(type, data, found, ctx) {
  if (type === 'eXIf') {
    const r = parseTiff(data, found, 0);
    if (ctx.orientation == null && r.orientation) ctx.orientation = r.orientation;
    return;
  }
  const z = data.indexOf(0);
  if (z < 1 || z > 79) { found.bad = true; return; }
  const key = data.toString('latin1', 0, z);
  if (type === 'tEXt') { pngText(key, data.subarray(z + 1).toString('latin1'), found); return; }
  if (type === 'zTXt') {
    const t = _inflate(data.subarray(z + 2), found);
    if (!t) { found.bad = true; return; }
    pngText(key, t.toString('latin1'), found);
    return;
  }
  // iTXt: keyword, flag, method, language, translated keyword, text.
  const flag = data[z + 1];
  let p = z + 3;
  const lang = data.indexOf(0, p);
  if (lang < 0) { found.bad = true; return; }
  const tk = data.indexOf(0, lang + 1);
  if (tk < 0) { found.bad = true; return; }
  p = tk + 1;
  let body = data.subarray(p);
  if (flag === 1) { body = _inflate(body, found); if (!body) { found.bad = true; return; } }
  pngText(key, body.toString('utf8'), found);
  const tkey = data.subarray(lang + 1, tk).toString('utf8');
  if (tkey) found.scan(tkey);
}

/* ── ffprobe ──────────────────────────────────────────────────────────── */

/**
 * Run a program with an args array (never a shell). Bounded output, a time
 * limit (timeoutMs, total) and an idle limit (idleMs, no output), and a
 * handle the caller can kill it through. Resolves { code, stdout, killed, timedOut }.
 */
function _run(exe, args, { timeoutMs = 0, idleMs = 0, maxOut = 64 * KB, onOutput, handle, keepOut = true } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: -1, stdout: '', killed: false, timedOut: false, failed: true });
      return;
    }
    const chunks = [];
    let outBytes = 0;
    let killed = false;
    let timedOut = false;
    let overflow = false;
    let idleT = null;
    const kill = () => { killed = true; try { child.kill(); } catch {} };
    const totalT = timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, timeoutMs) : null;
    const armIdle = () => {
      if (!idleMs) return;
      clearTimeout(idleT);
      idleT = setTimeout(() => { timedOut = true; kill(); }, idleMs);
    };
    armIdle();
    child.stdout.on('data', (b) => {
      armIdle();
      if (keepOut) {
        outBytes += b.length;
        if (outBytes > maxOut) { overflow = true; kill(); return; }
        chunks.push(b);
      }
      if (onOutput) { try { onOutput(b); } catch {} }
    });
    child.stderr.on('data', () => { armIdle(); if (onOutput) { try { onOutput(null); } catch {} } });
    if (handle) {
      handle.kill = kill;
      if (handle.cancelled) kill();
    }
    let done = false;
    const end = (code) => {
      if (done) return;
      done = true;
      clearTimeout(totalT);
      clearTimeout(idleT);
      if (handle && handle.kill === kill) handle.kill = null;
      resolve({ code: code == null ? -1 : code, stdout: keepOut ? Buffer.concat(chunks).toString('utf8') : '', killed, timedOut, overflow });
    };
    child.on('error', () => end(-1));
    child.on('close', end);
  });
}

/** The path as ffmpeg must see it: absolute, through the file protocol. */
function _ffPath(p) {
  return `file:${path.resolve(p)}`;
}

// Each is [program, ...arguments that go first] (tests put a script there).
let _probeCmd = () => [ffLocate.resolve('ffprobe')];
let _ffmpegCmd = () => [ffLocate.resolve('ffmpeg')];

/** ffprobe's JSON for a file, or null when it failed in any way (an error, the time limit, too much output, not JSON). */
async function _probe(filepath, handle) {
  let cmd;
  try { cmd = _probeCmd(); } catch { return null; }
  const [probeExe, ...probePre] = cmd;
  const r = await _run(probeExe, [...probePre, '-v', 'error', '-hide_banner', '-print_format', 'json',
    '-show_format', '-show_streams', '-show_chapters', _ffPath(filepath)],
  { timeoutMs: LIMITS.probeMs, maxOut: LIMITS.probeOut, handle });
  if (r.code !== 0 || r.killed) return null;
  try {
    const j = JSON.parse(r.stdout);
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

// Containers ffmpeg reads as a picture: its EXIF and XMP are not shown.
const IMAGE_FORMATS = /(^|,)(image2|[a-z0-9]+_pipe|gif|webp|apng|ico|tiff|bmp|jpegxl_anim|heif)(,|$)/;
const HEIF_BRANDS = /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|avif|avis)$/i;

/*
 * Video and audio: the types Vault checks through ffprobe. For these, a probe
 * that fails (an error, the time limit, too much output, output it cannot
 * read) is "the check failed", never "could not be checked": by its name or
 * by its first bytes. Anything else ffprobe cannot read is a type Vault does
 * not read (status 'unchecked', packed as it is).
 */
const AV_EXT = /^\.(mp4|m4v|m4a|m4b|m4p|mov|qt|3gp|3g2|mkv|mka|mks|mk3d|webm|avi|divx|wmv|wma|asf|flv|f4v|mpg|mpeg|mpe|m1v|m2v|mp2|vob|ts|mts|m2ts|tsv|tod|mod|mxf|ogg|ogv|oga|ogm|opus|spx|mp3|aac|ac3|eac3|dts|flac|wav|wave|aif|aiff|aifc|ape|wv|mpc|tta|amr|au|caf|dv|rm|rmvb|nut|y4m|ivf|alac)$/i;
const ISO_TOP = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid']);

/** 'av' for an MP4/MOV-family file, 'image' for HEIF/AVIF, null for anything else (by its first bytes). */
function _isoKind(head) {
  if (!head || head.length < 8 || !ISO_TOP.has(head.toString('latin1', 4, 8))) return null;
  if (head.toString('latin1', 4, 8) === 'ftyp' && head.length >= 12 && HEIF_BRANDS.test(head.toString('latin1', 8, 12))) return 'image';
  return 'av';
}

/** A video or audio container by its first bytes. */
function _avMagic(head) {
  if (!head || head.length < 4) return false;
  const s4 = head.toString('latin1', 0, 4);
  if (_isoKind(head) === 'av') return true;
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true;   // Matroska, WebM
  if (s4 === 'RIFF' && head.length >= 12 && /^(AVI |WAVE|AVIX|CDXA)$/.test(head.toString('latin1', 8, 12))) return true;
  if (['OggS', 'fLaC', 'FORM', '.snd', 'MAC ', 'wvpk', 'caff', '.RMF', 'MPCK', 'TTA1'].includes(s4)) return s4 !== 'FORM' || /^AIF[FC]$/.test(head.toString('latin1', 8, 12));
  if (s4.startsWith('ID3') || s4.startsWith('FLV')) return true;
  if (head[0] === 0x30 && head[1] === 0x26 && head[2] === 0xb2 && head[3] === 0x75) return true;   // ASF (WMV, WMA)
  if (head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && (head[3] === 0xba || head[3] === 0xb3)) return true;   // MPEG program stream
  return false;
}

const XMP_UUID = Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex');

/**
 * XMP in an MP4/MOV, which ffprobe does not show: a top-level (or moov)
 * 'uuid' box of Adobe's XMP id, and 'XMP_' in moov/udta and moov/trak/udta.
 * Boxes are walked by their sizes (LIMITS.isoBoxes, four levels); a box
 * running past its parent or the end of the file ends the walk there (there
 * is nothing after it), a box with an impossible size is broken.
 */
async function _isoXmp(fh, size, found) {
  let boxes = 0;
  const readXmp = async (a, b) => {
    if (b - a > LIMITS.xmp) { found.over = true; return; }
    const d = await _readAt(fh, a, b - a);
    if (!d) { found.bad = true; return; }
    parseXmp(d.toString('utf8'), found);
  };
  const walk = async (start, end, depth, parent) => {
    let p = start;
    while (p + 8 <= end && !found.over) {
      if (++boxes > LIMITS.isoBoxes) { found.over = true; return; }
      const h = await _readAt(fh, p, Math.min(16, end - p));
      if (!h) { found.bad = true; return; }
      let len = h.readUInt32BE(0);
      const type = h.toString('latin1', 4, 8);
      let hdr = 8;
      if (len === 1) {
        if (h.length < 16) { found.bad = true; return; }
        const big = h.readBigUInt64BE(8);
        len = big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
        hdr = 16;
      } else if (len === 0) len = end - p;
      if (len < hdr) { found.bad = true; return; }
      const bend = Math.min(end, p + len);
      const body = p + hdr;
      if (type === 'uuid' && bend - body >= 16) {
        const id = await _readAt(fh, body, 16);
        if (id && id.equals(XMP_UUID)) await readXmp(body + 16, bend);
      } else if (type === 'XMP_' && parent === 'udta') await readXmp(body, bend);
      else if (depth < 4 && (type === 'moov' || type === 'trak' || type === 'udta')) await walk(body, bend, depth + 1, type);
      if (p + len >= end) return;
      p += len;
    }
  };
  await walk(0, size, 0, '');
}

// Tags that are never personal by themselves (they are still scanned).
const QUIET_TAG = /^(encoder|encoding_tool|encoder_options|encoding_settings|major_brand|minor_version|compatible_brands|creation_time|date|year|date_recorded|date_released|originaldate|duration|language|handler_name|vendor_id|timecode|rotate|bps.*|number_of_.*|_statistics_.*|statistics_.*|software|version|muxing_app|writing_app|itunsmpb|itunnorm|genre|track|tracktotal|totaltracks|disc|disctotal|totaldiscs|compilation|rating|gapless_playback|media_type|hd_video|iso6709_precision|live-photo\..*|content\.identifier|capture\.fps|full-frame-rate-playback-intent|stik|tvsh|tvsn|tves|tvnn|account_type|purchase_date|sort_.*|mimetype|filename|bit_rate|replaygain_.*|r128_.*|acoustid_.*|musicbrainz_.*|isrc|barcode|catalognumber|script|encoder_settings|lyrics-.*)$/;
const LOCATION_TAG = /^(location|location\..*|xyz|iso6709|gps.*|.*\.gps.*|coordinates|geo.*)$/;
const NAME_TAG = /(^|[._ -])(artist|artists|album_artist|albumartist|author|composer|performer|copyright|creator|owner|lyricist|writer|conductor|arranger|director|producer|publisher|by)$/;
const TITLE_TAG = /^(title|subtitle|album|show|grouping|work|movement|episode_id|name)$/;
const COMMENT_TAG = /^(comment|comments|description|synopsis|summary|lyrics|notes|note|keywords|information|info)$/;
const AUTO_CHAPTER = /^(?:(?:chapter|chap|ch|kapitel|chapitre|capitolo|cap[ií]tulo|hoofdstuk|scene|part|track|глава)\s*[#.:-]?\s*\d{1,4}|\d{1,4}|\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)$/i;

function _probeTags(tags, where, found) {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return;
  let n = 0;
  for (const [rawKey, rawVal] of Object.entries(tags)) {
    if (++n > 400 || !found.tick()) { found.over = true; break; }
    const v = typeof rawVal === 'string' ? rawVal : (rawVal == null ? '' : String(rawVal));
    const key = String(rawKey).slice(0, 128).toLowerCase()
      .replace(/^(com\.apple\.quicktime\.|com\.android\.|com\.apple\.|©)/, '')
      .replace(/-[a-z]{3}$/, '');
    const val = tidy(v);
    if (!val) continue;
    // "Encoded by" is a person unless the whole value is a program (see
    // SOFTWARE_SIG_RX): "LAME 3.100" is not a name, "Alex Smith v1.2" is.
    if (key === 'encoded_by' && isSoftware(v)) { found.scan(v); continue; }
    if (QUIET_TAG.test(key)) { found.scan(v); continue; }
    if (LOCATION_TAG.test(key)) { found.add('Location', iso6709(val) || val); continue; }
    if (key === 'make' || key === 'manufacturer') { found.setMake(v); continue; }
    if (key === 'model' || key === 'camera_model') { found.setModel(v); continue; }
    if (/serial/.test(key)) { found.addSerial(v, /lens/.test(key)); continue; }
    if (key === 'device' || key === 'host' || key === 'hostname' || key === 'camera') { found.addDevice(val); continue; }
    if (NAME_TAG.test(key)) { found.field('Name', v); continue; }
    // A stream's own title or name is a track label ("English", "Commentary"):
    // only what it looks like counts there.
    if (TITLE_TAG.test(key)) { if (where === 'format') found.field('Title', v); else found.scan(v); continue; }
    // No software exemption here, not even ffmpeg's whole signature: ffprobe
    // cuts a value at its first NUL, so "Lavc6\0a@b.com" reads as "Lavc6" and
    // the rest is never seen. ffmpeg never writes its signature into a comment
    // tag anyway (only into encoder tags, above).
    if (COMMENT_TAG.test(key)) { found.field('Comment', v); continue; }
    found.scan(v);
  }
}

function _fromProbe(j, found) {
  const fmt = j.format && typeof j.format === 'object' ? j.format : {};
  const streams = Array.isArray(j.streams) ? j.streams.slice(0, 256) : [];
  const chapters = Array.isArray(j.chapters) ? j.chapters.slice(0, 2000) : [];
  if ((Array.isArray(j.streams) && j.streams.length > 256) || (Array.isArray(j.chapters) && j.chapters.length > 2000)) found.over = true;
  _probeTags(fmt.tags, 'format', found);
  // v: video streams that are not a cover picture; t: attachments (fonts
  // for styled subtitles); pics: cover pictures (attached pictures).
  const counts = { v: 0, a: 0, s: 0, t: 0, pics: 0 };
  const attachments = [];
  const pictures = [];   // the covers' stream numbers, for cleanCopy's size rule
  for (const s of streams) {
    if (!s || typeof s !== 'object') continue;
    const pic = !!(s.disposition && typeof s.disposition === 'object' && Number(s.disposition.attached_pic) === 1);
    if (pic) {
      // A cover picture: its tags are its kind ("Cover (front)", "Other")
      // and a caption, never flagged as such, only scanned. The picture
      // itself is not looked inside; a cleaned copy never keeps it.
      counts.pics++;
      if (Number.isInteger(s.index) && s.index >= 0) pictures.push(s.index);
      _scanTags(s.tags, found);
      continue;
    }
    if (s.codec_type === 'video') counts.v++;
    else if (s.codec_type === 'audio') counts.a++;
    else if (s.codec_type === 'subtitle') counts.s++;
    else if (s.codec_type === 'attachment') {
      counts.t++;
      const t = s.tags && typeof s.tags === 'object' ? s.tags : {};
      attachments.push({ filename: typeof t.filename === 'string' ? t.filename : '', mimetype: typeof t.mimetype === 'string' ? t.mimetype : '' });
    }
    _probeTags(s.tags, 'stream', found);
    const handler = s.tags && typeof s.tags.handler_name === 'string' ? s.tags.handler_name : '';
    if (s.codec_type === 'data' && (/^(gpmd|camm)$/i.test(String(s.codec_tag_string || '')) || /gps|location/i.test(handler))) {
      found.add('Location', 'GPS track');
    }
  }
  for (const c of chapters) {
    if (!found.tick()) break;
    const t = c && c.tags && typeof c.tags.title === 'string' ? tidy(c.tags.title) : '';
    if (!t || AUTO_CHAPTER.test(t)) { if (t) found.scan(t); continue; }
    found.field('Title', t);
  }
  const brand = fmt.tags && typeof fmt.tags.major_brand === 'string' ? fmt.tags.major_brand.trim() : '';
  const image = IMAGE_FORMATS.test(String(fmt.format_name || '')) || HEIF_BRANDS.test(brand);
  const d = Number(fmt.duration);
  // Ogg keeps a cover base64-encoded in its comments: a third bigger there.
  const base64Covers = /(^|,)ogg(,|$)/.test(String(fmt.format_name || ''));
  return { counts, image, attachments, pictures, base64Covers, duration: Number.isFinite(d) && d > 0 ? d : null };
}

/** Tags that are only scanned (paths, emails, coordinates), whatever their names. */
function _scanTags(tags, found) {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return;
  let n = 0;
  for (const v of Object.values(tags)) {
    if (++n > 400) { found.over = true; break; }
    found.scan(typeof v === 'string' ? v : (v == null ? '' : String(v)));
  }
}

/**
 * An attachment's name and type as the cleaned copy carries them: kept when
 * plainly a file name (letters, digits, spaces, . _ - ( ) +), else
 * "attachment-N" with its extension; a type that is not plainly a type
 * becomes application/octet-stream. Players load attached fonts by what is
 * inside them, not by these names.
 */
function _attachmentTags(a, i) {
  const base = String(a.filename || '').split(/[\\/]/).pop().slice(0, 120);
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  const filename = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,119}$/.test(base) ? base : `attachment-${i + 1}${ext ? `.${ext[1].toLowerCase()}` : ''}`;
  const mimetype = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(String(a.mimetype || '')) ? a.mimetype : 'application/octet-stream';
  return { filename, mimetype };
}

/* ── detect: one file ─────────────────────────────────────────────────── */

/**
 * Check one file. Never throws. The status is one of:
 *   'personal'   something was found (findings say what);
 *   'clean'      looked at in full, nothing found;
 *   'unchecked'  a type Vault does not read (webp, heic, gif, a document...):
 *                packed as it is, and step 1 says so;
 *   'failed'     a type Vault checks (JPEG, PNG, video, audio) whose check
 *                did not finish: unreadable, broken, too large, over a
 *                limit, ffprobe failing, any error. Never clean: with
 *                "Remove from the packed copies" the share fails for it.
 * @returns {Promise<{status:'personal'|'clean'|'unchecked'|'failed', kind:string|null, findings:{label,value}[], counts?:object}>}
 */
async function detect(filepath, { handle } = {}) {
  try {
    return await _detect(filepath, handle);
  } catch {
    return { status: 'failed', kind: null, findings: [] };
  }
}

async function _detect(filepath, handle) {
  const found = new Found();
  let kind = null;
  let av = false;
  let extra = {};
  const fh = await fs.promises.open(filepath, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { status: 'failed', kind: null, findings: [] };
    const head = (await _readAt(fh, 0, Math.min(16, st.size))) || Buffer.alloc(0);
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      kind = 'jpeg';
      const ctx = await _detectJpeg(fh, st.size, found);
      extra = { orientation: ctx.orientation };
    } else if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIG)) {
      kind = 'png';
      const ctx = { orientation: null };
      await _pngChunks(fh, st.size, found, (type, data) => _pngTextChunk(type, data, found, ctx), PNG_TEXT, { scan: true });
      extra = { orientation: ctx.orientation };
    } else {
      kind = 'probe';
      av = AV_EXT.test(path.extname(filepath)) || _avMagic(head);
      if (_isoKind(head) === 'av') await _isoXmp(fh, st.size, found);
    }
  } finally {
    try { await fh.close(); } catch {}
  }
  if (kind === 'probe') {
    const j = await _probe(filepath, handle);
    if (!j) return { status: av ? 'failed' : 'unchecked', kind: av ? 'av' : null, findings: [] };
    const r = _fromProbe(j, found);
    kind = r.image ? 'image' : 'av';
    extra = { counts: r.counts, duration: r.duration, attachments: r.attachments, pictures: r.pictures, base64Covers: r.base64Covers };
    if (!found.personal()) {
      // ffprobe does not show a picture's EXIF or XMP; nothing found is not "clean".
      if (r.image) return { status: 'unchecked', kind, findings: [], ...extra };
      if (r.counts.v + r.counts.a === 0) return { status: av ? 'failed' : 'unchecked', kind, findings: [], ...extra };
    }
    // A cover picture goes with the rest when the file is cleaned: said so.
    if (found.personal() && kind === 'av' && r.counts.pics) found.add('Picture', 'cover picture');
  }
  if (found.personal()) return { status: 'personal', kind, findings: found.findings(), ...extra };
  if (found.bad || found.over) return { status: 'failed', kind, findings: [], ...extra };
  return { status: 'clean', kind, findings: [], ...extra };
}

/* ── The session cache and the check line ─────────────────────────────── */

const _cache = new Map();     // path -> { id, size, mtimeMs, result } (oldest first)
const _inflight = new Map();  // path + id -> promise
const _running = new Set();   // handles of probes running now
let _gen = 0;
let _active = 0;
const _wait = [];

/**
 * What a file is right now, for the cache: size, modified and changed times
 * (nanoseconds) and the file's id on its drive (inode / NTFS file index,
 * device). A file replaced, rewritten or restored with its old modified time
 * gets a new id. content: the same without the changed time, which a new
 * hard link to the file also moves (packing links files on the same drive).
 * null when it is not a regular file that can be looked at.
 */
async function fileId(p) {
  let st;
  try { st = await fs.promises.stat(p, { bigint: true }); } catch { return null; }
  if (!st.isFile()) return null;
  const content = `${st.size}\0${st.mtimeNs}\0${st.ino}\0${st.dev}`;
  return {
    id: `${content}\0${st.ctimeNs}`,
    content,
    size: Number(st.size),
    mtimeMs: Number(st.mtimeNs / 1000000n),
  };
}

function _remember(p, rec) {
  if (_cache.has(p)) _cache.delete(p);
  _cache.set(p, rec);
  while (_cache.size > LIMITS.cache) _cache.delete(_cache.keys().next().value);
}

const FAILED = Object.freeze({ status: 'failed', kind: null, findings: [] });

async function _slot() {
  if (_active < LIMITS.concurrency) { _active++; return; }
  await new Promise(r => _wait.push(r));
  _active++;
}
function _release() {
  _active--;
  const next = _wait.shift();
  if (next) next();
}

/**
 * One file, from the cache or a check: { r, fresh, id }. The file is looked
 * at first (fileId): the cache answers only for the very same file, size,
 * times and id; anything else is checked as it is now. wanted(): asked when
 * its turn comes; false skips it (r null, nothing kept). A result is kept
 * only when the file is still the same after the check, and never when the
 * check failed. fresh: a check ran (or one under way was joined) for it.
 */
async function _checkFile(f, { wanted = () => true, handle = null } = {}) {
  const now = await fileId(f.path);
  if (!now) return { r: FAILED, fresh: false, id: null };
  const hit = _cache.get(f.path);
  if (hit && hit.id === now.id) return { r: hit.result, fresh: false, id: now.content };
  const key = `${f.path}\0${now.id}`;
  if (_inflight.has(key)) return { r: await _inflight.get(key), fresh: true, id: now.content };
  const gen = _gen;
  const p = (async () => {
    await _slot();
    try {
      if (gen !== _gen || !wanted() || (handle && handle.cancelled)) return null;
      const h = { cancelled: false, kill: null };
      _running.add(h);
      let r;
      try { r = await detect(f.path, { handle: h }); } finally { _running.delete(h); }
      if (gen !== _gen || h.cancelled) return null;
      const after = await fileId(f.path);
      // Changed while it was read: its result is for no file that exists now.
      if (!after || after.id !== now.id) return FAILED;
      if (r.status !== 'failed') _remember(f.path, { id: now.id, size: now.size, mtimeMs: now.mtimeMs, result: r });
      return r;
    } finally {
      _release();
      if (_inflight.get(key) === p) _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return { r: await p, fresh: true, id: now.content };
}

/** The result for one file ({ path }), from the cache or a check (see _checkFile); null when skipped. */
async function checkFile(f, opts) {
  return (await _checkFile(f, opts)).r;
}

/**
 * The cached result for a file ({ path, size, mtimeMs }), or null; never
 * starts a check, never looks at the file. An estimate only (the space a
 * share may need at its start): what gets cleaned is decided by checkNow.
 */
function cached(f) {
  const hit = _cache.get(f.path);
  return hit && hit.size === f.size && hit.mtimeMs === Math.trunc(f.mtimeMs) ? hit.result : null;
}

/**
 * The server's own check of a share's files at its pack turn: every file as
 * it is now (the cache for the very same file, or a check). Results in the
 * order of `paths`: null when it could not be done (the share must not take
 * it as clean). onFile: after each file a check actually ran for (a cached
 * answer is not work, so not a sign of life). ids (an array, optional): each
 * file's content key as checked (fileId().content), so the caller can tell
 * if it changed later.
 * Throws CANCELLED when the handle is cancelled.
 */
async function checkNow(paths, { handle, onFile, ids } = {}) {
  const out = new Array(paths.length).fill(null);
  const kill = () => { for (const h of _running) { h.cancelled = true; try { if (h.kill) h.kill(); } catch {} } };
  if (handle) handle.kill = kill;
  try {
    await Promise.all(paths.map(async (p, i) => {
      // A check of the same file already under way for step 1 may be skipped
      // (its window closed) and answer null: then it is asked again, so no
      // file goes unchecked here by accident.
      let x = { r: null, fresh: false, id: null };
      for (let tries = 0; !x.r && tries < 5 && !(handle && handle.cancelled); tries++) x = await _checkFile({ path: p }, { handle });
      out[i] = x.r;
      if (ids) ids[i] = x.id;
      if (onFile && x.r && x.fresh) { try { onFile(); } catch {} }
    }));
  } finally {
    if (handle && handle.kill === kill) handle.kill = null;
  }
  if (handle && handle.cancelled) throw _err('CANCELLED', 'Packing was cancelled.');
  return out;
}

/* Step 1 checks: a list of files and when the page last asked. */
const _checks = new Map();   // id -> { id, files, extra, wantedAt, results: [] }

/**
 * Start (or rejoin) a step 1 check. files: [{ path, size, mtimeMs, ... }].
 * Returns its id. Files nobody asked about for LIMITS.wantedMs are not
 * checked (the window was closed); asking again picks them up.
 */
function startCheck(files, extra = null) {
  _sweepChecks();
  while (_checks.size >= LIMITS.checks) _checks.delete(_checks.keys().next().value);
  const id = crypto.randomBytes(12).toString('hex');
  const rec = { id, files: files.slice(), extra, wantedAt: Date.now(), results: new Array(files.length).fill(undefined) };
  _checks.set(id, rec);
  _pumpCheck(rec);
  return id;
}

function _pumpCheck(rec) {
  const gen = _gen;
  rec.files.forEach((f, i) => {
    if (rec.results[i] !== undefined) return;
    rec.results[i] = null;   // in hand
    checkFile(f, { wanted: () => gen === _gen && _checks.get(rec.id) === rec && Date.now() - rec.wantedAt < LIMITS.wantedMs })
      .then((r) => { if (_checks.get(rec.id) === rec) rec.results[i] = r || undefined; })
      .catch(() => { if (_checks.get(rec.id) === rec) rec.results[i] = FAILED; });
  });
}

function _sweepChecks() {
  const now = Date.now();
  for (const [id, rec] of _checks) if (now - rec.wantedAt > LIMITS.checkIdleMs) _checks.delete(id);
}

/** Where a step 1 check is: { done, checked, total, results, extra } or null for an unknown id. */
function checkStatus(id) {
  _sweepChecks();
  const rec = typeof id === 'string' ? _checks.get(id) : null;
  if (!rec) return null;
  rec.wantedAt = Date.now();
  // Files skipped while nobody asked are picked up again.
  if (rec.results.some(r => r === undefined)) _pumpCheck(rec);
  const checked = rec.results.filter(r => r && typeof r === 'object').length;
  const done = checked === rec.files.length;
  return { done, checked, total: rec.files.length, results: done ? rec.results.slice() : null, files: rec.files, extra: rec.extra };
}

/** Drop every found value, every check, and stop the probes running now. */
function forget() {
  _gen += 1;
  _cache.clear();
  _checks.clear();
  for (const h of _running) { h.cancelled = true; try { if (h.kill) h.kill(); } catch {} }
}

/* ── Cleaned copies ───────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function _pngChunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, 'latin1');
  data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}

/**
 * Write `pieces` into a NEW file at dst (fails if anything is there, a link
 * included). Each piece: a Buffer, or { from: [start, end] } of fhSrc.
 */
async function _writeNew(dst, pieces, { fhSrc = null, handle } = {}) {
  const out = await fs.promises.open(dst, 'wx', 0o600);
  let written = 0;
  try {
    const block = Buffer.alloc(MB);
    for (const p of pieces) {
      if (handle && handle.cancelled) throw _err('CANCELLED', 'Packing was cancelled.');
      if (Buffer.isBuffer(p)) {
        let off = 0;
        while (off < p.length) { const { bytesWritten } = await out.write(p, off, p.length - off); off += bytesWritten; }
        written += p.length;
        continue;
      }
      let [s, e] = p.from;
      while (s < e) {
        if (handle && handle.cancelled) throw _err('CANCELLED', 'Packing was cancelled.');
        const n = Math.min(block.length, e - s);
        const { bytesRead } = await fhSrc.read(block, 0, n, s);
        if (!bytesRead) throw _err('CLEAN_FAILED', 'The file ended early.');
        let off = 0;
        while (off < bytesRead) { const { bytesWritten } = await out.write(block, off, bytesRead - off); off += bytesWritten; }
        s += bytesRead;
        written += bytesRead;
      }
    }
  } finally {
    await out.close();
  }
  return written;
}

/** The cleaned JPEG, streamed: the original read a block at a time, never whole. */
async function _cleanJpeg(src, tmp, handle) {
  const fh = await fs.promises.open(src, 'r');
  try {
    const st = await fh.stat();
    const pieces = await _jpegPieces(fh, st.size, handle);
    const want = pieces.reduce((n, p) => n + (Buffer.isBuffer(p) ? p.length : p.from[1] - p.from[0]), 0);
    const n = await _writeNew(tmp, pieces, { fhSrc: fh, handle });
    return { expected: want, written: n };
  } finally {
    await fh.close();
  }
}

async function _cleanPng(src, tmp, handle) {
  const fh = await fs.promises.open(src, 'r');
  try {
    const st = await fh.stat();
    const found = new Found();
    const ctx = { orientation: null };
    const list = await _pngChunks(fh, st.size, found, (type, data) => {
      if (type === 'eXIf' && ctx.orientation == null) {
        const r = parseTiff(data, new Found(), 0);
        ctx.orientation = r.orientation || 0;
      }
    }, new Set(['eXIf']));
    if (found.bad || found.over || !list.length || list[0].type !== 'IHDR') throw _err('CLEAN_FAILED', 'Broken PNG.');
    const pieces = [Buffer.from(PNG_SIG)];
    let want = PNG_SIG.length;
    for (const c of list) {
      // The picture's own chunks and those needed to draw it as it was; any
      // other chunk (text, eXIf, private or unknown, critical or not) goes.
      if (PNG_DRAW.has(c.type) || PNG_KEEP.has(c.type)) {
        pieces.push({ from: [c.pos, c.pos + 12 + c.len] });
        want += 12 + c.len;
      }
      if (c.type === 'IHDR' && ctx.orientation >= 2 && ctx.orientation <= 8) {
        const ex = _pngChunk('eXIf', orientationTiff(ctx.orientation));
        pieces.push(ex);
        want += ex.length;
      }
    }
    const n = await _writeNew(tmp, pieces, { fhSrc: fh, handle });
    return { expected: want, written: n };
  } finally {
    await fh.close();
  }
}

/**
 * Video and audio (and pictures ffmpeg reads): stream copy, all metadata
 * dropped. For video and audio, "0:V" is the video that is not a cover
 * picture: covers are never in a cleaned copy (they are not looked inside).
 * Attachments (the fonts styled subtitles need) are kept, with their name
 * and type set again (dropping the metadata drops them too) as
 * _attachmentTags makes them.
 */
async function _cleanAv(src, tmp, known, handle, onActivity) {
  const maps = known.kind === 'image'
    ? ['-map', '0:v?', '-map', '0:a?', '-map', '0:s?']
    : ['-map', '0:V?', '-map', '0:a?', '-map', '0:s?', '-map', '0:t?'];
  const att = [];
  (Array.isArray(known.attachments) ? known.attachments : []).forEach((a, i) => {
    const t = _attachmentTags(a, i);
    att.push(`-metadata:s:t:${i}`, `filename=${t.filename}`, `-metadata:s:t:${i}`, `mimetype=${t.mimetype}`);
  });
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n',
    '-i', _ffPath(src),
    ...maps, '-c', 'copy',
    '-map_metadata', '-1', '-map_metadata:c', '-1',
    ...(known.kind === 'image' ? [] : att),
    '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
    '-progress', 'pipe:1', '-nostats',
    _ffPath(tmp)];
  const [ffExe, ...ffPre] = _ffmpegCmd();
  const r = await _run(ffExe, [...ffPre, ...args], {
    idleMs: LIMITS.cleanIdleMs, keepOut: false, handle,
    onOutput: (b) => { if (b && onActivity) onActivity(); },
  });
  if (handle && handle.cancelled) throw _err('CANCELLED', 'Packing was cancelled.');
  if (r.code !== 0 || r.killed) throw _err('CLEAN_FAILED', 'ffmpeg failed.');
  return { expected: null };
}

/**
 * The bytes the cover pictures take in src, measured: ffmpeg hands each
 * cover's one packet (the picture file itself, whatever the container) to
 * stdout and only the count is kept. A cover that cannot be measured counts
 * as 0, which only makes cleanCopy's size rule stricter (a false failure at
 * worst, never a short copy let through). At most 8 covers are measured.
 */
async function _coverBytes(src, known, handle) {
  const idx = (Array.isArray(known.pictures) ? known.pictures : []).filter(i => Number.isInteger(i) && i >= 0).slice(0, 8);
  let total = 0;
  for (const i of idx) {
    let n = 0;
    const [ffExe, ...ffPre] = _ffmpegCmd();
    const r = await _run(ffExe, [...ffPre, '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', _ffPath(src),
      '-map', `0:${i}`, '-c', 'copy', '-frames', '1', '-f', 'data', 'pipe:1'], {
      timeoutMs: LIMITS.probeMs, keepOut: false, handle,
      onOutput: (b) => { if (b) n += b.length; },
    });
    if (handle && handle.cancelled) throw _err('CANCELLED', 'Packing was cancelled.');
    if (r.code === 0 && !r.killed && n > 0) total += n;
  }
  return known.base64Covers ? Math.ceil(total * 4 / 3) : total;
}

/**
 * Make the cleaned copy of src at dst (a path in the share's work folder that
 * does not exist yet). known: this file's result from the check (kind,
 * counts). Throws CLEAN_FAILED (or CANCELLED); on any failure the partial
 * file is removed and dst is not made.
 */
async function cleanCopy({ src, dst, known, handle = null, onActivity = null }) {
  const fail = () => _err('CLEAN_FAILED', 'Vault could not remove personal details from this file.');
  if (!known || known.status !== 'personal') throw fail();
  const srcAbs = path.resolve(src);
  const dir = path.dirname(path.resolve(dst));
  const st = await fs.promises.stat(srcAbs);
  if (!st.isFile()) throw fail();
  const ext = path.extname(srcAbs);
  const safeExt = /^\.[A-Za-z0-9]{1,10}$/.test(ext) ? ext.toLowerCase() : '';
  const tmp = path.join(dir, `.vclean-${crypto.randomBytes(8).toString('hex')}${safeExt}`);
  if (path.resolve(tmp) === srcAbs || path.resolve(dst) === srcAbs) throw fail();
  const drop = async () => { try { await fs.promises.unlink(tmp); } catch {} };
  try {
    let r;
    if (known.kind === 'jpeg') r = await _cleanJpeg(srcAbs, tmp, handle);
    else if (known.kind === 'png') r = await _cleanPng(srcAbs, tmp, handle);
    else if (known.kind === 'av' || known.kind === 'image') {
      if (!safeExt) throw fail();
      r = await _cleanAv(srcAbs, tmp, known, handle, onActivity);
    } else throw fail();
    if (handle && handle.cancelled) throw _err('CANCELLED', 'Packing was cancelled.');
    if (onActivity) { try { onActivity(); } catch {} }
    // A new file of its own: a regular file, one link, not the original.
    const ts = await fs.promises.lstat(tmp);
    if (!ts.isFile() || ts.nlink !== 1 || ts.size <= 0) throw fail();
    if (ts.ino && st.ino && ts.ino === st.ino && ts.dev === st.dev) throw fail();
    if (r.expected != null && (ts.size !== r.expected || r.written !== r.expected)) throw fail();
    const pics = known.counts && known.counts.pics ? known.counts.pics : 0;
    // Video and audio lose only metadata, data tracks and cover pictures. So
    // the copy must hold at least half of what is left of the original once
    // its covers (measured, never taken from a header) are taken away, less
    // up to 16 KB for tags, and never under a quarter of it. One rule for
    // every file, with or without covers, whatever its duration says.
    if (r.expected == null) {
      const covers = pics ? await _coverBytes(srcAbs, known, handle) : 0;
      const rest = Math.max(0, st.size - covers);
      if (ts.size < rest * 0.5 - Math.min(16 * KB, rest * 0.25)) throw fail();
    }
    // Checked again with the same checker.
    const again = await detect(tmp, { handle });
    if (handle && handle.cancelled) throw _err('CANCELLED', 'Packing was cancelled.');
    if (again.status === 'personal' || again.status === 'failed') throw fail();
    if ((known.kind === 'jpeg' || known.kind === 'png') && (again.status !== 'clean' || again.kind !== known.kind)) throw fail();
    if (known.kind === 'av') {
      // The same streams, attachments included, and no cover picture left.
      const a = again.counts || {};
      const b = known.counts || {};
      if (again.status !== 'clean' || a.v !== b.v || a.a !== b.a || a.s !== b.s || (a.t || 0) !== (b.t || 0) || (a.pics || 0) !== 0) throw fail();
      // With a cover gone, far shorter by its own header is missing something
      // too (a header can claim any length: this only adds to the size rule).
      if (pics && known.duration && !(again.duration >= known.duration * 0.5)) throw fail();
    }
    if (known.kind === 'image' && again.kind !== 'image') throw fail();
    // Its name in the archive, which must not exist yet.
    let exists = true;
    try { await fs.promises.lstat(dst); } catch (e) { exists = !(e && e.code === 'ENOENT'); }
    if (exists) throw fail();
    await fs.promises.rename(tmp, dst);
    // The modified date stays as it was (the archive keeps it).
    try { await fs.promises.utimes(dst, st.atime, st.mtime); } catch {}
  } catch (err) {
    await drop();
    if (err && err.code === 'CANCELLED') throw err;
    throw fail();
  }
}

/**
 * Tests only: use other programs for ffprobe and ffmpeg (null: Vault's own).
 * Each is a path, or { exe, pre: [arguments that go first] } for a script.
 */
function _setForTest({ probe, ffmpeg } = {}) {
  const cmd = (v, name) => {
    if (!v) return () => [ffLocate.resolve(name)];
    if (typeof v === 'string') return () => [v];
    return () => [v.exe, ...(v.pre || [])];
  };
  if (probe !== undefined) _probeCmd = cmd(probe, 'ffprobe');
  if (ffmpeg !== undefined) _ffmpegCmd = cmd(ffmpeg, 'ffmpeg');
}

function _stateForTest() {
  return { cache: _cache.size, checks: _checks.size, active: _active, running: _running.size };
}

module.exports = {
  detect, checkFile, checkNow, cached, startCheck, checkStatus, forget, cleanCopy, fileId,
  // pieces, for tests
  parseTiff, parseXmp, jpegStrip, orientationTiff, crc32, tidy, shorten, Found, _fromProbe, _probeTags,
  LIMITS, CATS, _setForTest, _stateForTest,
};
