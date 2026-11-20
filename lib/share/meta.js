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
 * WHERE IT LOOKS (detect):
 *   JPEG   the segments before the picture data: EXIF (every directory, GPS
 *          included, and whether maker notes are there), XMP (also the
 *          extended parts), IPTC in Photoshop's APP13, COM, Ducky (APP12);
 *          any other APPn only for paths, emails and coordinates in its text.
 *   PNG    tEXt, zTXt, iTXt (XMP and ImageMagick's raw profiles too), eXIf.
 *   others ffprobe (lib/ffmpeg-locate.js finds it, as everywhere in Vault):
 *          container tags, each stream's tags, chapter titles, GPS tracks.
 *          A picture ffprobe reads (webp, heic, gif...) is flagged only when
 *          its tags show something; otherwise it is "could not be checked",
 *          because ffprobe does not show their EXIF or XMP.
 *   A file that cannot be read or parsed is "could not be checked" (status
 *   'unchecked'), never flagged and never called clean.
 *
 * CLEANED COPIES (cleanCopy): only for a file this check flagged, and only
 * into the share's own work folder. The original is opened read-only (fs
 * reads, ffmpeg input); the copy is a brand-new file (O_EXCL, or ffmpeg -n
 * on a fresh random name), checked to have one link only, then renamed to its
 * name in the archive and given the original's modified date.
 *   video and audio: ffmpeg stream copy of the video, audio and subtitle
 *     streams, no re-encode; global, stream and chapter metadata dropped
 *     (chapters keep their times, not their titles); data streams (GPS and
 *     other timed metadata tracks) and attachments dropped; bitexact, so no
 *     encoder tag is written.
 *   JPEG: every APPn and COM dropped, before and between the scans, and
 *     anything after the end of the picture; kept: the ICC colour profile,
 *     a minimal JFIF header, Adobe's colour transform marker, and the
 *     orientation as a new EXIF block that holds nothing else. Picture data
 *     is copied byte for byte.
 *   PNG: text chunks, eXIf and every unknown ancillary chunk dropped; kept
 *     every chunk needed to draw it (colour, transparency, animation) and the
 *     orientation as a new eXIf that holds nothing else.
 * The copy is then checked again with the same checker; if it still shows
 * something, if the tool failed, or if the copy is missing, empty or far too
 * small, cleanCopy throws CLEAN_FAILED and the share fails (never a quiet
 * fall back to the original).
 *
 * UNTRUSTED INPUT. Every read is bounded (LIMITS), every offset checked,
 * ffprobe and ffmpeg run with an args array (no shell), the path as
 * "file:<absolute path>" (a name starting with "-" or holding ":" or "|" is
 * never read as an option or a protocol), with a time limit and killed on
 * cancel. At most LIMITS.concurrency checks run at once.
 *
 * PERSONAL DATA. Found values live in memory only (the session cache below,
 * keyed by path, size and modified time), are never logged, never written to
 * the database, a share row or an error message. They are shortened, and
 * control and direction characters are removed, before they leave here.
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
  jpegHeader: 8 * MB,     // bytes of a JPEG read before its picture data
  segments: 2000,         // JPEG segments before the picture data
  ifdEntries: 1000,       // entries in one TIFF directory
  ifds: 24,               // TIFF directories in one EXIF block
  tags: 4000,             // tags and values looked at per file, all kinds
  value: 4096,            // characters of one value looked at
  pngChunks: 400000,
  pngText: 8 * MB,        // bytes of PNG text chunks read
  inflate: 2 * MB,        // a compressed PNG text, unpacked
  xmp: 2 * MB,
  findings: 32,           // raw findings kept per file
  shown: 60,              // characters of one value shown on step 1
  group: 90,              // characters of one line (a category) shown
  probeMs: 30 * 1000,
  probeOut: 8 * MB,
  cleanIdleMs: 5 * 60 * 1000,
  jpegClean: 256 * MB,
  concurrency: 3,
  cache: 20000,
  checks: 8,              // step 1 checks kept at once
  checkIdleMs: 10 * 60 * 1000,
  wantedMs: 20 * 1000,    // a step 1 check nobody asked about for this long stops
});

const CATS = ['Location', 'Device', 'Name', 'Title', 'Comment', 'Folder path', 'Email'];

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

