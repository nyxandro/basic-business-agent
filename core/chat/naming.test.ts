// The name of a conversation (spec, section 8.16): the service call that names it once its task is
// clear, the person's own rename, and the answer of the model read as a name.
import { randomUUID } from 'node:crypto';
import { CHAT_EVENTS, type SearchResponse, type ThreadPage } from '@bba/contracts';
import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setMaskingKinds } from '../masking/settings.ts';
import { setAutoTitle } from '../memory/titles.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { NAMING_TITLE_LENGTH, titleFromModel } from './naming.ts';

// How long the end of an answer waits for the naming call in these tests (3 s in an installation),
// and how long one naming call may take (60 s in an installation).
const WAIT_MS = 1000;
const NAMING_MS = 4000;

let t: TestApp;
let olga: string;
let olgaId: string;
let igor: string;

interface AguiEvent {
  type: string;
  name?: string;
  value?: unknown;
  delta?: string;
  outcome?: { interrupts?: { id: string }[] };
}

async function run(cookie: string, agentId: string, threadId: string, text: string | null, resume?: unknown): Promise<AguiEvent[]> {
  const res = await t.call('POST', `/app/api/copilotkit/agent/${agentId}/run`, {
    cookie,
    body: {
      threadId,
      runId: randomUUID(),
      messages: text ? [{ id: randomUUID(), role: 'user', content: text }] : [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
      ...(resume ? { resume } : {}),
    },
  });
  expect(res.status).toBe(200);
  return (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as AguiEvent);
}

const isTitled = (e: AguiEvent) => e.type === 'CUSTOM' && e.name === CHAT_EVENTS.threadTitled;
const answerOf = (events: AguiEvent[]) => events.filter((e) => e.type === 'TEXT_MESSAGE_CHUNK' || e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta ?? '').join('');

async function threads(cookie = olga): Promise<ThreadPage['threads']> {
  const res = await t.call('GET', '/app/api/threads?limit=30', { cookie });
  return ((await res.json()) as ThreadPage).threads;
}

const titleOf = async (threadId: string) => (await threads()).find((x) => x.id === threadId)?.title;

beforeAll(async () => {
  t = await createTestApp({ titleWaitMs: WAIT_MS, namingMaxMs: NAMING_MS });
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  await t.createUser({ email: 'igor@example.com', name: 'Игорь' });
  const dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [dep, olgaId]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [dep]);
  olga = await t.signIn('olga@example.com');
  igor = await t.signIn('igor@example.com');
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  t.model.clear();
  vi.restoreAllMocks();
});

