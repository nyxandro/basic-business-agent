// Routes of the memory of a project and of «Моя память» (spec, section 8.26): who reads and changes what.
import type { MemoryEntryDto, MemoryListDto, ProjectDto } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let olga: string;
let petr: string;
let anna: string;
let olgaId: string;

async function json<T>(res: Response, status = 200): Promise<T> {
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

async function code(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function newProject(name: string, mode: 'private' | 'org'): Promise<string> {
  const res = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name, access: { mode, departmentIds: [], userIds: [] } } });
  return (await json<ProjectDto>(res, 201)).id;
}

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова' });
  await t.createUser({ email: 'petr@example.com', name: 'Пётр Иванов' });
  await t.createUser({ email: 'anna@example.com', name: 'Анна' });
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
  anna = await t.signIn('anna@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('memory of a project', () => {
  it('is read and changed by everyone who sees the project, and by nobody else', async () => {
    const id = await newProject('Тендер ЖК Северный', 'org');
    const added = await json<MemoryEntryDto>(await t.call('POST', `/app/api/projects/${id}/memory`, { cookie: olga, body: { text: 'Подача\nдо 28.11' } }));
    expect(added).toMatchObject({ number: 1, text: 'Подача до 28.11', version: 1, editor: { name: 'Ольга Смирнова', byAgent: false, you: true } });

    const seenByPetr = await json<MemoryListDto>(await t.call('GET', `/app/api/projects/${id}/memory`, { cookie: petr }));
    expect(seenByPetr).toMatchObject({ usedChars: 'Подача до 28.11'.length, maxChars: 6000, readOnly: false });
    expect(seenByPetr.entries[0]!.editor).toEqual({ name: 'Ольга Смирнова', byAgent: false, you: false });

    const changed = await json<MemoryEntryDto>(await t.call('PUT', `/app/api/projects/${id}/memory/${added.id}`, { cookie: petr, body: { text: 'Подача до 01.12', version: 1 } }));
    expect(changed).toMatchObject({ text: 'Подача до 01.12', version: 2, editor: { name: 'Пётр Иванов', you: true } });
    // Olga saves over the version she saw: the entry has changed meanwhile.
    expect(await code(await t.call('PUT', `/app/api/projects/${id}/memory/${added.id}`, { cookie: olga, body: { text: 'Подача до 30.11', version: 1 } }), 409)).toBe('APP_MEMORY_CONFLICT');

    const removed = await json<MemoryEntryDto>(await t.call('DELETE', `/app/api/projects/${id}/memory/${added.id}`, { cookie: petr }));
    expect(removed.text).toBe('Подача до 01.12');
    expect(await code(await t.call('DELETE', `/app/api/projects/${id}/memory/${added.id}`, { cookie: petr }), 404)).toBe('APP_MEMORY_ENTRY_NOT_FOUND');
  });

  it('is closed to a person the project is not open to, and to a colleague once the access is closed', async () => {
    const id = await newProject('Кровля школы', 'org');
    await json(await t.call('POST', `/app/api/projects/${id}/memory`, { cookie: olga, body: { text: 'НМЦК 14 862 400 ₽' } }));
    await json(await t.call('GET', `/app/api/projects/${id}/memory`, { cookie: anna }));
    await json(await t.call('PUT', `/app/api/projects/${id}/access`, { cookie: olga, body: { mode: 'private', departmentIds: [], userIds: [] } }));
    expect(await code(await t.call('GET', `/app/api/projects/${id}/memory`, { cookie: anna }), 404)).toBe('APP_NOT_FOUND');
    expect(await code(await t.call('POST', `/app/api/projects/${id}/memory`, { cookie: anna, body: { text: 'Чужое' } }), 404)).toBe('APP_NOT_FOUND');
  });

  it('of an archived project is read only, for its creator only', async () => {
    const id = await newProject('Архивный тендер', 'org');
    await json(await t.call('POST', `/app/api/projects/${id}/memory`, { cookie: olga, body: { text: 'Итоги 02.12' } }));
    await json(await t.call('POST', `/app/api/projects/${id}/archive`, { cookie: olga }));
    const list = await json<MemoryListDto>(await t.call('GET', `/app/api/projects/${id}/memory`, { cookie: olga }));
    expect(list).toMatchObject({ readOnly: true, entries: [{ text: 'Итоги 02.12' }] });
    expect(await code(await t.call('POST', `/app/api/projects/${id}/memory`, { cookie: olga, body: { text: 'Ещё' } }), 409)).toBe('APP_PROJECT_ARCHIVED');
    expect(await code(await t.call('GET', `/app/api/projects/${id}/memory`, { cookie: petr }), 404)).toBe('APP_NOT_FOUND');
  });

  it('refuses an empty entry, one over 400 signs, the same text twice and an id that is not one', async () => {
    const id = await newProject('Проверки', 'private');
    expect(await code(await t.call('POST', `/app/api/projects/${id}/memory`, { cookie: olga, body: { text: '   ' } }), 400)).toBe('APP_VALIDATION_FAILED');
    expect(await code(await t.call('POST', `/app/api/projects/${id}/memory`, { cookie: olga, body: { text: 'ы'.repeat(401) } }), 400)).toBe('APP_MEMORY_ENTRY_TOO_LONG');
    await json(await t.call('POST', `/app/api/projects/${id}/memory`, { cookie: olga, body: { text: 'Срок поставки 10 дней' } }));
    expect(await code(await t.call('POST', `/app/api/projects/${id}/memory`, { cookie: olga, body: { text: 'Срок  поставки 10 дней' } }), 409)).toBe('APP_MEMORY_DUPLICATE');
    expect(await code(await t.call('DELETE', `/app/api/projects/${id}/memory/not-an-id`, { cookie: olga }), 404)).toBe('APP_MEMORY_ENTRY_NOT_FOUND');
  });
});