/** Software names in a free-text field (a JPEG COM, "encoded by"): not personal. */
const SOFTWARE_RX = /^(?:CREATOR: gd-jpeg|Created with (?:The )?GIMP|LEAD Technologies|Optimized by JPEGmini|Intel\(R\) JPEG|Lav[cf]\d|Handmade Software|AppleMark|Compressed by jpeg-recompress|ACD Systems|File written by Adobe|Adobe |Photoshop|IrfanView|XnView|Paint\.NET|Picasa|ImageMagick|GraphicsMagick|libvips|mozjpeg|libjpeg|Exiv2|LAME|iTunes|HandBrake|FFmpeg|mkvmerge|libebml|Exact Audio Copy|fre:ac|foobar2000|Winamp|Audacity|Nero|dBpoweramp|x264|x265|Mp3tag|MediaMonkey)\b/i;

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
  }

  /** One more tag looked at; false (and over) past the limit. */
  tick() {
    this.n += 1;
    if (this.n > LIMITS.tags) { this.over = true; return false; }
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
    if (v.length < 5) return;
    let m;
    if ((m = RX_WIN.exec(v)) || (m = RX_UNC.exec(v)) || (m = RX_NIX.exec(v))) this.add('Folder path', m[0].trim());
    if (v.includes('@') && (m = RX_EMAIL.exec(v))) this.add('Email', m[0]);
    if ((m = RX_ISO6709.exec(v))) this.add('Location', iso6709(m[0]) || m[0]);
    else if ((m = RX_DECPAIR.exec(v)) || (m = RX_DMS.exec(v))) this.add('Location', m[0]);
  }

  /** Every printable run of a binary block, scanned (an unknown segment). */
  scanBinary(buf) {
    const s = buf.subarray(0, 256 * KB).toString('latin1');
    const re = /[\x20-\x7e]{6,}/g;
    let m;
    let runs = 0;
    while ((m = re.exec(s)) !== null && runs++ < 500) this.scan(m[0]);
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
  return String(s).replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]{2,4});/g, (m, e) => {
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

function parseXmp(text, found) {
  const s = String(text || '').slice(0, LIMITS.xmp);
  if (!s) return;
  let lat = NaN;
  let lon = NaN;
  for (const [name, cat] of XMP_FIELDS) {
    if (!s.includes(name)) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const vals = [];
    const ra = new RegExp(`[\\s<]${esc}\\s*=\\s*(?:"([^"]{0,4096})"|'([^']{0,4096})')`, 'g');
    const re = new RegExp(`<${esc}(?:\\s[^<>]{0,2048})?>([\\s\\S]{0,8192}?)</${esc}\\s*>`, 'g');
    let m;
    let guard = 0;
    while ((m = ra.exec(s)) !== null && guard++ < 50) vals.push(m[1] !== undefined ? m[1] : m[2]);
    guard = 0;
    while ((m = re.exec(s)) !== null && guard++ < 50) {
      const inner = m[1];
      const lis = [...inner.matchAll(/<rdf:li(?:\s[^<>]{0,512})?>([\s\S]{0,4096}?)<\/rdf:li\s*>/g)].slice(0, 20).map(x => x[1]);
      vals.push(...(lis.length ? lis : [inner]).map(v => v.replace(/<[^<>]{0,2048}>/g, ' ')));
    }
    for (const raw of vals) {
      if (!found.tick()) return;
      const v = decodeEntities(raw);
      if (!tidy(v)) continue;
      if (cat === 'gpslat') { lat = xmpCoord(v); if (!found.gps) found.gps = true; }
      else if (cat === 'gpslon') { lon = xmpCoord(v); if (!found.gps) found.gps = true; }
      else if (cat === 'make') found.setMake(v);
      else if (cat === 'model') found.setModel(v);
      else if (cat === 'serial') found.addSerial(v);
      else if (cat === 'lensserial') found.addSerial(v, true);
      else found.field(cat, v);
    }
  }
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
      && (found.gps === true || !found.gps)) found.gps = { lat, lon };
  // Any attribute value or text: paths, emails, coordinates.
  const any = /="([^"]{1,4096})"|>([^<]{1,4096})</g;
  let m;
  let guard = 0;
  while ((m = any.exec(s)) !== null && guard++ < 5000) {
    const v = m[1] !== undefined ? m[1] : m[2];
    if (v && /\S/.test(v)) found.scan(decodeEntities(v));
    if (found.over) break;
  }
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
    if (SOFTWARE_RX.test(tidy(v))) found.scan(v); else found.field('Comment', v);
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
    if (ctx.xmpExt.length + part.length <= LIMITS.xmp) ctx.xmpExt.push(part); else found.over = true;
    return;
  }
  if (marker === 0xe2 && (_startsWith(payload, 'ICC_PROFILE\0') || _startsWith(payload, 'MPF\0'))) return;
  if (marker === 0xe0 && (_startsWith(payload, 'JFIF\0') || _startsWith(payload, 'JFXX\0'))) return;
  if (marker === 0xee && _startsWith(payload, 'Adobe')) return;
  if (marker === 0xed && _startsWith(payload, 'Photoshop 3.0\0')) {
    ctx.irb.push(payload.subarray(14));
    return;
  }
  if (marker === 0xec && _startsWith(payload, 'Ducky')) { parseDucky(payload, found); return; }
  found.scanBinary(payload);
}

