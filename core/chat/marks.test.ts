// Marks on a document in the viewer (spec, section 8.32): the browser sends the picture of the marks into the
// hidden folder «.marks» of the conversation's working folder — kept with the files, never among the project's
// files; only a JPEG the model can take; the status of a file names its version, which the draft of marks keeps.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKS_FOLDER, MODEL_PICTURE_MAX_BYTES, type ProjectDto, type ThreadFileStatus, type UploadedFile } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureThread } from '../memory/memory.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { contextRoot } from '../workspace/layout.ts';

let t: TestApp;
let olga: string;
let olgaId: string;
let petr: string;

// The first bytes of a JPEG and of a PNG.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function tooBig(): Uint8Array {
  const bytes = new Uint8Array(MODEL_PICTURE_MAX_BYTES + 1);
  bytes.set(JPEG);
  return bytes;
}

async function send(cookie: string, threadId: string, name: string, bytes: Uint8Array): Promise<Response> {
  const form = new FormData();
  form.append('file', new File([Buffer.from(bytes)], name));
  return t.app.request(`/app/api/threads/${threadId}/marks`, { method: 'POST', body: form, headers: { cookie, origin: TEST_PUBLIC_URL } });
}

async function projectThread(name: string): Promise<{ threadId: string; root: string; projectId: string }> {
  const project = (await (await t.call('POST', '/app/api/projects', { cookie: olga, body: { name, access: { mode: 'private', departmentIds: [], userIds: [] } } })).json()) as ProjectDto;
  const threadId = randomUUID();
  await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: olga, body: { projectId: project.id } });
  return { threadId, root: contextRoot(t.workspaceRoot, olgaId, project.id), projectId: project.id };
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

describe('the picture of marks', () => {
  it('lies in «.marks» of the project’s working folder, a taken name gets «(2)», never among the project’s files', async () => {
    const { threadId, root, projectId } = await projectThread('Договор');
    const first = await send(olga, threadId, 'Договор.docx (пометки).jpg', JPEG);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual<UploadedFile>({ name: 'Договор.docx (пометки).jpg', path: `${MARKS_FOLDER}/Договор.docx (пометки).jpg`, bytes: JPEG.length });
    expect(readFileSync(join(root, MARKS_FOLDER, 'Договор.docx (пометки).jpg'))).toEqual(Buffer.from(JPEG));
    const second = (await (await send(olga, threadId, 'Договор.docx (пометки).jpg', JPEG)).json()) as UploadedFile;
    expect(second.path).toBe(`${MARKS_FOLDER}/Договор.docx (пометки) (2).jpg`);
    const files = (await (await t.call('GET', `/app/api/projects/${projectId}/files`, { cookie: olga })).json()) as { files: unknown[] };
    expect(files.files).toEqual([]);
  });

  it('in a conversation without a project lies in «.marks» of the person’s own folder', async () => {
    const threadId = randomUUID();
    const res = await send(olga, threadId, 'Счёт.pdf (пометки).jpg', JPEG);
    expect(res.status).toBe(201);
    expect(readFileSync(join(contextRoot(t.workspaceRoot, olgaId, null), MARKS_FOLDER, 'Счёт.pdf (пометки).jpg'))).toEqual(Buffer.from(JPEG));
  });

  it('is taken only as a JPEG the model can see', async () => {
    const { threadId, root } = await projectThread('Не картинка');
    for (const [name, bytes] of [
      ['пометки.png', PNG],
      ['пометки.jpg', PNG],
      ['пометки.jpg', tooBig()],
    ] as const) {
      const res = await send(olga, threadId, name, bytes);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('APP_MARKS_PICTURE_INVALID');
    }
    expect(existsSync(join(root, MARKS_FOLDER))).toBe(false);
  });

  it('another person’s conversation is not found', async () => {
    const threadId = randomUUID();
    await ensureThread(t.memory, { threadId, resourceId: olgaId, agentId: 'sales', kind: 'chat', title: 'Разговор' });
    expect((await send(petr, threadId, 'пометки.jpg', JPEG)).status).toBe(404);
  });
});

describe('the status of a file of the conversation', () => {
  it('names the version of the file, which changes when the file is written again', async () => {
    const { threadId, root } = await projectThread('Версия');
    writeFileSync(join(root, 'КП.docx'), 'v1');
    const status = async () => (await (await t.call('GET', `/app/api/threads/${threadId}/file/status?path=${encodeURIComponent('КП.docx')}`, { cookie: olga })).json()) as ThreadFileStatus;
    const before = await status();
    expect(before).toEqual({ state: 'ok', version: expect.any(String) });
    expect(await status()).toEqual(before);
    writeFileSync(join(root, 'КП.docx'), 'v2');
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, 'КП.docx'), later, later);
    expect(await status()).not.toEqual(before);
  });
});
