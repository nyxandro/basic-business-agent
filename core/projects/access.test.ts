// Who sees a project (spec, section 8.20), on a real database through the HTTP routes: the creator,
// people and departments of «Выбранным», the whole organisation — and nobody else. Access is counted
// on every request, so a change of departments works at once.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectAccessInput, ProjectDto, ProjectListResponse, ThreadPage, ThreadProjectResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDepartment, deleteDepartment, setDepartmentMembers } from '../auth/departments.ts';
import { setUserBlocked } from '../auth/users.ts';
import { ensureThread } from '../memory/memory.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';

let t: TestApp;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};
let sales: string;
let logistics: string;

const PRIVATE: ProjectAccessInput = { mode: 'private', departmentIds: [], userIds: [] };
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const errorOf = async (res: Response) => (await json<{ error: { code: string; message: string } }>(res)).error;

async function create(who: string, name: string, access: ProjectAccessInput = PRIVATE): Promise<ProjectDto> {
  const res = await t.call('POST', '/app/api/projects', { cookie: cookie[who], body: { name, access } });
  expect(res.status).toBe(201);
  return json<ProjectDto>(res);
}
const list = async (who: string) => json<ProjectListResponse>(await t.call('GET', '/app/api/projects', { cookie: cookie[who] }));
const names = async (who: string) => (await list(who)).projects.map((p) => p.name);
const page = (who: string, projectId: string) => t.call('GET', `/app/api/projects/${projectId}`, { cookie: cookie[who] });
const share = (who: string, projectId: string, access: ProjectAccessInput) => t.call('PUT', `/app/api/projects/${projectId}/access`, { cookie: cookie[who], body: access });

beforeAll(async () => {
  t = await createTestApp();
  for (const [key, name] of [['olga', 'Ольга Смирнова'], ['ivan', 'Иван Котов'], ['petr', 'Пётр Иванов'], ['nina', 'Нина Белова'], ['boss', 'Игорь']] as const) {
    id[key] = await t.createUser({ email: `${key}@example.com`, name });
    cookie[key] = await t.signIn(`${key}@example.com`);
  }
  sales = await createDepartment(t.db, id.boss!, 'Продажи');
  logistics = await createDepartment(t.db, id.boss!, 'Логистика');
  await setDepartmentMembers(t.db, id.boss!, sales, [id.olga!, id.ivan!]);
  await setDepartmentMembers(t.db, id.boss!, logistics, [id.nina!]);
});
afterAll(async () => {
  await t.close();
});