async function _detectJpeg(fh, size, found) {
  let buf = Buffer.alloc(0);
  const ensure = async (end) => {
    if (end <= buf.length) return true;
    if (end > size || end > LIMITS.jpegHeader) return false;
    const want = Math.min(Math.max(end, buf.length + 256 * KB), size, LIMITS.jpegHeader);
    const nb = Buffer.alloc(want);
    buf.copy(nb, 0);
    let got = buf.length;
    while (got < want) {
      const { bytesRead } = await fh.read(nb, got, want - got, got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    buf = nb.subarray(0, got);
    return end <= buf.length;
  };
  const ctx = { orientation: null, xmpExt: [], irb: [] };
  if (!(await ensure(4)) || buf[0] !== 0xff || buf[1] !== 0xd8) { found.bad = true; return ctx; }
  let pos = 2;
  let segs = 0;
  let sos = false;
  for (;;) {
    if (!(await ensure(pos + 4))) { if (size > LIMITS.jpegHeader) found.over = true; else found.bad = true; break; }
    if (buf[pos] !== 0xff) { found.bad = true; break; }
    const m = buf[pos + 1];
    if (m === 0xff) { pos += 1; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { pos += 2; continue; }
    if (m === 0xd9) { found.bad = true; break; }
    if (++segs > LIMITS.segments) { found.over = true; break; }
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2) { found.bad = true; break; }
    if (m === 0xda) { sos = true; break; }
    if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
      if (!(await ensure(pos + 2 + len))) { if (pos + 2 + len > size) found.bad = true; else found.over = true; break; }
      jpegSegment(m, buf.subarray(pos + 4, pos + 2 + len), found, ctx);
    }
    pos += 2 + len;
    if (found.over) break;
  }
  if (!sos && !found.over) found.bad = true;
  if (ctx.irb.length) parseIrb(Buffer.concat(ctx.irb), found);
  if (ctx.xmpExt.length) parseXmp(Buffer.concat(ctx.xmpExt).toString('utf8'), found);
  return ctx;
}

/**
 * The cleaned JPEG as a list of buffers (pieces of `buf` and new blocks).
 * Throws when the file is not a JPEG it can follow to the end of the picture.
 */
function jpegStrip(buf) {
  if (!(buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8)) throw _err('BAD_JPEG', 'Not a JPEG.');
  let pos = 2;
  let orientation = null;
  let jfif = null;
  let adobe = null;
  const icc = [];
  const head = [];
  const found = new Found();   // only for the orientation
  let segs = 0;
  for (;;) {
    if (pos + 4 > buf.length || buf[pos] !== 0xff) throw _err('BAD_JPEG', 'Broken JPEG.');
    const m = buf[pos + 1];
    if (m === 0xff) { pos += 1; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { pos += 2; continue; }
    if (m === 0xd9) throw _err('BAD_JPEG', 'Broken JPEG.');
    if (++segs > LIMITS.segments * 4) throw _err('BAD_JPEG', 'Broken JPEG.');
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2 || pos + 2 + len > buf.length) throw _err('BAD_JPEG', 'Broken JPEG.');
    const seg = buf.subarray(pos, pos + 2 + len);
    const payload = buf.subarray(pos + 4, pos + 2 + len);
    pos += 2 + len;
    if (m >= 0xe0 && m <= 0xef) {
      if (m === 0xe1 && _startsWith(payload, 'Exif') && orientation == null) {
        const r = parseTiff(payload.subarray(6), found);
        orientation = r.orientation || 0;
      } else if (m === 0xe2 && _startsWith(payload, 'ICC_PROFILE\0')) icc.push(seg);
      else if (m === 0xe0 && _startsWith(payload, 'JFIF\0') && !jfif && payload.length >= 12) {
        const j = Buffer.alloc(18);
        j.writeUInt16BE(0xffe0, 0);
        j.writeUInt16BE(16, 2);
        j.write('JFIF\0', 4, 'latin1');
        payload.copy(j, 9, 5, 12);   // version, units, densities
        j[16] = 0; j[17] = 0;         // no thumbnail
        jfif = j;
      } else if (m === 0xee && _startsWith(payload, 'Adobe') && payload.length === 12 && !adobe) adobe = seg;
      continue;   // every other APPn goes
    }
    if (m === 0xfe) continue;   // COM goes
    head.push(seg);
    if (m === 0xda) break;
  }
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
  pieces.push(...head);
  // The scans: picture data copied as it is; between scans only the
  // markers the picture needs (tables, restart, more scans), never APPn or COM.
  let start = pos;
  let guard = 0;
  for (;;) {
    const i = buf.indexOf(0xff, pos);
    if (i < 0 || i + 1 >= buf.length) throw _err('BAD_JPEG', 'The JPEG has no end.');
    const m = buf[i + 1];
    if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) { pos = i + 2; continue; }
    if (m === 0xff) { pos = i + 1; continue; }
    if (++guard > 100000) throw _err('BAD_JPEG', 'Broken JPEG.');
    pieces.push(buf.subarray(start, i));
    if (m === 0xd9) { pieces.push(Buffer.from([0xff, 0xd9])); break; }   // anything after the end goes
    if (i + 4 > buf.length) throw _err('BAD_JPEG', 'Broken JPEG.');
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw _err('BAD_JPEG', 'Broken JPEG.');
    if (!((m >= 0xe0 && m <= 0xef) || m === 0xfe)) pieces.push(buf.subarray(i, i + 2 + len));
    pos = i + 2 + len;
    start = pos;
  }
  return pieces;
}

