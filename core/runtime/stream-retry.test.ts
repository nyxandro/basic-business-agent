// A model answer that broke after it started (spec, section 9.1): the agent built by the core asks
// the model once more, the new answer goes out as a new message and the chat is told which message
// to take off the screen. The break comes as LiteLLM sends it inside the stream (gateway.test.ts
// checks that through the test LiteLLM).
import type { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toHistory } from '../chat/history.ts';
import { migrate } from '../db/migrate.ts';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import type { AgentRuntime } from '../loader/registry.ts';
import { createMemory } from '../memory/memory.ts';
import { startFakeModel, type FakeModel, type FakeTurn, type GatewayStreamError } from '../models/fake-openai.ts';
import { createMastraAgent, FALLBACK_FIRST_CHUNK_MS, MODEL_CALL_MAX_MS } from './agent-factory.ts';
import { REQUEST_KEYS } from './request-keys.ts';

const ANSWER = 'Привет! Чем помочь?';
// What LiteLLM sent when Groq closed the connection after «Пр» (dev conversation of 15.11).
const BREAK: GatewayStreamError = { message: 'litellm.APIConnectionError: APIConnectionError: GroqException - Connection closed.', type: 'internal_server_error', param: null, code: '500' };
const TOO_LONG: GatewayStreamError = { message: 'litellm.BadRequestError: Please reduce the length of the messages or completion.', type: 'invalid_request_error', param: 'messages', code: '400' };

let database: TestDatabase;
let memory: Memory;

function buildAgent(models: Record<string, string>, stepMs = MODEL_CALL_MAX_MS): Agent {
  const rt: AgentRuntime = {
    passport: { id: 'assistant', name: 'Помощник', description: 'x', plugins: [], readOnly: [], starters: [] },
    dir: '/x',
    instructions: 'Ты помощник.',
    tools: {},
    readOnly: new Set(),
    subagents: [],
    connectorIds: [],
    toolSystems: {},
  };
  return createMastraAgent(rt, {
    gateway: { modelConfig: (modelId) => Promise.resolve({ providerId: 'fake', modelId, url: models[modelId]!, apiKey: 'x', headers: {} }) },
    firstChunkMs: FALLBACK_FIRST_CHUNK_MS,
    stepMs,
    memory,
    processorsFor: () => ({ input: [], output: [] }),
  });
}

interface Outcome {
  text: string;
  error: unknown;
  discarded: string[];
  // Ids of the response messages as the stream announced its steps.
  stepMessageIds: string[];
}

async function answer(agent: Agent, threadId: string, opts: { fallback?: boolean } = {}): Promise<Outcome> {
  const discarded: string[] = [];
  const rc = new RequestContext();
  rc.set(REQUEST_KEYS.userId, 'igor');
  rc.set(REQUEST_KEYS.modelId, 'main');
  if (opts.fallback) rc.set(REQUEST_KEYS.fallbackModelId, 'spare');
  rc.set(REQUEST_KEYS.threadId, threadId);
  rc.set(REQUEST_KEYS.skillPaths, '[]');
  rc.set(REQUEST_KEYS.messageDiscarded, (messageId: string) => discarded.push(messageId));
  const out = await agent.stream('привет', { memory: { thread: threadId, resource: 'igor' }, requestContext: rc });
  const stepMessageIds: string[] = [];
  for await (const chunk of out.fullStream as AsyncIterable<{ type: string; payload?: { messageId?: string } }>) {
    if (chunk.type === 'step-start' && chunk.payload?.messageId) stepMessageIds.push(chunk.payload.messageId);
  }
  return { text: await out.text, error: out.error, discarded, stepMessageIds };
}

async function shownAfterReload(threadId: string): Promise<string> {
  const { messages } = await memory.recall({ threadId, resourceId: 'igor', perPage: false });
  return toHistory(messages)
    .filter((m) => m.role === 'assistant')
    .map((m) => m.text)
    .join('');
}

