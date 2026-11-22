import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let olgaId: string;
let olga: string;
let admin: string;

async function spend(userId: string, model: string, agent: string, cost: number, tokens: [number, number], subscription = false): Promise<void> {
  await t.db.query(
    `INSERT INTO app.usage_events (at, user_id, agent_id, model, deployment, is_subscription, input_tokens, output_tokens, cost_rub, litellm_call_id)
     VALUES (now(), $1, $2, $3, $3 || '-1', $4, $5, $6, $7, gen_random_uuid()::text)`,
    [userId, agent, model, subscription, tokens[0], tokens[1], cost],
  );
}

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  await t.createUser({ email: 'boss@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  olga = await t.signIn('olga@example.com');
  admin = await t.signIn('boss@example.com');
  await t.db.query('INSERT INTO app.user_limits (user_id, monthly_rub, daily_subscription_tokens) VALUES ($1, 3000, 500000)', [olgaId]);
  await spend(olgaId, 'test-paid', 'sales', 1500, [1000, 500]);
  await spend(olgaId, 'test-paid', 'assistant', 260, [200, 100]);
  await spend(olgaId, 'test-sub', 'sales', 0, [40000, 20000], true);
});
afterAll(async () => {
  await t.close();
});

describe('usage', () => {
  it('shows the employee their spend, limit, date of the new limit and today’s subscription tokens', async () => {
    const me = (await (await t.call('GET', '/app/api/me/usage', { cookie: olga })).json()) as {
      month: { spentRub: number; limitRub: number; resetsOn: string };
      daily: { usedTokens: number; capTokens: number };
    };
    expect(me.month.spentRub).toBe(1760);
    expect(me.month.limitRub).toBe(3000);
    expect(me.month.resetsOn).toMatch(/^\d{4}-\d{2}-01$/);
    expect(me.daily).toEqual({ usedTokens: 60000, capTokens: 500000 });
  });

  it('gives the admin a report by employee, agent and model', async () => {
    // The day of the installation (Europe/Moscow in the test app): the report counts its days.
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
    const get = async (groupBy: string) =>
      (await (await t.call('GET', `/app/api/admin/usage?from=${today}&to=${today}&groupBy=${groupBy}`, { cookie: admin })).json()) as { rows: { label: string; costRub: number; calls: number }[]; totalRub: number };
    const byUser = await get('user');
    expect(byUser.rows).toMatchObject([{ label: 'Ольга', costRub: 1760, calls: 3 }]);
    expect(byUser.totalRub).toBe(1760);
    expect((await get('agent')).rows.map((r) => [r.label, r.costRub])).toEqual([['Продажи', 1500], ['Помощник', 260]]);
    expect((await get('model')).rows.map((r) => r.label)).toEqual(['Платная (заглушка)', 'Подписка (заглушка)']);
  });

  // docs/specs/[20.11.2026]-feedback-and-value.md, F3: the table counts days and months in the installation's time zone,
  // as the chart and the monthly limit do — 01:30 in Moscow on 1 December is December, not November.
  it('counts the days of the report in the installation’s time zone', async () => {
    const userId = await t.createUser({ email: 'edge@example.com', name: 'Край' });
    await t.db.query(
      `INSERT INTO app.usage_events (at, user_id, agent_id, model, deployment, is_subscription, input_tokens, output_tokens, cost_rub, litellm_call_id)
       VALUES ('2025-11-30T22:30:00Z', $1, 'sales', 'test-paid', 'test-paid-1', false, 1, 1, 7, gen_random_uuid()::text)`,
      [userId],
    );
    const report = async (from: string, to: string) => (await (await t.call('GET', `/app/api/admin/usage?from=${from}&to=${to}&groupBy=user`, { cookie: admin })).json()) as { totalRub: number };
    expect((await report('2025-12-01', '2025-12-01')).totalRub).toBe(7);
    expect((await report('2025-11-01', '2025-11-30')).totalRub).toBe(0);
  });

  it('closes the report to a role without the "usage" right', async () => {
    const res = await t.call('GET', '/app/api/admin/usage?from=2026-11-01&to=2026-11-30&groupBy=user', { cookie: olga });
    expect(res.status).toBe(403);
  });
});