/* ── PNG ──────────────────────────────────────────────────────────────── */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_TEXT = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf']);
// Ancillary chunks a viewer needs to draw the picture as it was (colour,
// transparency, density, animation). Unknown ancillary chunks go.
const PNG_KEEP = new Set(['tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'mDCv', 'cLLI', 'cLLi',
  'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT']);
const PNG_QUIET_KEYS = /^(software|creation time|date:.*|png:.*|icc:.*|signature|thumb::.*|exif:(date.*|offset.*|subsec.*|exif.*|pixel.*|color.*|components.*|compression|orientation|resolution.*|x.*resolution|y.*resolution|flashpix.*|scene.*|exposure.*|f.*number|iso.*|shutter.*|aperture.*|focal.*|flash|white.*|metering.*|brightness.*|light.*|sensing.*|contrast|saturation|sharpness|gain.*|digital.*|custom.*|subject.*distance.*|interop.*|thumbnail.*|jpeg.*|ycbcr.*|bits.*|photometric.*|samples.*|planar.*|software|version|max.*))$/i;

function _inflate(b) {
  try { return zlib.inflateSync(b, { maxOutputLength: LIMITS.inflate }); } catch { return null; }
}

/** ImageMagick's "Raw profile type X": "\nexif\n   1234\nhex hex...". */
function _rawProfile(text) {
  const m = /^\s*\n?\s*[a-z0-9-]*\s*\n\s*(\d+)\s*\n([\s\S]*)$/i.exec(text);
  if (!m) return null;
  const hex = m[2].replace(/[^0-9a-fA-F]/g, '');
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
  else if (lk === 'comment') { if (SOFTWARE_RX.test(tidy(text))) found.scan(text); else found.field('Comment', text); }
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

/**
 * Walk a PNG's chunks: [{ type, pos, len }] up to IEND. Sets found.bad / over.
 * onText(type, data) for each chunk of a type in `read` (default: the text
 * chunks and eXIf).
 */
async function _pngChunks(fh, size, found, onText, read = PNG_TEXT) {
  const list = [];
  let pos = 8;
  let textBytes = 0;
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
    }
    pos += 12 + len;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended && !found.over) found.bad = true;
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
    const t = _inflate(data.subarray(z + 2));
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
  if (flag === 1) { body = _inflate(body); if (!body) { found.bad = true; return; } }
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

