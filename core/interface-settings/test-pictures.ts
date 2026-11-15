// Pictures for the tests of the agent's mark (spec, section 8.17): real 2×2 files, and the headers of
// PNG, JPEG and WebP built byte by byte here, independently of the code under test, with any width
// and height. Only the first bytes of a picture carry its size; the rest is filler.
import type { AgentImageType } from './image.ts';

export const PNG_2X2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGM8oaHBwMDAxMDAwMDAAAAN6gEcJJUQNAAAAABJRU5ErkJggg==', 'base64');
// Lossy ('VP8 '), as a browser's canvas writes it.
export const WEBP_2X2 = Buffer.from('UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/vCbQ/4DdfFtMv/ucD/uyf/2yf+pAAAA', 'base64');
// Baseline JFIF with two quantisation tables before the frame header (SOF0).
export const JPEG_2X2 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDiqKKK8A/Wz//Z',
  'base64',
);

// A built header: its bytes, what they say, and where the size ends — fewer bytes than that carry
// no size at all.
export interface Header {
  bytes: Uint8Array;
  type: AgentImageType;
  width: number;
  height: number;
  sizeEnd: number;
}

const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0));
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [Math.floor(n / 2 ** 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number) => [...le24(n), Math.floor(n / 2 ** 24) & 0xff];
const FILLER = [0x11, 0x22, 0x33, 0x44];

// Signature, then the IHDR chunk: length 13, «IHDR», width, height, depth 8, RGB, then its CRC.
export function pngHeader(width: number, height: number): Header {
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii('IHDR'), ...be32(width), ...be32(height), 8, 2, 0, 0, 0, ...FILLER];
  return { bytes: Uint8Array.from(bytes), type: 'image/png', width, height, sizeEnd: 24 };
}

// SOI, the segments a camera or an editor puts first, fill bytes, then the frame header (SOFn):
// length, precision, height, width, components.
export function jpegHeader(width: number, height: number, { before = [], sof = 0xc0, fill = 0 }: { before?: { marker: number; payload: Uint8Array }[]; sof?: number; fill?: number } = {}): Header {
  const bytes = [0xff, 0xd8];
  for (const { marker, payload } of before) bytes.push(0xff, marker, ...be16(payload.length + 2), ...payload);
  for (let i = 0; i < fill; i++) bytes.push(0xff);
  const start = bytes.length;
  bytes.push(0xff, sof, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, ...FILLER);
  return { bytes: Uint8Array.from(bytes), type: 'image/jpeg', width, height, sizeEnd: start + 9 };
}

// RIFF, length, WEBP, then the first chunk: lossy key frame (start code 9d 01 2a, 14-bit sides, the
// two upper bits of each are its upscaling, `scale`), lossless (signature 0x2f, sides minus one
// packed in 14 bits each) or extended (sides minus one, 24 bits each).
export function webpHeader(kind: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number, scale = 0): Header {
  const start = [...ascii('RIFF'), ...le32(100), ...ascii('WEBP'), ...ascii(kind)];
  if (kind === 'VP8 ') {
    const bytes = [...start, ...le32(30), 0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(width + scale * 2 ** 14), ...le16(height + scale * 2 ** 14), ...FILLER];
    return { bytes: Uint8Array.from(bytes), type: 'image/webp', width, height, sizeEnd: 30 };
  }
  if (kind === 'VP8L') {
    const packed = (width - 1) + (height - 1) * 2 ** 14;
    const bytes = [...start, ...le32(30), 0x2f, ...le32(packed), ...FILLER];
    return { bytes: Uint8Array.from(bytes), type: 'image/webp', width, height, sizeEnd: 25 };
  }
  const bytes = [...start, ...le32(10), 0x10, 0, 0, 0, ...le24(width - 1), ...le24(height - 1), ...FILLER];
  return { bytes: Uint8Array.from(bytes), type: 'image/webp', width, height, sizeEnd: 30 };
}
