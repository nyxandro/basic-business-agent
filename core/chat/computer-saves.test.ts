// A file the agent writes onto the person's computer (spec, section 8.25, «Запись в папку»): before the browser writes
// it, the server keeps a snapshot of it — what the chat opens later — and the version on the computer it replaces, in
// the hidden «.computer-saved» of the project; nothing leads out of the folder; another person's conversation is not found.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ComputerSaveResponse, ProjectDto } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { contextRoot } from '../workspace/layout.ts';

let t: TestApp;
let olga: string;
let olgaId: string;
let petr: string;

async function save(cookie: string, threadId: string, fields: { source: string; target: string; previous?: string }): Promise<Response> {
  const form = new FormData();
  form.append('source', fields.source);
  form.append('target', fields.target);
  if (fields.previous !== undefined) form.append('previous', new File([fields.previous], fields.target.split('/').pop() ?? 'file'));
  return await t.app.request(`/app/api/threads/${threadId}/computer-saves`, { method: 'POST', body: form, headers: { cookie, origin: TEST_PUBLIC_URL } });
}

async function projectThread(name: string): Promise<{ threadId: string; root: string; projectId: string }> {
  const project = (await (await t.call('POST', '/app/api/projects', { cookie: olga, body: { name, access: { mode: 'private', departmentIds: [], userIds: [] } } })).json()) as ProjectDto;
  const threadId = randomUUID();
  await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: olga, body: { projectId: project.id } });
  return { threadId, root: contextRoot(t.workspaceRoot, olgaId, project.id), projectId: project.id };
}

function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
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

describe('a file written onto the computer', () => {
  it('keeps a snapshot of the file and the version it replaces in «.computer-saved», never among the project’s files', async () => {
    const { threadId, root, projectId } = await projectThread('Тендер');
    put(root, 'КП Ёлка.docx', 'новое КП');
    const res = await save(olga, threadId, { source: 'КП Ёлка.docx', target: 'Тендеры/2026/КП Ёлка.docx', previous: 'старое КП' });
    expect(res.status).toBe(201);
    const saved = (await res.json()) as ComputerSaveResponse;
    expect(saved).toEqual({
      id: expect.stringMatching(/^[a-z0-9-]+$/),
      name: 'КП Ёлка.docx',
      bytes: Buffer.byteLength('новое КП'),
      snapshot: `.computer-saved/${olgaId}/${saved.id}/КП Ёлка.docx`,
      previous: `.computer-saved/${olgaId}/${saved.id}/before/КП Ёлка.docx`,
    });
    expect(readFileSync(join(root, saved.snapshot), 'utf8')).toBe('новое КП');
    expect(readFileSync(join(root, saved.previous!), 'utf8')).toBe('старое КП');
    // The chat opens the snapshot as any file of the conversation.
    const download = await t.call('GET', `/app/api/threads/${threadId}/file?path=${encodeURIComponent(saved.snapshot)}`, { cookie: olga });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('новое КП');
    const files = (await (await t.call('GET', `/app/api/projects/${projectId}/files`, { cookie: olga })).json()) as { files: { path: string }[] };
    expect(files.files.map((f) => f.path)).toEqual(['КП Ёлка.docx']);
  });

  it('a new file has no earlier version; the snapshot of the next write is its own', async () => {
    const { threadId, root } = await projectThread('Новый файл');
    put(root, '.work/t/Смета.xlsx', 'v1');
    const first = (await (await save(olga, threadId, { source: '.work/t/Смета.xlsx', target: 'Смета.xlsx' })).json()) as ComputerSaveResponse;
    expect(first.previous).toBeNull();
    put(root, '.work/t/Смета.xlsx', 'v2');
    const second = (await (await save(olga, threadId, { source: '.work/t/Смета.xlsx', target: 'Смета.xlsx' })).json()) as ComputerSaveResponse;
    expect(second.id).not.toBe(first.id);
    expect(readFileSync(join(root, first.snapshot), 'utf8')).toBe('v1');
    expect(readFileSync(join(root, second.snapshot), 'utf8')).toBe('v2');
  });

  it('says when the file is not in the working folder, and nothing leads out of it', async () => {
    const { threadId } = await projectThread('Ошибки');
    const missing = await save(olga, threadId, { source: 'нет.docx', target: 'нет.docx' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { message: string } }).error.message).toBe('Файла «нет.docx» нет в рабочей папке.');
    expect((await save(olga, threadId, { source: '../../секрет.txt', target: 'секрет.txt' })).status).toBe(400);
    expect((await save(olga, threadId, { source: '', target: 'a.txt' })).status).toBe(400);
    expect((await save(olga, threadId, { source: 'a.txt', target: '' })).status).toBe(400);
  });

  it('another person’s conversation is not found', async () => {
    const { threadId, root } = await projectThread('Чужое');
    put(root, 'КП.docx', 'x');
    expect((await save(petr, threadId, { source: 'КП.docx', target: 'КП.docx' })).status).toBe(404);
    expect(existsSync(join(root, '.computer-saved'))).toBe(false);
  });
});
