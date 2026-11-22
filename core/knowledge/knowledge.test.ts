// The knowledge base (docs/specs/[20.11.2026]-knowledge-base.md, section 23): documents are read into fragments, the
// agent finds the right one by words in full force — forms, synonyms, typos, another script and layout, codes — with its
// document, section and edition; a department's documents only for its people (F3); the document whole is copied into
// the conversation's folder. Search by meaning is not built (owner 22.11, F4).
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { KbDocumentsResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { chatRoot } from '../workspace/layout.ts';
import { chunksOf, SHEET_ROWS } from './chunk.ts';
import { FRAGMENT_CHARS, searchKnowledge } from './search.ts';

let t: TestApp;
let igor: string;
let olgaId: string;
let olga: string;
let mariaId: string;
let maria: string;
let sales: string;
let hr: string;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function upload(cookie: string, name: string, text: string, department?: string): Promise<{ status: number; id?: string }> {
  const form = new FormData();
  form.append('file', new File([text], name, { type: 'text/plain' }));
  const res = await t.app.request(`/app/api/knowledge/documents${department ? `?department=${department}` : ''}`, { method: 'POST', headers: { cookie }, body: form });
  const body = (await res.json()) as { id?: string };
  return { status: res.status, ...(body.id ? { id: body.id } : {}) };
}

const RETURNS = `# Регламент возвратов

## Сроки возврата

Возврат возможен в течение 14 дней с момента покупки при сохранении упаковки.

Исключение — брак: 30 дней.

## Профнастил С21

Профнастил С21 оцинкованный, лист 1150 мм. Отгрузка со склада в течение 3 дней.`;

const BONUS = `# Положение о премировании

## Квартальная премия

Квартальная премия — до 20 % оклада по итогам KPI.`;

beforeAll(async () => {
  t = await createTestApp();
  await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  hr = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Отдел кадров') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales'), ($2, 'sales')`, [sales, hr]);
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга', departmentIds: [sales] });
  const keeper = (await t.db.query<{ id: string }>(`INSERT INTO app.roles (name, permissions) VALUES ('Документы отдела', '["documents.department.manage"]') RETURNING id`)).rows[0]!.id;
  mariaId = await t.createUser({ email: 'maria@example.com', name: 'Мария', departmentIds: [hr], roleIds: [await t.roleId('employee'), keeper] });
  igor = await t.signIn('igor@example.com');
  olga = await t.signIn('olga@example.com');
  maria = await t.signIn('maria@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('the fragments of a document', () => {
  it('follow the headings of a text, and the rows of a sheet with its header', () => {
    const chunks = chunksOf('word', RETURNS);
    expect(chunks.map((c) => c.section)).toEqual(['Регламент возвратов › Сроки возврата', 'Регламент возвратов › Профнастил С21']);
    expect(chunks[0]!.text).toContain('14 дней');
    const rows = Array.from({ length: 100 }, (_, i) => `Позиция ${i},${i * 10}`);
    const sheet = chunksOf('sheet', `## Прайс\nНаименование,Цена\n${rows.join('\n')}`);
    expect(sheet).toHaveLength(Math.ceil(100 / SHEET_ROWS));
    expect(sheet.every((c) => c.text.startsWith('Наименование,Цена') && c.section === 'Прайс')).toBe(true);
    const pdf = chunksOf('pdf', '— стр. 1 —\nПервая страница.\n\n— стр. 2: без текста (картинка или скан) —\n\n— стр. 3 —\nТретья.');
    expect(pdf.map((c) => c.page)).toEqual([1, 3]);
  });

  // The independent review of 22.11: no fragment is longer than what the agent is shown.
  it('cut a long paragraph, a wide sheet and a page without blank lines into pieces the agent sees whole', () => {
    const long = Array.from({ length: 80 }, (_, i) => `Пункт ${i} регламента о порядке возврата товара покупателем.`).join(' ');
    const page = Array.from({ length: 90 }, (_, i) => `Строка ${i} страницы прайса без пустых строк`).join('\n');
    const wide = Array.from({ length: 40 }, (_, i) => `Позиция ${i},${'описание товара очень подробное '.repeat(4)},${i * 10}`).join('\n');
    for (const chunks of [chunksOf('word', `# Раздел\n\n${long}`), chunksOf('pdf', `— стр. 1 —\n${page}`), chunksOf('sheet', `## Прайс\nНаименование,Описание,Цена\n${wide}`)]) {
      expect(chunks.length).toBeGreaterThan(1);
      expect(Math.max(...chunks.map((c) => c.text.length))).toBeLessThanOrEqual(FRAGMENT_CHARS);
    }
    expect(chunksOf('sheet', `## Прайс\nНаименование,Описание,Цена\n${wide}`).every((c) => c.text.startsWith('Наименование,Описание,Цена'))).toBe(true);
  });

  it('follow the slides of a presentation, its number as the page and its notes inside', () => {
    const deck = '<!-- Slide number: 1 -->\n# Цены\nПрофнастил С21 — 495 ₽\n\n### Notes:\nНе называть скидку\n\n<!-- Slide number: 2 -->\nСроки отгрузки — 3 дня';
    const chunks = chunksOf('slides', deck);
    expect(chunks.map((c) => [c.page, c.section])).toEqual([
      [1, 'Цены'],
      [2, null],
    ]);
    expect(chunks[0]!.text).toContain('Не называть скидку');
    expect(chunks[1]!.text).not.toContain('Slide number');
  });
});

