// Where notifications come from (docs/specs/[20.11.2026]-notifications.md, steps 2 and 7): an answer the person left
// before it ended, a question of a conversation on «Ждёт подтверждения» and its term, the reminder, a broken access, a
// project opened to the person, the monthly limit.
import { randomUUID } from 'node:crypto';
import type { ApprovalsResponse, NotificationList, NotificationsResponse, ProjectDto } from '@bba/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { remindExpiring } from '../approvals/reminders.ts';
import { expireChatQuestions } from '../approvals/requests.ts';
import { markCredentialBroken } from '../connections/credentials.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let olga: string;
let petr: string;
let petrId: string;
let igor: string;
let igorId: string;
let sales: string;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const listOf = async (cookie: string) => (await json<NotificationList>(await t.call('GET', '/app/api/me/notifications/list', { cookie }))).items;
const body = (threadId: string, text: string | null, resume?: unknown) => ({
  threadId,
  runId: randomUUID(),
  messages: text ? [{ id: randomUUID(), role: 'user', content: text }] : [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
  ...(resume ? { resume } : {}),
});
const run = async (cookie: string, threadId: string, text: string | null, resume?: unknown) => {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', { cookie, body: body(threadId, text, resume) });
  return { status: res.status, text: await res.text() };
};
// The tab is closed right after the answer began; CopilotKit lets the agent finish without it.
async function runAndLeave(cookie: string, threadId: string, text: string): Promise<void> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', { cookie, body: body(threadId, text) });
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel();
}
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 100 && !done(value); i++) {
    await new Promise((r) => setTimeout(r, 50));
    value = await read();
  }
  return value;
}
const sendMail = { toolCalls: [{ name: 'mail_send', args: { to: 'client@example.com', text: 'Счёт во вложении' } }] };
const questionOf = async (threadId: string) =>
  (await t.db.query<{ id: string; run_id: string; tool_call_id: string; created_at: Date; expires_at: Date; status: string; closed_at: Date | null }>('SELECT * FROM app.approval_requests WHERE thread_id = $1', [threadId])).rows[0]!;

beforeAll(async () => {
  t = await createTestApp();
  igorId = await t.createUser({ email: 'igor@example.com', name: 'Игорь Власов', roleIds: [await t.roleId('superadmin')] });
  sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова', departmentIds: [sales] });
  petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр Иванов' });
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
  igor = await t.signIn('igor@example.com');
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  t.sentMail.length = 0;
});

describe('an answer the person left before it ended', () => {
  it('tells «Ответ готов» with the conversation; an answer watched to its end tells nothing', async () => {
    const watched = randomUUID();
    t.model.script({ text: 'Готово, вот сводка.' });
    expect((await run(olga, watched, 'Сводка по сделкам')).status).toBe(200);
    const left = randomUUID();
    t.model.script({ text: 'Коммерческое предложение готово, вот оно целиком.', delayMs: 400 });
    await runAndLeave(olga, left, 'Сделай КП для Вектора');
    const items = await eventually(() => listOf(olga), (list) => list.some((n) => n.kind === 'answer_ready'));
    const ready = items.filter((n) => n.kind === 'answer_ready');
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ title: 'Ответ готов', link: `/agents/sales?thread=${left}`, read: false });
    expect(ready[0]!.body).toMatch(/^Разговор «.+»$/);
    // Opening the conversation reads it.
    await t.call('POST', '/app/api/copilotkit/agent/sales/connect', { cookie: olga, body: body(left, null) });
    expect((await listOf(olga)).find((n) => n.id === ready[0]!.id)?.read).toBe(true);
  });

  it('tells «Ждёт вашего решения» instead when the answer stopped at a question «Да»', async () => {
    const left = randomUUID();
    // The model thinks a while before it asks: the tab is gone by then.
    t.model.script({ ...sendMail, delayMs: 400 });
    await runAndLeave(olga, left, 'Отправь клиенту счёт');
    const items = await eventually(() => listOf(olga), (list) => list.some((n) => n.kind === 'approval_waiting' && n.link.includes(left)));
    const question = items.find((n) => n.kind === 'approval_waiting' && n.link.includes(left))!;
    expect(question).toMatchObject({ title: 'Ждёт вашего решения', link: `/agents/sales?thread=${left}` });
    expect(question.body).toMatch(/^Разговор «.+» · Отправить письмо клиенту$/);
    expect(items.some((n) => n.kind === 'answer_ready' && n.link.includes(left))).toBe(false);
  });
});

