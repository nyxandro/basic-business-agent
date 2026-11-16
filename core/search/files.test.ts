import { chmodSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listProjects } from '../projects/projects.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { filesRoot } from '../workspace/layout.ts';
import { recentFiles, searchFiles } from './files.ts';
import { inSearch } from './match-sql.ts';
import { queryVariants } from './variants.ts';

let t: TestApp;
let olgaId: string;
let petrId: string;
let olga: string;
let tender: string;

const deps = () => ({ db: t.db, memory: t.memory, workspaceRoot: t.workspaceRoot });
function put(root: string, path: string, minutesAgo = 0): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, 'x');
  const at = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(full, at, at);
}
async function find(userId: string, q: string) {
  const projects = (await listProjects(deps(), userId)).projects;
  const words = await queryVariants(t.db, q);
  return inSearch(t.db, (client) => searchFiles(deps(), client, userId, words, projects));
}
const names = async (userId: string, q: string) => (await find(userId, q)).files.map((f) => f.name);
const recent = async (userId: string) => recentFiles(deps(), userId, (await listProjects(deps(), userId)).projects);

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
  olga = await t.signIn('olga@example.com');
  tender = ((await (await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Тендер ЖК Северный', access: { mode: 'private', departmentIds: [], userIds: [] } } })).json()) as { id: string }).id;
  const project = filesRoot(t.workspaceRoot, olgaId, tender);
  put(project, 'KP_Yelka_v2.pdf', 30);
  put(project, 'расчёты/Бюджет 2026.xlsx', 20);
  for (const junk of ['build_yelka.js', 'document.xml', 'slide-2.jpg', '.renders/page-1.png']) put(project, junk, 1);
  put(filesRoot(t.workspaceRoot, olgaId, null), 'Договор поставки.docx', 10);
  put(filesRoot(t.workspaceRoot, olgaId, null), 'Margin.xlsx', 40);
  put(filesRoot(t.workspaceRoot, olgaId, null), 'КП-12 бетон.pdf', 41);
  put(filesRoot(t.workspaceRoot, olgaId, null), 'КП-21 бетон.pdf', 42);
});
afterAll(async () => {
  await t.close();
});

describe('files the person finds by name (spec, section 8.21)', () => {
  it('finds documents by Russian, Latin, the other layout and a typo, with their project or none', async () => {
    const [kp] = (await find(olgaId, 'кп ёлка')).files;
    expect(kp).toMatchObject({ name: 'KP_Yelka_v2.pdf', path: 'KP_Yelka_v2.pdf', projectId: tender, bytes: 1 });
    expect(await names(olgaId, 'dogovor')).toEqual(['Договор поставки.docx']);
    expect((await find(olgaId, 'dogovor')).files[0]!.projectId).toBeNull();
    expect((await find(olgaId, ',.l;tn')).files.map((f) => f.path)).toEqual(['расчёты/Бюджет 2026.xlsx']);
    expect(await names(olgaId, 'дговор')).toEqual(['Договор поставки.docx']);
    expect(await names(olgaId, 'ёлка pdf')).toEqual(['KP_Yelka_v2.pdf']);
  });

  it('finds a short word’s Latin only at the start of a word, and a code exactly', async () => {
    expect(await names(olgaId, 'кп ёлка')).toEqual(['KP_Yelka_v2.pdf']);
    // «кп» is «kp» in Latin: «KP_Yelka» and «КП-12», never «Margin» or the «rg» of the other layout.
    expect(await names(olgaId, 'кп')).toEqual(['KP_Yelka_v2.pdf', 'КП-12 бетон.pdf', 'КП-21 бетон.pdf']);
    expect(await names(olgaId, 'кп-12')).toEqual(['КП-12 бетон.pdf']);
  });

  it('never finds the working files of the agent: scripts, parts of documents, pictures, hidden folders', async () => {
    for (const q of ['build', 'yelka', 'document', 'slide', 'page']) expect(await names(olgaId, q)).not.toEqual(expect.arrayContaining(['build_yelka.js', 'document.xml', 'slide-2.jpg', 'page-1.png']));
  });

  it('shows a colleague the files of a project opened to them and never anyone’s own files', async () => {
    expect(await names(petrId, 'кп')).toEqual([]);
    await t.call('PUT', `/app/api/projects/${tender}/access`, { cookie: olga, body: { mode: 'list', departmentIds: [], userIds: [petrId] } });
    expect(await names(petrId, 'кп')).toEqual(['KP_Yelka_v2.pdf']);
    expect(await names(petrId, 'договор')).toEqual([]);
    await t.call('PUT', `/app/api/projects/${tender}/access`, { cookie: olga, body: { mode: 'private', departmentIds: [], userIds: [] } });
    expect(await names(petrId, 'кп')).toEqual([]);
  });

  it('gives the newest documents first and says when there are more', async () => {
    const page = await recent(olgaId);
    expect(page.files.map((f) => f.name)).toEqual(['Договор поставки.docx', 'Бюджет 2026.xlsx', 'KP_Yelka_v2.pdf', 'Margin.xlsx', 'КП-12 бетон.pdf', 'КП-21 бетон.pdf']);
    expect(page.more).toBe(false);
  });

  it('leaves out a project folder it cannot read and says so, the rest is found', async () => {
    const shut = ((await (await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Закрытый', access: { mode: 'private', departmentIds: [], userIds: [] } } })).json()) as { id: string }).id;
    const root = filesRoot(t.workspaceRoot, olgaId, shut);
    put(root, 'Смета закрытая.pdf');
    put(root, 'внутри/Отчёт.pdf');
    const errors = vi.spyOn(console, 'error');
    chmodSync(join(root, 'внутри'), 0o000);
    try {
      const found = await find(olgaId, 'договор');
      expect(found.files.map((f) => f.name)).toEqual(['Договор поставки.docx']);
      expect(found.unreadable).toEqual([{ projectId: shut, name: 'Закрытый' }]);
      expect(errors.mock.calls.some(([line]) => String(line).includes('search_files_folder_failed') && String(line).includes('EACCES'))).toBe(true);
    } finally {
      chmodSync(join(root, 'внутри'), 0o755);
      errors.mockRestore();
    }
  });

  it('does not find the files of an archived project', async () => {
    const old = ((await (await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Старый', access: { mode: 'private', departmentIds: [], userIds: [] } } })).json()) as { id: string }).id;
    put(filesRoot(t.workspaceRoot, olgaId, old), 'Акт сверки.pdf');
    expect(await names(olgaId, 'акт сверки')).toEqual(['Акт сверки.pdf']);
    await t.call('POST', `/app/api/projects/${old}/archive`, { cookie: olga });
    expect(await names(olgaId, 'акт сверки')).toEqual([]);
  });

  it('stops reading a folder at 5 000 documents and says so in the log', { timeout: 60_000 }, async () => {
    const big = ((await (await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Большой', access: { mode: 'private', departmentIds: [], userIds: [] } } })).json()) as { id: string }).id;
    const root = filesRoot(t.workspaceRoot, olgaId, big);
    for (let i = 0; i <= 5000; i++) put(root, `Документ ${i}.txt`);
    const log = vi.spyOn(console, 'log');
    try {
      const page = await recent(olgaId);
      expect(page.more).toBe(true);
      expect(log.mock.calls.some(([line]) => String(line).includes('search_files_capped') && String(line).includes(big))).toBe(true);
    } finally {
      log.mockRestore();
      await t.call('POST', `/app/api/projects/${big}/archive`, { cookie: olga });
    }
  });

  // M5 (16.11): 10 000 documents in 50 folders.
  it('M5: finds among 10 000 documents in 50 folders within the limit', { timeout: 120_000 }, async () => {
    const lena = await t.createUser({ email: 'lena@example.com', name: 'Лена' });
    const cookie = await t.signIn('lena@example.com');
    const words = ['смета', 'договор', 'акт', 'счёт', 'отчёт', 'накладная', 'КП', 'спецификация', 'график', 'расчёт'];
    for (let p = 0; p < 49; p++) {
      const id = ((await (await t.call('POST', '/app/api/projects', { cookie, body: { name: `Проект ${p}`, access: { mode: 'private', departmentIds: [], userIds: [] } } })).json()) as { id: string }).id;
      const root = filesRoot(t.workspaceRoot, lena, id);
      for (let f = 0; f < 200; f++) put(root, `${words[(p + f) % 10]} ${p}-${f}.pdf`);
    }
    for (let f = 0; f < 200; f++) put(filesRoot(t.workspaceRoot, lena, null), `${words[f % 10]} личное ${f}.docx`);
    // The first walk after writing 10 000 files reads a cold file system cache (325–444 ms, 16.11); a person
    // searches key after key, so the bound is for the walks after it.
    const cold = performance.now();
    await find(lena, 'смета');
    const timings: number[] = [];
    for (const q of ['договор', 'дговор 12-3', 'kp 7']) {
      const started = performance.now();
      await find(lena, q);
      timings.push(performance.now() - started);
    }
    console.log(`M5 timings: cold ${Math.round(performance.now() - cold - timings.reduce((a, b) => a + b, 0))}, then ${timings.map(Math.round).join(', ')} ms`);
    // The bound guards against a slowdown, as M3's: alone 128–164 ms (16.11); the full parallel `pnpm test`
    // loads the machine several times over.
    expect(Math.max(...timings)).toBeLessThan(800);
  });
});