describe('naming a conversation', () => {
  it('keeps the first message as the name while the task is not clear yet', async () => {
    const threadId = randomUUID();
    const before = t.model.namingRequests.length;
    const events = await run(olga, 'sales', threadId, 'Привет, как дела?');
    expect(t.model.namingRequests.length).toBe(before + 1);
    expect(events.some(isTitled)).toBe(false);
    expect(await titleOf(threadId)).toBe('Привет, как дела?');
  });

  it('names the conversation once its task is clear, before the answer ends, and only once', async () => {
    const threadId = randomUUID();
    await run(olga, 'sales', threadId, 'Привет!');
    t.model.scriptNaming({ text: '«Письмо клиентам о новых ценах».' });
    const events = await run(olga, 'sales', threadId, 'Нужно письмо клиентам про новые цены с 1 декабря');

    const titled = events.findIndex(isTitled);
    expect(titled).toBeGreaterThan(events.findIndex((e) => e.type === 'RUN_STARTED'));
    expect(titled).toBeLessThan(events.findIndex((e) => e.type === 'RUN_FINISHED'));
    expect(events[titled]!.value).toEqual({ threadId, title: 'Письмо клиентам о новых ценах' });
    expect(await titleOf(threadId)).toBe('Письмо клиентам о новых ценах');

    // The model saw the conversation so far, the new message included, as a call of the agent.
    const call = t.model.namingRequests.at(-1)!;
    const seen = JSON.stringify(call.messages);
    expect(seen).toContain('Сотрудник: Привет!');
    expect(seen).toContain('Ассистент: Готово.');
    expect(seen).toContain('Сотрудник: Нужно письмо клиентам про новые цены с 1 декабря');
    expect(call.headers['x-bba-agent-id']).toBe('sales');

    // A name is given once: the topic may change, the name stays.
    const count = t.model.namingRequests.length;
    await run(olga, 'sales', threadId, 'А теперь давай про отчёт по продажам');
    expect(t.model.namingRequests.length).toBe(count);
    expect(await titleOf(threadId)).toBe('Письмо клиентам о новых ценах');
  });

  it('sends personal data to the naming call as placeholders and shows the real values in the name', async () => {
    await setMaskingKinds(t.db, olgaId, ['email']);
    try {
      const threadId = randomUUID();
      t.model.scriptNaming((req) => ({ text: `Письмо для ${/\[ПОЧТА_\d+\]/.exec(JSON.stringify(req.messages))?.[0] ?? 'нет заглушки'}` }));
      await run(olga, 'sales', threadId, 'Напиши ivan@example.com про договор поставки');
      const seen = JSON.stringify(t.model.namingRequests.at(-1)!.messages);
      expect(seen).not.toContain('ivan@example.com');
      expect(seen).toContain('[ПОЧТА_1]');
      expect(await titleOf(threadId)).toBe('Письмо для ivan@example.com');
    } finally {
      await setMaskingKinds(t.db, olgaId, []);
    }
  });

  it('hides personal data in the whole message before it is cut short for the naming call', async () => {
    await setMaskingKinds(t.db, olgaId, ['email']);
    try {
      const threadId = randomUUID();
      // The address lies across the 400th character, where the message is cut.
      const message = `${'а'.repeat(385)} Пишите ivan.petrov@example.com по вопросам договора поставки`;
      expect(message.indexOf('ivan.petrov')).toBeLessThan(400);
      expect(message.indexOf('example.com')).toBeGreaterThan(400);
      await run(olga, 'sales', threadId, message);
      const seen = JSON.stringify(t.model.namingRequests.at(-1)!.messages);
      expect(seen).not.toContain('ivan');
      expect(seen).not.toContain('petrov');
    } finally {
      await setMaskingKinds(t.db, olgaId, []);
    }
  });

  // Mastra ends a call cut by the deadline without an error (empty text, finish reason «aborted»).
  it('a naming call that runs out of time is a failure: the name stays and it is logged', async () => {
    const log = vi.spyOn(console, 'log');
    const threadId = randomUUID();
    t.model.scriptNaming({ text: 'Письмо клиентам', delayMs: NAMING_MS + 1000 });
    await run(olga, 'sales', threadId, 'Подготовь письмо клиентам о новых ценах');
    await vi.waitFor(() => expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('"event":"thread_title_failed"') && line.includes(threadId))).toBe(true), {
      timeout: NAMING_MS + 3000,
      interval: 100,
    });
    expect(await titleOf(threadId)).toBe('Подготовь письмо клиентам о новых ценах');
  });

  it('a failed naming call neither breaks the answer nor changes the name, and is logged once', async () => {
    const log = vi.spyOn(console, 'log');
    const threadId = randomUUID();
    const before = t.model.namingRequests.length;
    t.model.scriptNaming({ status: 500, error: 'provider is down' });
    const events = await run(olga, 'sales', threadId, 'Подготовь отчёт по складу');
    expect(answerOf(events)).toBe('Готово.');
    expect(events.some((e) => e.type === 'RUN_ERROR')).toBe(false);
    expect(await titleOf(threadId)).toBe('Подготовь отчёт по складу');
    // No hidden repeat: the next message of the person asks again.
    expect(t.model.namingRequests.length).toBe(before + 1);
    const failures = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"event":"thread_title_failed"'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(threadId);
  });

  it('the end of the answer waits for a slow naming call only so long; the name comes later', async () => {
    const threadId = randomUUID();
    t.model.scriptNaming({ text: 'Сверка счетов за октябрь', delayMs: WAIT_MS + 1500 });
    const started = Date.now();
    const events = await run(olga, 'sales', threadId, 'Сверь счета за октябрь');
    expect(Date.now() - started).toBeLessThan(WAIT_MS + 1200);
    expect(events.some(isTitled)).toBe(false);
    expect(await titleOf(threadId)).toBe('Сверь счета за октябрь');
    await vi.waitFor(async () => expect(await titleOf(threadId)).toBe('Сверка счетов за октябрь'), { timeout: 5000, interval: 100 });
  });

  it('names no answer to «Да», no draft check and no conversation from before the names', async () => {
    const threadId = randomUUID();
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'client@example.com', text: 'Добрый день' } }] }, { text: 'Письмо отправлено.' });
    const first = await run(olga, 'sales', threadId, 'Напиши клиенту');
    const interrupt = first.find((e) => e.type === 'RUN_FINISHED')?.outcome?.interrupts?.[0];
    expect(interrupt).toBeTruthy();
    const afterQuestion = t.model.namingRequests.length;
    await run(olga, 'sales', threadId, null, [{ interruptId: interrupt!.id, status: 'resolved', payload: { approved: true } }]);
    expect(t.model.namingRequests.length).toBe(afterQuestion);

    // The admin's draft check of a prompt.
    const igorId = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'igor@example.com'`)).rows[0]!.id;
    const role = (await t.db.query<{ id: string }>(`INSERT INTO app.roles (name, permissions) VALUES ('Агенты', '["agents"]') RETURNING id`)).rows[0]!.id;
    await t.db.query('INSERT INTO app.user_roles (user_id, role_id) VALUES ($1, $2)', [igorId, role]);
    const draft = await t.app.request('/app/api/copilotkit/agent/sales/run', {
      method: 'POST',
      headers: { cookie: igor, origin: 'http://localhost:8080', 'content-type': 'application/json', 'x-bba-draft': '1' },
      body: JSON.stringify({ threadId: randomUUID(), runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: 'Проверка черновика' }], tools: [], context: [], state: {}, forwardedProps: {} }),
    });
    expect(draft.status).toBe(200);
    await draft.text();
    expect(t.model.namingRequests.length).toBe(afterQuestion);

    // A conversation from before 15.11 has no source of its name: it keeps it.
    const old = randomUUID();
    const now = new Date();
    await t.memory.saveThread({ thread: { id: old, resourceId: olgaId, title: 'Старый разговор', metadata: { agentId: 'sales', kind: 'chat' }, createdAt: now, updatedAt: now } });
    await run(olga, 'sales', old, 'Составь план продаж на декабрь');
    expect(t.model.namingRequests.length).toBe(afterQuestion);
    expect(await titleOf(old)).toBe('Старый разговор');
  });
});

describe('renaming a conversation', () => {
  it('renames one’s own conversation without moving it in the list; the search finds the new name', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await run(olga, 'sales', a, 'Первый разговор');
    await run(olga, 'sales', b, 'Второй разговор');
    const order = async () => (await threads()).map((x) => x.id).filter((id) => id === a || id === b);
    expect(await order()).toEqual([b, a]);

    const res = await t.call('PATCH', `/app/api/threads/${a}`, { cookie: olga, body: { title: '  Смета на ремонт склада ' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ thread: { id: a, title: 'Смета на ремонт склада' } });
    expect(await titleOf(a)).toBe('Смета на ремонт склада');
    expect(await order()).toEqual([b, a]);

    const found = (await (await t.call('GET', `/app/api/search?q=${encodeURIComponent('ремонт склада')}`, { cookie: olga })).json()) as SearchResponse;
    expect(found.threads.map((x) => x.id)).toContain(a);
  });

  it('gives the name of one’s own conversation for the rename window; someone else’s or an unknown one is not found', async () => {
    const threadId = randomUUID();
    await run(olga, 'sales', threadId, 'Разговор для окна');
    const own = await t.call('GET', `/app/api/threads/${threadId}`, { cookie: olga });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ thread: { id: threadId, title: 'Разговор для окна' } });
    for (const [cookie, id] of [
      [igor, threadId],
      [olga, randomUUID()],
    ] as const) {
      const missing = await t.call('GET', `/app/api/threads/${id}`, { cookie });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('APP_NOT_FOUND');
    }
  });

  it('refuses someone else’s or an unknown conversation, and an empty or too long name', async () => {
    const threadId = randomUUID();
    await run(olga, 'sales', threadId, 'Разговор Ольги');
    const foreign = await t.call('PATCH', `/app/api/threads/${threadId}`, { cookie: igor, body: { title: 'Чужое имя' } });
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe('APP_NOT_FOUND');
    const unknown = await t.call('PATCH', `/app/api/threads/${randomUUID()}`, { cookie: olga, body: { title: 'Имя' } });
    expect(unknown.status).toBe(404);
    for (const title of ['   ', 'я'.repeat(101)]) {
      const bad = await t.call('PATCH', `/app/api/threads/${threadId}`, { cookie: olga, body: { title } });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('APP_VALIDATION_FAILED');
    }
    expect(await titleOf(threadId)).toBe('Разговор Ольги');
  });

  it('a conversation named by hand is never named by the model, not even by a call already under way', async () => {
    const threadId = randomUUID();
    await run(olga, 'sales', threadId, 'Привет');
    expect((await t.call('PATCH', `/app/api/threads/${threadId}`, { cookie: olga, body: { title: 'Мой разговор' } })).status).toBe(200);
    const before = t.model.namingRequests.length;
    await run(olga, 'sales', threadId, 'Составь коммерческое предложение для ООО «Пример»');
    expect(t.model.namingRequests.length).toBe(before);
    // A naming call that started before the rename comes too late to overwrite it.
    expect(await setAutoTitle(t.db, threadId, 'Коммерческое предложение')).toBe(false);
    expect(await titleOf(threadId)).toBe('Мой разговор');
  });
});

describe('the answer of the model as a name', () => {
  it('reads the name out of what models really answer', () => {
    expect(titleFromModel('-')).toBeNull();
    expect(titleFromModel(' — ')).toBeNull();
    expect(titleFromModel('')).toBeNull();
    expect(titleFromModel('\n\n')).toBeNull();
    expect(titleFromModel('<think>Сотрудник просит письмо…</think>\n«Письмо клиентам о новых ценах».')).toBe('Письмо клиентам о новых ценах');
    expect(titleFromModel('<think>не дописал мысль')).toBeNull();
    expect(titleFromModel('Название: "Отчёт по продажам"')).toBe('Отчёт по продажам');
    expect(titleFromModel('Отчёт по продажам\nЯ выбрал его, потому что…')).toBe('Отчёт по продажам');
    expect(titleFromModel('  Сверка   счетов  ')).toBe('Сверка счетов');
    const long = titleFromModel('Очень длинное название разговора, которое модель написала вопреки просьбе быть краткой');
    expect([...long!]).toHaveLength(NAMING_TITLE_LENGTH);
    expect(long!.endsWith('…')).toBe(true);
  });

  it('a name is empty or one clean line of at most 60 characters, and reading it again changes nothing', () => {
    const pieces = fc.oneof(
      fc.constantFrom('«', '»', '"', '“', '”', "'", 'Название:', 'название :', ' ', '\n', '.', '-', '—', '<think>', '</think>', '…', '👩‍💼', 'Отчёт'),
      fc.string({ unit: 'grapheme', maxLength: 40 }),
    );
    fc.assert(
      fc.property(fc.array(pieces, { maxLength: 12 }).map((parts) => parts.join('')), (raw) => {
        const title = titleFromModel(raw);
        if (title === null) return;
        expect(title.isWellFormed()).toBe(true);
        expect(title).not.toMatch(/[\r\n]/);
        expect(title).toBe(title.trim());
        expect([...title].length).toBeGreaterThan(0);
        expect([...title].length).toBeLessThanOrEqual(NAMING_TITLE_LENGTH);
        expect(title).not.toMatch(/^[«»"“”„'`]|[«»"“”„'`.]$/);
        expect(titleFromModel(title)).toBe(title);
      }),
      // Known edges: a label and quotes twice over, a «-» in quotes, and an emoji right where a long
      // name is cut (a cut by UTF-16 units would leave half of it).
      { examples: [['Название: Название: «Отчёт».'], ['«-»'], [`${'а'.repeat(58)}😀${'б'.repeat(5)}`], [`${'Отчёт '.repeat(10)}👩‍💼👩‍💼`]] },
    );
  });
});