describe('a question of a conversation (decision of the owner 21.11, F4)', () => {
  it('waits on «Ждёт подтверждения» with its conversation, burns after a day, and its old card runs nothing', async () => {
    const threadId = randomUUID();
    t.model.script(sendMail);
    await run(olga, threadId, 'Отправь клиенту счёт');
    const q = await questionOf(threadId);
    expect(q.expires_at.getTime() - q.created_at.getTime()).toBe(24 * 3600 * 1000);

    const screen = await json<ApprovalsResponse>(await t.call('GET', '/app/api/approvals', { cookie: olga }));
    expect(screen.pending.find((p) => p.id === q.id)).toMatchObject({ task: null, conversation: { threadId, agentId: 'sales' }, action: { title: 'Отправить письмо клиенту' } });
    expect((await json<NotificationsResponse>(await t.call('GET', '/app/api/me/notifications', { cookie: olga }))).pendingApprovals).toBeGreaterThanOrEqual(1);

    // A day later (the clock of the database is moved by the question's own times).
    await t.db.query(`UPDATE app.approval_requests SET created_at = created_at - interval '24 hours 1 minute', expires_at = expires_at - interval '24 hours 1 minute' WHERE id = $1`, [q.id]);
    expect(await expireChatQuestions(t.db)).toBe(1);
    expect((await questionOf(threadId)).status).toBe('expired');
    const after = await json<ApprovalsResponse>(await t.call('GET', '/app/api/approvals', { cookie: olga }));
    expect(after.pending.some((p) => p.id === q.id)).toBe(false);

    // The chat shows the call as burnt at once, before the next message.
    const connect = await (await t.call('POST', '/app/api/copilotkit/agent/sales/connect', { cookie: olga, body: body(threadId, null) })).text();
    expect(connect).toContain('\\"expiredHours\\":24');
    expect(connect).not.toContain('"interrupt"');

    // «Да» on the old card: refused with the term, the letter is not sent.
    const resume = [{ interruptId: `mastra-approval::${q.run_id}::${q.tool_call_id}`, status: 'resolved', payload: { approved: true } }];
    const answered = await run(olga, threadId, null, resume);
    expect(answered.status).toBe(410);
    expect(answered.text).toContain('APP_APPROVAL_EXPIRED');
    expect(answered.text).toContain('Вопрос истёк: вы не ответили за 24 ч. Действие не выполнено.');
    expect(t.sentMail).toEqual([]);

    // The next message gives the waiting answer its refusal: the model hears the term, the letter stays unsent.
    t.model.script({ text: 'Хорошо, письмо не отправлено.' }, { text: 'Слушаю.' });
    expect((await run(olga, threadId, 'Ладно, давай другое')).status).toBe(200);
    expect((await questionOf(threadId)).closed_at).not.toBeNull();
    expect(JSON.stringify(t.model.requests.at(-2)?.messages ?? t.model.requests.at(-1)?.messages)).toContain('Истекло: сотрудник не ответил за 24 ч.');
    expect(t.sentMail).toEqual([]);
  });

  it('a shorter term set by the admin touches only new questions; only the right «Агенты» sets it', async () => {
    const first = randomUUID();
    t.model.script(sendMail);
    await run(olga, first, 'Отправь клиенту счёт');
    expect((await t.call('PUT', '/app/api/admin/approval-settings', { cookie: olga, body: { chatTtlHours: 2, backgroundTtlHours: 72 } })).status).toBe(403);
    expect((await t.call('PUT', '/app/api/admin/approval-settings', { cookie: igor, body: { chatTtlHours: 0, backgroundTtlHours: 72 } })).status).toBe(400);
    const saved = await t.call('PUT', '/app/api/admin/approval-settings', { cookie: igor, body: { chatTtlHours: 2, backgroundTtlHours: 72 } });
    expect(await json<unknown>(saved)).toEqual({ chatTtlHours: 2, backgroundTtlHours: 72 });
    const second = randomUUID();
    t.model.script(sendMail);
    await run(olga, second, 'Отправь клиенту счёт ещё раз');
    const term = async (threadId: string) => {
      const q = await questionOf(threadId);
      return (q.expires_at.getTime() - q.created_at.getTime()) / 3600_000;
    };
    expect(await term(first)).toBe(24);
    expect(await term(second)).toBe(2);
    await t.call('PUT', '/app/api/admin/approval-settings', { cookie: igor, body: { chatTtlHours: 24, backgroundTtlHours: 72 } });
  });

  it('reminds once when a quarter of the term is left', async () => {
    const threadId = randomUUID();
    t.model.script(sendMail);
    await run(olga, threadId, 'Отправь клиенту счёт');
    const q = await questionOf(threadId);
    await t.db.query(`UPDATE app.approval_requests SET created_at = now() - interval '18 hours', expires_at = now() + interval '6 hours' WHERE id = $1`, [q.id]);
    await remindExpiring(t.db);
    await remindExpiring(t.db);
    const reminders = (await listOf(olga)).filter((n) => n.kind === 'approval_expiring' && n.link.includes(threadId));
    expect(reminders).toMatchObject([{ title: 'Вопрос сгорит через 6 ч', link: `/agents/sales?thread=${threadId}` }]);
  });

  it('never lists a question of an admin’s draft check of a prompt', async () => {
    const { rows } = await t.db.query<{ id: string }>(
      `INSERT INTO app.approval_requests (user_id, agent_id, thread_id, run_id, tool_call_id, tool, summary, status, expires_at, run_kind)
       VALUES ($1, 'sales', 'draft-thread', 'draft-run', 'draft-call', 'mail_send', 'Отправить письмо клиенту', 'pending', now() + interval '1 day', 'draft') RETURNING id`,
      [igorId],
    );
    const screen = await json<ApprovalsResponse>(await t.call('GET', '/app/api/approvals', { cookie: igor }));
    expect(screen.pending.some((p) => p.id === rows[0]!.id)).toBe(false);
    expect((await json<NotificationsResponse>(await t.call('GET', '/app/api/me/notifications', { cookie: igor }))).pendingApprovals).toBe(0);
  });
});

