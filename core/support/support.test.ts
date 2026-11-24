// Complaints (docs/specs/[20.11.2026]-feedback-and-value.md, steps 1–3; F9): a complaint becomes a ticket — its comment
// the first message — with a copy of the conversation as the person saw it and its files; a second complaint about the
// same turn is a new message of the first and opens it again; only the person's own conversation; «Поддержка» only with
// «Агенты». The conversation of a ticket, requests and the counter — conversation.test.ts.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminTicketDto, ComplaintResponse, ComplaintStateResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureThread } from '../memory/memory.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { chatRoot } from '../workspace/layout.ts';
import { copyFiles } from './snapshot.ts';
import { withoutHolders } from './test-db.ts';
import { complain } from './tickets.ts';

let t: TestApp;
let olgaId: string;
let igorId: string;
let olga: string;
let petr: string;
let igor: string;

type Part = Record<string, unknown>;
const text = (value: string): Part => ({ type: 'text', text: value });
const call = (toolName: string, args: unknown, result: unknown): Part => ({ type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: randomUUID(), toolName, args, result } });

let clock = Date.parse('2026-11-01T07:00:00Z');
async function conversation(userId: string, turns: [role: 'user' | 'assistant', parts: Part[]][]): Promise<string> {
  const threadId = randomUUID();
  await ensureThread(t.memory, { threadId, resourceId: userId, agentId: 'sales', kind: 'chat', title: 'КП для «Вектора»' });
  await t.memory.saveMessages({
    messages: turns.map(([role, parts]) => ({ id: randomUUID(), threadId, resourceId: userId, role, createdAt: new Date((clock += 60_000)), content: { format: 2 as const, parts: parts as never } })),
  });
  return threadId;
}

