// The width and height of the agent's picture, read from the header of the file (spec, section 8.17):
// the server refuses a picture larger than the browser makes, so that one upload cannot make every
// employee's browser unpack gigabytes. Headers are built in test-pictures.ts, independently of the
// code under test.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { imageSizeOf } from './image-size.ts';
import { JPEG_2X2, jpegHeader, PNG_2X2, pngHeader, WEBP_2X2, webpHeader, type Header } from './test-pictures.ts';

const side = (max: number) => fc.integer({ min: 1, max });
// What comes before the frame header of a JPEG: application data, comments, tables — DHT (0xc4) is
// in the range of frame headers but is not one.
const segment = fc.record({ marker: fc.constantFrom(0xe0, 0xe1, 0xed, 0xfe, 0xdb, 0xc4, 0xdd), payload: fc.uint8Array({ maxLength: 40 }) });
const FRAME_HEADERS = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];

const header: fc.Arbitrary<Header> = fc.oneof(
  fc.tuple(side(2 ** 31 - 1), side(2 ** 31 - 1)).map(([w, h]) => pngHeader(w, h)),
  fc
    .tuple(side(65_535), side(65_535), fc.array(segment, { maxLength: 4 }), fc.constantFrom(...FRAME_HEADERS), fc.nat({ max: 3 }))
    .map(([w, h, before, sof, fill]) => jpegHeader(w, h, { before, sof, fill })),
  fc.tuple(side(16_383), side(16_383), fc.nat({ max: 3 })).map(([w, h, scale]) => webpHeader('VP8 ', w, h, scale)),
  fc.tuple(side(16_384), side(16_384)).map(([w, h]) => webpHeader('VP8L', w, h)),
  fc.tuple(side(2 ** 24), side(2 ** 24)).map(([w, h]) => webpHeader('VP8X', w, h)),
);

const real = (bytes: Uint8Array, type: Header['type']): Header => ({ bytes, type, width: 2, height: 2, sizeEnd: bytes.length });
// Where the bytes end: the whole header, a few bytes around the end of the size (an off-by-one
// there is the usual mistake) or anywhere.
const WHOLE = { near: null, at: 0 };
const cut = fc.oneof(fc.constant(WHOLE), fc.record({ near: fc.integer({ min: -3, max: 3 }), at: fc.constant(0) }), fc.record({ near: fc.constant(null), at: fc.nat() }));

describe('imageSizeOf', () => {
  it('reads the size of a whole header exactly and never guesses it from a cut one', () => {
    fc.assert(
      fc.property(header, cut, ({ bytes, type, width, height, sizeEnd }, { near, at }) => {
        const length = near !== null ? Math.min(Math.max(sizeEnd + near, 0), bytes.length) : at === 0 ? bytes.length : at % bytes.length;
        expect(imageSizeOf(bytes.subarray(0, length), type)).toEqual(length >= sizeEnd ? { width, height } : null);
      }),
      {
        examples: [
          [real(PNG_2X2, 'image/png'), WHOLE],
          [real(WEBP_2X2, 'image/webp'), WHOLE],
          [real(JPEG_2X2, 'image/jpeg'), WHOLE],
          [pngHeader(1, 1), WHOLE],
          [webpHeader('VP8 ', 16_383, 1, 3), WHOLE],
          [webpHeader('VP8L', 16_384, 16_384), WHOLE],
          [jpegHeader(257, 256, { before: [{ marker: 0xc4, payload: Uint8Array.from([0, 1, 0, 1, 0, 1]) }] }), WHOLE],
          [jpegHeader(300, 200), { near: -1, at: 0 }],
        ],
      },
    );
  });

  it('answers any bytes after a signature with a size or nothing, never with a failure or a hang', () => {
    const signed = fc.oneof(
      fc.uint8Array({ maxLength: 80 }).map((tail) => ({ bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail]), type: 'image/png' as const })),
      fc.uint8Array({ maxLength: 80 }).map((tail) => ({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, ...tail]), type: 'image/jpeg' as const })),
      fc
        .tuple(fc.constantFrom('VP8 ', 'VP8L', 'VP8X', 'ALPH'), fc.uint8Array({ maxLength: 80 }))
        .map(([kind, tail]) => ({ bytes: Uint8Array.from([...Buffer.from(`RIFF\0\0\0\0WEBP${kind}`, 'latin1'), ...tail]), type: 'image/webp' as const })),
    );
    fc.assert(
      fc.property(signed, ({ bytes, type }) => {
        const size = imageSizeOf(bytes, type);
        if (size) expect(Number.isInteger(size.width) && size.width > 0 && Number.isInteger(size.height) && size.height > 0).toBe(true);
      }),
      // Segments that say they are shorter than their own length field.
      { examples: [[{ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xe0, 0x00, 0x01]), type: 'image/jpeg' }]] },
    );
  });
});
