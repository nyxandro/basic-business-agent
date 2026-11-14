import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let olga: string;

interface AguiEvent {
  type: string;
  toolCallName?: string;
  content?: string;
  outcome?: { type: string; interrupts?: unknown[] };
}

async function run(text: string): Promise<AguiEvent[]> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie: olga,
    body: { threadId: randomUUID(), runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps: {} },
  });
  expect(res.status).toBe(200);
  return (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as AguiEvent);
}

const TABLE = { title: 'Сделки', columns: [{ key: 'name', label: 'Сделка' }, { key: 'sum', label: 'Сумма' }], rows: [{ name: 'Поставка бетона', sum: 120000 }] };

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

describe('interface blocks of the core', () => {
  it('are offered to the model and shown without asking the person', async () => {
    t.model.script({ toolCalls: [{ name: 'show_table', args: TABLE }] }, { text: 'Вот сделки.' });
    const events = await run('Покажи сделки таблицей');

    const offered = t.model.requests.at(-2)!.tools!.map((x) => x.function.name);
    for (const name of ['show_table', 'show_chart', 'show_card', 'ask_choice', 'ask_form']) expect(offered).toContain(name);
    expect(events.find((e) => e.type === 'TOOL_CALL_START')?.toolCallName).toBe('show_table');
    expect(JSON.parse(events.find((e) => e.type === 'TOOL_CALL_RESULT')!.content!)).toMatchObject({ shown: true });
    expect(events.find((e) => e.type === 'RUN_FINISHED')?.outcome?.type).not.toBe('interrupt');
  });

  it('returns broken data to the model with the field to fix', async () => {
    const chart = { kind: 'bar', labels: ['Янв', 'Фев'], series: [{ name: 'Выручка', values: [1] }] };
    t.model.script({ toolCalls: [{ name: 'show_chart', args: chart }] }, { text: 'Исправлю.' });
    await run('Нарисуй график');

    const toolMessage = t.model.requests.at(-1)!.messages.find((m) => m.role === 'tool');
    expect(JSON.stringify(toolMessage?.content)).toMatch(/series/);
    expect(JSON.stringify(toolMessage?.content)).toMatch(/validation failed/i);
  });

  it('asks the model to wait for the person after a choice', async () => {
    const choice = { question: 'Кому написать?', options: [{ value: 'a', label: 'Альфа' }, { value: 'b', label: 'Бета' }] };
    t.model.script({ toolCalls: [{ name: 'ask_choice', args: choice }] }, { text: 'Жду выбора.' });
    const events = await run('Предложи варианты');
    expect(JSON.parse(events.find((e) => e.type === 'TOOL_CALL_RESULT')!.content!)).toMatchObject({ shown: true, waitForAnswer: true });
  });
});
