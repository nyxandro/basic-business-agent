import fc from 'fast-check';
import { ICAO_DOC_9303, translate } from 'iuliia';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import { createPool, type Db } from '../db/pool.ts';
import { buildVariants, cyrillicCandidates, queryVariants, SCHEMES, switchLayout } from './variants.ts';

// Words people of a business look for; «ё» already as «е», as the search compares them.
const WORDS = [
  'договор', 'смета', 'счет', 'поставка', 'бюджет', 'накладная', 'заявка', 'отчет', 'презентация', 'предложение',
  'тендер', 'подряд', 'субподряд', 'аренда', 'склад', 'бетон', 'арматура', 'щебень', 'цемент', 'юрист',
  'бухгалтерия', 'зарплата', 'премия', 'отпуск', 'командировка', 'клиент', 'заказчик', 'поставщик', 'объем', 'район',
  'елка', 'мария', 'щука', 'жилой', 'комплекс', 'северный', 'проект', 'график', 'оплата', 'задолженность',
  'претензия', 'гарантия', 'доверенность', 'устав', 'выписка', 'налог', 'декларация', 'чертеж', 'спецификация', 'расчет',
  'калькуляция', 'логистика', 'доставка', 'маршрут', 'подъезд', 'съезд', 'объявление', 'материал', 'цех', 'хлеб',
];

// Edits between two words (insert, delete, replace): the test's own ruler for «close enough for a typo».
function edits(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}
const typoRoom = (w: string) => (w.length >= 8 ? 2 : 1);

describe('variants of a word of the query (spec, section 8.21)', () => {
  it('switches the keyboard layout of the whole query, punctuation keys included', () => {
    expect(switchLayout(',.l;tn')).toBe('бюджет');
    expect(switchLayout('ljujdjh gjcnfdrb')).toBe('договор поставки');
    expect(switchLayout('вщсгьуте')).toBe('document');
  });

  it('gives the forms a person types: the word, the other layout, Latin by the common systems and back', () => {
    const [ljujdjh] = buildVariants('ljujdjh', new Map());
    expect(ljujdjh!.direct).toContain('договор');
    const [shchuka] = buildVariants('щука', new Map());
    expect(shchuka!.direct).toEqual(expect.arrayContaining(['щука', 'shchuka', 'shhuka', 'schuka', 'scuka']));
    const [dogovor] = buildVariants('dogovor', new Map());
    expect(dogovor!.direct).toContain('договор');
    const [kp] = buildVariants('кп', new Map());
    expect(kp!.direct).toEqual(expect.arrayContaining(['кп', 'kp']));
    expect(kp!.fuzzy).toEqual([]);
  });

  it('adds the stem of a Russian word and its Latin forms', () => {
    const [w] = buildVariants('договоры', new Map([['договоры', 'договор']]));
    expect(w!.direct).toEqual(expect.arrayContaining(['договоры', 'договор', 'dogovor']));
  });

  it('a word written by any common system finds the Russian word, directly or as a typo', () => {
    for (const word of WORDS) {
      for (const [name, schema] of SCHEMES) {
        const latin = translate(word, schema).toLowerCase().replace(/['"`]/g, '');
        const candidates = cyrillicCandidates(latin);
        const found = candidates.includes(word) || candidates.slice(0, 3).some((c) => edits(c, word) <= typoRoom(word));
        expect(found, `${word} by ${name} as «${latin}» gave ${candidates.join(', ')}`).toBe(true);
      }
    }
  });

  // Known: in a word with «ъ», a system that drops it (sezd, obyavleniye) against ICAO that writes it as
  // «ie» (sieezd, obieiavlenie) differ by more than a typo; reading every «e» or «y» as «ъ» would find too much.
  const icao = (word: string) => translate(word, ICAO_DOC_9303).toLowerCase();
  const known = (word: string, typed: string, written: string) => word.includes('ъ') && (typed === icao(word) || written === icao(word));

  it('a word written by one system finds the same word written by any other', () => {
    for (const word of WORDS) {
      const forms = [...new Set(SCHEMES.map(([, schema]) => translate(word, schema).replace(/['"`]/g, '').toLowerCase()))];
      for (const typed of forms) {
        const [v] = buildVariants(typed, new Map());
        for (const written of forms) {
          if (known(word, typed, written)) continue;
          const direct = v!.direct.some((d) => written.includes(d) && d.length >= Math.min(4, written.length));
          const typo = v!.fuzzy.some((f) => edits(f, written) <= typoRoom(written));
          expect(direct || typo, `«${typed}» does not find «${written}» (${word}): ${v!.direct.join(', ')}`).toBe(true);
        }
      }
    }
  });

  // A query as typed: business words, Latin letters with the punctuation keys of the other layout, any
  // characters, up to 8 words split by any spaces.
  const token = fc.oneof(
    fc.constantFrom(...WORDS),
    fc.string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz,.;[]\'`'), minLength: 1, maxLength: 10 }),
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 8 }).filter((t) => !/\s/.test(t)),
  );
  const query = fc.tuple(fc.array(token, { maxLength: 8 }), fc.constantFrom(' ', '  ', '\t', '\u00a0', ' \n ')).map(([tokens, gap]) => tokens.join(gap));

  // No counterexample in the default 100 runs over queries of that shape.
  it('loses no word of any query and never fails on it', () => {
    fc.assert(
      fc.property(query, (q) => {
        const words = q.toLowerCase().replaceAll('ё', 'е').split(/\s+/).filter(Boolean);
        const variants = buildVariants(q, new Map());
        expect(variants.map((v) => v.word)).toEqual(words);
        for (const v of variants) {
          expect(v.direct).toContain(v.word);
          expect(v.direct.length).toBeLessThanOrEqual(24);
          expect(v.fuzzy.every((f) => f.length >= 4)).toBe(true);
        }
      }),
      { examples: [['ljujdjh  ,.l;tn'], ['   '], ['Ёлка'], ['a b']] },
    );
  });
});

describe('stems from the dictionary of the database', () => {
  let database: TestDatabase;
  let db: Db;
  beforeAll(async () => {
    database = await createTestDatabase();
    db = createPool(database.url);
  });
  afterAll(async () => {
    await db.end();
    await database.drop();
  });

  it('finds «договору» by «договоры» and «сметы» by «смета», and leaves Latin words as they are', async () => {
    const [dogovory, smeta, kp] = await queryVariants(db, 'договоры смета kp');
    expect(dogovory!.direct).toContain('договор');
    expect(smeta!.direct).toContain('смет');
    expect(kp!.direct).toEqual(expect.arrayContaining(['kp', 'кп']));
  });
});