async function withModels<T>(scripts: Record<string, FakeTurn[]>, run: (models: Record<string, FakeModel>) => Promise<T>): Promise<T> {
  const models: Record<string, FakeModel> = {};
  for (const [id, turns] of Object.entries(scripts)) {
    models[id] = await startFakeModel();
    models[id].script(...turns);
  }
  try {
    return await run(models);
  } finally {
    for (const m of Object.values(models)) await m.close();
  }
}

const urls = (models: Record<string, FakeModel>) => Object.fromEntries(Object.entries(models).map(([id, m]) => [id, m.url]));

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url);
  memory = createMemory(new PostgresStore({ id: 'stream-retry-test', connectionString: database.url, schemaName: 'mastra' }));
});
afterAll(async () => {
  await database.drop();
});

describe('an answer that broke after it started', () => {
  it('is asked once more; the new answer is a new message and the shown words are dropped', async () => {
    const log = vi.spyOn(console, 'log');
    try {
      await withModels({ main: [{ text: 'Пр', cut: BREAK }, { text: ANSWER }] }, async (models) => {
        const outcome = await answer(buildAgent(urls(models)), 't-once');
        expect(models.main!.requests).toHaveLength(2);
        expect(outcome.error).toBeUndefined();
        expect(outcome.text).toBe(ANSWER);
        // The broken attempt's message is dropped; the retry answers under another id.
        expect(outcome.discarded).toEqual([outcome.stepMessageIds[0]]);
        expect(outcome.stepMessageIds.at(-1)).not.toBe(outcome.stepMessageIds[0]);
        expect(await shownAfterReload('t-once')).toBe(ANSWER);
      });
      expect(log.mock.calls.some(([line]) => String(line).includes('"model_stream_retried"'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('is asked only once more: a second break ends the answer with the error kept in the history', async () => {
    await withModels({ main: [{ text: 'Пр', cut: BREAK }, { text: 'При', cut: BREAK }, { text: ANSWER }] }, async (models) => {
      const outcome = await answer(buildAgent(urls(models)), 't-twice');
      expect(models.main!.requests).toHaveLength(2);
      expect(String(outcome.error)).toContain('Connection closed');
      expect(await shownAfterReload('t-twice')).toBe('При');
    });
  });

  it('is not asked again when the provider refused the request itself', async () => {
    await withModels({ main: [{ text: 'Пр', cut: TOO_LONG }, { text: ANSWER }] }, async (models) => {
      const outcome = await answer(buildAgent(urls(models)), 't-refused');
      expect(models.main!.requests).toHaveLength(1);
      expect(outcome.discarded).toEqual([]);
    });
  });

  it('is asked again on the same model when a fallback is set: Mastra does not switch on a broken stream', async () => {
    const log = vi.spyOn(console, 'log');
    try {
      await withModels({ main: [{ text: 'Пр', cut: BREAK }, { text: ANSWER }], spare: [{ text: 'Ответ запасной.' }] }, async (models) => {
        const outcome = await answer(buildAgent(urls(models)), 't-fallback', { fallback: true });
        expect(models.main!.requests).toHaveLength(2);
        expect(models.spare!.requests).toHaveLength(0);
        expect(outcome.text).toBe(ANSWER);
      });
      expect(log.mock.calls.some(([line]) => String(line).includes('"model_fallback_used"'))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});

describe('a primary model that went silent mid-answer, with a fallback set', () => {
  it('gives way to the fallback after the limit of one call; the shown words are dropped', async () => {
    await withModels({ main: [{ text: 'Пр', cut: 'hang' }], spare: [{ text: 'Ответ запасной.' }] }, async (models) => {
      const outcome = await answer(buildAgent(urls(models), 1500), 't-silent-primary', { fallback: true });
      expect(models.spare!.requests).toHaveLength(1);
      expect(outcome.text).toBe('Ответ запасной.');
      expect(outcome.discarded).toEqual([outcome.stepMessageIds[0]]);
      expect(await shownAfterReload('t-silent-primary')).toBe('Ответ запасной.');
    });
  });
});
