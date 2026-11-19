// «Что агенту можно» (spec, section 8.30): every agent has its row from the start of the server, a new one with
// everything on (decision of the owner 19.11); the admin switches the internet and the commands per agent.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withAttachments, type AdminAgentsResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { abilitiesLayer, COMMANDS_OFF, COMMANDS_RULES, WEB_OFF, WEB_RULES } from '../prompts/layers.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { contextRoot } from '../workspace/layout.ts';
import { AGENT_ABILITY_DEFAULTS, ensureAgentAbilities, readAbilities } from './abilities.ts';

let t: TestApp;
let admin: string;
let olga: string;
let olgaId: string;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const listed = async (id: string) => (await json<AdminAgentsResponse>(await t.call('GET', '/app/api/admin/agents', { cookie: admin }))).agents.find((a) => a.id === id)!;

beforeAll(async () => {
  t = await createTestApp();
  await t.createUser({ email: 'boss@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  const sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [sales, olgaId]);
  admin = await t.signIn('boss@example.com');
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('what an agent may do', () => {
  it('gives every agent of the installation everything at the start of the server', async () => {
    expect(AGENT_ABILITY_DEFAULTS).toEqual({ web: true, commands: true });
    expect(await readAbilities(t.db, 'sales')).toEqual({ web: true, commands: true });
    expect((await listed('assistant')).abilities).toEqual({ web: true, commands: true });
  });

  it('switches one ability, keeps the other, writes the audit and keeps it over the next start', async () => {
    const res = await t.call('PUT', '/app/api/admin/agents/sales/abilities', { cookie: admin, body: { web: false } });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ abilities: { web: false, commands: true } });
    expect((await listed('sales')).abilities).toEqual({ web: false, commands: true });
    const { rows } = await t.db.query<{ details: unknown }>("SELECT details FROM app.admin_audit WHERE action = 'agent.abilities' AND target = 'sales'");
    expect(rows.at(-1)!.details).toEqual({ web: false, commands: true });
    // The next start of the server: a row the admin changed stays as it is.
    await ensureAgentAbilities(t.db, ['sales', 'assistant']);
    expect(await readAbilities(t.db, 'sales')).toEqual({ web: false, commands: true });
    await t.call('PUT', '/app/api/admin/agents/sales/abilities', { cookie: admin, body: { web: true, commands: false } });
    expect(await readAbilities(t.db, 'sales')).toEqual({ web: true, commands: false });
  });

  it('refuses an unknown agent, an empty change and a person without «Агенты»', async () => {
    expect((await t.call('PUT', '/app/api/admin/agents/ghost/abilities', { cookie: admin, body: { web: true } })).status).toBe(404);
    expect((await t.call('PUT', '/app/api/admin/agents/sales/abilities', { cookie: admin, body: {} })).status).toBe(400);
    expect((await t.call('PUT', '/app/api/admin/agents/sales/abilities', { cookie: olga, body: { web: true } })).status).toBe(403);
  });

  // An agent whose passport turns the core's rules off gets no rules of programs either; it is told what is off.
  it('gives the rules of programs only with the core’s rules, and the switched-off lines always', () => {
    expect(abilitiesLayer({ web: true, commands: true }, false)).toBe(WEB_RULES);
    expect(abilitiesLayer({ web: false, commands: false }, false)).toBe(`${COMMANDS_OFF}\n\n${WEB_OFF}`);
    expect(abilitiesLayer({ web: true, commands: true }, true)).toBe(`${COMMANDS_RULES.trim()}\n\n${WEB_RULES}`);
  });

  it('stops a run of an agent the database has no row of', async () => {
    await expect(readAbilities(t.db, 'ghost')).rejects.toThrow(/APP_CONFIG_INVALID/);
  });

  // What the model of every entry point of a run sees (acceptance 10): the rules of programs or the line that they
  // are switched off, the internet or the line that it is off.
  const systemOf = () => JSON.stringify(t.model.requests.at(-1)!.messages.filter((m) => m.role === 'system'));
  async function chat(text: string, headers: Record<string, string> = {}): Promise<void> {
    const body = { threadId: randomUUID(), runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps: {} };
    const res = await t.app.request('/app/api/copilotkit/agent/sales/run', { method: 'POST', headers: { cookie: headers.cookie ?? olga, origin: 'http://localhost:8080', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    await res.text();
  }

  it('tells the model what is switched off, in a chat, a draft check and a background run', async () => {
    await t.call('PUT', '/app/api/admin/agents/sales/abilities', { cookie: admin, body: { web: false, commands: false } });
    t.model.script({ text: 'Сделать файл Word нельзя.' });
    await chat('Сделай КП в Word');
    expect(systemOf()).toContain(JSON.stringify(COMMANDS_OFF).slice(1, -1));
    expect(systemOf()).toContain(JSON.stringify(WEB_OFF).slice(1, -1));
    expect(systemOf()).not.toContain('## Программы');

    t.model.script({ text: 'Черновик.' });
    await chat('Проверка черновика', { cookie: admin, 'x-bba-draft': '1' });
    expect(systemOf()).toContain(JSON.stringify(COMMANDS_OFF).slice(1, -1));

    t.model.script({ text: 'Разобрал письмо.' });
    expect((await t.background.startAgentRun({ agentId: 'sales', userId: olgaId, prompt: 'Пришло письмо', title: 'Письмо' })).outcome).toBe('done');
    expect(systemOf()).toContain(JSON.stringify(WEB_OFF).slice(1, -1));

    await t.call('PUT', '/app/api/admin/agents/sales/abilities', { cookie: admin, body: { web: true, commands: true } });
    t.model.script({ text: 'Готово.' });
    await chat('Сделай КП в Word');
    expect(systemOf()).toContain(JSON.stringify(COMMANDS_RULES.trim()).slice(1, -1));
    expect(systemOf()).toContain(JSON.stringify(WEB_RULES).slice(1, -1));
    expect(systemOf()).not.toContain(JSON.stringify(COMMANDS_OFF).slice(1, -1));
  });

  it('offers no skill in the card of a document the agent without commands cannot read', async () => {
    await t.call('PUT', '/app/api/admin/agents/sales/abilities', { cookie: admin, body: { commands: false } });
    const dir = contextRoot(t.workspaceRoot, olgaId, null);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'КП.docx'), 'not a real document');
    t.model.script({ text: 'Не прочитал.' });
    await chat(withAttachments('Что тут?', [{ name: 'КП.docx', path: 'КП.docx' }]));
    const user = JSON.stringify(t.model.requests.at(-1)!.messages.filter((m) => m.role === 'user'));
    expect(user).toContain('не разобрался');
    expect(user).not.toContain('скиллом');
    await t.call('PUT', '/app/api/admin/agents/sales/abilities', { cookie: admin, body: { commands: true } });
  });
});