describe('the knowledge base', () => {
  let returns: string;

  it('is kept with «Документы организации» or «Документы отдела» of one’s own department', async () => {
    expect((await upload(olga, 'Регламент возвратов.md', RETURNS)).status).toBe(403);
    const up = await upload(igor, 'Регламент возвратов.md', RETURNS);
    expect(up.status).toBe(201);
    returns = up.id!;
    expect((await upload(igor, 'Копия.md', RETURNS)).status).toBe(409);
    expect((await upload(maria, 'Положение о премировании.md', BONUS, sales)).status).toBe(403);
    expect((await upload(maria, 'Положение о премировании.md', BONUS, hr)).status).toBe(201);
    await t.knowledge.indexer.idle();
    const listed = await json<KbDocumentsResponse>(await t.call('GET', '/app/api/knowledge/documents', { cookie: igor }));
    expect(listed.documents[0]).toMatchObject({ title: 'Регламент возвратов', status: 'ready', currentVersion: 1, chunks: 2 });
    expect((await t.call('PATCH', `/app/api/knowledge/documents/${returns}`, { cookie: igor, body: { editionDate: '2026-03-12' } })).status).toBe(200);
  });

  it('finds the right fragment by words in full force — synonyms, typos, another script and layout, codes', async () => {
    const top = async (q: string) => (await searchKnowledge(t.db, olgaId, q, null))[0];
    expect(await top('рекламация срок дней')).toMatchObject({ document: 'Регламент возвратов', section: 'Регламент возвратов › Сроки возврата', edition: '12.03.2026' });
    expect((await top('вазврат товара'))?.text).toContain('14 дней');
    expect((await top('vozvrat'))?.text).toContain('14 дней');
    expect((await top('djpdhfn'))?.text).toContain('14 дней');
    expect((await top('C21'))?.section).toBe('Регламент возвратов › Профнастил С21');
    expect((await top('С-21'))?.section).toBe('Регламент возвратов › Профнастил С21');
    // A question mark or a comma does not switch off synonyms, typos and the layout of the word.
    expect((await top('рекламация?'))?.text).toContain('14 дней');
    expect((await top('djpdhfn,'))?.text).toContain('14 дней');
  });

  it('shows a department’s documents only to its people, also to its agent (F3)', async () => {
    expect(await searchKnowledge(t.db, olgaId, 'квартальная премия', null)).toEqual([]);
    expect((await searchKnowledge(t.db, mariaId, 'квартальная премия', null))[0]).toMatchObject({ document: 'Положение о премировании' });
    expect((await searchKnowledge(t.db, mariaId, 'возврат', null))[0]).toMatchObject({ document: 'Регламент возвратов' });
    // The department's base is not lost with the department.
    expect((await t.call('DELETE', `/app/api/admin/departments/${hr}`, { cookie: igor })).status).toBe(409);
  });

  it('gives the agent the search and the document whole, and names the documents in its prompt', async () => {
    const threadId = randomUUID();
    t.model.script({ toolCalls: [{ name: 'knowledge_search', args: { query: 'рекламация срок' } }] }, { toolCalls: [{ name: 'knowledge_open', args: { docId: returns } }] }, { text: 'По «Регламенту возвратов» — 14 дней.' });
    const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', { cookie: olga, body: { threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: 'Можно ли вернуть товар через 20 дней?' }], tools: [], context: [], state: {}, forwardedProps: {} } });
    expect(res.status).toBe(200);
    await res.text();
    const system = JSON.stringify(t.model.requests.at(0)!.messages.filter((m) => m.role === 'system'));
    expect(system).toContain('# База знаний организации');
    expect(system).toContain('- Регламент возвратов');
    expect(system).not.toContain('Положение о премировании');
    const sent = JSON.stringify(t.model.requests.at(-1)!.messages);
    expect(sent).toContain('Возврат возможен в течение 14 дней');
    expect(existsSync(join(chatRoot(t.workspaceRoot, olgaId, threadId), '.work', 'knowledge', 'Регламент возвратов.md'))).toBe(true);
  }, 30_000);

  it('a new version is searched once read; a removed document is found no more', async () => {
    const form = new FormData();
    form.append('file', new File([RETURNS.replace('14 дней', '21 день')], 'Регламент возвратов.md'));
    expect((await t.app.request(`/app/api/knowledge/documents/${returns}/versions`, { method: 'POST', headers: { cookie: igor }, body: form })).status).toBe(200);
    await t.knowledge.indexer.idle();
    expect((await searchKnowledge(t.db, olgaId, 'срок возврата', null))[0]?.text).toContain('21 день');
    expect((await t.call('DELETE', `/app/api/knowledge/documents/${returns}`, { cookie: igor })).status).toBe(200);
    expect(await searchKnowledge(t.db, olgaId, 'срок возврата', null)).toEqual([]);
    expect((await t.db.query(`SELECT 1 FROM app.kb_words WHERE word = 'возврат'`)).rowCount).toBe(0);
  });

  // The review of 22.11: one document that cannot be read never stops the reading of the others.
  it('refuses a document that keeps failing and reads the next one', async () => {
    // Hex does not compress: the word is over the size of an index row of Postgres.
    const word = randomBytes(1600).toString('hex');
    const bad = await upload(igor, 'Ключи.txt', `# Ключи\n\n${word}`);
    const good = await upload(igor, 'Памятка.md', '# Памятка\n\nПропуск выдаёт охрана на первом этаже.');
    await t.knowledge.indexer.idle();
    const listed = await json<KbDocumentsResponse>(await t.call('GET', '/app/api/knowledge/documents', { cookie: igor }));
    expect(listed.documents.find((d) => d.id === good.id)).toMatchObject({ status: 'ready' });
    expect(listed.documents.find((d) => d.id === bad.id)?.status).not.toBe('pending');
    expect((await searchKnowledge(t.db, olgaId, 'пропуск охрана', null))[0]?.document).toBe('Памятка');
  });

  it('gives an earlier version of a file only to the one who keeps the base', async () => {
    const up = await upload(igor, 'Тарифы.md', '# Тарифы\n\nДоставка по городу — 500 ₽.');
    await t.knowledge.indexer.idle();
    const form = new FormData();
    form.append('file', new File(['# Тарифы\n\nДоставка по городу — 700 ₽.'], 'Тарифы.md'));
    await t.app.request(`/app/api/knowledge/documents/${up.id}/versions`, { method: 'POST', headers: { cookie: igor }, body: form });
    await t.knowledge.indexer.idle();
    expect((await t.call('GET', `/app/api/knowledge/documents/${up.id}/file`, { cookie: olga })).status).toBe(200);
    expect((await t.call('GET', `/app/api/knowledge/documents/${up.id}/file?version=1`, { cookie: olga })).status).toBe(404);
    expect(await (await t.call('GET', `/app/api/knowledge/documents/${up.id}/file?version=1`, { cookie: igor })).text()).toContain('500 ₽');
  });

  it('answers a wrong address with a code, not a server failure', async () => {
    expect((await t.call('GET', '/app/api/knowledge/documents?department=nope', { cookie: igor })).status).toBe(404);
    expect((await upload(igor, 'Ничей.md', '# Ничей', randomUUID())).status).toBe(404);
    expect((await t.call('DELETE', '/app/api/knowledge/synonyms/not-a-uuid', { cookie: igor })).status).toBe(404);
    expect((await t.call('GET', `/app/api/knowledge/documents/${randomUUID()}/file?version=99999999999`, { cookie: igor })).status).toBe(400);
  });

  it('adds synonyms of the company: «отгул» finds «выходной день»', async () => {
    await upload(igor, 'Порядок выходных.md', '# Порядок\n\nВыходной день за свой счёт предоставляется по заявлению за 3 дня.');
    await t.knowledge.indexer.idle();
    expect(await searchKnowledge(t.db, olgaId, 'отгул', null)).toEqual([]);
    expect((await t.call('POST', '/app/api/knowledge/synonyms', { cookie: igor, body: { words: ['отгул', 'выходной день'] } })).status).toBe(201);
    expect((await searchKnowledge(t.db, olgaId, 'отгул', null))[0]?.text).toContain('Выходной день');
    expect((await t.call('POST', '/app/api/knowledge/synonyms', { cookie: igor, body: { words: ['одно'] } })).status).toBe(400);
  });
});
