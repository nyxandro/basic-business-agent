// «Что агенту можно» (spec, section 8.30): every agent has its row from the start of the server, a new one with
// everything on (decision of the owner 19.11); the admin switches the internet and the commands per agent.
import type { AdminAgentsResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { AGENT_ABILITY_DEFAULTS, ensureAgentAbilities, readAbilities } from './abilities.ts';

let t: TestApp;
let admin: string;
let olga: string;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const listed = async (id: string) => (await json<AdminAgentsResponse>(await t.call('GET', '/app/api/admin/agents', { cookie: admin }))).agents.find((a) => a.id === id)!;

beforeAll(async () => {
  t = await createTestApp();
  await t.createUser({ email: 'boss@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
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

  it('stops a run of an agent the database has no row of', async () => {
    await expect(readAbilities(t.db, 'ghost')).rejects.toThrow(/APP_CONFIG_INVALID/);
  });
});
