// The demo installation of the repository (config/, agents/assistant, plugins/example-notes) loads
// and works: the agent answers and its plugin action waits for «Да» (spec, step 20).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadInstallation } from '../core/config/load.ts';
import { buildRegistry } from '../core/loader/registry.ts';
import { pluginSchemaName } from '../core/plugins/public/index.ts';
import { createTestApp, type TestApp } from '../core/server/test-app.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let t: TestApp;
let cookie: string;

type Event = { type: string; delta?: string; outcome?: { type: string; interrupts?: { id: string; metadata?: { mastra?: { toolName?: string } } }[] } };

async function run(threadId: string, text: string | null, resume?: unknown): Promise<Event[]> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/assistant/run', {
    cookie,
    body: { threadId, runId: randomUUID(), messages: text ? [{ id: randomUUID(), role: 'user', content: text }] : [], tools: [], context: [], state: {}, forwardedProps: {}, ...(resume ? { resume } : {}) },
  });
  expect(res.status).toBe(200);
  return (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as Event);
}

beforeAll(async () => {
  const installation = await loadInstallation(ROOT, process.env);
  t = await createTestApp({ registry: (db, chains) => buildRegistry({ root: ROOT, installation, env: process.env, db, chains }) });
  const olga = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  const dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Офис') RETURNING id`)).rows[0]!.id;
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [dep, olga]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'assistant')`, [dep]);
  cookie = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('demo installation', () => {
  it('opens the general helper with its starter questions to the department', async () => {
    const { agents } = (await (await t.call('GET', '/app/api/agents', { cookie })).json()) as { agents: { id: string; systems: { tools: Record<string, string> } }[] };
    expect(agents.map((a) => a.id)).toEqual(['assistant']);
    // The notes of the plugin; the mailbox and the folder of the computer are the core's own (spec, 8.24, 8.25).
    expect(agents[0]!.systems.tools).toMatchObject({ notes_list: 'Заметки', notes_add: 'Заметки', mailbox_send: 'Почта', computer_folder_read: 'Компьютер' });
  });

  it('answers, adds a note only after «Да» and lists notes without asking', async () => {
    const threadId = randomUUID();
    t.model.script({ toolCalls: [{ name: 'notes_add', args: { text: 'Позвонить поставщику в пятницу' } }] });
    const first = await run(threadId, 'Запиши заметку: позвонить поставщику в пятницу');
    const interrupt = first.find((e) => e.type === 'RUN_FINISHED')?.outcome?.interrupts?.[0];
    expect(interrupt?.metadata?.mastra?.toolName).toBe('notes_add');
    const table = `${pluginSchemaName('example-notes')}.notes`;
    expect((await t.db.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);

    t.model.script({ text: 'Записал.' });
    await run(threadId, null, [{ interruptId: interrupt!.id, status: 'resolved', payload: { approved: true } }]);
    expect((await t.db.query<{ text: string }>(`SELECT text FROM ${table}`)).rows.map((r) => r.text)).toEqual(['Позвонить поставщику в пятницу']);

    t.model.script({ toolCalls: [{ name: 'notes_list', args: {} }] }, { text: 'У вас одна заметка: позвонить поставщику в пятницу.' });
    const listed = await run(randomUUID(), 'Покажи мои заметки');
    expect(listed.find((e) => e.type === 'RUN_FINISHED')?.outcome?.type).not.toBe('interrupt');
    expect(listed.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta).join('')).toBe('У вас одна заметка: позвонить поставщику в пятницу.');
  });
});
