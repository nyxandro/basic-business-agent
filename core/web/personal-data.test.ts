// Documents of people never leave through the internet of agents (spec, section 8.30; decisions of the owner 19.11):
// a passport, a SNILS, a card — in a query, a task or an address, written with spaces, «+» or «%20»; phones, mail
// and INN go, and nothing is stopped of a kind «Маскирование» does not mask.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { createPool, type Db } from '../db/pool.ts';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import { ensureMaskingSettings } from '../masking/settings.ts';
import { personalDocumentIn } from './personal-data.ts';

let database: TestDatabase;
let db: Db;

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url);
  db = createPool(database.url);
  await ensureMaskingSettings(db, ['passport', 'snils', 'card', 'inn', 'phone', 'email']);
});
afterAll(async () => {
  await db.end();
  await database.drop();
});

describe('documents of people in the internet of agents', () => {
  it('stops a passport, a SNILS and a card wherever they are written', async () => {
    expect(await personalDocumentIn(db, 'паспорт 4510 123456', 'web_search')).toBe('passport');
    expect(await personalDocumentIn(db, 'https://example.com/?passport=4510%20123456', 'web_fetch')).toBe('passport');
    expect(await personalDocumentIn(db, 'https://example.com/?p=4510+123456', 'web_fetch')).toBe('passport');
    expect(await personalDocumentIn(db, 'СНИЛС 112-233-445 95', 'web_research')).toBe('snils');
    expect(await personalDocumentIn(db, 'карта 4111 1111 1111 1111', 'web_research')).toBe('card');
  });

  it('lets phones, mail and INN through, and a broken escape is read as it is', async () => {
    for (const text of ['чей номер 8-800-555-35-35', 'что за компания info@stroy.ru', 'ИНН 7707083893', 'ИП ИНН 500100732259', 'https://example.com/%E0%A4%A']) {
      expect(await personalDocumentIn(db, text, 'web_search'), text).toBeNull();
    }
  });
});