describe('who sees a project', () => {
  it('a private project is its creator’s only', async () => {
    const p = await create('olga', 'Личный');
    expect(p).toMatchObject({ role: 'owner', shared: false, unseen: false, owner: { id: id.olga, name: 'Ольга Смирнова' }, access: { mode: 'private', departments: [], people: [] } });
    for (const who of ['ivan', 'petr', 'nina']) {
      expect((await page(who, p.id)).status).toBe(404);
      expect(await names(who)).not.toContain('Личный');
    }
  });

  it('«Выбранным» opens to the people and the departments of the list, and follows the departments at once', async () => {
    const p = await create('olga', 'Тендер', { mode: 'list', departmentIds: [sales], userIds: [id.petr!] });
    expect(p.shared).toBe(true);
    expect(p.access).toEqual({ mode: 'list', departments: [{ id: sales, name: 'Продажи', members: 2 }], people: [{ id: id.petr, name: 'Пётр Иванов', email: 'petr@example.com', blocked: false }] });
    expect(await names('ivan')).toContain('Тендер');
    expect(await names('petr')).toContain('Тендер');
    expect(await names('nina')).not.toContain('Тендер');
    const seenByIvan = await json<ProjectDto>(await page('ivan', p.id));
    expect(seenByIvan).toMatchObject({ role: 'member', shared: true, owner: { name: 'Ольга Смирнова' }, access: null });

    // Ivan leaves «Продажи»: no access from the next request on; Nina joins and gets it.
    await setDepartmentMembers(t.db, id.boss!, sales, [id.olga!, id.nina!]);
    expect((await page('ivan', p.id)).status).toBe(404);
    expect(await names('nina')).toContain('Тендер');
    await setDepartmentMembers(t.db, id.boss!, sales, [id.olga!, id.ivan!]);
  });

  it('a removed department leaves the list; a list with nobody left is «только я»', async () => {
    const temp = await createDepartment(t.db, id.boss!, 'Временный');
    await setDepartmentMembers(t.db, id.boss!, temp, [id.nina!]);
    const p = await create('olga', 'Временный проект', { mode: 'list', departmentIds: [temp], userIds: [] });
    expect(await names('nina')).toContain('Временный проект');
    await deleteDepartment(t.db, id.boss!, temp);
    expect(await names('nina')).not.toContain('Временный проект');
    expect(await json<ProjectDto>(await page('olga', p.id))).toMatchObject({ shared: false, access: { mode: 'private', departments: [], people: [] } });
  });

  it('«Всей организации» opens to everyone, newcomers too', async () => {
    const p = await create('olga', 'Для всех', { mode: 'org', departmentIds: [], userIds: [] });
    for (const who of ['ivan', 'petr', 'nina']) expect(await names(who)).toContain('Для всех');
    id.lena = await t.createUser({ email: 'lena@example.com', name: 'Лена' });
    cookie.lena = await t.signIn('lena@example.com');
    expect(await names('lena')).toContain('Для всех');
    expect((await page('lena', p.id)).status).toBe(200);
  });

  it('a colleague cannot rename, rewrite, reopen or remove the project; pinning is their own', async () => {
    const p = await create('olga', 'Общий отчёт', { mode: 'list', departmentIds: [], userIds: [id.petr!] });
    for (const res of [
      await t.call('PUT', `/app/api/projects/${p.id}`, { cookie: cookie.petr, body: { name: 'Мой' } }),
      await t.call('PUT', `/app/api/projects/${p.id}`, { cookie: cookie.petr, body: { instructions: 'Иначе' } }),
      await share('petr', p.id, { mode: 'org', departmentIds: [], userIds: [] }),
      await t.call('DELETE', `/app/api/projects/${p.id}`, { cookie: cookie.petr }),
    ]) {
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toMatchObject({ code: 'APP_PROJECT_OWNER_ONLY', message: 'Это может только создатель проекта.' });
    }
    const before = await names('olga');
    expect(await json<ProjectDto>(await t.call('PUT', `/app/api/projects/${p.id}`, { cookie: cookie.petr, body: { pinned: true } }))).toMatchObject({ pinned: true, name: 'Общий отчёт' });
    expect((await list('petr')).projects[0]).toMatchObject({ name: 'Общий отчёт', pinned: true });
    expect(await names('olga')).toEqual(before);
    expect((await list('olga')).projects.find((x) => x.id === p.id)?.pinned).toBe(false);
  });

  it('a newly shared project comes first among the colleague’s unpinned ones, «новое» until opened', async () => {
    const own = await create('nina', 'Свой Нины');
    const shared = await create('olga', 'Новое для Нины', { mode: 'list', departmentIds: [logistics], userIds: [] });
    const ninas = (await list('nina')).projects.filter((p) => !p.pinned);
    expect(ninas[0]).toMatchObject({ id: shared.id, unseen: true });
    expect(ninas.find((p) => p.id === own.id)?.unseen).toBe(false);
    expect(await json<ProjectDto>(await page('nina', shared.id))).toMatchObject({ unseen: false });
    expect((await list('nina')).projects.find((p) => p.id === shared.id)?.unseen).toBe(false);
    // The order the colleague drags covers the shared projects too.
    const ids = (await list('nina')).projects.map((p) => p.id).reverse();
    expect((await t.call('PUT', '/app/api/projects/order', { cookie: cookie.nina, body: { ids } })).status).toBe(200);
    expect((await list('nina')).projects.map((p) => p.id)).toEqual(ids);
  });

  it('creates a project with its access in one go: a bad list or a taken name leaves nothing', async () => {
    const res = await t.call('POST', '/app/api/projects', { cookie: cookie.olga, body: { name: 'Без адресатов', access: { mode: 'list', departmentIds: [], userIds: [] } } });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe('Выберите хотя бы один отдел или сотрудника.');
    const gone = await t.call('POST', '/app/api/projects', { cookie: cookie.olga, body: { name: 'С пропавшим', access: { mode: 'list', departmentIds: [randomUUID()], userIds: [] } } });
    expect((await errorOf(gone)).message).toBe('Некоторых отделов или сотрудников уже нет. Обновите список и сохраните снова.');
    const self = await t.call('POST', '/app/api/projects', { cookie: cookie.olga, body: { name: 'С собой', access: { mode: 'list', departmentIds: [], userIds: [id.olga] } } });
    expect(self.status).toBe(400);
    const extra = await t.call('POST', '/app/api/projects', { cookie: cookie.olga, body: { name: 'Со списком', access: { mode: 'org', departmentIds: [sales], userIds: [] } } });
    expect(extra.status).toBe(400);
    await create('olga', 'Занятое');
    const taken = await t.call('POST', '/app/api/projects', { cookie: cookie.olga, body: { name: 'занятое', access: { mode: 'list', departmentIds: [sales], userIds: [] } } });
    expect(taken.status).toBe(409);
    expect(await names('olga')).not.toEqual(expect.arrayContaining(['Без адресатов', 'С пропавшим', 'С собой', 'Со списком']));
    expect((await t.db.query("SELECT 1 FROM app.project_shares s JOIN app.projects p ON p.id = s.project_id WHERE lower(p.name) = 'занятое'")).rowCount).toBe(0);
  });

  it('a blocked person stays in the list marked so, and cannot be added again', async () => {
    id.oleg = await t.createUser({ email: 'oleg@example.com', name: 'Олег' });
    const p = await create('olga', 'С Олегом', { mode: 'list', departmentIds: [], userIds: [id.oleg] });
    await setUserBlocked(t.db, id.boss!, id.oleg, true);
    expect((await json<ProjectDto>(await page('olga', p.id))).access?.people).toEqual([{ id: id.oleg, name: 'Олег', email: 'oleg@example.com', blocked: true }]);
    expect((await share('olga', p.id, { mode: 'list', departmentIds: [], userIds: [id.oleg, id.petr!] })).status).toBe(400);
    expect(await json<ProjectDto>(await share('olga', p.id, { mode: 'list', departmentIds: [], userIds: [id.petr!] }))).toMatchObject({ access: { mode: 'list', people: [{ name: 'Пётр Иванов' }] } });
  });
});

