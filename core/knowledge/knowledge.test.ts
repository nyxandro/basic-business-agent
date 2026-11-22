// The knowledge base (docs/specs/[20.11.2026]-knowledge-base.md, section 23): documents are read into fragments, the
// agent finds the right one by words in full force — forms, synonyms, typos, another script and layout, codes — with its
// document, section and edition; a department's documents only for its people (F3); the document whole is copied into
// the conversation's folder. Search by meaning is not built (owner 22.11, F4).
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { KbDocumentsResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { chatRoot } from '../workspace/layout.ts';
import { chunksOf, SHEET_ROWS } from './chunk.ts';
import { searchKnowledge } from './search.ts';

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
    expect((await top('C21 лист'))?.section).toBe('Регламент возвратов › Профнастил С21');
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

  it('adds synonyms of the company: «отгул» finds «выходной день»', async () => {
    await upload(igor, 'Порядок выходных.md', '# Порядок\n\nВыходной день за свой счёт предоставляется по заявлению за 3 дня.');
    await t.knowledge.indexer.idle();
    expect(await searchKnowledge(t.db, olgaId, 'отгул', null)).toEqual([]);
    expect((await t.call('POST', '/app/api/knowledge/synonyms', { cookie: igor, body: { words: ['отгул', 'выходной день'] } })).status).toBe(201);
    expect((await searchKnowledge(t.db, olgaId, 'отгул', null))[0]?.text).toContain('Выходной день');
    expect((await t.call('POST', '/app/api/knowledge/synonyms', { cookie: igor, body: { words: ['одно'] } })).status).toBe(400);
  });
});
