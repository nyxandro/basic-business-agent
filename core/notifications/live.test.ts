// The instant channel and the states of conversations (decision of the owner 22.11; docs/specs/[20.11.2026]-notifications.md):
// a change reaches the open page at once through Postgres, and the lists know where an agent works, where a question
// waits, where an answer is ready or broke while nobody watched.
import { randomUUID } from 'node:crypto';
import type { NotificationsResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { notices } from './kinds.ts';
import { notify } from './notify.ts';

let t: TestApp;
let olga: string;
let olgaId: string;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const statesOf = async () => (await json<NotificationsResponse>(await t.call('GET', '/app/api/me/notifications', { cookie: olga }))).threads;
const body = (threadId: string, text: string | null) => ({ threadId, runId: randomUUID(), messages: text ? [{ id: randomUUID(), role: 'user', content: text }] : [], tools: [], context: [], state: {}, forwardedProps: {} });
const run = (threadId: string, text: string) => t.call('POST', '/app/api/copilotkit/agent/sales/run', { cookie: olga, body: body(threadId, text) }).then((r) => r.text());
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 100 && !done(value); i++) {
    await new Promise((r) => setTimeout(r, 30));
    value = await read();
  }
  return value;
}

beforeAll(async () => {
  t = await createTestApp();
  const sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга', departmentIds: [sales] });
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('the instant channel', () => {
  it('tells a subscriber once for a burst of changes of the person — a notification, a question, a hand-made signal', async () => {
    let told = 0;
    const stop = t.notifications.live.subscribe(olgaId, () => told++);
    try {
      await notify(t.db, notices.taskResult({ userId: olgaId, runId: 'live-1', taskId: 'task-1', taskTitle: 'Сводка', agentId: 'sales' }));
      await notify(t.db, notices.taskResult({ userId: olgaId, runId: 'live-2', taskId: 'task-1', taskTitle: 'Сводка', agentId: 'sales' }));
      await eventually(() => Promise.resolve(told), (n) => n > 0);
      await new Promise((r) => setTimeout(r, 300));
      expect(told).toBe(1);
      // Reading a notification tells too (its mark goes from the conversation).
      await t.db.query(`UPDATE app.notifications SET read_at = now() WHERE dedup_key = 'task_result:live-1'`);
      expect(await eventually(() => Promise.resolve(told), (n) => n > 1)).toBe(2);
    } finally {
      stop();
    }
  });

  // A page loading in React's development mode opens and closes a first connection at once; that connection's own end
  // comes again later (the keep-alive loop wakes up) — it must not drop the connection open now.
  it('keeps telling the open connection when an old connection of the person ends a second time', async () => {
    let told = 0;
    const stopOld = t.notifications.live.subscribe(olgaId, () => undefined);
    stopOld();
    const stop = t.notifications.live.subscribe(olgaId, () => told++);
    stopOld();
    try {
      await notify(t.db, notices.taskResult({ userId: olgaId, runId: 'live-stale', taskId: 'task-1', taskTitle: 'Сводка', agentId: 'sales' }));
      expect(await eventually(() => Promise.resolve(told), (n) => n > 0)).toBe(1);
    } finally {
      stop();
    }
  });

  it('streams «changed» to the open page of the person', async () => {
    const res = await t.call('GET', '/app/api/me/events', { cookie: olga });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (marker: string) => {
      while (!text.includes(marker)) {
        const chunk = (await reader.read()) as { value?: Uint8Array };
        text += decoder.decode(chunk.value);
      }
    };
    await readUntil('event: ready');
    await notify(t.db, notices.taskResult({ userId: olgaId, runId: 'live-3', taskId: 'task-1', taskTitle: 'Сводка', agentId: 'sales' }));
    await readUntil('event: changed');
    await reader.cancel();
  });
});

describe('the states of conversations', () => {
  it('shows an agent at work, then its answer ready for one who was not watching, gone once the conversation is opened', async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Сводка готова.', delayMs: 600 });
    const answer = run(threadId, 'Сводка по сделкам');
    expect(await eventually(statesOf, (s) => s[threadId] === 'running')).toMatchObject({ [threadId]: 'running' });
    await answer;
    expect(await eventually(statesOf, (s) => s[threadId] === 'done')).toMatchObject({ [threadId]: 'done' });
    await t.call('POST', '/app/api/copilotkit/agent/sales/connect', { cookie: olga, body: body(threadId, null) });
    expect((await statesOf())[threadId]).toBeUndefined();
  });

  it('shows no mark for an answer the person watched to its end', async () => {
    const threadId = randomUUID();
    await t.call('POST', '/app/api/me/presence', { cookie: olga, body: { tab: 'tab-on-chat-1', visible: true, threadId } });
    t.model.script({ text: 'Готово.' });
    await run(threadId, 'Привет');
    await new Promise((r) => setTimeout(r, 200));
    expect((await statesOf())[threadId]).toBeUndefined();
    await t.call('POST', '/app/api/me/presence', { cookie: olga, body: { tab: 'tab-on-chat-1', visible: false, threadId: null } });
  });

  it('shows a question «Да» waiting, and a broken answer as failed', async () => {
    const asking = randomUUID();
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'client@example.com', text: 'Счёт' } }] });
    await run(asking, 'Отправь клиенту счёт');
    expect(await eventually(statesOf, (s) => s[asking] === 'waiting')).toMatchObject({ [asking]: 'waiting' });

    const broken = randomUUID();
    await notify(t.db, notices.answerFailed({ userId: olgaId, runKey: 'broken-1', agentId: 'sales', threadId: broken, threadTitle: 'Отчёт' }));
    expect((await statesOf())[broken]).toBe('failed');
  });

  it('shows a background run at work and its unopened result as done', async () => {
    const threadId = `bg:task-x:${olgaId}`;
    const release = t.notifications.activity.start(olgaId, threadId);
    expect((await statesOf())[threadId]).toBe('running');
    release();
    await t.memory.saveThread({ thread: { id: threadId, resourceId: olgaId, title: 'Задача: Сводка', metadata: { unread: true }, createdAt: new Date(), updatedAt: new Date() } });
    expect((await statesOf())[threadId]).toBe('done');
  });
});
