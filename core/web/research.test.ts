// The internet of an agent (spec, section 8.30): the agent gives the work to the researcher, which gets the task
// only — not the conversation —, searches and reads, and returns the answer with its sources; nothing of its own
// talk is kept. The search and the pages are fakes here; the gateway's search is tested in core/models/gateway.test.ts.
import { randomUUID } from 'node:crypto';
import { WEB_RESEARCH_TOOL, webResearchResultSchema } from '@bba/contracts';
import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeRequest } from '../models/fake-openai.ts';
import { REQUEST_KEYS } from '../run-context/request-keys.ts';
import { setMaskingKinds } from '../masking/settings.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import type { FetchedPage, PageReader } from './fetch.ts';
import { RESEARCH_MAX_STEPS } from './research.ts';
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
    // A failure that is not ours (the search answered with something that is not JSON).
    if (query === 'сломай поиск') return Promise.reject(new SyntaxError('Unexpected token < in JSON'));
    return Promise.resolve([HIT]);
  },
};
const reader: PageReader = {
  read: (address, offset): Promise<FetchedPage> => {
    opened.push(address);
    // A short link that leads to another site.
    const final = address === 'https://short.example/x' ? 'https://example.org/real' : address;
    return Promise.resolve({ address, final_address: final, title: 'Профнастил С21 — цены', kind: 'html', text: 'Профнастил С21: 520 ₽ за лист.', from: offset, to: offset + 30, total_chars: 30 });
  },
};

const isResearcher = (req: FakeRequest) => JSON.stringify(req.messages[0]?.content ?? '').includes('Ты — исследователь');
const call = (name: string, args: Record<string, unknown>) => ({ toolCalls: [{ name, args }] });

async function chat(threadId: string, text: string): Promise<string> {
  const body = { threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps: {} };
  const res = await t.app.request('/app/api/copilotkit/agent/sales/run', { method: 'POST', headers: { cookie: olga, origin: 'http://localhost:8080', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return res.text();
}

// The events of the chat stream, as the browser gets them.
const eventsOf = (stream: string) =>
  stream
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()) as { type: string; name?: string; value?: unknown; toolCallId?: string; toolCallName?: string; content?: string });

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
    const stream = await chat(threadId, 'Сколько стоит профнастил С21 в Екатеринбурге?');

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
    // The live block of the search (decision of the owner 20.11): every step of the researcher comes in the chat
    // stream at once, tied to the call of web_research; the result keeps the steps for a reload.
    const events = eventsOf(stream);
    const callId = events.find((e) => e.type === 'TOOL_CALL_START' && e.toolCallName === WEB_RESEARCH_TOOL)?.toolCallId;
    expect(callId).toBeTruthy();
    const steps = events.filter((e) => e.type === 'CUSTOM' && e.name === 'bba.web_progress').map((e) => e.value as { toolCallId: string; step: { kind: string; state: string; query?: string; host?: string; found?: number; title?: string } });
    expect(steps.every((s) => s.toolCallId === callId)).toBe(true);
    expect(steps.map((s) => `${s.step.kind}:${s.step.state}`)).toEqual(['search:running', 'search:done', 'page:running', 'page:done']);
    expect(steps[1]!.step).toMatchObject({ query: 'профнастил С21 цена Екатеринбург', found: 1 });
    expect(steps[3]!.step).toMatchObject({ host: 'example.com', title: 'Профнастил С21 — цены' });
    // The call comes the moment the agent makes it (decision of the owner 20.11: like Codex and Claude Code), before
    // the first step — not together with its result, or the block has nothing to hang on while the search runs.
    const startAt = events.findIndex((e) => e.type === 'TOOL_CALL_START' && e.toolCallId === callId);
    expect(startAt).toBeLessThan(events.findIndex((e) => e.type === 'CUSTOM' && e.name === 'bba.web_progress'));
    // The steps come before the result of the call.
    const resultAt = events.findIndex((e) => e.type === 'TOOL_CALL_RESULT' && e.toolCallId === callId);
    expect(events.findIndex((e) => e.type === 'CUSTOM' && e.name === 'bba.web_progress')).toBeLessThan(resultAt);
    // The steps are for the person's screen only: the browser gets them with the result, the model does not — now
    // and in the next turns, from the stored conversation (F35: only what was asked for comes back to the agent).
    const shown = events.find((e) => e.type === 'TOOL_CALL_RESULT' && e.toolCallId === callId)?.content;
    expect(webResearchResultSchema.parse(JSON.parse(shown ?? '')).steps).toHaveLength(2);
    expect(output).not.toContain('steps');
    expect(output).not.toContain('профнастил С21 цена Екатеринбург');
    t.model.script({ text: 'Пожалуйста.' });
    await chat(threadId, 'Спасибо');
    const next = JSON.stringify(t.model.requests.at(-1)!.messages);
    expect(next).toContain('520 ₽ за лист');
    expect(next).not.toContain('steps');
    // Nothing of the researcher in Mastra's memory.
    expect(Number((await t.db.query<{ n: string }>('SELECT count(*) AS n FROM mastra.mastra_threads')).rows[0]!.n)).toBe(threadsBefore);
  });

  it('shows a page read in parts once, the site a link led to, and a step that broke as failed', async () => {
    t.model.script(
      call(WEB_RESEARCH_TOOL, { task: 'Найди цены на профнастил С21' }),
      call('web_search', { query: 'сломай поиск' }),
      call('web_fetch', { address: 'https://example.com/c21' }),
      call('web_fetch', { address: 'https://example.com/c21', offset: 30 }),
      call('web_fetch', { address: 'https://short.example/x' }),
      { text: 'Профнастил С21 — 520 ₽ (https://example.com/c21, https://example.org/real).' },
      { text: 'Цена — 520 ₽.' },
    );
    const stream = await chat(randomUUID(), 'Сколько стоит профнастил С21?');
    const shown = webResearchResultSchema.parse(JSON.parse(eventsOf(stream).find((e) => e.type === 'TOOL_CALL_RESULT')?.content ?? ''));
    expect(shown.steps.map((s) => `${s.kind}:${s.state}:${s.kind === 'page' ? s.host : s.query}`)).toEqual(['search:failed:сломай поиск', 'page:done:example.com', 'page:done:example.org']);
    expect(shown.sources.map((s) => s.address)).toEqual(['https://example.com/c21', 'https://example.org/real']);
    expect(lastToolOutput(t.model.requests.at(-1))).toContain('https://example.org/real');
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
    const stream = await chat(randomUUID(), 'Найди в интернете то, чего нет');
    const output = lastToolOutput(t.model.requests.at(-1));
    expect(output).toContain('APP_WEB_RESEARCH_FAILED');
    // What was tried is for the person's screen, not for the model.
    expect(output).not.toContain('steps');
    const shown = eventsOf(stream).find((e) => e.type === 'TOOL_CALL_RESULT')?.content;
    expect(JSON.parse(shown ?? '')).toMatchObject({ code: 'APP_WEB_RESEARCH_FAILED', steps: expect.arrayContaining([expect.objectContaining({ kind: 'search', query: 'ещё раз' })]) });
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
  rc.set(REQUEST_KEYS.abilities, '{"web":true,"commands":true,"widgets":true}');
  return rc;
}
