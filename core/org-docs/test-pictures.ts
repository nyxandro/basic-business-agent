// Real PNG files for the tests of the letterhead, the stamp and the signature: a filled shape on a background that is
// transparent (RGBA) or white (RGB, no transparency), any size. Built byte by byte, independently of the code under test.
import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// A dark blue circle in the middle; around it — transparent (`alpha`) or white.
export function testPng(width: number, height: number, { alpha }: { alpha: boolean }): Buffer {
  const channels = alpha ? 4 : 3;
  const rows: Buffer[] = [];
  const r = Math.min(width, height) / 2 - 1;
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * channels);
    for (let x = 0; x < width; x++) {
      const inside = (x - width / 2) ** 2 + (y - height / 2) ** 2 <= r * r;
      const px = inside ? [20, 60, 160, 255] : [255, 255, 255, 0];
      for (let c = 0; c < channels; c++) row[1 + x * channels + c] = px[c]!;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