const json = async <T>(res: Response): Promise<T> => {
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return (await res.json()) as T;
};

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова' });
  await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
  igorId = await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
  igor = await t.signIn('igor@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('complaints', () => {
  it('makes a ticket with the conversation as the person saw it, its files, the model and the notice to the support', async () => {
    const threadId = await conversation(olgaId, [
      ['user', [text('Сделай КП для «Вектора»')]],
      ['assistant', [{ type: 'reasoning', reasoning: 'служебное рассуждение' }, text('Готово, вот КП.'), call('show_file', { path: 'КП-Вектор.docx' }, { shown: true, path: 'КП-Вектор.docx', name: 'КП-Вектор.docx', bytes: 9 })]],
      ['user', [text('Цена не та')]],
      ['assistant', [text('Исправил.')]],
    ]);
    const folder = chatRoot(t.workspaceRoot, olgaId, threadId);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'КП-Вектор.docx'), 'кп вектор');
    await t.db.query(
      `INSERT INTO app.usage_events (at, user_id, agent_id, model, deployment, is_subscription, input_tokens, output_tokens, cost_rub, litellm_call_id)
       VALUES ('2026-11-01T07:01:30Z', $1, 'sales', 'test-paid', 'test-paid-1', false, 1, 1, 1, gen_random_uuid()::text)`,
      [olgaId],
    );

    const made = await json<ComplaintResponse>(await t.call('POST', '/app/api/me/support', { cookie: olga, body: { threadId, turn: 1, comment: 'Цена на С21 из прошлогоднего прайса' } }));
    expect(made.appended).toBe(false);

    const ticket = await json<AdminTicketDto>(await t.call('GET', `/app/api/admin/support/${made.id}`, { cookie: igor }));
    expect(ticket).toMatchObject({ author: 'Ольга Смирнова', kind: 'complaint', agentName: 'Продажи', status: 'open', turn: 1, models: ['test-paid'] });
    expect(ticket.messages).toMatchObject([{ side: 'employee', author: 'Ольга Смирнова', text: 'Цена на С21 из прошлогоднего прайса', files: [] }]);
    expect(ticket.snapshot.map((m) => [m.role, m.text, m.turn])).toEqual([
      ['user', 'Сделай КП для «Вектора»', 1],
      ['assistant', 'Готово, вот КП.', 1],
      ['user', 'Цена не та', 2],
      ['assistant', 'Исправил.', 2],
    ]);
    expect(JSON.stringify(ticket.snapshot)).not.toContain('служебное');
    expect(ticket.snapshot[1]!.marks).toEqual(['файл: КП-Вектор.docx']);
    expect(ticket.contextFiles).toEqual([{ ord: 0, name: 'КП-Вектор.docx', size: Buffer.byteLength('кп вектор'), state: 'copied' }]);
    const file = await t.call('GET', `/app/api/admin/support/${made.id}/files/0`, { cookie: igor });
    expect(await file.text()).toBe('кп вектор');
    // The files of the conversation are the support's to see, not the employee's ticket files.
    expect((await t.call('GET', `/app/api/me/support/${made.id}/files/0`, { cookie: olga })).status).toBe(404);

    const told = await t.db.query<{ title: string; link: string }>(`SELECT title, link FROM app.notifications WHERE user_id = $1 AND kind = 'support_new'`, [igorId]);
    expect(told.rows).toEqual([{ title: `Новая жалоба №${made.id}`, link: `/admin/support/${made.id}` }]);

    // Removing the conversation leaves the ticket whole.
    expect((await t.call('DELETE', `/app/api/threads/${threadId}`, { cookie: olga })).status).toBe(200);
    const after = await json<AdminTicketDto>(await t.call('GET', `/app/api/admin/support/${made.id}`, { cookie: igor }));
    expect(after.snapshot).toHaveLength(4);
    expect(await (await t.call('GET', `/app/api/admin/support/${made.id}/files/0`, { cookie: igor })).text()).toBe('кп вектор');
  });

  it('adds a second complaint about the same turn to the first as a message, opening it again when closed', async () => {
    const threadId = await conversation(olgaId, [['user', [text('Сколько стоит С21?')]], ['assistant', [text('400 ₽')]]]);
    const first = await json<ComplaintResponse>(await t.call('POST', '/app/api/me/support', { cookie: olga, body: { threadId, turn: 1, comment: 'Старая цена' } }));
    const state = await json<ComplaintStateResponse>(await t.call('GET', `/app/api/me/support/turn?threadId=${threadId}&turn=1`, { cookie: olga }));
    expect(state.ticket).toEqual({ id: first.id, status: 'open' });
    const second = await json<ComplaintResponse>(await t.call('POST', '/app/api/me/support', { cookie: olga, body: { threadId, turn: 1, comment: 'Сейчас 495 ₽' } }));
    expect(second).toEqual({ id: first.id, appended: true });
    const ticket = await json<AdminTicketDto>(await t.call('GET', `/app/api/admin/support/${first.id}`, { cookie: igor }));
    expect(ticket.messages.map((m) => [m.side, m.text])).toEqual([
      ['employee', 'Старая цена'],
      ['employee', 'Сейчас 495 ₽'],
    ]);

    await json(await t.call('POST', `/app/api/admin/support/${first.id}/status`, { cookie: igor, body: { status: 'rejected' } }));
    await json(await t.call('POST', '/app/api/me/support', { cookie: olga, body: { threadId, turn: 1, comment: 'Цена всё ещё старая' } }));
    const reopened = await json<AdminTicketDto>(await t.call('GET', `/app/api/admin/support/${first.id}`, { cookie: igor }));
    expect(reopened).toMatchObject({ status: 'open', closedAt: null, closedSide: null });
    expect(reopened.messages.at(-1)).toMatchObject({ side: 'employee', text: 'Цена всё ещё старая' });
  });

  // The browser counts only what the person wrote: a turn the server started on their behalf (the outcome of an agreed
  // request) is not a turn of the complaint, and the chat does not show it.
  it('numbers the turns by the person’s own messages only', async () => {
    const threadId = await conversation(olgaId, [
      ['user', [text('Отправь письмо клиенту')]],
      ['assistant', [text('Отправлено на согласование №3')]],
      ['user', [text('[Итог согласования №3] Действие «Письмо» согласовано и выполнено.')]],
      ['assistant', [text('Письмо ушло.')]],
      ['user', [text('Спасибо')]],
      ['assistant', [text('Пожалуйста')]],
    ]);
    const { id } = await json<ComplaintResponse>(await t.call('POST', '/app/api/me/support', { cookie: olga, body: { threadId, turn: 2, comment: 'Не то' } }));
    const ticket = await json<AdminTicketDto>(await t.call('GET', `/app/api/admin/support/${id}`, { cookie: igor }));
    expect(ticket.snapshot.map((m) => [m.text, m.turn])).toEqual([
      ['Отправь письмо клиенту', 1],
      ['Отправлено на согласование №3', 1],
      ['Письмо ушло.', 1],
      ['Спасибо', 2],
      ['Пожалуйста', 2],
    ]);
    const history = (await (await t.call('GET', `/app/api/threads/${threadId}/messages`, { cookie: olga })).json()) as { messages: { role: string; text: string }[] };
    expect(history.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['Отправь письмо клиенту', 'Спасибо']);
  });

  it('takes only the person’s own conversation and a turn it has', async () => {
    const threadId = await conversation(olgaId, [['user', [text('Привет')]], ['assistant', [text('Здравствуйте')]]]);
    expect((await t.call('POST', '/app/api/me/support', { cookie: petr, body: { threadId, turn: 1, comment: 'Плохо' } })).status).toBe(404);
    expect((await t.call('POST', '/app/api/me/support', { cookie: olga, body: { threadId, turn: 5, comment: 'Плохо' } })).status).toBe(400);
    expect((await t.call('POST', '/app/api/me/support', { cookie: olga, body: { threadId, turn: 1, comment: '   ' } })).status).toBe(400);
    // A zero character Postgres cannot keep: refused as a bad comment, not failed on saving.
    const zero = await t.call('POST', '/app/api/me/support', { cookie: olga, body: { threadId, turn: 1, comment: 'Пло\0хо' } });
    expect(zero.status).toBe(400);
    expect(((await zero.json()) as { error: { code: string } }).error.code).toBe('APP_VALIDATION_FAILED');
  });

  // Sent again after an error, a complaint made already would be a second message of it.
  it('keeps a complaint made and answers it as made when whom to tell cannot be read', async () => {
    const threadId = await conversation(olgaId, [['user', [text('Итог за неделю')]], ['assistant', [text('Итог: 0')]]]);
    const deps = { db: withoutHolders(t.db), memory: t.memory, storage: t.storage, workspaceRoot: t.workspaceRoot, timezone: 'Europe/Moscow', agentName: (id: string) => id };
    expect(await complain(deps, olgaId, { threadId, turn: 1, comment: 'Не посчитал' })).toMatchObject({ appended: false });
    const state = await json<ComplaintStateResponse>(await t.call('GET', `/app/api/me/support/turn?threadId=${threadId}&turn=1`, { cookie: olga }));
    expect(state.ticket).toMatchObject({ status: 'open' });
  });

  it('opens «Поддержка» only with «Агенты»', async () => {
    expect((await t.call('GET', '/app/api/admin/support', { cookie: olga })).status).toBe(403);
    expect((await t.call('GET', '/app/api/admin/support/1', { cookie: olga })).status).toBe(403);
    expect((await t.call('POST', '/app/api/admin/support/1/status', { cookie: olga, body: { status: 'resolved' } })).status).toBe(403);
    expect((await t.call('POST', '/app/api/admin/support/1/messages', { cookie: olga, body: {} })).status).toBe(403);
  });

  it('copies files while they fit in the limit and names the rest', () => {
    const folder = join(t.workspaceRoot, 'limit-test');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'big.pdf'), 'x'.repeat(30));
    writeFileSync(join(folder, 'small.txt'), 'y'.repeat(10));
    // What the agent may put in place of a file: a pipe (reading it would hang the server) and a link out of the folder.
    execFileSync('mkfifo', [join(folder, 'pipe.docx')]);
    writeFileSync(join(t.workspaceRoot, 'colleague.docx'), 'чужое');
    symlinkSync(join(t.workspaceRoot, 'colleague.docx'), join(folder, 'link.docx'));
    const copied = copyFiles(
      folder,
      [{ name: 'big.pdf', path: 'big.pdf' }, { name: 'small.txt', path: 'small.txt' }, { name: 'gone.docx', path: 'gone.docx' }, { name: 'out', path: '../../etc/passwd' }, { name: 'pipe.docx', path: 'pipe.docx' }, { name: 'link.docx', path: 'link.docx' }],
      20,
    );
    expect(copied.map((f) => [f.name, f.state, f.size])).toEqual([
      ['big.pdf', 'too_large', 30],
      ['small.txt', 'copied', 10],
      ['gone.docx', 'gone', null],
      ['out', 'gone', null],
      ['pipe.docx', 'gone', null],
      ['link.docx', 'gone', null],
    ]);
  });
});
