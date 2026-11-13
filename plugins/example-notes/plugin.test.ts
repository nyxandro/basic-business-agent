import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTestDatabase, migrate, toolContextFor, type Db, type TestDatabase } from '../../core/testing/public/index.ts';
import plugin from './plugin.ts';

let database: TestDatabase;
let db: Db;

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url, undefined, [{ prefix: 'plugin:example-notes', dir: fileURLToPath(new URL('./migrations', import.meta.url)) }]);
  db = createPool(database.url);
  await db.query(`INSERT INTO app."user" ("id", "name", "email", "emailVerified") VALUES ('u1', 'Ольга', 'o@example.com', true), ('u2', 'Игорь', 'i@example.com', true)`);
});
afterAll(async () => {
  await db.end();
  await database.drop();
});

const as = toolContextFor;

describe('example-notes plugin', () => {
  it('keeps each employee’s notes separate and lists the newest first', async () => {
    const tools = plugin.tools!({ name: 'example-notes', settings: { maxNotes: 10 }, secrets: {}, db, startAgentRun: () => Promise.reject(new Error('not used')) });
    await tools.notes_add!.execute!({ text: 'Позвонить в Альфа-Строй' }, as('u1') as never);
    await tools.notes_add!.execute!({ text: 'Счёт до пятницы' }, as('u1') as never);
    await tools.notes_add!.execute!({ text: 'Чужая заметка' }, as('u2') as never);
    const listed = (await tools.notes_list!.execute!({}, as('u1') as never)) as { notes: { text: string }[] };
    expect(listed.notes.map((n) => n.text)).toEqual(['Счёт до пятницы', 'Позвонить в Альфа-Строй']);
  });

  it('marks only the list as read-only, so adding a note needs confirmation', () => {
    expect(plugin.readOnly).toEqual(['notes_list']);
  });
});
