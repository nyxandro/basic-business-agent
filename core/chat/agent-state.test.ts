// The «state of the agent» of CopilotKit (spec, section 8.26): the chat does not use it, and the AG-UI adapter
// of Mastra carried the personal memory through it — after every run to the browser, and back from the
// browser into the memory. Our middleware cuts it both ways.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let olga: string;
let olgaId: string;

async function run(state: Record<string, unknown>): Promise<string> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie: olga,
    body: { threadId: randomUUID(), runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: 'Привет' }], tools: [], context: [], state, forwardedProps: {} },
  });
  expect(res.status).toBe(200);
  return res.text();
}

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  const dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [dep, olgaId]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ('${dep}', 'sales')`);
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('the state of the agent', () => {
  it('carries nothing of what Mastra kept to the browser, and nothing from the browser into the memory', async () => {
    await t.db.query(`INSERT INTO mastra.mastra_resources (id, "workingMemory", "createdAt", "updatedAt") VALUES ($1, $2, now(), now())`, [olgaId, '{"workingMemory":"тендеры кровли"}']);
    t.model.script({ text: 'Здравствуйте.' });
    const stream = await run({});
    expect(stream).not.toContain('STATE_SNAPSHOT');
    expect(stream).not.toContain('тендеры кровли');

    t.model.script({ text: 'Здравствуйте.' });
    await run({ workingMemory: 'из открытой вкладки' });
    const { rows } = await t.db.query<{ workingMemory: string }>('SELECT "workingMemory" FROM mastra.mastra_resources WHERE id = $1', [olgaId]);
    expect(rows[0]!.workingMemory).toBe('{"workingMemory":"тендеры кровли"}');
    expect((await t.db.query('SELECT 1 FROM app.memory_entries WHERE user_id = $1', [olgaId])).rowCount).toBe(0);
  }, 60_000);
});
