import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDto, ThreadPage } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureThread } from '../memory/memory.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { contextRoot } from '../workspace/layout.ts';

let t: TestApp;
let olgaId: string;
let petrId: string;
let olga: string;
let petr: string;

const PRIVATE = { mode: 'private', departmentIds: [], userIds: [] };
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function thread(userId: string, agentId = 'sales', title = 'Разговор'): Promise<string> {
  const id = randomUUID();
  await ensureThread(t.memory, { threadId: id, resourceId: userId, agentId, kind: 'chat', title });
  return id;
}

async function upload(path: string, cookie: string, name: string, bytes: number[]): Promise<Response> {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], name));
  return t.app.request(path, { method: 'POST', body: form, headers: { cookie, origin: TEST_PUBLIC_URL } });
}

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('projects', () => {
  it('creates a project once per name, keeps instructions and hides it from others', async () => {
    const created = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: '  Тендер ЖК Северный ', access: PRIVATE } });
    expect(created.status).toBe(201);
    const project = await json<ProjectDto>(created);
    expect(project).toMatchObject({ name: 'Тендер ЖК Северный', instructions: '', threadCount: 0 });

    const twice = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'тендер жк северный', access: PRIVATE } });
    expect(twice.status).toBe(409);
    expect((await json<{ error: { code: string } }>(twice)).error.code).toBe('APP_PROJECT_EXISTS');
    expect((await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: ' ', access: PRIVATE } })).status).toBe(400);

    const saved = await t.call('PUT', `/app/api/projects/${project.id}`, { cookie: olga, body: { instructions: 'Заказчик — ООО Стройресурс.' } });
    expect(await json<ProjectDto>(saved)).toMatchObject({ instructions: 'Заказчик — ООО Стройресурс.' });

    for (const [method, path] of [['GET', `/app/api/projects/${project.id}`], ['PUT', `/app/api/projects/${project.id}`], ['DELETE', `/app/api/projects/${project.id}`], ['GET', `/app/api/projects/${project.id}/files`]] as const) {
      const res = await t.call(method, path, { cookie: petr, body: method === 'PUT' ? { name: 'Чужой' } : undefined });
      expect(res.status).toBe(404);
    }
    expect(await json<{ projects: ProjectDto[] }>(await t.call('GET', '/app/api/projects', { cookie: petr }))).toEqual({ projects: [], archivedCount: 0 });
  });

  it('puts a conversation into a project before its first message and counts only existing conversations', async () => {
    const project = await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Ключевые клиенты', access: PRIVATE } }));
    const futureThread = randomUUID();
    expect((await t.call('PUT', `/app/api/threads/${futureThread}/project`, { cookie: olga, body: { projectId: project.id } })).status).toBe(200);
    expect(await json(await t.call('GET', `/app/api/threads/${futureThread}/project`, { cookie: olga }))).toEqual({ projectId: project.id, lost: null });
    expect(await json(await t.call('GET', `/app/api/threads/${futureThread}/project`, { cookie: petr }))).toEqual({ projectId: null, lost: null });
    let list = await json<{ projects: ProjectDto[] }>(await t.call('GET', '/app/api/projects', { cookie: olga }));
    expect(list.projects.find((p) => p.id === project.id)?.threadCount).toBe(0);

    await ensureThread(t.memory, { threadId: futureThread, resourceId: olgaId, agentId: 'sales', kind: 'chat', title: 'Сделки без движения' });
    list = await json<{ projects: ProjectDto[] }>(await t.call('GET', '/app/api/projects', { cookie: olga }));
    expect(list.projects.find((p) => p.id === project.id)?.threadCount).toBe(1);
    const inProject = await json<ThreadPage>(await t.call('GET', `/app/api/threads?projectId=${project.id}`, { cookie: olga }));
    expect(inProject.threads.map((x) => [x.id, x.agentId, x.projectId])).toEqual([[futureThread, 'sales', project.id]]);

    // A link to a conversation that never started is removed after a day.
    const orphan = randomUUID();
    await t.db.query(`INSERT INTO app.thread_projects (thread_id, user_id, project_id, created_at) VALUES ($1, $2, $3, now() - interval '2 days')`, [orphan, olgaId, project.id]);
    await t.call('GET', '/app/api/projects', { cookie: olga });
    expect((await t.db.query('SELECT 1 FROM app.thread_projects WHERE thread_id = $1', [orphan])).rowCount).toBe(0);

    // Someone else's conversation cannot be moved; moving out of a project is allowed.
    const petrThread = await thread(petrId);
    expect((await t.call('PUT', `/app/api/threads/${petrThread}/project`, { cookie: olga, body: { projectId: project.id } })).status).toBe(404);
    expect((await t.call('PUT', `/app/api/threads/${futureThread}/project`, { cookie: olga, body: { projectId: null } })).status).toBe(200);
    expect((await json<ThreadPage>(await t.call('GET', `/app/api/threads?projectId=${project.id}`, { cookie: olga }))).threads).toEqual([]);
  });

  it('removes the project with its files and leaves its conversations without a project', async () => {
    const project = await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'На удаление', access: PRIVATE } }));
    const id = await thread(olgaId);
    await t.call('PUT', `/app/api/threads/${id}/project`, { cookie: olga, body: { projectId: project.id } });
    expect((await upload(`/app/api/projects/${project.id}/files`, olga, 'смета.xlsx', [1, 2])).status).toBe(201);
    const folder = join(t.workspaceRoot, olgaId, 'projects', project.id);
    expect(existsSync(join(folder, 'files', 'смета.xlsx'))).toBe(true);

    // Removed for good only from the archive, 30 days after archiving (spec, section 8.20).
    await t.db.query("UPDATE app.projects SET archived_at = now() - interval '31 days' WHERE id = $1", [project.id]);
    expect((await t.call('DELETE', `/app/api/projects/${project.id}`, { cookie: olga })).status).toBe(200);
    expect(existsSync(folder)).toBe(false);
    const all = await json<ThreadPage>(await t.call('GET', '/app/api/threads', { cookie: olga }));
    expect(all.threads.find((x) => x.id === id)?.projectId).toBeNull();
  });

  it('keeps project files: an attachment of a project conversation, listing, download and removal', async () => {
    const project = await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Отчётность', access: PRIVATE } }));
    const id = await thread(olgaId);
    await t.call('PUT', `/app/api/threads/${id}/project`, { cookie: olga, body: { projectId: project.id } });
    expect((await upload(`/app/api/threads/${id}/files`, olga, 'отчёт.pdf', [1, 2, 3])).status).toBe(201);
    // The drafts of the agent are not among the files of the project (spec, section 8.33).
    mkdirSync(join(contextRoot(t.workspaceRoot, olgaId, project.id), '.work', id), { recursive: true });
    writeFileSync(join(contextRoot(t.workspaceRoot, olgaId, project.id), '.work', id, 'Черновик.docx'), 'x');

    const files = await json<{ files: { path: string; bytes: number }[] }>(await t.call('GET', `/app/api/projects/${project.id}/files`, { cookie: olga }));
    expect(files.files).toEqual([{ path: 'отчёт.pdf', bytes: 3 }]);
    const download = await t.call('GET', `/app/api/projects/${project.id}/file?path=${encodeURIComponent('отчёт.pdf')}`, { cookie: olga });
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await t.call('GET', `/app/api/projects/${project.id}/file?path=${encodeURIComponent('../../x')}`, { cookie: olga })).status).toBe(400);
    expect((await t.call('DELETE', `/app/api/projects/${project.id}/file?path=${encodeURIComponent('отчёт.pdf')}`, { cookie: olga })).status).toBe(200);
    // A folder of the path that is a link to someone else's files: nothing is deleted there.
    const outside = mkdtempSync(join(tmpdir(), 'bba-outside-'));
    writeFileSync(join(outside, 'чужой.txt'), 'KEEP');
    symlinkSync(outside, join(contextRoot(t.workspaceRoot, olgaId, project.id), 'чужая'));
    expect((await t.call('DELETE', `/app/api/projects/${project.id}/file?path=${encodeURIComponent('чужая/чужой.txt')}`, { cookie: olga })).status).toBe(400);
    expect(readFileSync(join(outside, 'чужой.txt'), 'utf8')).toBe('KEEP');
    rmSync(outside, { recursive: true, force: true });
    rmSync(join(contextRoot(t.workspaceRoot, olgaId, project.id), 'чужая'));
    expect((await json<{ files: unknown[] }>(await t.call('GET', `/app/api/projects/${project.id}/files`, { cookie: olga }))).files).toEqual([]);
  });

  // Order of the side panel (spec, section 8.12; decision of the owner 17.11): the pinned ones first in
  // the order the person gave them, then the rest by the person's latest work in each.
  it('puts the pinned ones first in the order the person dragged, then the rest by the latest work', async () => {
    const ninaId = await t.createUser({ email: 'nina@example.com', name: 'Нина' });
    const nina = await t.signIn('nina@example.com');
    const names = async () => (await json<{ projects: ProjectDto[] }>(await t.call('GET', '/app/api/projects', { cookie: nina }))).projects.map((p) => `${p.name}${p.pinned ? '*' : ''}`);
    const ids: Record<string, string> = {};
    const create = async (name: string) => (ids[name] = (await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: nina, body: { name, access: PRIVATE } }))).id);
    for (const name of ['Альфа', 'Бета', 'Гамма', 'Дельта']) await create(name);
    // Nothing done in any yet: the newest first.
    expect(await names()).toEqual(['Дельта', 'Гамма', 'Бета', 'Альфа']);
    // A conversation in a project takes it up.
    const talk = randomUUID();
    await t.call('PUT', `/app/api/threads/${talk}/project`, { cookie: nina, body: { projectId: ids['Альфа'] } });
    await ensureThread(t.memory, { threadId: talk, resourceId: ninaId, agentId: 'sales', kind: 'chat', title: 'Смета' });
    expect(await names()).toEqual(['Альфа', 'Дельта', 'Гамма', 'Бета']);

    const pin = async (name: string, pinned: boolean) => json<ProjectDto>(await t.call('PUT', `/app/api/projects/${ids[name]}`, { cookie: nina, body: { pinned } }));
    expect(await pin('Гамма', true)).toMatchObject({ name: 'Гамма', pinned: true });
    await pin('Бета', true);
    expect(await names()).toEqual(['Гамма*', 'Бета*', 'Альфа', 'Дельта']);
    // Pinning a pinned project again does not move it.
    await pin('Гамма', true);
    expect(await names()).toEqual(['Гамма*', 'Бета*', 'Альфа', 'Дельта']);
    // The pinned ones are dragged among themselves; a new project comes first under them.
    expect((await t.call('PUT', '/app/api/projects/order', { cookie: nina, body: { ids: [ids['Бета'], ids['Гамма']] } })).status).toBe(200);
    await create('Эпсилон');
    expect(await names()).toEqual(['Бета*', 'Гамма*', 'Эпсилон', 'Альфа', 'Дельта']);
    // An unpinned project goes by its work: nothing was done in Бета since it was created.
    await pin('Бета', false);
    expect(await names()).toEqual(['Гамма*', 'Эпсилон', 'Альфа', 'Дельта', 'Бета']);
    // A pinned project, pinned again, comes last among the pinned.
    await pin('Дельта', true);
    await pin('Бета', true);
    expect(await names()).toEqual(['Гамма*', 'Дельта*', 'Бета*', 'Эпсилон', 'Альфа']);
  });

  it('takes an order only of exactly the person’s pinned projects', async () => {
    await t.createUser({ email: 'vera@example.com', name: 'Вера' });
    const vera = await t.signIn('vera@example.com');
    const create = async (name: string) => (await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: vera, body: { name, access: PRIVATE } }))).id;
    const a = await create('Первый');
    const b = await create('Второй');
    const c = await create('Третий');
    for (const id of [a, b]) await t.call('PUT', `/app/api/projects/${id}`, { cookie: vera, body: { pinned: true } });
    const someoneElses = (await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: petr, body: { name: 'Чужой', access: PRIVATE } }))).id;
    for (const ids of [[a], [a, b, a], [a, b, c], [a, someoneElses], ['order', b]]) {
      const res = await t.call('PUT', '/app/api/projects/order', { cookie: vera, body: { ids } });
      expect(res.status).toBe(400);
      expect((await json<{ error: { code: string; message: string } }>(res)).error).toMatchObject({ code: 'APP_VALIDATION_FAILED', message: 'Список проектов изменился, порядок не сохранён. Перетащите проект ещё раз.' });
    }
    const listed = async () => (await json<{ projects: ProjectDto[] }>(await t.call('GET', '/app/api/projects', { cookie: vera }))).projects.map((p) => p.id);
    expect(await listed()).toEqual([a, b, c]);
    expect((await t.call('PUT', '/app/api/projects/order', { cookie: vera, body: { ids: [b, a] } })).status).toBe(200);
    expect(await listed()).toEqual([b, a, c]);
    // A pinned project in the archive is not in the panel: the order is of the others.
    const d = await create('Четвёртый');
    await t.call('PUT', `/app/api/projects/${d}`, { cookie: vera, body: { pinned: true } });
    expect((await t.call('POST', `/app/api/projects/${d}/archive`, { cookie: vera })).status).toBe(200);
    expect((await t.call('PUT', '/app/api/projects/order', { cookie: vera, body: { ids: [b, a, d] } })).status).toBe(400);
    expect((await t.call('PUT', '/app/api/projects/order', { cookie: vera, body: { ids: [a, b] } })).status).toBe(200);
    expect(await listed()).toEqual([a, b, c]);
    expect((await json<{ projects: ProjectDto[] }>(await t.call('GET', '/app/api/projects', { cookie: petr }))).projects.map((p) => p.id)).toContain(someoneElses);
  });

  // The project picker of the input sorts by it («по недавности»).
  it('says when the person last worked in each project: their latest conversation, else when the project appeared for them', async () => {
    const listOf = async (cookie: string) => new Map((await json<{ projects: ProjectDto[] }>(await t.call('GET', '/app/api/projects', { cookie }))).projects.map((p) => [p.id, p]));
    const older = await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Давний проект', access: { mode: 'list', departmentIds: [], userIds: [petrId] } } }));
    const newer = await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Свежий проект', access: PRIVATE } }));
    let olgas = await listOf(olga);
    expect(olgas.get(older.id)!.lastActiveAt).toBe(older.createdAt);
    expect(olgas.get(newer.id)!.lastActiveAt).toBe(newer.createdAt);

    const talk = randomUUID();
    await t.call('PUT', `/app/api/threads/${talk}/project`, { cookie: olga, body: { projectId: older.id } });
    await ensureThread(t.memory, { threadId: talk, resourceId: olgaId, agentId: 'sales', kind: 'chat', title: 'Смета' });
    // Two conversations: the project takes the later one, whichever its link comes first.
    const later = randomUUID();
    await t.call('PUT', `/app/api/threads/${later}/project`, { cookie: olga, body: { projectId: older.id } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await ensureThread(t.memory, { threadId: later, resourceId: olgaId, agentId: 'sales', kind: 'chat', title: 'Счёт' });
    const [inOlder, earlier] = (await json<ThreadPage>(await t.call('GET', `/app/api/threads?projectId=${older.id}`, { cookie: olga }))).threads;
    expect([inOlder!.id, earlier!.id]).toEqual([later, talk]);
    olgas = await listOf(olga);
    expect(olgas.get(older.id)!.lastActiveAt).toBe(inOlder!.updatedAt);
    expect(olgas.get(older.id)!.lastActiveAt > olgas.get(newer.id)!.lastActiveAt).toBe(true);

    // A colleague's conversations are not the person's work: Пётр has the project from when it appeared
    // for him — its creation until he opens it, then that moment.
    let petrs = await listOf(petr);
    expect(petrs.get(older.id)!.lastActiveAt).toBe(older.createdAt);
    await t.call('GET', `/app/api/projects/${older.id}`, { cookie: petr });
    petrs = await listOf(petr);
    expect(petrs.get(older.id)!.lastActiveAt > inOlder!.updatedAt).toBe(true);
  });

  it('lists conversations of all agents newest first, page by page', async () => {
    const lena = await t.createUser({ email: 'lena@example.com', name: 'Лена' });
    const cookie = await t.signIn('lena@example.com');
    for (let i = 0; i < 35; i++) {
      const id = randomUUID();
      await ensureThread(t.memory, { threadId: id, resourceId: lena, agentId: i % 2 ? 'sales' : 'helper', kind: 'chat', title: `Разговор ${i}` });
      await new Promise((r) => setTimeout(r, 2));
    }
    const first = await json<ThreadPage>(await t.call('GET', '/app/api/threads?limit=30', { cookie }));
    expect(first.threads).toHaveLength(30);
    expect(first.threads[0]!.title).toBe('Разговор 34');
    expect(new Set(first.threads.map((x) => x.agentId))).toEqual(new Set(['sales', 'helper']));
    expect(first.next).not.toBeNull();
    const second = await json<ThreadPage>(await t.call('GET', `/app/api/threads?limit=30&before=${encodeURIComponent(first.next!)}`, { cookie }));
    expect(second.threads.map((x) => x.title)).toEqual(['Разговор 4', 'Разговор 3', 'Разговор 2', 'Разговор 1', 'Разговор 0']);
    expect(second.next).toBeNull();
  });
});