async function _probe(filepath, handle) {
  const [probeExe, ...probePre] = _probeCmd();
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
    if (key === 'encoded_by' && (SOFTWARE_RX.test(val) || /\d+\.\d+/.test(val))) { found.scan(v); continue; }
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
  const counts = { v: 0, a: 0, s: 0 };
  for (const s of streams) {
    if (!s || typeof s !== 'object') continue;
    if (s.codec_type === 'video') counts.v++;
    else if (s.codec_type === 'audio') counts.a++;
    else if (s.codec_type === 'subtitle') counts.s++;
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
  return { counts, image };
}

/* ── detect: one file ─────────────────────────────────────────────────── */

/**
 * Check one file. Never throws.
 * @returns {Promise<{status:'personal'|'clean'|'unchecked', kind:string|null, findings:{label,value}[], counts?:object}>}
 */
async function detect(filepath, { handle } = {}) {
  const found = new Found();
  let kind = null;
  let fh = null;
  let extra = {};
  try {
    fh = await fs.promises.open(filepath, 'r');
    const st = await fh.stat();
    if (!st.isFile()) return { status: 'unchecked', kind: null, findings: [] };
    const head = await _readAt(fh, 0, Math.min(16, st.size));
    if (head && head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      kind = 'jpeg';
      const ctx = await _detectJpeg(fh, st.size, found);
      extra = { orientation: ctx.orientation };
    } else if (head && head.length >= 8 && head.subarray(0, 8).equals(PNG_SIG)) {
      kind = 'png';
      const ctx = { orientation: null };
      await _pngChunks(fh, st.size, found, (type, data) => _pngTextChunk(type, data, found, ctx));
      extra = { orientation: ctx.orientation };
    } else {
      kind = 'probe';
    }
  } catch {
    found.bad = true;
  } finally {
    if (fh) { try { await fh.close(); } catch {} }
  }
  if (kind === 'probe') {
    const j = await _probe(filepath, handle);
    if (!j) return { status: 'unchecked', kind: null, findings: [] };
    const r = _fromProbe(j, found);
    kind = r.image ? 'image' : 'av';
    extra = { counts: r.counts };
    if (!found.personal()) {
      // ffprobe does not show a picture's EXIF or XMP; nothing found is not "clean".
      if (r.image) return { status: 'unchecked', kind, findings: [], ...extra };
      if (r.counts.v + r.counts.a === 0) return { status: 'unchecked', kind, findings: [], ...extra };
    }
  }
  if (found.personal()) return { status: 'personal', kind, findings: found.findings(), ...extra };
  if (found.bad || found.over || !kind) return { status: 'unchecked', kind, findings: [], ...extra };
  return { status: 'clean', kind, findings: [], ...extra };
}

/* ── The session cache and the check line ─────────────────────────────── */

const _cache = new Map();     // key -> result (oldest first)
const _inflight = new Map();  // key -> promise
const _running = new Set();   // handles of probes running now
let _gen = 0;
let _active = 0;
const _wait = [];

function _key(f) {
  return `${f.path}\0${f.size}\0${f.mtimeMs}`;
}

function _remember(key, r) {
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, r);
  while (_cache.size > LIMITS.cache) _cache.delete(_cache.keys().next().value);
}

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
 * The result for one file (path, size, mtimeMs), from the cache or a check.
 * wanted(): asked when its turn comes; false skips it (resolves null, not cached).
 * The file is looked at again first: a file that changed is checked as it is now.
 */
