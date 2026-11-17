// Memory of a project and of an employee kept as entries (spec, section 8.26): numbers, limits, versions,
// duplicates and the archive, on a real database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { createPool, type Db } from '../db/pool.ts';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import {
  addEntry,
  applyAgentOperations,
  changeEntry,
  forgetPersonal,
  listEntries,
  MEMORY_ENTRY_MAX_CHARS,
  PERSONAL_MEMORY_MAX_CHARS,
  PROJECT_MEMORY_MAX_CHARS,
  removeEntry,
  type MemoryScope,
  type SeenVersions,
} from './entries.ts';

let database: TestDatabase;
let db: Db;
let project: MemoryScope;
const olga = { userId: 'olga', byAgent: false } as const;
const petrAgent = { userId: 'petr', byAgent: true } as const;

async function newProject(): Promise<MemoryScope> {
  const id = randomUUID();
  await db.query(`INSERT INTO app.projects (id, user_id, name, access) VALUES ($1, 'olga', $2, 'private')`, [id, `Тендер ${id.slice(0, 6)}`]);
  return { kind: 'project', projectId: id };
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url);
  db = createPool(database.url);
  await db.query(`INSERT INTO app."user" ("id", "name", "email", "emailVerified") VALUES
    ('olga', 'Ольга Смирнова', 'olga@example.com', true), ('petr', 'Пётр Иванов', 'petr@example.com', true), ('igor', 'Игорь', 'igor@example.com', true)`);
});
afterAll(async () => {
  await db.end();
  await database.drop();
});
beforeEach(async () => {
  project = await newProject();
});