describe('a colleague’s work in a shared project', () => {
  it('files go to the creator’s folder; the conversation leaves the project when access is closed and comes back when reopened', async () => {
    const p = await create('olga', 'Совместный', { mode: 'list', departmentIds: [], userIds: [id.petr!] });
    const form = new FormData();
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'расчёт.xlsx'));
    const up = await t.app.request(`/app/api/projects/${p.id}/files`, { method: 'POST', body: form, headers: { cookie: cookie.petr!, origin: TEST_PUBLIC_URL } });
    expect(up.status).toBe(201);
    expect(existsSync(join(t.workspaceRoot, id.olga!, 'projects', p.id, 'files', 'расчёт.xlsx'))).toBe(true);
    expect((await json<{ files: unknown[] }>(await t.call('GET', `/app/api/projects/${p.id}/files`, { cookie: cookie.olga }))).files).toEqual([{ path: 'расчёт.xlsx', bytes: 3 }]);

    const threadId = randomUUID();
    await ensureThread(t.memory, { threadId, resourceId: id.petr!, agentId: 'sales', kind: 'chat', title: 'КП' });
    expect((await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: cookie.petr, body: { projectId: p.id } })).status).toBe(200);
    const threadProject = async () => json<ThreadProjectResponse>(await t.call('GET', `/app/api/threads/${threadId}/project`, { cookie: cookie.petr }));
    expect(await threadProject()).toEqual({ projectId: p.id, lost: null });
    expect((await json<ThreadPage>(await t.call('GET', `/app/api/threads?projectId=${p.id}`, { cookie: cookie.petr }))).threads.map((x) => x.id)).toEqual([threadId]);
    // The creator does not see a colleague's conversations.
    expect((await json<ThreadPage>(await t.call('GET', `/app/api/threads?projectId=${p.id}`, { cookie: cookie.olga }))).threads).toEqual([]);
    expect((await list('olga')).projects.find((x) => x.id === p.id)?.threadCount).toBe(0);

    await share('olga', p.id, PRIVATE);
    expect(await threadProject()).toEqual({ projectId: null, lost: { name: 'Совместный', reason: 'access', ownerName: 'Ольга Смирнова', canUnarchive: false } });
    expect((await json<ThreadPage>(await t.call('GET', '/app/api/threads', { cookie: cookie.petr }))).threads.find((x) => x.id === threadId)?.projectId).toBeNull();
    expect((await t.call('GET', `/app/api/projects/${p.id}/files`, { cookie: cookie.petr })).status).toBe(404);

    await share('olga', p.id, { mode: 'list', departmentIds: [], userIds: [id.petr!] });
    expect(await threadProject()).toEqual({ projectId: p.id, lost: null });

    // Removed for good: the colleague's conversation keeps the name; the creator's links go.
    await t.db.query("UPDATE app.projects SET archived_at = now() - interval '31 days' WHERE id = $1", [p.id]);
    expect((await t.call('DELETE', `/app/api/projects/${p.id}`, { cookie: cookie.olga })).status).toBe(200);
    expect(await threadProject()).toEqual({ projectId: null, lost: { name: 'Совместный', reason: 'deleted', ownerName: null, canUnarchive: false } });
    expect((await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: cookie.petr, body: { projectId: null } })).status).toBe(200);
    expect(await threadProject()).toEqual({ projectId: null, lost: null });
  });

  it('an archived project is gone for colleagues and from lists; its creator still opens its page', async () => {
    const p = await create('olga', 'В архив', { mode: 'org', departmentIds: [], userIds: [] });
    const threadId = randomUUID();
    await ensureThread(t.memory, { threadId, resourceId: id.olga!, agentId: 'sales', kind: 'chat', title: 'Архивный' });
    await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: cookie.olga, body: { projectId: p.id } });
    const archivedBefore = (await list('olga')).archivedCount;
    await t.db.query('UPDATE app.projects SET archived_at = now() WHERE id = $1', [p.id]);
    expect(await names('olga')).not.toContain('В архив');
    expect((await list('olga')).archivedCount).toBe(archivedBefore + 1);
    expect(await names('nina')).not.toContain('В архив');
    expect((await page('nina', p.id)).status).toBe(404);
    expect(await json<ProjectDto>(await page('olga', p.id))).toMatchObject({ name: 'В архив', archivedAt: expect.any(String) });
    const rename = await t.call('PUT', `/app/api/projects/${p.id}`, { cookie: cookie.olga, body: { name: 'Новое имя' } });
    expect((await errorOf(rename)).code).toBe('APP_PROJECT_ARCHIVED');
    expect(await json<ThreadProjectResponse>(await t.call('GET', `/app/api/threads/${threadId}/project`, { cookie: cookie.olga }))).toEqual({ projectId: null, lost: { name: 'В архив', reason: 'archived', ownerName: 'Ольга Смирнова', canUnarchive: true } });
    expect((await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: cookie.olga, body: { projectId: p.id } })).status).toBe(404);
  });
});
