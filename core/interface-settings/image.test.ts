// The agent's picture is recognised by its first bytes (spec, section 8.17): PNG, JPEG or WebP,
// never by the file's name or the type the browser declared; no larger than the browser makes it.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkAgentImage, imageTypeOf } from './image.ts';
import { AGENT_IMAGE_MAX_BYTES, AGENT_IMAGE_SIDE_PX } from '@bba/contracts';
import { isAppError } from '../errors/app-error.ts';
import { PNG_2X2, pngHeader, webpHeader } from './test-pictures.ts';

// Signatures written out here independently of the code under test; `size` is the four bytes of
// a WebP file's length, which say nothing about the format.
const SIGNED = {
  'image/png': (tail: Uint8Array) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail]),
  'image/jpeg': (tail: Uint8Array) => Uint8Array.from([0xff, 0xd8, 0xff, ...tail]),
  'image/webp': (tail: Uint8Array, size: Uint8Array = Uint8Array.from([1, 2, 3, 4])) => Uint8Array.from([...ascii('RIFF'), ...size, ...ascii('WEBP'), ...tail]),
} as const;
const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((b, i) => bytes[i] === b);
function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}
function looksLike(bytes: Uint8Array, type: keyof typeof SIGNED): boolean {
  if (type === 'image/png') return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (type === 'image/jpeg') return startsWith(bytes, [0xff, 0xd8, 0xff]);
  return startsWith(bytes, ascii('RIFF')) && startsWith(bytes.slice(8), ascii('WEBP'));
}

describe('imageTypeOf', () => {
  it('tells a picture by its first bytes and nothing else', () => {
    // `expected` undefined: the bytes are not built to be a picture, only soundness is checked.
    type Case = { bytes: Uint8Array; expected: string | null | undefined };
    const type = fc.constantFrom(...(Object.keys(SIGNED) as (keyof typeof SIGNED)[]));
    const signed = fc
      .tuple(type, fc.uint8Array({ maxLength: 64 }), fc.uint8Array({ minLength: 4, maxLength: 4 }))
      .map(([t, tail, size]): Case => ({ bytes: SIGNED[t](tail, size), expected: t }));
    const anyBytes = fc.uint8Array({ maxLength: 64 }).map((bytes): Case => ({ bytes, expected: undefined }));
    // A signature with one byte changed: random bytes almost never come this close.
    const nearMiss = fc
      .tuple(signed, fc.nat(), fc.integer({ min: 1, max: 255 }))
      .map(([{ bytes }, at, delta]): Case => {
        const changed = bytes.slice();
        const i = at % Math.min(changed.length, 12);
        changed[i] = (changed[i]! + delta) % 256;
        return { bytes: changed, expected: undefined };
      });
    fc.assert(
      fc.property(fc.oneof(signed, anyBytes, nearMiss), ({ bytes, expected }) => {
        const found = imageTypeOf(bytes);
        if (expected !== undefined) expect(found).toBe(expected);
        // Whatever it recognises really starts with that signature; the rest is refused.
        if (found !== null) expect(looksLike(bytes, found)).toBe(true);
      }),
      {
        examples: [
          [{ bytes: new Uint8Array(), expected: null }],
          [{ bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]), expected: null }],
          [{ bytes: Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]), expected: null }],
          [{ bytes: Uint8Array.from(ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), expected: null }],
          [{ bytes: Uint8Array.from(ascii('GIF89a')), expected: null }],
        ],
      },
    );
  });
});

describe('checkAgentImage', () => {
  it('keeps the bytes, their type and sha256 of a picture', () => {
    const image = checkAgentImage(PNG_2X2);
    expect(image).toEqual({ bytes: PNG_2X2, type: 'image/png', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(checkAgentImage(pngHeader(AGENT_IMAGE_SIDE_PX, AGENT_IMAGE_SIDE_PX).bytes).type).toBe('image/png');
  });

  it('refuses another format, a picture over the limit, a picture without its size and a larger one with APP_AGENT_IMAGE_INVALID', () => {
    const refused = (bytes: Uint8Array): string => {
      try {
        checkAgentImage(bytes);
      } catch (error) {
        if (!isAppError(error)) throw error;
        expect(error.code).toBe('APP_AGENT_IMAGE_INVALID');
        return error.userMessage;
      }
      return expect.unreachable('a wrong picture was accepted');
    };
    expect(refused(Uint8Array.from(ascii('GIF89a')))).toMatch(/Нужен PNG, JPEG или WebP/);
    expect(refused(SIGNED['image/jpeg'](new Uint8Array(AGENT_IMAGE_MAX_BYTES)))).toMatch(/больше 512 КБ/);
    expect(refused(SIGNED['image/png'](new Uint8Array([1, 2, 3])))).toMatch(/Нужен PNG, JPEG или WebP/);
    for (const larger of [pngHeader(AGENT_IMAGE_SIDE_PX + 1, 1), pngHeader(1, AGENT_IMAGE_SIDE_PX + 1), webpHeader('VP8L', 16_384, 16_384)]) {
      expect(refused(larger.bytes)).toMatch(/больше 256×256 точек/);
    }
  });
});