function checkFile(f, { wanted = () => true, handle = null } = {}) {
  const key = _key(f);
  const hit = _cache.get(key);
  if (hit) return Promise.resolve(hit);
  if (_inflight.has(key)) return _inflight.get(key);
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
      let st = null;
      try { st = fs.statSync(f.path); } catch { st = null; }
      // Changed while it was read: not kept under the old key.
      if (st && st.size === f.size && Math.trunc(st.mtimeMs) === f.mtimeMs) _remember(key, r);
      return r;
    } finally {
      _release();
      if (_inflight.get(key) === p) _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

/** The cached result for a file, or null (never starts a check). */
function cached(f) {
  return _cache.get(_key(f)) || null;
}

/**
 * The server's own check of a share's files at its pack turn: every file as
 * it is now (stat, then the cache or a check). onFile: after each file (a
 * sign of life). Results in the order of `paths`; null for a file that could
 * not be read. Throws CANCELLED when the handle is cancelled.
 */
async function checkNow(paths, { handle, onFile } = {}) {
  const out = new Array(paths.length).fill(null);
  const kill = () => { for (const h of _running) { h.cancelled = true; try { if (h.kill) h.kill(); } catch {} } };
  if (handle) handle.kill = kill;
  try {
    await Promise.all(paths.map(async (p, i) => {
      let st;
      try { st = await fs.promises.stat(p); } catch { st = null; }
      if (!st || !st.isFile() || (handle && handle.cancelled)) return;
      const f = { path: p, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
      // A check of the same file already under way for step 1 may be skipped
      // (its window closed) and answer null: then it is asked again, so no
      // file goes unchecked here by accident.
      let r = null;
      for (let tries = 0; !r && tries < 5 && !(handle && handle.cancelled); tries++) r = await checkFile(f, { handle });
      out[i] = r;
      if (onFile && r) { try { onFile(); } catch {} }
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
      .catch(() => { if (_checks.get(rec.id) === rec) rec.results[i] = { status: 'unchecked', kind: null, findings: [] }; });
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

async function _cleanJpeg(src, tmp, handle) {
  const st = await fs.promises.stat(src);
  if (st.size > LIMITS.jpegClean) throw _err('CLEAN_FAILED', 'Too large.');
  const buf = await fs.promises.readFile(src, { flag: 'r' });
  const pieces = jpegStrip(buf);
  const want = pieces.reduce((n, p) => n + p.length, 0);
  const n = await _writeNew(tmp, pieces, { handle });
  return { expected: want, written: n };
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
      const critical = c.type[0] >= 'A' && c.type[0] <= 'Z';
      if (critical || PNG_KEEP.has(c.type)) {
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

async function _cleanAv(src, tmp, handle, onActivity) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n',
    '-i', _ffPath(src),
    '-map', '0:v?', '-map', '0:a?', '-map', '0:s?', '-c', 'copy',
    '-map_metadata', '-1', '-map_metadata:c', '-1',
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
      r = await _cleanAv(srcAbs, tmp, handle, onActivity);
    } else throw fail();
    if (handle && handle.cancelled) throw _err('CANCELLED', 'Packing was cancelled.');
    if (onActivity) { try { onActivity(); } catch {} }
    // A new file of its own: a regular file, one link, not the original.
    const ts = await fs.promises.lstat(tmp);
    if (!ts.isFile() || ts.nlink !== 1 || ts.size <= 0) throw fail();
    if (ts.ino && st.ino && ts.ino === st.ino && ts.dev === st.dev) throw fail();
    if (r.expected != null && (ts.size !== r.expected || r.written !== r.expected)) throw fail();
    // Video and audio lose only metadata and data tracks: far smaller means something is missing.
    if (r.expected == null && st.size > 64 * KB && ts.size < st.size * 0.5) throw fail();
    // Checked again with the same checker.
    const again = await detect(tmp, { handle });
    if (handle && handle.cancelled) throw _err('CANCELLED', 'Packing was cancelled.');
    if (again.status === 'personal') throw fail();
    if ((known.kind === 'jpeg' || known.kind === 'png') && (again.status !== 'clean' || again.kind !== known.kind)) throw fail();
    if (known.kind === 'av') {
      const a = again.counts || {};
      const b = known.counts || {};
      if (again.status !== 'clean' || a.v !== b.v || a.a !== b.a || a.s !== b.s) throw fail();
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
  detect, checkFile, checkNow, cached, startCheck, checkStatus, forget, cleanCopy,
  // pieces, for tests
  parseTiff, parseXmp, jpegStrip, orientationTiff, crc32, tidy, shorten, Found, _fromProbe, _probeTags,
  LIMITS, CATS, _setForTest, _stateForTest,
};
