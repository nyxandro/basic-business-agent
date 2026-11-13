import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MASKING_KINDS, type MaskingKind } from '../config/schemas.ts';
import { migrate } from '../db/migrate.ts';
import { createPool, type Db } from '../db/pool.ts';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import { createThreadMasker, isPlaceholderPrefix } from './masker.ts';
import { VALUE_ARBS } from './test-generators.ts';

let database: TestDatabase;
let db: Db;
const ALL = new Set<MaskingKind>(MASKING_KINDS);

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url);
  db = createPool(database.url);
});
afterAll(async () => {
  await db.end();
  await database.drop();
});

describe('thread masker', () => {
  it('numbers placeholders per kind and keeps them for the thread', async () => {
    const threadId = randomUUID();
    const first = await createThreadMasker(db, threadId, ALL);
    expect(await first.mask('a@example.ru и b@example.ru, снова a@example.ru')).toBe('[ПОЧТА_1] и [ПОЧТА_2], снова [ПОЧТА_1]');
    const later = await createThreadMasker(db, threadId, ALL);
    expect(await later.mask('пишу b@example.ru')).toBe('пишу [ПОЧТА_2]');
    expect(later.unmask('[ПОЧТА_1], [ПОЧТА_9]')).toBe('a@example.ru, [ПОЧТА_9]');
    expect(later.unknownPlaceholders('[ПОЧТА_1] [ПОЧТА_9]')).toEqual(['[ПОЧТА_9]']);
  });

  it('recognises the start of a placeholder cut off at the end of a chunk', () => {
    expect(['[', '[П', '[ПОЧ', '[ПОЧТА_', '[ПОЧТА_1'].every(isPlaceholderPrefix)).toBe(true);
    expect(['[см. приложение', '[1]', 'ПОЧТА'].some(isPlaceholderPrefix)).toBe(false);
  });

  // Domain: business text with personal data values embedded between separators. Not covered: text
  // that already contains a literal placeholder such as "[ПОЧТА_1]" — it is treated as a placeholder.
  it('round trip: unmask(mask(text)) gives the text back, and the masked text holds none of the values', async () => {
    const filler = fc.string({ unit: 'grapheme', maxLength: 30 }).map((s) => s.replace(/[[\]\d@+]/g, ''));
    const value = fc.constantFrom(...MASKING_KINDS).chain((kind) => VALUE_ARBS[kind]);
    const separator = fc.constantFrom(' ', ', ', '\n', ': ', ' — ');
    const text = fc.array(fc.tuple(filler, separator, value, separator), { maxLength: 5 }).map((parts) => ({
      values: parts.map(([, , v]) => v),
      text: parts.map(([f, s1, v, s2]) => `${f}${s1}${v}${s2}`).join(''),
    }));
    await fc.assert(
      fc.asyncProperty(text, async ({ text: input, values }) => {
        const masker = await createThreadMasker(db, randomUUID(), ALL);
        const masked = await masker.mask(input);
        expect(masker.unmask(masked)).toBe(input);
        for (const v of values) expect(masked).not.toContain(v);
      }),
      {
        examples: [
          [{ text: '', values: [] }],
          [{ text: 'ivan@example.ru', values: ['ivan@example.ru'] }],
          [{ text: 'ivan@example.ru, ivan@example.ru', values: ['ivan@example.ru'] }],
          [{ text: 'паспорт 4510 123456, СНИЛС 112-233-445 95', values: ['4510 123456', '112-233-445 95'] }],
        ],
      },
    );
  });
});
