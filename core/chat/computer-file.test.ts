// A file of the person's computer the agent reads (spec, section 8.25): the browser sends it into the hidden
// folder «.computer» of the conversation's working folder — for the skills, not among the project's files;
// a newer copy of the same path replaces the older; nothing leads out of the folder.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectDto } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { contextRoot } from '../workspace/layout.ts';

let t: TestApp;
let olga: string;
let olgaId: string;
let petr: string;

async function send(cookie: string, threadId: string, path: string, text: string): Promise<Response> {
  const form = new FormData();
  form.append('path', path);
  form.append('file', new File([new TextEncoder().encode(text)], path.split('/').pop() ?? 'file'));
  return t.app.request(`/app/api/threads/${threadId}/computer-file`, { method: 'POST', body: form, headers: { cookie, origin: TEST_PUBLIC_URL } });
}

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('a file of the computer', () => {
  it('lies in «.computer» of the project’s working folder, replaced by a newer copy, never among the project’s files', async () => {
    const project = (await (await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Тендер', access: { mode: 'private', departmentIds: [], userIds: [] } } })).json()) as ProjectDto;
    const threadId = randomUUID();
    await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: olga, body: { projectId: project.id } });
    const first = await send(olga, threadId, 'Договоры/2026/смета.xlsx', 'v1');
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ path: '.computer/Договоры/2026/смета.xlsx', bytes: 2 });
    const root = contextRoot(t.workspaceRoot, olgaId, project.id);
    expect(readFileSync(join(root, '.computer/Договоры/2026/смета.xlsx'), 'utf8')).toBe('v1');
    await send(olga, threadId, 'Договоры/2026/смета.xlsx', 'v2');
    expect(readFileSync(join(root, '.computer/Договоры/2026/смета.xlsx'), 'utf8')).toBe('v2');
    const files = (await (await t.call('GET', `/app/api/projects/${project.id}/files`, { cookie: olga })).json()) as { files: unknown[] };
    expect(files.files).toEqual([]);
  });

  it('nothing leads out of the folder; another person’s conversation is not found', async () => {
    const threadId = randomUUID();
    const out = await send(olga, threadId, '../../secret.txt', 'x');
    expect(out.status).toBe(400);
    expect(existsSync(join(t.workspaceRoot, olgaId, 'secret.txt'))).toBe(false);
    await t.memory.saveThread({ thread: { id: threadId, resourceId: olgaId, title: 'Разговор', createdAt: new Date(), updatedAt: new Date(), metadata: {} } });
    expect((await send(petr, threadId, 'a.txt', 'x')).status).toBe(404);
  });
});
