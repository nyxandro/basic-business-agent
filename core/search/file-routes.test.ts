import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SearchFiles, SearchFileStatus, SearchResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { filesRoot } from '../workspace/layout.ts';

let t: TestApp;
let olga: string;
let petr: string;
let project: string;

function put(root: string, path: string, body = 'x'): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
const get = (path: string, cookie = olga) => t.call('GET', path, { cookie });
const json = async <T>(res: Response) => (await res.json()) as T;

beforeAll(async () => {
  t = await createTestApp();
  const olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
  project = (await json<{ id: string }>(await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Тендер ЖК Северный', access: { mode: 'private', departmentIds: [], userIds: [] } } }))).id;
  put(filesRoot(t.workspaceRoot, olgaId, project), 'KP_Yelka_v2.pdf', '%PDF-1.4');
  put(filesRoot(t.workspaceRoot, olgaId, project), 'Смета.xlsx');
  put(filesRoot(t.workspaceRoot, olgaId, null), 'Договор поставки.docx');
});
afterAll(async () => {
  await t.close();
});

describe('addresses of the file search (spec, section 8.21)', () => {
  it('finds files with scope «files» and «all», not with the others', async () => {
    const files = await json<SearchResponse>(await get(`/app/api/search?q=${encodeURIComponent('кп ёлка')}&scope=files`));
    expect(files.files.files.map((f) => f.name)).toEqual(['KP_Yelka_v2.pdf']);
    expect(files.threads).toEqual([]);
    expect((await json<SearchResponse>(await get(`/app/api/search?q=dogovor`))).files.files.map((f) => f.name)).toEqual(['Договор поставки.docx']);
    expect((await json<SearchResponse>(await get(`/app/api/search?q=dogovor&scope=threads`))).files.files).toEqual([]);
  });

  it('gives the newest documents for the tab «Файлы»', async () => {
    const recent = await json<SearchFiles>(await get('/app/api/search/files'));
    expect(recent.files.map((f) => f.name).sort()).toEqual(['KP_Yelka_v2.pdf', 'Договор поставки.docx', 'Смета.xlsx']);
    expect((await json<SearchFiles>(await get('/app/api/search/files', petr))).files).toEqual([]);
  });

  it('tells whether a found file is there, in the project trash or gone', async () => {
    const status = async (query: string, cookie = olga) => json<SearchFileStatus>(await get(`/app/api/files/status?${query}`, cookie));
    expect(await status(`path=${encodeURIComponent('Договор поставки.docx')}`)).toEqual({ state: 'ok' });
    expect(await status(`path=${encodeURIComponent('Нет такого.docx')}`)).toEqual({ state: 'deleted', name: 'Нет такого.docx' });
    expect(await status(`projectId=${project}&path=KP_Yelka_v2.pdf`)).toEqual({ state: 'ok' });
    await t.call('DELETE', `/app/api/projects/${project}/file?path=${encodeURIComponent('Смета.xlsx')}`, { cookie: olga });
    expect(await status(`projectId=${project}&path=${encodeURIComponent('Смета.xlsx')}`)).toMatchObject({ state: 'trash', name: 'Смета.xlsx', projectId: project });
    expect((await get(`/app/api/files/status?projectId=${project}&path=KP_Yelka_v2.pdf`, petr)).status).toBe(404);
  });

  it('downloads one’s own file, opens a PDF in place only when asked, and refuses paths out of the folder', async () => {
    const own = await get(`/app/api/files/file?path=${encodeURIComponent('Договор поставки.docx')}`);
    expect(own.status).toBe(200);
    expect(own.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect((await get(`/app/api/files/file?path=${encodeURIComponent('Договор поставки.docx')}&inline=1`)).headers.get('content-disposition')).toMatch(/^attachment;/);
    const pdf = await get(`/app/api/projects/${project}/file?path=KP_Yelka_v2.pdf&inline=1`);
    expect(pdf.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect((await get(`/app/api/projects/${project}/file?path=KP_Yelka_v2.pdf`)).headers.get('content-disposition')).toMatch(/^attachment;/);
    expect((await get(`/app/api/files/file?path=${encodeURIComponent('../x.docx')}`)).status).toBe(400);
    expect((await get(`/app/api/files/file?path=${encodeURIComponent('Нет такого.docx')}`)).status).toBe(404);
    // Пётр's own folder has no such file: nobody reaches another person's own folder.
    expect((await get(`/app/api/files/file?path=${encodeURIComponent('Договор поставки.docx')}`, petr)).status).toBe(404);
  });
});
