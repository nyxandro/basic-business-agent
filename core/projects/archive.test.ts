// A project is archived, not removed (spec, section 8.20; decision of the owner 16.11): it leaves
// «Проекты» of everyone, comes back whole, and is removed for good only 30 days after archiving.
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchivedProjectDto, ProjectDto, ProjectListResponse, ThreadProjectResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureThread } from '../memory/memory.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { contextRoot } from '../workspace/layout.ts';

let t: TestApp;
let olgaId: string;
let petrId: string;
let olga: string;
let petr: string;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const names = async (cookie: string) => (await json<ProjectListResponse>(await t.call('GET', '/app/api/projects', { cookie }))).projects.map((p) => p.name);
const errorOf = async (res: Response) => (await json<{ error: { code: string; message: string } }>(res)).error;

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова' });
  petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр Иванов' });
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('the archive of projects', () => {
  it('takes a project out of everyone’s «Проекты», gives it back whole, and removes it for good only after 30 days', async () => {
    const p = await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Тендер', access: { mode: 'list', departmentIds: [], userIds: [petrId] } } }));
    writeFileSync(join(contextRoot(t.workspaceRoot, olgaId, p.id), 'договор.pdf'), 'Д');
    const petrThread = randomUUID();
    await ensureThread(t.memory, { threadId: petrThread, resourceId: petrId, agentId: 'sales', kind: 'chat', title: 'КП' });
    await t.call('PUT', `/app/api/threads/${petrThread}/project`, { cookie: petr, body: { projectId: p.id } });
    await t.call('PUT', `/app/api/projects/${p.id}`, { cookie: petr, body: { pinned: true } });

    // A colleague cannot archive it.
    expect((await errorOf(await t.call('POST', `/app/api/projects/${p.id}/archive`, { cookie: petr }))).code).toBe('APP_PROJECT_OWNER_ONLY');
    expect((await t.call('POST', `/app/api/projects/${p.id}/archive`, { cookie: olga })).status).toBe(200);
    // Archiving twice changes nothing.
    expect((await t.call('POST', `/app/api/projects/${p.id}/archive`, { cookie: olga })).status).toBe(200);
    expect(await names(olga)).not.toContain('Тендер');
    expect(await names(petr)).not.toContain('Тендер');
    expect((await json<ProjectListResponse>(await t.call('GET', '/app/api/projects', { cookie: olga }))).archivedCount).toBe(1);
    const archive = (await json<{ projects: ArchivedProjectDto[] }>(await t.call('GET', '/app/api/projects/archive', { cookie: olga }))).projects;
    expect(archive).toEqual([{ id: p.id, name: 'Тендер', archivedAt: expect.any(String), deletableFrom: expect.any(String), files: 1, shared: true }]);
    expect(Date.parse(archive[0]!.deletableFrom) - Date.parse(archive[0]!.archivedAt)).toBe(30 * 86_400_000);
    expect((await json<{ projects: unknown[] }>(await t.call('GET', '/app/api/projects/archive', { cookie: petr }))).projects).toEqual([]);
    expect(await json<ThreadProjectResponse>(await t.call('GET', `/app/api/threads/${petrThread}/project`, { cookie: petr }))).toMatchObject({ projectId: null, lost: { reason: 'archived', canUnarchive: false } });

    // Too early to remove for good.
    const early = await t.call('DELETE', `/app/api/projects/${p.id}`, { cookie: olga });
    expect(early.status).toBe(409);
    expect(await errorOf(early)).toMatchObject({ code: 'APP_PROJECT_DELETE_TOO_EARLY', message: expect.stringMatching(/^Удалить навсегда можно будет с \d+ [а-я]+ \d{4} г\.\.?$/) });

    // Back: the place in the colleague's panel and his conversation come back with it.
    expect((await t.call('POST', `/app/api/projects/${p.id}/unarchive`, { cookie: olga })).status).toBe(200);
    expect((await json<ProjectListResponse>(await t.call('GET', '/app/api/projects', { cookie: petr }))).projects[0]).toMatchObject({ name: 'Тендер', pinned: true });
    expect(await json<ThreadProjectResponse>(await t.call('GET', `/app/api/threads/${petrThread}/project`, { cookie: petr }))).toEqual({ projectId: p.id, lost: null });

    // Not archived: cannot be removed for good.
    expect(await errorOf(await t.call('DELETE', `/app/api/projects/${p.id}`, { cookie: olga }))).toMatchObject({ code: 'APP_VALIDATION_FAILED', message: 'Сначала перенесите проект в архив.' });

    // 30 days in the archive: removed with its files and trash; the colleague's conversation keeps its name.
    await t.call('POST', `/app/api/projects/${p.id}/archive`, { cookie: olga });
    await t.db.query("UPDATE app.projects SET archived_at = now() - interval '30 days 1 minute' WHERE id = $1", [p.id]);
    // A colleague does not see an archived project at all (F8).
    expect((await t.call('DELETE', `/app/api/projects/${p.id}`, { cookie: petr })).status).toBe(404);
    expect((await t.call('DELETE', `/app/api/projects/${p.id}`, { cookie: olga })).status).toBe(200);
    expect(existsSync(join(t.workspaceRoot, olgaId, 'projects', p.id))).toBe(false);
    expect(await json<ThreadProjectResponse>(await t.call('GET', `/app/api/threads/${petrThread}/project`, { cookie: petr }))).toEqual({ projectId: null, lost: { name: 'Тендер', reason: 'deleted', ownerName: null, canUnarchive: false } });
    expect((await json<ProjectListResponse>(await t.call('GET', '/app/api/projects', { cookie: olga }))).archivedCount).toBe(0);
  });
});