describe('«Моя память»', () => {
  it('is the employee’s own: add, change, remove one, forget all — with what Mastra kept before', async () => {
    expect(await json<MemoryListDto>(await t.call('GET', '/app/api/me/memory', { cookie: olga }))).toEqual({ entries: [], usedChars: 0, maxChars: 3000, readOnly: false });
    const a = await json<MemoryEntryDto>(await t.call('POST', '/app/api/me/memory', { cookie: olga, body: { text: 'Ведёт только юрлиц' } }));
    await json(await t.call('POST', '/app/api/me/memory', { cookie: petr, body: { text: 'Ведёт бухгалтерию' } }));
    const changed = await json<MemoryEntryDto>(await t.call('PUT', `/app/api/me/memory/${a.id}`, { cookie: olga, body: { text: 'Ведёт только юрлиц и ИП', version: 1 } }));
    expect(changed.version).toBe(2);
    // Someone else's entry is not found in one's own memory.
    expect(await code(await t.call('DELETE', `/app/api/me/memory/${a.id}`, { cookie: petr }), 404)).toBe('APP_MEMORY_ENTRY_NOT_FOUND');

    await t.db.query(`INSERT INTO mastra.mastra_resources (id, "workingMemory", "createdAt", "updatedAt") VALUES ($1, 'старая память', now(), now()), ($2, 'память черновика', now(), now())`, [olgaId, `draft:${olgaId}`]);
    await json(await t.call('DELETE', '/app/api/me/memory', { cookie: olga }));
    expect((await t.db.query('SELECT 1 FROM mastra.mastra_resources WHERE id = $1', [`draft:${olgaId}`])).rowCount).toBe(0);
    expect((await json<MemoryListDto>(await t.call('GET', '/app/api/me/memory', { cookie: olga }))).entries).toEqual([]);
    expect((await t.db.query('SELECT 1 FROM mastra.mastra_resources WHERE id = $1', [olgaId])).rowCount).toBe(0);
    expect((await json<MemoryListDto>(await t.call('GET', '/app/api/me/memory', { cookie: petr }))).entries.map((e) => e.text)).toEqual(['Ведёт бухгалтерию']);
  });
});

describe('removing an employee', () => {
  it('takes away their personal memory and what Mastra kept; their entries in a project stay, by «nobody»', async () => {
    await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
    const igor = await t.signIn('igor@example.com');
    const ninaId = await t.createUser({ email: 'nina@example.com', name: 'Нина' });
    const nina = await t.signIn('nina@example.com');
    const id = await newProject('Общий тендер', 'org');
    await json(await t.call('POST', `/app/api/projects/${id}/memory`, { cookie: nina, body: { text: 'Обеспечение заявки 1 %' } }));
    await json(await t.call('POST', '/app/api/me/memory', { cookie: nina, body: { text: 'Работает по вторникам' } }));
    await t.db.query(`INSERT INTO mastra.mastra_resources (id, "workingMemory", "createdAt", "updatedAt") VALUES ($1, 'старая память', now(), now())`, [ninaId]);

    expect((await t.call('DELETE', `/app/api/admin/users/${ninaId}`, { cookie: igor })).status).toBe(200);
    expect((await t.db.query('SELECT 1 FROM app.memory_entries WHERE user_id = $1', [ninaId])).rowCount).toBe(0);
    expect((await t.db.query('SELECT 1 FROM mastra.mastra_resources WHERE id = $1', [ninaId])).rowCount).toBe(0);
    const list = await json<MemoryListDto>(await t.call('GET', `/app/api/projects/${id}/memory`, { cookie: olga }));
    expect(list.entries[0]).toMatchObject({ text: 'Обеспечение заявки 1 %', editor: { name: null, byAgent: false, you: false } });
  });
});
