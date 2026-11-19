// The internet of an agent (spec, section 8.30): the agent gives the work to the researcher, which gets the task
// only — not the conversation —, searches and reads, and returns the answer with its sources; nothing of its own
// talk is kept. The search and the pages are fakes here; the gateway's search is tested in core/models/gateway.test.ts.
import { randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeRequest } from '../models/fake-openai.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { setMaskingKinds } from '../masking/settings.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import type { FetchedPage, PageReader } from './fetch.ts';
import { RESEARCH_MAX_STEPS, WEB_RESEARCH_TOOL } from './research.ts';
import type { SearchHit, WebSearcher } from './search.ts';

let t: TestApp;
let olga: string;
let olgaId: string;
const searched: string[] = [];
const opened: string[] = [];

const HIT: SearchHit = { title: 'Профнастил С21 — цены', address: 'https://example.com/c21', snippet: 'от 520 ₽', date: null };
const searcher: WebSearcher = {
  search: ({ query }) => {
    searched.push(query);
    return Promise.resolve([HIT]);
  },
};
const reader: PageReader = {
  read: (address, offset): Promise<FetchedPage> => {
    opened.push(address);
    return Promise.resolve({ address, final_address: address, title: 'Профнастил С21 — цены', kind: 'html', text: 'Профнастил С21: 520 ₽ за лист.', from: offset, to: offset + 30, total_chars: 30 });
  },
};

const isResearcher = (req: FakeRequest) => JSON.stringify(req.messages[0]?.content ?? '').includes('Ты — исследователь');
const call = (name: string, args: Record<string, unknown>) => ({ toolCalls: [{ name, args }] });

async function chat(threadId: string, text: string): Promise<void> {
  const body = { threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps: {} };
  const res = await t.app.request('/app/api/copilotkit/agent/sales/run', { method: 'POST', headers: { cookie: olga, origin: 'http://localhost:8080', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  await res.text();
}

const lastToolOutput = (req: FakeRequest | undefined) => JSON.stringify(req?.messages.filter((m) => m.role === 'tool').at(-1)?.content ?? '');

beforeAll(async () => {
  t = await createTestApp({ web: { searcher, reader } });
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  const sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [sales, olgaId]);
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('the researcher of the internet', () => {
  it('gets the task only, searches and reads, and gives back the answer with its sources; keeps nothing of its own', async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Здравствуйте, Ольга.' });
    await chat(threadId, 'Секретный договор с ООО «Ромашка» на 3 млн');
    const threadsBefore = Number((await t.db.query<{ n: string }>('SELECT count(*) AS n FROM mastra.mastra_threads')).rows[0]!.n);

    t.model.script(
      call(WEB_RESEARCH_TOOL, { task: 'Найди цены на профнастил С21 в Екатеринбурге, с адресами страниц' }),
      call('web_search', { query: 'профнастил С21 цена Екатеринбург' }),
      call('web_fetch', { address: 'https://example.com/c21' }),
      { text: 'Профнастил С21 — 520 ₽ за лист (https://example.com/c21).' },
      { text: 'Цена — 520 ₽ за лист, источник: example.com.' },
    );
    await chat(threadId, 'Сколько стоит профнастил С21 в Екатеринбурге?');

    const research = t.model.requests.filter(isResearcher);
    expect(research.length).toBe(3);
    // The researcher sees its instructions and the task — nothing of the conversation.
    expect(research[0]!.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(JSON.stringify(research[0]!.messages)).toContain('Найди цены на профнастил С21');
    expect(JSON.stringify(research.map((r) => r.messages))).not.toContain('Ромашка');
    expect((research[0]!.tools ?? []).map((tool) => tool.function.name).sort()).toEqual(['web_fetch', 'web_search']);
    expect(searched.at(-1)).toBe('профнастил С21 цена Екатеринбург');
    expect(opened.at(-1)).toBe('https://example.com/c21');

    const output = lastToolOutput(t.model.requests.at(-1));
    expect(output).toContain('520 ₽ за лист');
    expect(output).toContain('https://example.com/c21');
    expect(output).toContain('Профнастил С21 — цены');
    // The agent the person talks to has the errand, not the search itself.
    const parentTools = (t.model.requests.at(-1)!.tools ?? []).map((tool) => tool.function.name);
    expect(parentTools).toContain(WEB_RESEARCH_TOOL);
    expect(parentTools).not.toContain('web_search');
    // Nothing of the researcher in Mastra's memory.
    expect(Number((await t.db.query<{ n: string }>('SELECT count(*) AS n FROM mastra.mastra_threads')).rows[0]!.n)).toBe(threadsBefore);
  });

  it('sends no passport, SNILS or card to the internet: the task is refused before the researcher starts', async () => {
    // «Маскирование» of the organisation masks passports (the test app starts with none).
    await setMaskingKinds(t.db, olgaId, ['passport']);
    const before = t.model.requests.filter(isResearcher).length;
    t.model.script(call(WEB_RESEARCH_TOOL, { task: 'Что есть в интернете про паспорт 4510 123456' }), { text: 'Искать по паспорту нельзя.' });
    await chat(randomUUID(), 'Найди в интернете, что известно о паспорте 4510 123456');
    expect(t.model.requests.filter(isResearcher).length).toBe(before);
    expect(lastToolOutput(t.model.requests.at(-1))).toContain('APP_WEB_PERSONAL_DATA');
  });

  it('ends a researcher that has not answered in its calls of the model with a failure the agent explains', async () => {
    const lost = (req: FakeRequest) => (isResearcher(req) ? call('web_search', { query: 'ещё раз' }) : { text: 'лишний ответ' });
    t.model.script(call(WEB_RESEARCH_TOOL, { task: 'Найди то, чего нет' }), ...Array.from({ length: RESEARCH_MAX_STEPS }, () => lost), { text: 'Поиск не получился.' });
    await chat(randomUUID(), 'Найди в интернете то, чего нет');
    expect(lastToolOutput(t.model.requests.at(-1))).toContain('APP_WEB_RESEARCH_FAILED');
  });

  it('stops with the run: a stopped run does not start the researcher', async () => {
    const before = t.model.requests.length;
    const { web_research: tool } = (await t.mastra.getAgent('sales').listTools({ requestContext: contextOf() })) as Record<string, { execute: (input: unknown, ctx: unknown) => Promise<unknown> }>;
    await expect(tool!.execute({ task: 'Найди цены' }, { requestContext: contextOf(), abortSignal: AbortSignal.abort() })).rejects.toThrow();
    expect(t.model.requests.length).toBe(before);
  });
});

function contextOf(): RequestContext {
  const rc = new RequestContext();
  rc.set(REQUEST_KEYS.userId, olgaId);
  rc.set(REQUEST_KEYS.threadId, randomUUID());
  rc.set(REQUEST_KEYS.agentId, 'sales');
  rc.set(REQUEST_KEYS.modelId, 'test-paid');
  rc.set(REQUEST_KEYS.runKind, 'chat');
  rc.set(REQUEST_KEYS.skillPaths, '[]');
  rc.set(REQUEST_KEYS.abilities, '{"web":true,"commands":true}');
  return rc;
}
