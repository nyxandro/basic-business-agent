import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { marksOf, type FoundBy } from './marks.ts';
import { buildVariants, normalize, type WordVariants } from './variants.ts';

const w = (query: string, corrections: Record<string, string[]> = {}): WordVariants[] =>
  buildVariants(query, new Map([['договоры', 'договор']])).map((word) => ({ ...word, corrections: corrections[word.word] ?? [] }));
// The marked pieces of a text, as the person sees them.
const marked = (text: string, words: WordVariants[], by: FoundBy = 'direct') => marksOf(text, words, by).map(([from, to]) => text.slice(from, to));

describe('what of a text the search found (spec, section 8.21)', () => {
  it('marks the word in any case and with «ё»', () => {
    expect(marked('Ёлка во дворе, ещё одна ЁЛКА', w('ёлка'))).toEqual(['Ёлка', 'ЁЛКА']);
  });

  it('marks the stem of another form, the Latin, the other layout and a piece inside a word', () => {
    expect(marked('Пришлю по договору завтра', w('договоры'))).toEqual(['договор']);
    expect(marked('KP_Yelka_v2.pdf', w('кп ёлка'))).toEqual(['KP', 'Yelka']);
    expect(marked('Бюджет 2026.xlsx', w(',.l;tn'))).toEqual(['Бюджет']);
    expect(marked('Субподряд 2026', w('подряд'))).toEqual(['подряд']);
  });

  it('marks a short word’s Latin only at the start of a word', () => {
    expect(marked('Margin и KP-12', w('кп'))).toEqual(['KP']);
  });

  it('marks what a typo means only when the thing was found with a typo', () => {
    const words = w('кари', { кари: ['карточки'] });
    expect(marked('На карточке и в карточки', words)).toEqual([]);
    // In a message the search goes by the words of the dictionary the typo means — only those.
    expect(marked('На карточке и в карточки', words, 'message-typo')).toEqual(['карточки']);
    expect(marked('Марина подстригла каре', words, 'message-typo')).toEqual([]);
    // In a name — by a word within the allowed edits, as the database compares it (match-sql.ts).
    expect(marked('Марина подстригла каре', words, 'name-typo')).toEqual(['Марина', 'каре']);
    expect(marked('Договор поставки', w('дговор'), 'name-typo')).toEqual(['Договор']);
    expect(marked('Договор поставки', w('дговор'))).toEqual([]);
    // Two letters swapped, in both.
    expect(marked('Договро аренды', w('договор'), 'message-typo')).toEqual(['Договро']);
  });

  it('joins pieces that overlap into one mark', () => {
    // «yelka» and «elka» both mean «ёлка»: one mark, not two crossing.
    expect(marksOf('KP_Yelka', w('ёлка'), 'direct')).toEqual([[3, 8]]);
    // «договоры» and its stem «договор» are both in «Договоры».
    expect(marked('Договоры подписаны', w('договоры'))).toEqual(['Договоры']);
    expect(marksOf('ёлкаёлка', w('ёлка'), 'direct')).toEqual([[0, 8]]);
  });

  it('keeps places right where lower case is longer than the letter (İ)', () => {
    expect(marked('İstanbul: договор', w('договор'))).toEqual(['договор']);
  });

  it('gives marks in order, apart, inside the text, made of variants of a word and covering every one', () => {
    const letters = fc.constantFrom(...'абвгдеёжзийклмнопрстуфхцчшщыьэюяabcdefgklmnoprstuvyz ДОГОВРЁЛКА_.-1');
    fc.assert(
      fc.property(fc.array(letters, { maxLength: 80 }), fc.constantFrom('договор', 'ёлка', 'кп', 'смета', 'kp'), (chars, query) => {
        const text = chars.join('');
        const words = w(query);
        const marks = marksOf(text, words, 'direct');
        marks.forEach(([from, to], i) => {
          expect(0 <= from && from < to && to <= text.length).toBe(true);
          if (i > 0) expect(from).toBeGreaterThan(marks[i - 1]![1]);
          // Every mark is made of found pieces: a piece of a variant starts it.
          const piece = normalize(text.slice(from, to));
          expect(words.some((word) => [...word.direct, ...word.starts].some((v) => piece.startsWith(v)))).toBe(true);
        });
        // …and nothing the search goes by is left unmarked.
        const normal = normalize(text);
        const covered = (from: number, to: number) => marks.some(([a, b]) => a <= from && to <= b);
        for (const piece of words.flatMap((word) => word.direct)) {
          for (let at = normal.indexOf(piece); at >= 0; at = normal.indexOf(piece, at + 1)) expect(covered(at, at + piece.length)).toBe(true);
        }
      }),
      { examples: [[[...'ёлкаёлка'], 'ёлка'], [[...'kpkp'], 'кп']] },
    );
  });
});
