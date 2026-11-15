// The width and height of a PNG, JPEG or WebP picture, read from the header of the file without
// decoding it (spec, section 8.17). null when the bytes end before the size or the header is not
// what the format says: such a picture is refused, its size is never guessed.
import type { AgentImageType } from './image.ts';

export interface ImageSize {
  width: number;
  height: number;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const tagAt = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
const sized = (width: number, height: number): ImageSize | null => (width > 0 && height > 0 ? { width, height } : null);

// After the 8-byte signature comes IHDR: length, «IHDR», width and height in four bytes each.
function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24 || tagAt(bytes, 12) !== 'IHDR') return null;
  return sized(view(bytes).getUint32(16), view(bytes).getUint32(20));
}

// Frame headers SOF0–SOF15, except the markers of the same range that are tables (DHT 0xc4,
// DAC 0xcc) and reserved (JPG 0xc8).
const isFrameHeader = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
// Markers without a length: TEM, RST0–RST7, SOI.
const standsAlone = (marker: number) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);

// Segments one after another, each «ff marker length…», until the frame header: precision, then
// height and width in two bytes each. Image data (SOS) or the end (EOI) before it — no size.
function jpegSize(bytes: Uint8Array): ImageSize | null {
  // Every step moves forward by at least a byte: the loop ends on any bytes.
  let at = 2;
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (standsAlone(marker)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda || at + 4 > bytes.length) return null;
    const length = view(bytes).getUint16(at + 2);
    if (isFrameHeader(marker)) return at + 9 > bytes.length ? null : sized(view(bytes).getUint16(at + 7), view(bytes).getUint16(at + 5));
    at += 2 + length;
  }
  return null;
}

// RIFF, length, WEBP, then the first chunk (its tag at 12, its data from 20): lossy key frame
// (14-bit sides after the start code; the two upper bits are upscaling), lossless (sides minus one
// in 14 bits each after the signature 0x2f) or extended (sides minus one in 24 bits each).
function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 16) return null;
  const chunk = tagAt(bytes, 12);
  if (chunk === 'VP8 ') {
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return sized(view(bytes).getUint16(26, true) & 0x3fff, view(bytes).getUint16(28, true) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const packed = view(bytes).getUint32(21, true);
    return sized((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') {
    if (bytes.length < 30) return null;
    const side = (offset: number) => bytes[offset]! + bytes[offset + 1]! * 0x100 + bytes[offset + 2]! * 0x10000 + 1;
    return sized(side(24), side(27));
  }
  return null;
}

export function imageSizeOf(bytes: Uint8Array, type: AgentImageType): ImageSize | null {
  if (type === 'image/png') return pngSize(bytes);
  if (type === 'image/jpeg') return jpegSize(bytes);
  return webpSize(bytes);
}
