// The routes of the viewer (spec, section 8.27): the same right to a file as its download, a PDF in place.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectDto } from '@bba/contracts';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { chatRoot } from '../workspace/layout.ts';
import type { RunCommand } from './convert.ts';
import { parseRange } from './response.ts';

let t: TestApp;
let olgaId: string;
let petrId: string;
let olga: string;
let petr: string;
const conversions: string[] = [];

// LibreOffice's stand-in: a small PDF, counting its runs.
const run: RunCommand = (cwd, _program, args) => {
  conversions.push(args.at(-1)!);
  mkdirSync(join(cwd, 'out'), { recursive: true });
  writeFileSync(join(cwd, 'out', 'source.pdf'), '%PDF-1.4 stand-in made for the route test');
  return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
};

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const errorOf = async (res: Response) => (await json<{ error: { code: string; message: string } }>(res)).error;

beforeAll(async () => {
  t = await createTestApp({ previewRun: run });
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
});
afterAll(async () => {
  await t.close();
});

async function thread(userId: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await t.memory.saveThread({ thread: { id, resourceId: userId, title: 'КП', metadata: { agentId: 'sales', kind: 'chat' }, createdAt: now, updatedAt: now } });
  return id;
}

// A file of the person's own files (the search) — or, with `threadId`, of that conversation's folder (spec, 8.33).
function ownFile(userId: string, rel: string, content = 'DOCX-BYTES', threadId?: string): string {
  const path = join(threadId ? chatRoot(t.workspaceRoot, userId, threadId) : join(t.workspaceRoot, userId, 'files'), rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('the PDF of a document of a conversation', () => {
  it('is given to the person in place, in parts on request, and to nobody else', async () => {
    const threadId = await thread(olgaId);
    ownFile(olgaId, 'итоги/КП «Ёлка».docx', 'DOCX-BYTES', threadId);
    const url = (path: string) => `/app/api/threads/${threadId}/file/preview?path=${encodeURIComponent(path)}`;
    const res = await t.call('GET', url('итоги/КП «Ёлка».docx'), { cookie: olga });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.4 stand-in made for the route test');
    expect(Object.fromEntries(['content-type', 'content-disposition', 'cache-control', 'x-content-type-options', 'accept-ranges', 'content-length'].map((h) => [h, res.headers.get(h)]))).toEqual({
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent('КП «Ёлка».pdf')}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      'content-length': '41',
    });
    const part = await t.app.request(url('итоги/КП «Ёлка».docx'), { headers: { cookie: olga, origin: TEST_PUBLIC_URL, range: 'bytes=0-3' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 0-3/41');
    expect(await part.text()).toBe('%PDF');
    // Made once for both.
    expect(conversions.filter((c) => c === 'source.docx')).toHaveLength(1);
    expect((await t.call('GET', url('итоги/КП «Ёлка».docx'), { cookie: petr })).status).toBe(404);
  });

  it('says what the download says for a file gone, and what the viewer cannot show', async () => {
    const threadId = await thread(olgaId);
    const url = (path: string) => `/app/api/threads/${threadId}/file/preview?path=${encodeURIComponent(path)}`;
    const gone = await t.call('GET', url('нет.docx'), { cookie: olga });
    expect(gone.status).toBe(404);
    expect(await errorOf(gone)).toMatchObject({ code: 'APP_FILE_DELETED', message: 'Файл «нет.docx» удалён из рабочей папки — скачать его нельзя.' });
    ownFile(olgaId, 'архив.zip', 'DOCX-BYTES', threadId);
    const zip = await t.call('GET', url('архив.zip'), { cookie: olga });
    expect(zip.status).toBe(415);
    expect((await errorOf(zip)).code).toBe('APP_PREVIEW_UNSUPPORTED');
    // 50 MB and a byte: a sparse file, nothing written.
    truncateSync(ownFile(olgaId, 'огромный.pptx', '', threadId), 50 * 1024 * 1024 + 1);
    const big = await t.call('GET', url('огромный.pptx'), { cookie: olga });
    expect(big.status).toBe(413);
    expect(await errorOf(big)).toMatchObject({ code: 'APP_PREVIEW_TOO_BIG', message: 'Файл больше 50 МБ — посмотреть его здесь нельзя. Скачайте его.' });
    rmSync(join(chatRoot(t.workspaceRoot, olgaId, threadId), 'огромный.pptx'));
  });
});

describe('the PDF of a document of a project', () => {
  it('as its download: the creator and those it is open to, the archive to its creator', async () => {
    const project = await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Тендер', access: { mode: 'private', departmentIds: [], userIds: [] } } }));
    const form = new FormData();
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'Смета.xlsx'));
    expect((await t.app.request(`/app/api/projects/${project.id}/files`, { method: 'POST', body: form, headers: { cookie: olga, origin: TEST_PUBLIC_URL } })).status).toBe(201);
    const url = `/app/api/projects/${project.id}/file/preview?path=${encodeURIComponent('Смета.xlsx')}`;
    expect((await t.call('GET', url, { cookie: olga })).status).toBe(200);
    expect((await t.call('GET', url, { cookie: petr })).status).toBe(404);
    await t.call('PUT', `/app/api/projects/${project.id}/access`, { cookie: olga, body: { mode: 'list', departmentIds: [], userIds: [petrId] } });
    expect((await t.call('GET', url, { cookie: petr })).status).toBe(200);
    await t.call('POST', `/app/api/projects/${project.id}/archive`, { cookie: olga });
    expect((await t.call('GET', url, { cookie: olga })).status).toBe(200);
    expect((await t.call('GET', url, { cookie: petr })).status).toBe(404);
  });
});

describe('the PDF of a document of the person’s own files (the search)', () => {
  it('only from the person’s folder', async () => {
    ownFile(olgaId, 'Договор.odt');
    const url = `/app/api/files/file/preview?path=${encodeURIComponent('Договор.odt')}`;
    const res = await t.call('GET', url, { cookie: olga });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect((await t.call('GET', url, { cookie: petr })).status).toBe(404);
    expect((await t.call('GET', `/app/api/files/file/preview?path=${encodeURIComponent('../../etc/passwd')}`, { cookie: olga })).status).toBe(400);
  });
});

describe('a part of the PDF', () => {
  it('is always inside the file, or refused', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=2-', 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=10-12', 10)).toBe('invalid');
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), fc.string(), (size, header) => {
        const range = parseRange(`bytes=${header}`, size);
        if (range === null || range === 'invalid') return;
        expect(range.start).toBeGreaterThanOrEqual(0);
        expect(range.start).toBeLessThanOrEqual(range.end);
        expect(range.end).toBeLessThan(size);
      }),
    );
  });
});
