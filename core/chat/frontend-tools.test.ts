// Tools of the browser (spec, section 8.25: the folder of the person's computer): the agent calls a tool the
// chat registered, the run ends with the call, the browser answers and starts the next run with the result —
// as CopilotKit does — and the agent goes on with it. The server keeps no tool of its own for that.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let olga: string;

interface Event {
  type: string;
  toolCallId?: string;
  toolCallName?: string;
  parentMessageId?: string;
  delta?: string;
}

const TOOLS = [{ name: 'computer_folder_list', description: 'Что лежит в папке «Тендер» на компьютере сотрудника', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

async function run(threadId: string, messages: unknown[]): Promise<Event[]> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', { cookie: olga, body: { threadId, runId: randomUUID(), messages, tools: TOOLS, context: [], state: {}, forwardedProps: {} } });
  expect(res.status).toBe(200);
  return (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as Event);
}

beforeAll(async () => {
  t = await createTestApp();
  const olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  const dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [dep, olgaId]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [dep]);
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('a tool of the browser', () => {
  it('ends the run with the call; the next run with the browser’s answer goes on to the reply', async () => {
    const threadId = randomUUID();
    t.model.script({ toolCalls: [{ name: 'computer_folder_list', args: {} }] }, (req) => {
      const result = JSON.stringify(req.messages.at(-1));
      return { text: result.includes('смета.xlsx') ? 'В папке одна смета' : 'Результата нет' };
    });
    const user = { id: randomUUID(), role: 'user', content: 'Что в папке с компьютера?' };
    const first = await run(threadId, [user]);
    const call = first.find((e) => e.type === 'TOOL_CALL_START');
    expect(call).toMatchObject({ toolCallName: 'computer_folder_list' });
    expect(first.some((e) => e.type === 'TEXT_MESSAGE_CONTENT')).toBe(false);
    // The model was offered the tool of the browser beside the server's.
    expect(t.model.requests.at(-1)?.tools?.some((x) => x.function.name === 'computer_folder_list')).toBe(true);

    const second = await run(threadId, [
      user,
      { id: call!.parentMessageId ?? randomUUID(), role: 'assistant', content: '', toolCalls: [{ id: call!.toolCallId, type: 'function', function: { name: 'computer_folder_list', arguments: '{}' } }] },
      { id: randomUUID(), role: 'tool', toolCallId: call!.toolCallId, content: JSON.stringify({ folder: 'Тендер', entries: [{ path: 'смета.xlsx', kind: 'file', bytes: 10 }] }) },
    ]);
    expect(second.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta).join('')).toBe('В папке одна смета');
  }, 30_000);
});
