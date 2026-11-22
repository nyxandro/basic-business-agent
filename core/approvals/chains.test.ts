// Multi-step approvals (docs/specs/[20.11.2026]-multi-step-approvals.md, section 23): an action under a rule runs only
// after the employee's «Да» and every stage's agreement, exactly once; the approver decides by the card; the employee
// learns the outcome in the conversation, where the agent goes on.
import { randomUUID } from 'node:crypto';
import type { ChainDto, ChainsResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let igor: string;
let olga: string;
let petrId: string;
let petr: string;
let ivanId: string;
let ivan: string;
let dep: string;

interface AguiEvent {
  type: string;
  toolCallId?: string;
  toolCallName?: string;
  content?: string;
  outcome?: { interrupts?: { id: string; toolCallId?: string }[] };
}

async function run(threadId: string, text: string | null, resume?: unknown): Promise<AguiEvent[]> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie: olga,
    body: { threadId, runId: randomUUID(), messages: text ? [{ id: randomUUID(), role: 'user', content: text }] : [], tools: [], context: [], state: {}, forwardedProps: {}, ...(resume ? { resume } : {}) },
  });
  expect(res.status).toBe(200);
  return (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as AguiEvent);
}
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const interruptOf = (events: AguiEvent[]) => events.find((e) => e.type === 'RUN_FINISHED')?.outcome?.interrupts?.[0];
const resultOf = (events: AguiEvent[], tool: string) => {
  const call = events.find((e) => e.type === 'TOOL_CALL_START' && e.toolCallName === tool);
  const result = events.find((e) => e.type === 'TOOL_CALL_RESULT' && e.toolCallId === call?.toolCallId);
  return result?.content ? (JSON.parse(result.content) as Record<string, unknown>) : null;
};

// Ольга asks for a letter, writes «Зачем» on the card and says «Да»: the request it makes.
async function sendForApproval(args: { to: string; text: string }, reason = 'Клиент ждёт письмо до вечера'): Promise<{ threadId: string; sent: Record<string, unknown> }> {
  const threadId = randomUUID();
  t.model.script({ toolCalls: [{ name: 'mail_send', args }] }, { text: 'Отправил на согласование.' });
  const first = await run(threadId, 'Напиши клиенту');
  const interrupt = interruptOf(first)!;
  const toolCallId = first.find((e) => e.type === 'TOOL_CALL_START' && e.toolCallName === 'mail_send')!.toolCallId!;
  if (reason) expect((await t.call('POST', '/app/api/approval-chains/reason', { cookie: olga, body: { toolCallId, comment: reason } })).status).toBe(200);
  const second = await run(threadId, null, [{ interruptId: interrupt.id, status: 'resolved', payload: { approved: true } }]);
  return { threadId, sent: resultOf(second, 'mail_send') ?? {} };
}

const chainsOf = async (cookie: string) => json<ChainsResponse>(await t.call('GET', '/app/api/approval-chains', { cookie }));
const decide = (cookie: string, id: string, approve: boolean, reason?: string) => t.call('POST', `/app/api/approval-chains/${id}/decision`, { cookie, body: { approve, ...(reason ? { reason } : {}) } });

beforeAll(async () => {
  t = await createTestApp();
  const igorId = await t.createUser({ email: 'igor@example.com', name: 'Игорь Власов', roleIds: [await t.roleId('superadmin')] });
  dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [dep]);
  await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова', departmentIds: [dep] });
  petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр Сидоров', departmentIds: [dep] });
  ivanId = await t.createUser({ email: 'ivan@example.com', name: 'Сергей Иванов' });
  igor = await t.signIn('igor@example.com');
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
  ivan = await t.signIn('ivan@example.com');
  void igorId;
  expect((await t.call('PUT', `/app/api/admin/departments/${dep}/heads`, { cookie: igor, body: { userIds: [petrId] } })).status).toBe(200);
});
afterAll(async () => {
  await t.close();
});

