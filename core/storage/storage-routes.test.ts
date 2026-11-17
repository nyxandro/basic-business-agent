// The file storage in the installation (spec, section 8.23): «Хранилище файлов» of the admin panel, and every
// place that touches files — uploads, downloads, the agent's run, the search, the trash — working the same
// way with the files kept only in the bucket.
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectDto, SearchFiles, StorageStatus } from '@bba/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FakeRequest } from '../models/fake-openai.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { contextRoot } from '../workspace/layout.ts';
import { projectArea, userArea, areaDir } from './areas.ts';
import { startFakeS3, type FakeS3 } from './fake-s3.ts';

let t: TestApp;
let s3: FakeS3;
let igor: string;
let olga: string;
let olgaId: string;
let manager: string;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const bucket = () => [...s3.objects.keys()].filter((k) => !k.includes('.bba-check')).sort();

async function upload(path: string, cookie: string, name: string, text: string): Promise<Response> {
  const form = new FormData();
  form.append('file', new File([new TextEncoder().encode(text)], name));
  return t.app.request(path, { method: 'POST', body: form, headers: { cookie, origin: TEST_PUBLIC_URL } });
}

async function run(cookie: string, threadId: string, text: string): Promise<string> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie,
    body: { threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps: {} },
  });
  return res.text();
}

const connectBody = () => ({ provider: 'other', endpoint: s3.endpoint, region: 'ru-1', bucket: s3.bucket, prefix: '', pathStyle: true, accessKeyId: s3.accessKeyId, secretAccessKey: 'secret' });

beforeAll(async () => {
  s3 = await startFakeS3();
  t = await createTestApp({ sandbox: true, keepCopyMs: 0 });
  await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  const dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [dep, olgaId]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [dep]);
  const { rows } = await t.db.query<{ id: string }>("INSERT INTO app.roles (name, permissions) VALUES ('Хранилище', '[\"storage\"]') RETURNING id");
  await t.createUser({ email: 'manager@example.com', name: 'Марина', roleIds: [rows[0]!.id] });
  igor = await t.signIn('igor@example.com');
  olga = await t.signIn('olga@example.com');
  manager = await t.signIn('manager@example.com');
});
afterAll(async () => {
  await t.close();
  await s3.close();
});
beforeEach(() => t.model.clear());

describe('«Хранилище файлов»', () => {
  it('is seen with the right, changed only by a superadmin; an employee does not see it at all', async () => {
    expect((await t.call('GET', '/app/api/admin/storage', { cookie: olga })).status).toBe(403);
    const seen = await json<StorageStatus>(await t.call('GET', '/app/api/admin/storage', { cookie: manager }));
    expect(seen).toMatchObject({ mode: 'local', state: 'active', bucket: null });
    const refused = await t.call('POST', '/app/api/admin/storage', { cookie: manager, body: connectBody() });
    expect(refused.status).toBe(403);
    expect((await json<{ error: { message: string } }>(refused)).error.message).toContain('только суперадминистратор');
  });

  it('a bucket with a wrong key is refused with what to check', async () => {
    const res = await t.call('POST', '/app/api/admin/storage', { cookie: igor, body: { ...connectBody(), accessKeyId: 'wrong' } });
    expect(res.status).toBe(502);
    expect(await json(res)).toMatchObject({ error: { code: 'APP_STORAGE_ACCESS_DENIED' } });
  });

  it('connects, moves the files there and writes who did it into the audit', async () => {
    writeFileSync(join(contextRoot(t.workspaceRoot, olgaId, null), 'до-хранилища.pdf'), 'pdf');
    const res = await t.call('POST', '/app/api/admin/storage', { cookie: igor, body: connectBody() });
    expect(res.status).toBe(200);
    expect(await json<StorageStatus>(res)).toMatchObject({ mode: 's3', bucket: { bucket: s3.bucket, provider: 'other' } });
    await t.storage.sweep();
    expect(bucket()).toContain(`users/${olgaId}/files/до-хранилища.pdf`);
    expect(existsSync(areaDir(t.workspaceRoot, userArea(olgaId)))).toBe(false);
    const { rows } = await t.db.query("SELECT action FROM app.admin_audit WHERE action = 'storage.connect'");
    expect(rows).toHaveLength(1);
    // Connected once: changing the bucket means disconnecting first.
    expect((await t.call('POST', '/app/api/admin/storage', { cookie: igor, body: connectBody() })).status).toBe(409);
  });
});