describe('other events', () => {
  it('tells once that an access broke, when it turns from working to broken; a new breakage tells again', async () => {
    const credential = (status: string) =>
      t.db.query(`INSERT INTO app.connector_credentials (user_id, connector_id, kind, ciphertext, iv, key_version, status) VALUES ($1, 'crm', 'static', '\\x00', '\\x00', 1, $2)
                  ON CONFLICT (user_id, connector_id) DO UPDATE SET status = EXCLUDED.status`, [petrId, status]);
    await credential('connected');
    await markCredentialBroken(t.db, { userId: petrId, connectorId: 'crm', title: 'Битрикс24', errorCode: 'APP_CONNECTOR_AUTH_FAILED' });
    await markCredentialBroken(t.db, { userId: petrId, connectorId: 'crm', title: 'Битрикс24', errorCode: 'APP_CONNECTOR_AUTH_FAILED' });
    expect((await listOf(petr)).filter((n) => n.kind === 'connection_broken')).toMatchObject([{ title: 'Не работает доступ к Битрикс24', link: '/settings/connections' }]);
    await credential('connected');
    await markCredentialBroken(t.db, { userId: petrId, connectorId: 'crm', title: 'Битрикс24', errorCode: 'APP_CONNECTOR_AUTH_FAILED' });
    expect((await listOf(petr)).filter((n) => n.kind === 'connection_broken')).toHaveLength(2);
  });

  it('tells the people a project is opened to — by name or by department — once; the whole organisation is not told', async () => {
    const created = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Тендер на поставку', access: { mode: 'list', departmentIds: [], userIds: [petrId] } } });
    const project = await json<ProjectDto>(created);
    const shared = (await listOf(petr)).filter((n) => n.kind === 'project_shared');
    expect(shared).toMatchObject([{ title: 'Вам открыли проект «Тендер на поставку»', body: 'Проект ведёт Ольга Смирнова. Он уже в списке «Проекты».', link: `/projects/${project.id}` }]);
    // The same list saved again tells nobody; a department added tells its people.
    await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [sales, igorId]);
    await t.call('PUT', `/app/api/projects/${project.id}/access`, { cookie: olga, body: { mode: 'list', departmentIds: [], userIds: [petrId] } });
    await t.call('PUT', `/app/api/projects/${project.id}/access`, { cookie: olga, body: { mode: 'list', departmentIds: [sales], userIds: [petrId] } });
    expect((await listOf(petr)).filter((n) => n.kind === 'project_shared')).toHaveLength(1);
    expect((await listOf(igor)).filter((n) => n.kind === 'project_shared' && n.link === `/projects/${project.id}`)).toHaveLength(1);
    expect((await listOf(olga)).some((n) => n.kind === 'project_shared' && n.link === `/projects/${project.id}`)).toBe(false);
    // Open to the whole organisation: nobody is told.
    const open = await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Общий регламент', access: { mode: 'org', departmentIds: [], userIds: [] } } }));
    expect((await listOf(petr)).some((n) => n.link === `/projects/${open.id}`)).toBe(false);
  });

  it('tells 80 % of the monthly limit and its end, each once a month', async () => {
    await t.db.query('INSERT INTO app.user_limits (user_id, monthly_rub) VALUES ($1, 10) ON CONFLICT (user_id) DO UPDATE SET monthly_rub = 10', [petrId]);
    const charge = (id: string, cost: number) =>
      t.app.request('/app/api/internal/usage', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${t.ledgerSecret}` },
        body: JSON.stringify({ litellm_call_id: id, status: 'success', startTime: Date.now() / 1000, model_group: 'test-paid', response_cost: cost, metadata: { user_api_key_user_id: petrId } }),
      });
    expect((await charge('call-1', 8.5)).status).toBe(200);
    expect((await charge('call-2', 0.5)).status).toBe(200);
    expect((await listOf(petr)).filter((n) => n.kind.startsWith('limit_'))).toMatchObject([{ kind: 'limit_near', title: expect.stringMatching(/^Израсходовано 8\d % лимита на [а-я]+$/), link: '/settings/usage' }]);
    expect((await charge('call-3', 2)).status).toBe(200);
    expect((await charge('call-4', 1)).status).toBe(200);
    const limits = (await listOf(petr)).filter((n) => n.kind.startsWith('limit_')).map((n) => n.kind);
    expect(limits.sort()).toEqual(['limit_exhausted', 'limit_near']);
  });
});
