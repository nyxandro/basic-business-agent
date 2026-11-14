import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let cookie: string;

beforeAll(async () => {
  t = await createTestApp({ assistantSubagent: true });
  await t.createUser({ email: 'igor@example.com', roleIds: [await t.roleId('superadmin')] });
  cookie = await t.signIn('igor@example.com');
});
afterAll(async () => {
  await t.close();
});

type Event = { type: string; outcome?: { interrupts?: { id: string; metadata?: { mastra?: { toolName?: string } } }[] } };

async function run(threadId: string, text: string | null, resume?: unknown): Promise<Event[]> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/assistant/run', {
    cookie,
    body: { threadId, runId: randomUUID(), messages: text ? [{ id: randomUUID(), role: 'user', content: text }] : [], tools: [], context: [], state: {}, forwardedProps: {}, ...(resume ? { resume } : {}) },
  });
  return (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as Event);
}

it('asks the person once for an action a sub-agent wants, and runs it after "Да"', async () => {
  const threadId = randomUUID();
  t.model.script({ toolCalls: [{ name: 'agent-mailer', args: { prompt: 'Отправь письмо a@example.com' } }] }, { toolCalls: [{ name: 'mail_send', args: { to: 'a@example.com', text: 'Привет' } }] });
  const first = await run(threadId, 'Попроси почтальона отправить письмо');
  const interrupt = first.find((e) => e.type === 'RUN_FINISHED')?.outcome?.interrupts?.[0];
  expect(interrupt?.metadata?.mastra?.toolName).toBe('mail_send');
  const pending = await t.db.query('SELECT 1 FROM app.approval_requests WHERE thread_id = $1 AND status = $2', [threadId, 'pending']);
  expect(pending.rowCount).toBe(1);

  t.model.script({ text: 'Отправил.' }, { text: 'Почтальон отправил письмо.' });
  await run(threadId, null, [{ interruptId: interrupt!.id, status: 'resolved', payload: { approved: true } }]);
  expect(t.sentMail).toEqual([{ to: 'a@example.com', text: 'Привет' }]);
  const left = await t.db.query('SELECT 1 FROM app.approval_requests WHERE thread_id = $1 AND status = $2', [threadId, 'pending']);
  expect(left.rowCount).toBe(0);
});

it('names the call of a sub-agent in the chat by the sub-agent’s name', async () => {
  const res = await t.call('GET', '/app/api/agents', { cookie });
  const { agents } = (await res.json()) as { agents: { id: string; actions: Record<string, unknown> }[] };
  expect(agents.find((a) => a.id === 'assistant')!.actions['agent-mailer']).toEqual({ title: 'Поручение агенту «Почтальон»', fields: {}, readOnly: false });
});
