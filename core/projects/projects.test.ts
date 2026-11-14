import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectDto, ThreadPage } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureThread } from '../memory/memory.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let olgaId: string;
let petrId: string;
let olga: string;
let petr: string;

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
    const created = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: '  Тендер ЖК Северный ' } });
    expect(created.status).toBe(201);
    const project = await json<ProjectDto>(created);
    expect(project).toMatchObject({ name: 'Тендер ЖК Северный', instructions: '', threadCount: 0 });

    const twice = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'тендер жк северный' } });
    expect(twice.status).toBe(409);
    expect((await json<{ error: { code: string } }>(twice)).error.code).toBe('APP_PROJECT_EXISTS');
    expect((await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: ' ' } })).status).toBe(400);

    const saved = await t.call('PUT', `/app/api/projects/${project.id}`, { cookie: olga, body: { instructions: 'Заказчик — ООО Стройресурс.' } });
    expect(await json<ProjectDto>(saved)).toMatchObject({ instructions: 'Заказчик — ООО Стройресурс.' });

    for (const [method, path] of [['GET', `/app/api/projects/${project.id}`], ['PUT', `/app/api/projects/${project.id}`], ['DELETE', `/app/api/projects/${project.id}`], ['GET', `/app/api/projects/${project.id}/files`]] as const) {
      const res = await t.call(method, path, { cookie: petr, body: method === 'PUT' ? { name: 'Чужой' } : undefined });
      expect(res.status).toBe(404);
    }
    expect(await json<{ projects: ProjectDto[] }>(await t.call('GET', '/app/api/projects', { cookie: petr }))).toEqual({ projects: [] });
  });

  it('puts a conversation into a project before its first message and counts only existing conversations', async () => {
    const project = await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Ключевые клиенты' } }));
    const futureThread = randomUUID();
    expect((await t.call('PUT', `/app/api/threads/${futureThread}/project`, { cookie: olga, body: { projectId: project.id } })).status).toBe(200);
    expect(await json(await t.call('GET', `/app/api/threads/${futureThread}/project`, { cookie: olga }))).toEqual({ projectId: project.id });
    expect(await json(await t.call('GET', `/app/api/threads/${futureThread}/project`, { cookie: petr }))).toEqual({ projectId: null });
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
    const project = await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'На удаление' } }));
    const id = await thread(olgaId);
    await t.call('PUT', `/app/api/threads/${id}/project`, { cookie: olga, body: { projectId: project.id } });
    expect((await upload(`/app/api/projects/${project.id}/files`, olga, 'смета.xlsx', [1, 2])).status).toBe(201);
    const folder = join(t.workspaceRoot, olgaId, 'projects', project.id);
    expect(existsSync(join(folder, 'files', 'смета.xlsx'))).toBe(true);

    expect((await t.call('DELETE', `/app/api/projects/${project.id}`, { cookie: olga })).status).toBe(200);
    expect(existsSync(folder)).toBe(false);
    const all = await json<ThreadPage>(await t.call('GET', '/app/api/threads', { cookie: olga }));
    expect(all.threads.find((x) => x.id === id)?.projectId).toBeNull();
  });

  it('keeps project files: an attachment of a project conversation, listing, download and removal', async () => {
    const project = await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Отчётность' } }));
    const id = await thread(olgaId);
    await t.call('PUT', `/app/api/threads/${id}/project`, { cookie: olga, body: { projectId: project.id } });
    expect((await upload(`/app/api/threads/${id}/files`, olga, 'отчёт.pdf', [1, 2, 3])).status).toBe(201);

    const files = await json<{ files: { path: string; bytes: number }[] }>(await t.call('GET', `/app/api/projects/${project.id}/files`, { cookie: olga }));
    expect(files.files).toEqual([{ path: 'отчёт.pdf', bytes: 3 }]);
    const download = await t.call('GET', `/app/api/projects/${project.id}/file?path=${encodeURIComponent('отчёт.pdf')}`, { cookie: olga });
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await t.call('GET', `/app/api/projects/${project.id}/file?path=${encodeURIComponent('../../x')}`, { cookie: olga })).status).toBe(400);
    expect((await t.call('DELETE', `/app/api/projects/${project.id}/file?path=${encodeURIComponent('отчёт.pdf')}`, { cookie: olga })).status).toBe(200);
    expect((await json<{ files: unknown[] }>(await t.call('GET', `/app/api/projects/${project.id}/files`, { cookie: olga }))).files).toEqual([]);
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
