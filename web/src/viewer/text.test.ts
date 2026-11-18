import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeText } from './text.ts';

const cp1251 = (text: string) => new Uint8Array([...text].map((ch) => (ch >= 'А' && ch <= 'я' ? ch.charCodeAt(0) - 0x410 + 0xc0 : ch.charCodeAt(0))));

describe('text files in the viewer (spec, section 8.27)', () => {
  it('reads UTF-8, Windows-1251 of Russian Excel, and UTF-16 by its mark', () => {
    expect(decodeText(new TextEncoder().encode('Реестр;Сумма'), false)).toBe('Реестр;Сумма');
    expect(decodeText(cp1251('Реестр;Сумма'), false)).toBe('Реестр;Сумма');
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...'Итог'].flatMap((ch) => [ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8])]);
    expect(decodeText(utf16, false)).toBe('Итог');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Да')]), false)).toBe('Да');
  });

  it('a file cut at 1 MB in the middle of a letter is still UTF-8, without the broken end', () => {
    const bytes = new TextEncoder().encode('Ёлка');
    expect(decodeText(bytes.slice(0, 5), true)).toBe('Ёл');
  });

  it('any UTF-8 text cut anywhere reads as its beginning', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', minLength: 1 }), fc.nat(), (text, at) => {
        const bytes = new TextEncoder().encode(text);
        const cut = bytes.slice(0, at % (bytes.length + 1));
        const read = decodeText(cut, true);
        expect(text.startsWith(read)).toBe(true);
      }),
    );
  });
});