describe('with the files in the bucket', () => {
  let project: ProjectDto;

  beforeAll(async () => {
    project = await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Тендер', access: { mode: 'private', departmentIds: [], userIds: [] } } }));
  });

  it('an uploaded project file goes to the bucket, is listed and downloaded without a copy left on the disk', async () => {
    expect((await upload(`/app/api/projects/${project.id}/files`, olga, 'смета.xlsx', 'смета v1')).status).toBe(201);
    expect(bucket()).toContain(`projects/${project.id}/files/смета.xlsx`);
    await t.storage.sweep();
    expect(existsSync(areaDir(t.workspaceRoot, projectArea(project.id, olgaId)))).toBe(false);
    const files = await json<{ files: { path: string; bytes: number }[] }>(await t.call('GET', `/app/api/projects/${project.id}/files`, { cookie: olga }));
    expect(files.files).toEqual([{ path: 'смета.xlsx', bytes: Buffer.byteLength('смета v1') }]);
    // The listing brought nothing to the disk.
    expect(existsSync(areaDir(t.workspaceRoot, projectArea(project.id, olgaId)))).toBe(false);
    const down = await t.call('GET', `/app/api/projects/${project.id}/file?path=${encodeURIComponent('смета.xlsx')}`, { cookie: olga });
    expect(await down.text()).toBe('смета v1');
  });

  it('the search finds a document of a project that has no copy on the disk', async () => {
    await t.storage.sweep();
    const found = await json<SearchFiles>(await t.call('GET', `/app/api/search/files?q=${encodeURIComponent('смета')}`, { cookie: olga }));
    expect(found.files.map((f) => f.path)).toContain('смета.xlsx');
  });

  it('the agent works in a copy of the project made for its answer; what it writes is stored when it ends', async () => {
    const threadId = randomUUID();
    await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: olga, body: { projectId: project.id } });
    const tool = (req: FakeRequest, end: string) => (req.tools ?? []).map((x) => x.function.name).find((n) => n.endsWith(end)) ?? `missing_${end}`;
    t.model.script(
      (req) => ({ toolCalls: [{ name: tool(req, 'read_file'), args: { path: 'смета.xlsx' } }] }),
      (req) => ({ toolCalls: [{ name: tool(req, 'write_file'), args: { path: 'итог.txt', content: 'итог готов' } }] }),
      { text: 'Готово.' },
    );
    const body = await run(olga, threadId, 'Прочитай смету и запиши итог');
    expect(body).toContain('Готово.');
    // The agent found the file in the copy (an xlsx is not read as text, its size is told).
    expect(JSON.stringify(t.model.requests.at(-2)?.messages)).toContain('смета.xlsx (13 bytes');
    // The agent ended: the folder is let go after its trash; the new file is in the bucket.
    await expect.poll(() => bucket().includes(`projects/${project.id}/files/итог.txt`), { timeout: 5000 }).toBe(true);
    await t.storage.sweep();
    expect(existsSync(areaDir(t.workspaceRoot, projectArea(project.id, olgaId)))).toBe(false);
  }, 30_000);

  it('a file removed by the page goes to the trash in the bucket and comes back from it', async () => {
    const removed = await json<{ trashId: string }>(await t.call('DELETE', `/app/api/projects/${project.id}/file?path=${encodeURIComponent('итог.txt')}`, { cookie: olga }));
    expect(bucket()).toContain(`projects/${project.id}/trash/${removed.trashId}`);
    expect(bucket()).not.toContain(`projects/${project.id}/files/итог.txt`);
    await t.storage.sweep();
    const restored = await t.call('POST', `/app/api/projects/${project.id}/trash/restore`, { cookie: olga, body: { ids: [removed.trashId] } });
    expect(await json(restored)).toEqual({ restored: ['итог.txt'] });
    expect(bucket()).toContain(`projects/${project.id}/files/итог.txt`);
  });

  it('when the bucket does not answer, the answer does not start and the person reads why', async () => {
    await t.storage.sweep();
    s3.outage(true);
    try {
      const res = await t.call('GET', `/app/api/projects/${project.id}/file?path=${encodeURIComponent('смета.xlsx')}`, { cookie: olga });
      expect(res.status).toBe(503);
      expect(await json(res)).toMatchObject({ error: { code: 'APP_STORAGE_UNAVAILABLE', message: 'Хранилище файлов сейчас не отвечает — файлы недоступны.' } });
    } finally {
      s3.outage(false);
    }
  }, 30_000);

  it('disconnecting brings the files back to the server', async () => {
    expect((await t.call('DELETE', '/app/api/admin/storage', { cookie: igor })).status).toBe(200);
    await t.storage.sweep();
    expect(await json<StorageStatus>(await t.call('GET', '/app/api/admin/storage', { cookie: igor }))).toMatchObject({ mode: 'local', bucket: null });
    expect(bucket()).toEqual([]);
    const down = await t.call('GET', `/app/api/projects/${project.id}/file?path=${encodeURIComponent('смета.xlsx')}`, { cookie: olga });
    expect(await down.text()).toBe('смета v1');
  });
});
