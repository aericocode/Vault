/**
 * Small media files for the personal details tests (test/share-meta*.test.js).
 * BASE_JPEG: a real 16x16 baseline JPEG made by ffmpeg (bitexact): SOI, JFIF,
 * DQT, DHT, SOF0, SOS, picture data, EOI. No personal details in it.
 */
const zlib = require('node:zlib');

const BASE_JPEG = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD/2wBDAAgKCgsKCw0NDQ0NDRAPEBAQEBAQEBAQEBASEhIVFRUSEhIQEBISFBQVFRcXFxUVFRUXFxkZGR4eHBwjIyQrKzP/xABvAAEBAAAAAAAAAAAAAAAAAAAFBgEBAQEAAAAAAAAAAAAAAAAABgMAEAADAAICAQQCAwEAAAAAAAABAgMEERIFABMhMQZCQTIjFCIRAAEEAgEEAgMBAAAAAAAAAAECAwQRBRIhMQAUEwYVQSMyQv/AABEIABAAEAMBEgACEgADEgD/2gAMAwEAAhEDEQA/AJk41+l6HEpKzyteSZBpGjqQtSlJqGAQgiddOB+RI2RryhyZ4fZ9Jgr/ALseQlDHx2bkjgekk05N/YvHkZn2PxvWzrxTgsRjpbvtkxmZJUCKfQl1AHPRCwUf4BsjYc0a7OYT5LLYmiI3iX3yLOyVrvXm1aiOrgbCzddO9HlLmoyiHUtn6puIiGoJpTfmOFx9d3/a6Si+KQmhWyrhkmncB9kWG15FGSEZSVtpKUoTDUEqUCkOhwFS0pJBSElQHN9q9v2afV+wlfHjKcFonrRlJAGmfTV+CgzAcK7sn/QHPXLY8E+yY+b3mXfGTEyJ8daZZ0ry/gfZQi/pN/J9j4LwWUyEtOsmXIkBXX3OKdPG9UXCojoOhF0L7SYr47BiRDIYzEaYUC1NtpbsXtQJTIXV2a4/HdokVqW7mXXt3FY7wvCBcc9cfygQ/o2Fhv8AYANrSeeevdPjkiPJXlGpTzUB3ICIfS8tIca8YE1qstqXsDfRNDnnv//Z', 'base64');

/** One JPEG segment: FF marker, length, payload. */
function seg(marker, payload) {
  const h = Buffer.alloc(4);
  h[0] = 0xff; h[1] = marker; h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}

/** BASE_JPEG with a COM segment holding text, right after its JFIF header. */
function jpegWithComment(text) {
  return Buffer.concat([BASE_JPEG.subarray(0, 20), seg(0xfe, Buffer.from(text, 'utf8')), BASE_JPEG.subarray(20)]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}
/** A 4x4 RGB PNG, with a tEXt chunk per [keyword, text] given. */
function pngWithText(pairs = []) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(4 * 13, 7); for (let r = 0; r < 4; r++) raw[r * 13] = 0;
  const text = pairs.map(([k, v]) => chunk('tEXt', Buffer.from(`${k}\0${v}`, 'latin1')));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...text,
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { BASE_JPEG, seg, jpegWithComment, pngWithText };
