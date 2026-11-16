import { randomUUID } from 'node:crypto';
import type { SearchResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureThread } from '../memory/memory.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let olgaId: string;
let petrId: string;
let olga: string;

type Part = { type: 'text'; text: string } | { type: 'tool-invocation'; toolInvocation: { state: 'result'; toolCallId: string; toolName: string; args: unknown; result: unknown } };

async function conversation(userId: string, title: string, turns: [role: 'user' | 'assistant', parts: Part[]][], agentId = 'sales'): Promise<string> {
  const threadId = randomUUID();
  await ensureThread(t.memory, { threadId, resourceId: userId, agentId, kind: 'chat', title });
  await t.memory.saveMessages({
    messages: turns.map(([role, parts], i) => ({ id: randomUUID(), threadId, resourceId: userId, role, createdAt: new Date(Date.now() + i), content: { format: 2 as const, parts } })),
  });
  return threadId;
}

const text = (value: string): Part => ({ type: 'text', text: value });
const search = async (q: string, extra = '') => (await (await t.call('GET', `/app/api/search?q=${encodeURIComponent(q)}${extra}`, { cookie: olga })).json()) as SearchResponse;

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('search', () => {
  it('finds a conversation when every word is in its title or in any of its messages, with a piece of text around the match', async () => {
    const id = await conversation(olgaId, 'Договор поставки', [
      ['user', [text('Проверь договор на риски')]],
      ['assistant', [text('В разделе 7 штраф 0,1% в день. Поставщик — ООО Стройресурс, срок — 10 дней после оплаты.')]],
    ]);
    await conversation(olgaId, 'Другое', [['user', [text('Сводка по воронке')]]]);
    const found = await search('договор стройресурс');
    expect(found.threads.map((x) => x.id)).toEqual([id]);
    expect(found.threads[0]).toMatchObject({ title: 'Договор поставки', agentId: 'sales', projectId: null });
    expect(found.threads[0]!.snippet).toContain('Стройресурс');
    expect(found.threads[0]!.snippet.length).toBeLessThanOrEqual(130);
  });

  it('shows the agent’s answer in the piece of text as the chat does, without Markdown', async () => {
    await conversation(olgaId, 'Что ты умеешь', [
      ['user', [text('Что ты умеешь?')]],
      ['assistant', [text('Вот что я реально умею. **Из инструментов:**\n1. **Заметки** — вести персональные заметки\n\n| Что | Где |\n|---|---|\n| Счета | `bills/` |')]],
    ]);
    const [found] = (await search('заметки')).threads;
    expect(found!.snippet).toBe('Вот что я реально умею. Из инструментов: Заметки — вести персональные заметки Что Где Счета bills/');
  });

  it('reads only the text of the person and the agent: not tool results, not the service words of the stored format', async () => {
    await conversation(olgaId, 'Сделки', [
      ['user', [text('Покажи сделки')]],
      ['assistant', [{ type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'c1', toolName: 'crm_deals', args: {}, result: { rows: ['ООО Секретный-Клиент'] } } }, text('Вот сделки.')]],
    ]);
    expect((await search('Секретный')).threads).toEqual([]);
    expect((await search('format')).threads).toEqual([]);
    expect((await search('parts')).threads).toEqual([]);
  });

  it('never shows someone else’s conversation and takes % and _ as plain characters', async () => {
    await conversation(petrId, 'Арматура', [['user', [text('Смета по арматуре А500С')]]]);
    expect((await search('арматур')).threads).toEqual([]);
    const pct = await conversation(olgaId, 'Скидки', [['user', [text('Скидка 10% на бетон')]]]);
    expect((await search('10%')).threads.map((x) => x.id)).toEqual([pct]);
    expect((await search('1_%')).threads).toEqual([]);
  });

  it('finds projects by name with their conversation count', async () => {
    const project = (await (await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Тендер ЖК Северный', access: { mode: 'private', departmentIds: [], userIds: [] } } })).json()) as { id: string };
    const inProject = await conversation(olgaId, 'Смета по тендеру', [['user', [text('Смета для тендера')]]]);
    await t.call('PUT', `/app/api/threads/${inProject}/project`, { cookie: olga, body: { projectId: project.id } });
    await conversation(olgaId, 'Тендер другой', [['user', [text('Ещё тендер')]]]);

    const all = await search('тендер');
    expect(all.projects).toEqual([{ id: project.id, name: 'Тендер ЖК Северный', threadCount: 1, shared: false, ownerName: null }]);
    expect(all.threads).toHaveLength(2);
    expect((await search('тендер', '&scope=projects')).threads).toEqual([]);
    expect((await search('тендер', '&scope=threads')).projects).toEqual([]);
    expect(all.threads.find((x) => x.id === inProject)?.projectId).toBe(project.id);
  });

  it('refuses a query shorter than 2 characters', async () => {
    expect((await t.call('GET', '/app/api/search?q=a', { cookie: olga })).status).toBe(400);
  });

  // M3 (14.11): 190–300 ms on 50 000 messages of one person — far more than a real person has.
  // The bound guards against a slowdown; above 300 ms the server writes search_slow to the log.
  it('M3: answers on 50 000 messages of one person within the limit', { timeout: 120_000 }, async () => {
    const lena = await t.createUser({ email: 'lena@example.com', name: 'Лена' });
    const cookie = await t.signIn('lena@example.com');
    const words = ['сделка', 'поставка', 'бетон', 'арматура', 'смета', 'счёт', 'договор', 'клиент', 'оплата', 'доставка'];
    for (let c = 0; c < 500; c++) {
      const threadId = randomUUID();
      await ensureThread(t.memory, { threadId, resourceId: lena, agentId: 'sales', kind: 'chat', title: `Разговор ${c}` });
      await t.memory.saveMessages({
        messages: Array.from({ length: 100 }, (_, i) => ({
          id: randomUUID(),
          threadId,
          resourceId: lena,
          role: (i % 2 ? 'assistant' : 'user'),
          createdAt: new Date(Date.now() + i),
          content: { format: 2 as const, parts: [text(`${words[(c + i) % 10]} номер ${c}-${i}: обычный текст сообщения о работе отдела продаж`)] },
        })),
      });
    }
    const timings: number[] = [];
    for (const q of ['бетон 250-7', 'договор', 'оплата 120-33']) {
      const started = performance.now();
      const res = await t.call('GET', `/app/api/search?q=${encodeURIComponent(q)}`, { cookie });
      timings.push(performance.now() - started);
      expect(res.status).toBe(200);
    }
    console.log(`M3 timings: ${timings.map(Math.round).join(', ')} ms`);
    expect(Math.max(...timings)).toBeLessThan(800);
  });
});
