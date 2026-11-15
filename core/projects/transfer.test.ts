// An employee removed: their projects — shared and private, archived too — go to the administrator
// who removes them (spec, section 8.20; decisions of the owner 16.11, F3 and F9).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminUser, ProjectDto, ProjectListResponse, SearchResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { contextRoot } from '../workspace/layout.ts';

let t: TestApp;
let igorId: string;
let olgaId: string;
let petrId: string;
let igor: string;
let olga: string;
let petr: string;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const create = async (cookie: string, name: string, userIds: string[] = []) =>
  json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie, body: { name, access: userIds.length ? { mode: 'list', departmentIds: [], userIds } : { mode: 'private', departmentIds: [], userIds: [] } } }));

beforeAll(async () => {
  t = await createTestApp();
  igorId = await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова' });
  petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр Иванов' });
  igor = await t.signIn('igor@example.com');
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('projects of a removed employee', () => {
  it('go to the administrator who removes them, with their files, trash and colleagues', async () => {
    const shared = await create(olga, 'Тендер', [petrId, igorId]);
    const own = await create(olga, 'Мои заметки');
    const old = await create(olga, 'Старый');
    await create(igor, 'Тендер');
    writeFileSync(join(contextRoot(t.workspaceRoot, olgaId, shared.id), 'договор.pdf'), 'Д');
    writeFileSync(join(contextRoot(t.workspaceRoot, olgaId, own.id), 'заметки.txt'), 'З');
    await t.call('DELETE', `/app/api/projects/${shared.id}/file?path=${encodeURIComponent('договор.pdf')}`, { cookie: olga });
    await t.call('POST', `/app/api/projects/${old.id}/archive`, { cookie: olga });

    const users = (await json<{ users: AdminUser[] }>(await t.call('GET', '/app/api/admin/users', { cookie: igor }))).users;
    expect(users.find((u) => u.id === olgaId)?.projects).toEqual({ total: 3, shared: 1 });

    expect((await t.call('DELETE', `/app/api/admin/users/${olgaId}`, { cookie: igor })).status).toBe(200);
    const list = await json<ProjectListResponse>(await t.call('GET', '/app/api/projects', { cookie: igor }));
    const given = list.projects.find((p) => p.id === shared.id)!;
    expect(given).toMatchObject({ name: 'Тендер (Ольга Смирнова)', role: 'owner', unseen: true, access: { mode: 'list', people: [{ name: 'Пётр Иванов' }] } });
    expect(list.projects.find((p) => p.id === own.id)).toMatchObject({ name: 'Мои заметки', shared: false, unseen: true });
    expect(list.archivedCount).toBe(1);
    expect(readFileSync(join(t.workspaceRoot, igorId, 'projects', own.id, 'files', 'заметки.txt'), 'utf8')).toBe('З');
    expect(existsSync(join(t.workspaceRoot, olgaId))).toBe(false);
    // The trash came along.
    const trash = await json<{ batches: { items: { path: string }[] }[] }>(await t.call('GET', `/app/api/projects/${shared.id}/trash`, { cookie: igor }));
    expect(trash.batches.flatMap((b) => b.items.map((i) => i.path))).toEqual(['договор.pdf']);
    // The colleague keeps the project, now with Игорь as its creator.
    expect((await json<ProjectListResponse>(await t.call('GET', '/app/api/projects', { cookie: petr }))).projects.find((p) => p.id === shared.id)).toMatchObject({ owner: { name: 'Игорь' } });
    const audit = await t.db.query("SELECT target FROM app.admin_audit WHERE action = 'project.transfer' ORDER BY target");
    expect(audit.rows.map((r: { target: string }) => r.target).sort()).toEqual([shared.id, own.id, old.id].sort());
  });

  it('search shows the colleague a shared project with its creator, and forgets it with the access', async () => {
    const p = await create(igor, 'Поставка бетона', [petrId]);
    const found = await json<SearchResponse>(await t.call('GET', `/app/api/search?q=${encodeURIComponent('бетон')}&scope=all`, { cookie: petr }));
    expect(found.projects).toEqual([{ id: p.id, name: 'Поставка бетона', threadCount: 0, shared: true, ownerName: 'Игорь' }]);
    await t.call('PUT', `/app/api/projects/${p.id}/access`, { cookie: igor, body: { mode: 'private', departmentIds: [], userIds: [] } });
    expect((await json<SearchResponse>(await t.call('GET', `/app/api/search?q=${encodeURIComponent('бетон')}&scope=all`, { cookie: petr }))).projects).toEqual([]);
  });
});