describe('entries', () => {
  it('numbers entries within their memory and never gives a removed number again', async () => {
    const a = await addEntry(db, project, olga, 'Подача до 28.11');
    const b = await addEntry(db, project, olga, 'НМЦК 14 862 400 ₽');
    expect([a.number, b.number]).toEqual([1, 2]);
    await removeEntry(db, project, b.id);
    const c = await addEntry(db, project, olga, 'Аванс не предусмотрен');
    expect(c.number).toBe(3);
    const other = await addEntry(db, await newProject(), olga, 'Другой проект');
    expect(other.number).toBe(1);
  });

  it('keeps one line: spaces and line breaks become one space; empty and over 400 signs are refused', async () => {
    const e = await addEntry(db, project, olga, '  Подача\n\nдо   28.11  ');
    expect(e.text).toBe('Подача до 28.11');
    await expect(addEntry(db, project, olga, ' \n ')).rejects.toMatchObject({ code: 'APP_VALIDATION_FAILED' });
    await expect(addEntry(db, project, olga, 'а'.repeat(MEMORY_ENTRY_MAX_CHARS + 1))).rejects.toMatchObject({ code: 'APP_MEMORY_ENTRY_TOO_LONG' });
    expect((await addEntry(db, project, olga, 'а'.repeat(MEMORY_ENTRY_MAX_CHARS))).text).toHaveLength(MEMORY_ENTRY_MAX_CHARS);
  });

  it('lists entries with who changed them last, newest change first, and the signs used', async () => {
    await addEntry(db, project, olga, 'Первая');
    await applyAgentOperations(db, project, petrAgent, [{ action: 'add', text: 'Вторая' }], new Map());
    const list = await listEntries(db, project);
    expect(list.entries.map((e) => [e.text, e.author.name, e.author.byAgent])).toEqual([
      ['Вторая', 'Пётр Иванов', true],
      ['Первая', 'Ольга Смирнова', false],
    ]);
    expect(list.usedChars).toBe('Первая'.length + 'Вторая'.length);
    expect(list.maxChars).toBe(PROJECT_MEMORY_MAX_CHARS);
    expect((await listEntries(db, { kind: 'personal', userId: 'igor' })).maxChars).toBe(PERSONAL_MEMORY_MAX_CHARS);
  });

  it('refuses an entry that would overflow the memory, but lets one call free the place and add', async () => {
    const filler = 'ф'.repeat(MEMORY_ENTRY_MAX_CHARS);
    for (let i = 0; i < PROJECT_MEMORY_MAX_CHARS / MEMORY_ENTRY_MAX_CHARS - 1; i++) await addEntry(db, project, olga, `${i}${filler}`.slice(0, MEMORY_ENTRY_MAX_CHARS));
    const used = (await listEntries(db, project)).usedChars;
    expect(used).toBe(PROJECT_MEMORY_MAX_CHARS - MEMORY_ENTRY_MAX_CHARS);
    await addEntry(db, project, olga, 'х'.repeat(MEMORY_ENTRY_MAX_CHARS - 100));
    await expect(addEntry(db, project, olga, 'х'.repeat(200))).rejects.toMatchObject({ code: 'APP_MEMORY_FULL' });
    const fresh = `Новый срок 01.12 ${'х'.repeat(150)}`;
    await expect(applyAgentOperations(db, project, petrAgent, [{ action: 'add', text: fresh }], new Map())).rejects.toMatchObject({ code: 'APP_MEMORY_FULL' });

    const seen = await seenOf(project);
    const result = await applyAgentOperations(db, project, petrAgent, [{ action: 'remove', number: 1 }, { action: 'add', text: fresh }], seen);
    expect(result.results.map((r) => r.action)).toEqual(['remove', 'add']);
    expect((await listEntries(db, project)).entries.some((e) => e.text === fresh)).toBe(true);
  });

  it('runs the operations of one call as a whole: a failed one leaves none of them', async () => {
    const seen = await seenOf(project);
    await expect(
      applyAgentOperations(db, project, petrAgent, [{ action: 'add', text: 'Первое' }, { action: 'add', text: 'Второе' }, { action: 'remove', number: 99 }], seen),
    ).rejects.toMatchObject({ code: 'APP_MEMORY_ENTRY_NOT_FOUND', details: { operation: 3 } });
    expect((await listEntries(db, project)).entries).toEqual([]);
  });

  it('gives no second entry for the same text', async () => {
    const first = await applyAgentOperations(db, project, petrAgent, [{ action: 'add', text: 'Подача до 28.11' }], new Map());
    const again = await applyAgentOperations(db, project, petrAgent, [{ action: 'add', text: 'Подача  до 28.11' }], new Map());
    expect(again.results[0]).toMatchObject({ action: 'add', number: first.results[0]!.number, duplicate: true });
    await expect(addEntry(db, project, olga, 'Подача до 28.11')).rejects.toMatchObject({ code: 'APP_MEMORY_DUPLICATE' });
    expect((await listEntries(db, project)).entries).toHaveLength(1);
  });

  it('lets an agent change and remove any entry, a person’s too, in the version it saw; says what was there before', async () => {
    const byOlga = await addEntry(db, project, olga, 'Подача до 28.11');
    const seen = await seenOf(project);
    const changed = await applyAgentOperations(db, project, petrAgent, [{ action: 'change', number: byOlga.number, text: 'Подача до 01.12' }], seen);
    expect(changed.results[0]).toMatchObject({ action: 'change', text: 'Подача до 01.12', previousText: 'Подача до 28.11' });
    const after = (await listEntries(db, project)).entries[0]!;
    expect(after.author).toMatchObject({ name: 'Пётр Иванов', byAgent: true });
    // The call's own result is the version the agent saw last: it may change the entry again.
    const removed = await applyAgentOperations(db, project, petrAgent, [{ action: 'remove', number: byOlga.number }], seen);
    expect(removed.results[0]).toMatchObject({ action: 'remove', text: 'Подача до 01.12' });
  });

  it('does not let an agent overwrite a change it has not seen', async () => {
    const entry = await addEntry(db, project, olga, 'Подача до 28.11');
    const seen = await seenOf(project);
    await changeEntry(db, project, olga, entry.id, 'Подача до 01.12 (перенос)', entry.version);
    await expect(applyAgentOperations(db, project, petrAgent, [{ action: 'change', number: entry.number, text: 'Подача до 30.11' }], seen)).rejects.toMatchObject({
      code: 'APP_MEMORY_CONFLICT',
      details: { operation: 1, number: entry.number, text: 'Подача до 01.12 (перенос)' },
    });
    // An entry added after the agent's look at the memory is not seen either.
    const fresh = await addEntry(db, project, olga, 'Свежая');
    await expect(applyAgentOperations(db, project, petrAgent, [{ action: 'remove', number: fresh.number }], seen)).rejects.toMatchObject({ code: 'APP_MEMORY_CONFLICT' });
    expect((await listEntries(db, project)).entries.map((e) => e.text).sort()).toEqual(['Подача до 01.12 (перенос)', 'Свежая']);
  });

  it('refuses a person’s change made over another version, and tells about a removed entry', async () => {
    const entry = await addEntry(db, project, olga, 'Подача до 28.11');
    await changeEntry(db, project, petrAgent, entry.id, 'Подача до 30.11', entry.version);
    await expect(changeEntry(db, project, olga, entry.id, 'Подача до 01.12', entry.version)).rejects.toMatchObject({
      code: 'APP_MEMORY_CONFLICT',
      details: { entry: { text: 'Подача до 30.11' } },
    });
    await removeEntry(db, project, entry.id);
    await expect(changeEntry(db, project, olga, entry.id, 'Подача до 01.12', entry.version + 1)).rejects.toMatchObject({ code: 'APP_MEMORY_ENTRY_NOT_FOUND' });
    await expect(removeEntry(db, project, entry.id)).rejects.toMatchObject({ code: 'APP_MEMORY_ENTRY_NOT_FOUND' });
  });

  it('two calls at once on an almost full memory neither overflow it nor share a number', async () => {
    const filler = 'ф'.repeat(MEMORY_ENTRY_MAX_CHARS);
    for (let i = 0; i < PROJECT_MEMORY_MAX_CHARS / MEMORY_ENTRY_MAX_CHARS - 1; i++) await addEntry(db, project, olga, `${i}${filler}`.slice(0, MEMORY_ENTRY_MAX_CHARS));
    const settled = await Promise.allSettled([
      applyAgentOperations(db, project, petrAgent, [{ action: 'add', text: 'а'.repeat(300) }], new Map()),
      applyAgentOperations(db, project, petrAgent, [{ action: 'add', text: 'б'.repeat(300) }], new Map()),
    ]);
    expect(settled.map((s) => s.status).sort()).toEqual(['fulfilled', 'rejected']);
    const list = await listEntries(db, project);
    expect(list.usedChars).toBeLessThanOrEqual(PROJECT_MEMORY_MAX_CHARS);
    expect(new Set(list.entries.map((e) => e.number)).size).toBe(list.entries.length);
  });

  it('an archived project keeps its memory read only', async () => {
    await addEntry(db, project, olga, 'Подача до 28.11');
    await db.query('UPDATE app.projects SET archived_at = now() WHERE id = $1', [(project as { projectId: string }).projectId]);
    expect((await listEntries(db, project)).entries).toHaveLength(1);
    await expect(addEntry(db, project, olga, 'Ещё')).rejects.toMatchObject({ code: 'APP_PROJECT_ARCHIVED' });
    await expect(applyAgentOperations(db, project, petrAgent, [{ action: 'add', text: 'Ещё' }], new Map())).rejects.toMatchObject({ code: 'APP_PROJECT_ARCHIVED' });
  });

  it('goes away with its project; an author removed from the installation becomes nobody', async () => {
    await db.query(`INSERT INTO app."user" ("id", "name", "email", "emailVerified") VALUES ('gone', 'Ушедший', 'gone@example.com', true)`);
    await addEntry(db, project, { userId: 'gone', byAgent: false }, 'Запись ушедшего');
    await db.query(`DELETE FROM app."user" WHERE "id" = 'gone'`);
    expect((await listEntries(db, project)).entries[0]!.author).toMatchObject({ id: null, name: null });
    await db.query('DELETE FROM app.projects WHERE id = $1', [(project as { projectId: string }).projectId]);
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.memory_entries WHERE project_id = $1', [(project as { projectId: string }).projectId]);
    expect(rows[0]!.n).toBe(0);
  });

  it('personal memory is the employee’s own; «forget all» clears only theirs', async () => {
    const igor: MemoryScope = { kind: 'personal', userId: 'igor' };
    const anna: MemoryScope = { kind: 'personal', userId: 'olga' };
    await addEntry(db, igor, { userId: 'igor', byAgent: true }, 'Ведёт бухгалтерию');
    await addEntry(db, anna, olga, 'Ведёт только юрлиц');
    await forgetPersonal(db, 'olga');
    expect((await listEntries(db, anna)).entries).toEqual([]);
    expect((await listEntries(db, igor)).entries.map((e) => e.text)).toEqual(['Ведёт бухгалтерию']);
  });
});

async function seenOf(scope: MemoryScope): Promise<SeenVersions> {
  return new Map((await listEntries(db, scope)).entries.map((e) => [e.number, e.version]));
}