describe('a rule of approvals', () => {
  let ruleId: string;

  it('needs an approver in every stage, and lists the actions that change data', async () => {
    const empty = await t.call('POST', '/app/api/admin/approval-rules', { cookie: igor, body: { target: 'mail_send', stages: [[]], enabled: true } });
    expect(empty.status).toBe(400);
    const saved = await t.call('POST', '/app/api/admin/approval-rules', { cookie: igor, body: { target: 'mail_send', stages: [[{ kind: 'head' }], [{ kind: 'user', userId: ivanId }]], enabled: true } });
    expect(saved.status).toBe(201);
    ruleId = String((await json<{ id: string }>(saved)).id);
    const listed = await json<{ rules: { target: string; title: string | null }[]; actions: { target: string }[] }>(await t.call('GET', '/app/api/admin/approval-rules', { cookie: igor }));
    expect(listed.rules[0]).toMatchObject({ target: 'mail_send' });
    expect(listed.actions.map((a) => a.target)).toContain('mail_send');
    expect(listed.actions.map((a) => a.target)).not.toContain('crm_search');
    const preview = await json<{ stages: string[] }>(await t.call('POST', '/app/api/approval-chains/preview', { cookie: olga, body: { tool: 'mail_send' } }));
    expect(preview.stages).toEqual(['руководитель отдела «Продажи»', 'Сергей Иванов']);
    expect((await json<{ stages: null }>(await t.call('POST', '/app/api/approval-chains/preview', { cookie: olga, body: { tool: 'crm_search' } }))).stages).toBeNull();
  });

  it('makes a request instead of sending; the same call again is the same request; parameters are kept encrypted', async () => {
    const { sent } = await sendForApproval({ to: 'client@example.com', text: 'Скидка 15 %' });
    expect(sent).toMatchObject({ status: 'sent_for_approval', stages: ['руководитель отдела «Продажи»', 'Сергей Иванов'] });
    expect(t.sentMail).toEqual([]);
    const row = (await t.db.query<{ args_ciphertext: Buffer; comment: string }>('SELECT args_ciphertext, comment FROM app.approval_chains WHERE id = $1', [sent.id])).rows[0]!;
    expect(row.args_ciphertext.toString('utf8')).not.toContain('client@example.com');
    expect(row.comment).toBe('Клиент ждёт письмо до вечера');
    const again = await sendForApproval({ to: 'client@example.com', text: 'Скидка 15 %' });
    expect(again.sent).toMatchObject({ status: 'already_waiting', id: sent.id });
    // The approver sees the request with real values and «Зачем»; nobody else sees it.
    const card = (await chainsOf(petr)).forMe.find((c) => c.id === sent.id)!;
    expect(card).toMatchObject({ stage: 1, stages: ['руководитель отдела «Продажи»', 'Сергей Иванов'], requester: 'Ольга Смирнова', comment: 'Клиент ждёт письмо до вечера', canDecide: true, args: { to: 'client@example.com' } });
    // Иванов approves later (stage 2): he may look, but it is not waiting for him yet; a colleague outside it sees nothing.
    expect((await chainsOf(ivan)).forMe).toEqual([]);
    expect((await t.call('GET', `/app/api/approval-chains/${String(sent.id)}`, { cookie: igor })).status).toBe(404);
  }, 30_000);

  it('runs once after every stage agreed, writes the outcome in the conversation and the agent goes on', async () => {
    const { threadId, sent } = await sendForApproval({ to: 'buyer@example.com', text: 'Счёт по сделке' });
    const id = String(sent.id);
    // Not the approver of stage 1: refused.
    expect((await decide(ivan, id, true)).status).toBe(404);
    expect((await decide(petr, id, true)).status).toBe(200);
    expect((await decide(petr, id, true)).status).toBe(404);
    expect((await chainsOf(ivan)).forMe.map((c) => c.id)).toContain(id);
    t.model.script({ text: 'Письмо ушло, продолжаю работу.' });
    expect((await decide(ivan, id, true)).status).toBe(200);
    await t.approvals.executor.idle();
    expect(t.sentMail).toEqual([{ to: 'buyer@example.com', text: 'Счёт по сделке' }]);
    const done = await json<ChainDto>(await t.call('GET', `/app/api/approval-chains/${id}`, { cookie: olga }));
    expect(done).toMatchObject({ status: 'done', decisions: [{ name: 'Пётр Сидоров', decision: 'approved' }, { name: 'Сергей Иванов', decision: 'approved' }] });
    const messages = ((await json<{ messages: { role: string; text: string }[] }>(await t.call('GET', `/app/api/threads/${threadId}/messages`, { cookie: olga }))).messages).map((m) => m.text);
    expect(messages.some((m) => m.startsWith(`Согласование №${id}`) && m.includes('согласовано и выполнено'))).toBe(true);
    expect(messages.at(-1)).toBe('Письмо ушло, продолжаю работу.');
    expect((await decide(ivan, id, true)).status).toBe(409);
  }, 30_000);

  it('a decline needs a reason and ends the request; the employee may withdraw; a stage expires in 72 hours', async () => {
    const declined = String((await sendForApproval({ to: 'a@example.com', text: 'Первое' })).sent.id);
    expect((await decide(petr, declined, false)).status).toBe(400);
    expect((await decide(petr, declined, false, 'Максимум 12 %')).status).toBe(200);
    await t.approvals.executor.idle();
    expect((await json<ChainDto>(await t.call('GET', `/app/api/approval-chains/${declined}`, { cookie: olga }))).status).toBe('declined');
    const withdrawn = String((await sendForApproval({ to: 'b@example.com', text: 'Второе' })).sent.id);
    expect((await t.call('POST', `/app/api/approval-chains/${withdrawn}/withdraw`, { cookie: olga })).status).toBe(200);
    expect((await decide(petr, withdrawn, true)).status).toBe(409);
    const expiring = String((await sendForApproval({ to: 'c@example.com', text: 'Третье' })).sent.id);
    await t.db.query(`UPDATE app.approval_chains SET stage_expires_at = now() - interval '1 minute' WHERE id = $1`, [expiring]);
    await t.approvals.executor.idle();
    expect((await json<ChainDto>(await t.call('GET', `/app/api/approval-chains/${expiring}`, { cookie: olga }))).status).toBe('expired');
    expect(t.sentMail.map((m) => m.to)).not.toContain('a@example.com');
  }, 60_000);

  // Criterion 3: the rule outranks the mark «только чтение» — a read-only action under a rule waits for «Да» too.
  it('a read-only action under a rule asks «Да» and becomes a request', async () => {
    const rule = await json<{ id: string }>(await t.call('POST', '/app/api/admin/approval-rules', { cookie: igor, body: { target: 'crm_search', stages: [[{ kind: 'user', userId: ivanId }]], enabled: true } }));
    const threadId = randomUUID();
    t.model.script({ toolCalls: [{ name: 'crm_search', args: { q: 'все сделки' } }] }, { text: 'Жду согласования.' });
    const first = await run(threadId, 'Найди сделки');
    expect(interruptOf(first)).toBeTruthy();
    const toolCallId = first.find((e) => e.type === 'TOOL_CALL_START' && e.toolCallName === 'crm_search')!.toolCallId!;
    await t.call('POST', '/app/api/approval-chains/reason', { cookie: olga, body: { toolCallId, comment: 'Нужна выгрузка для отчёта' } });
    const second = await run(threadId, null, [{ interruptId: interruptOf(first)!.id, status: 'resolved', payload: { approved: true } }]);
    expect(resultOf(second, 'crm_search')).toMatchObject({ status: 'sent_for_approval' });
    await t.call('DELETE', `/app/api/admin/approval-rules/${String(rule.id)}`, { cookie: igor });
  }, 30_000);

  it('a request without «Зачем» is not made', async () => {
    const { sent } = await sendForApproval({ to: 'd@example.com', text: 'Без причины' }, '');
    expect(JSON.stringify(sent)).toContain('APP_CHAIN_REASON_REQUIRED');
    expect((await t.db.query(`SELECT 1 FROM app.approval_chains WHERE args_hash IS NOT NULL AND summary IS NOT NULL AND comment = ''`)).rowCount).toBe(0);
  }, 30_000);

  it('the head asking passes their own stage (F4); a call broken by a restart is «итог неизвестен», «Повторить» re-runs a failed one', async () => {
    // Пётр, the head of «Продажи», asks: stage 1 is his own, only Иванов decides.
    await t.call('PUT', `/app/api/admin/approval-rules/${ruleId}`, { cookie: igor, body: { target: 'mail_send', stages: [[{ kind: 'head' }], [{ kind: 'user', userId: ivanId }]], enabled: true } });
    const own = await json<{ stages: string[] }>(await t.call('POST', '/app/api/approval-chains/preview', { cookie: petr, body: { tool: 'mail_send' } }));
    expect(own.stages[0]).toMatch(/вы сами/);
    // A request whose call started and never ended: the start of the server marks it, no second call.
    const broken = String((await sendForApproval({ to: 'e@example.com', text: 'Оборванное' })).sent.id);
    await t.db.query(`UPDATE app.approval_chains SET status = 'executing', call_started_at = now() WHERE id = $1`, [broken]);
    await t.approvals.executor.recover();
    await t.approvals.executor.idle();
    expect((await json<ChainDto>(await t.call('GET', `/app/api/approval-chains/${broken}`, { cookie: olga }))).status).toBe('unknown_outcome');
    expect(t.sentMail.map((m) => m.to)).not.toContain('e@example.com');
    // A failed one is run again on «Повторить выполнение».
    const failed = String((await sendForApproval({ to: 'f@example.com', text: 'Повтор' })).sent.id);
    await t.db.query(`UPDATE app.approval_chains SET status = 'failed', call_started_at = now(), error_code = 'APP_CONNECTOR_UNAVAILABLE', retry_until = now() + interval '1 hour' WHERE id = $1`, [failed]);
    expect((await json<ChainDto>(await t.call('GET', `/app/api/approval-chains/${failed}`, { cookie: olga }))).canRetry).toBe(true);
    t.model.script({ text: 'Готово.' });
    expect((await t.call('POST', `/app/api/approval-chains/${failed}/retry`, { cookie: olga })).status).toBe(200);
    await t.approvals.executor.idle();
    expect(t.sentMail.map((m) => m.to)).toContain('f@example.com');
  }, 60_000);

  // Review 22.11: a request that cannot run at all (its agent is gone) once stopped every request after it.
  it('a request that cannot run fails alone; the next agreed one runs', async () => {
    const stuck = String((await sendForApproval({ to: 'g@example.com', text: 'Застрявшее' })).sent.id);
    const fine = String((await sendForApproval({ to: 'h@example.com', text: 'Следующее' })).sent.id);
    await t.db.query(`UPDATE app.approval_chains SET status = 'executing', agent_id = 'ghost' WHERE id = $1`, [stuck]);
    await t.db.query(`UPDATE app.approval_chains SET status = 'executing' WHERE id = $1`, [fine]);
    t.model.script({ text: 'Отправил.' });
    await t.approvals.executor.idle();
    expect((await json<ChainDto>(await t.call('GET', `/app/api/approval-chains/${stuck}`, { cookie: olga }))).status).toBe('failed');
    expect((await json<ChainDto>(await t.call('GET', `/app/api/approval-chains/${fine}`, { cookie: olga }))).status).toBe('done');
    expect(t.sentMail.map((m) => m.to)).toContain('h@example.com');
  }, 60_000);

  // Section 10: a person met again in a later stage is asked once — the stage is passed, not sent to the admins.
  it('asks a repeated approver once', async () => {
    await t.call('PUT', `/app/api/admin/approval-rules/${ruleId}`, { cookie: igor, body: { target: 'mail_send', stages: [[{ kind: 'user', userId: ivanId }], [{ kind: 'user', userId: ivanId }]], enabled: true } });
    const id = String((await sendForApproval({ to: 'i@example.com', text: 'Иванов дважды' })).sent.id);
    t.model.script({ text: 'Готово.' });
    expect((await decide(ivan, id, true)).status).toBe(200);
    await t.approvals.executor.idle();
    expect((await json<ChainDto>(await t.call('GET', `/app/api/approval-chains/${id}`, { cookie: olga }))).status).toBe('done');
    expect((await chainsOf(igor)).forMe).toEqual([]);
  }, 60_000);
});
