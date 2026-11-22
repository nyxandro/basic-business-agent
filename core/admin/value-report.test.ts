// «Польза от агентов» (docs/specs/[20.11.2026]-feedback-and-value.md, step 7): hours = Σ norm × count; a department of 2
// people goes to «Другие отделы»; the spend counts the month as the monthly limit does, the subscription by calls; the
// file names no person; only with «Расходы».
import { WORK_KINDS, type ValueReport, type WorkKind } from '@bba/contracts';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { minutesOf } from './value-report.ts';

let t: TestApp;
let admin: string;
let olga: string;
let olgaId: string;
let sales: string;
let lawyers: string;

async function fact(kind: string, at: string, userId: string, agentId: string, departments: string[]): Promise<void> {
  await t.db.query('INSERT INTO app.work_facts (kind, at, user_id, agent_id, department_ids) VALUES ($1, $2, $3, $4, $5)', [kind, at, userId, agentId, departments]);
}

beforeAll(async () => {
  t = await createTestApp();
  sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  lawyers = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Юристы') RETURNING id`)).rows[0]!.id;
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова', departmentIds: [sales] });
  const ivan = await t.createUser({ email: 'ivan@example.com', name: 'Иван', departmentIds: [sales] });
  const anna = await t.createUser({ email: 'anna@example.com', name: 'Анна', departmentIds: [sales, lawyers] });
  const lev = await t.createUser({ email: 'lev@example.com', name: 'Лев', departmentIds: [lawyers] });
  await t.createUser({ email: 'boss@example.com', name: 'Директор', roleIds: [await t.roleId('superadmin')] });
  admin = await t.signIn('boss@example.com');
  olga = await t.signIn('olga@example.com');

  // November 2025 in Moscow: 01:30 on 1 December is December, 02:30 on 1 November is November.
  await fact('document', '2025-10-31T23:30:00Z', olgaId, 'sales', [sales]);
  await fact('document', '2025-11-15T10:00:00Z', ivan, 'sales', [sales]);
  await fact('action', '2025-11-15T10:00:00Z', anna, 'sales', [sales, lawyers]);
  await fact('email', '2025-11-16T10:00:00Z', lev, 'lawyer', [lawyers]);
  await fact('message', '2025-11-15T09:00:00Z', olgaId, 'sales', [sales]);
  await fact('message', '2025-11-15T09:01:00Z', olgaId, 'sales', [sales]);
  await fact('message', '2025-11-15T09:02:00Z', lev, 'lawyer', [lawyers]);
  await fact('conversation', '2025-11-15T09:00:00Z', olgaId, 'sales', [sales]);
  await fact('document', '2025-11-30T22:30:00Z', olgaId, 'sales', [sales]);
  const spend = `INSERT INTO app.usage_events (at, user_id, agent_id, model, deployment, is_subscription, input_tokens, output_tokens, cost_rub, litellm_call_id)
                 VALUES ($1, $2, 'sales', 'test-paid', 'test-paid-1', $3, 1, 1, $4, gen_random_uuid()::text)`;
  await t.db.query(spend, ['2025-11-10T10:00:00Z', olgaId, false, 120.5]);
  await t.db.query(spend, ['2025-11-10T10:00:00Z', olgaId, true, 0]);
  await t.db.query(spend, ['2025-11-30T22:30:00Z', olgaId, false, 999]);
});
afterAll(async () => {
  await t.close();
});

const report = async (from: string, to: string) => (await (await t.call('GET', `/app/api/admin/value?from=${from}&to=${to}`, { cookie: admin })).json()) as ValueReport;

describe('the report of value', () => {
  it('counts hours by the norms, beside the spend of the same month', async () => {
    const r = await report('2025-11', '2025-11');
    expect(r.total).toMatchObject({ people: 2, conversations: 1, facts: { document: 2, action: 1, email: 1, background_run: 0, web_research: 0, knowledge_answer: 0 } });
    // 2 documents × 20 + 1 action × 3 + 1 letter × 5.
    expect(r.total.minutes).toBe(48);
    expect(r.spendRub).toBe(120.5);
    expect(r.subscriptionCalls).toBe(1);
    expect(r.agents.map((a) => [a.name, a.minutes])).toEqual([['Продажи', 43], ['lawyer', 5]]);
  });

  it('shows a department under 3 people only inside «Другие отделы»', async () => {
    const r = await report('2025-11', '2025-11');
    expect(r.departments.map((d) => [d.name, d.facts.document, d.facts.action])).toEqual([['Продажи', 2, 1]]);
    expect(r.otherDepartments).toMatchObject({ facts: { action: 1, email: 1 }, people: 1 });
  });

  it('takes new norms and the cost of an hour, and only from «Расходы»', async () => {
    const norms = Object.fromEntries(WORK_KINDS.map((k) => [k, 0])) as Record<WorkKind, number>;
    expect((await t.call('PUT', '/app/api/admin/value-norms', { cookie: olga, body: { norms: { ...norms, document: 30 }, hourRub: 900 } })).status).toBe(403);
    expect((await t.call('GET', '/app/api/admin/value?from=2025-11&to=2025-11', { cookie: olga })).status).toBe(403);
    expect((await t.call('PUT', '/app/api/admin/value-norms', { cookie: admin, body: { norms: { ...norms, document: 30 }, hourRub: 900 } })).status).toBe(200);
    const r = await report('2025-11', '2025-11');
    expect(r).toMatchObject({ hourRub: 900, norms: { document: 30, action: 0 } });
    expect(r.total.minutes).toBe(60);
  });

  it('refuses a period over 12 months', async () => {
    expect((await t.call('GET', '/app/api/admin/value?from=2024-11&to=2025-11', { cookie: admin })).status).toBe(400);
    expect((await t.call('GET', '/app/api/admin/value?from=2025-11&to=2025-10', { cookie: admin })).status).toBe(400);
  });

  it('gives a file for Excel that names no person', async () => {
    const res = await t.call('GET', '/app/api/admin/value.csv?from=2025-11&to=2025-11', { cookie: admin });
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The mark of UTF-8 Excel reads Cyrillic by.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('Польза от агентов;2025-11 — 2025-11')).toBe(true);
    expect(text).toContain('Организация;Всего;2;1;2;1;1;0;0;0;1');
    for (const name of ['Ольга', 'Иван', 'Анна', 'Лев']) expect(text).not.toContain(name);
  });

  it('adds hours of two sets of facts as one', () => {
    const facts = fc.record(Object.fromEntries(WORK_KINDS.map((k) => [k, fc.nat(10_000)])) as Record<WorkKind, fc.Arbitrary<number>>);
    const norms = fc.record(Object.fromEntries(WORK_KINDS.map((k) => [k, fc.integer({ min: 0, max: 600 })])) as Record<WorkKind, fc.Arbitrary<number>>);
    fc.assert(
      fc.property(facts, facts, norms, (a, b, n) => {
        const both = Object.fromEntries(WORK_KINDS.map((k) => [k, a[k] + b[k]])) as Record<WorkKind, number>;
        return minutesOf(both, n) === minutesOf(a, n) + minutesOf(b, n) && minutesOf(a, n) >= 0;
      }),
    );
  });
});
