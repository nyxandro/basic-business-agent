// Complaints (docs/specs/[20.11.2026]-feedback-and-value.md, steps 1–3): a complaint becomes a ticket with a copy of the
// conversation as the person saw it and its files; a second complaint about the same turn adds to the first; only the
// person's own conversation; «Поддержка» only with «Агенты»; the answer goes back as a notification and «Мои обращения».
// Requests written straight from «Мои обращения» (F7, owner 24.11): a subject, a text and the files attached, nothing of a
// conversation; the support's answer reaches the open page of the employee at once.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORT_FILES_MAX_BYTES, SUPPORT_REQUEST_FILES_MAX, type AdminTicketDto, type AdminTicketsResponse, type ComplaintResponse, type ComplaintStateResponse, type MyTicketsResponse, type SupportRequestResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureThread } from '../memory/memory.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { chatRoot } from '../workspace/layout.ts';
import { copyFiles } from './snapshot.ts';

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
    expect(ticket).toMatchObject({ author: 'Ольга Смирнова', agentName: 'Продажи', status: 'new', turn: 1, comment: 'Цена на С21 из прошлогоднего прайса', models: ['test-paid'] });
    expect(ticket.snapshot.map((m) => [m.role, m.text, m.turn])).toEqual([
      ['user', 'Сделай КП для «Вектора»', 1],
      ['assistant', 'Готово, вот КП.', 1],
      ['user', 'Цена не та', 2],
      ['assistant', 'Исправил.', 2],
    ]);
    expect(JSON.stringify(ticket.snapshot)).not.toContain('служебное');
    expect(ticket.snapshot[1]!.marks).toEqual(['файл: КП-Вектор.docx']);
    expect(ticket.files).toEqual([{ ord: 0, name: 'КП-Вектор.docx', size: Buffer.byteLength('кп вектор'), state: 'copied' }]);
    const file = await t.call('GET', `/app/api/admin/support/${made.id}/files/0`, { cookie: igor });
    expect(await file.text()).toBe('кп вектор');

    const told = await t.db.query<{ title: string; link: string }>(`SELECT title, link FROM app.notifications WHERE user_id = $1 AND kind = 'support_new'`, [igorId]);
    expect(told.rows).toEqual([{ title: `Новая жалоба №${made.id}`, link: `/admin/support/${made.id}` }]);

    // Removing the conversation leaves the ticket whole.
    expect((await t.call('DELETE', `/app/api/threads/${threadId}`, { cookie: olga })).status).toBe(200);
    const after = await json<AdminTicketDto>(await t.call('GET', `/app/api/admin/support/${made.id}`, { cookie: igor }));
    expect(after.snapshot).toHaveLength(4);
    expect(await (await t.call('GET', `/app/api/admin/support/${made.id}/files/0`, { cookie: igor })).text()).toBe('кп вектор');
  });

  it('adds a second complaint about the same turn to the first', async () => {
    const threadId = await conversation(olgaId, [['user', [text('Сколько стоит С21?')]], ['assistant', [text('400 ₽')]]]);
    const first = await json<ComplaintResponse>(await t.call('POST', '/app/api/me/support', { cookie: olga, body: { threadId, turn: 1, comment: 'Старая цена' } }));
    const state = await json<ComplaintStateResponse>(await t.call('GET', `/app/api/me/support/turn?threadId=${threadId}&turn=1`, { cookie: olga }));
    expect(state.ticket).toEqual({ id: first.id, status: 'new' });
    const second = await json<ComplaintResponse>(await t.call('POST', '/app/api/me/support', { cookie: olga, body: { threadId, turn: 1, comment: 'Сейчас 495 ₽' } }));
    expect(second).toEqual({ id: first.id, appended: true });
    const ticket = await json<AdminTicketDto>(await t.call('GET', `/app/api/admin/support/${first.id}`, { cookie: igor }));
    expect(ticket.comment).toMatch(/^Старая цена\n\nДописано \d\d\.\d\d, \d\d:\d\d: Сейчас 495 ₽$/);
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
  });

  it('opens «Поддержка» only with «Агенты»', async () => {
    expect((await t.call('GET', '/app/api/admin/support', { cookie: olga })).status).toBe(403);
    expect((await t.call('GET', '/app/api/admin/support/1', { cookie: olga })).status).toBe(403);
    expect((await t.call('PATCH', '/app/api/admin/support/1', { cookie: olga, body: { status: 'resolved', reply: null, seen: new Date().toISOString() } })).status).toBe(403);
  });

  it('sends the answer and the state to the employee, who sees only their own requests', async () => {
    const threadId = await conversation(olgaId, [['user', [text('Сроки поставки?')]], ['assistant', [text('Неделя')]]]);
    const { id } = await json<ComplaintResponse>(await t.call('POST', '/app/api/me/support', { cookie: olga, body: { threadId, turn: 1, comment: 'Сроки другие' } }));
    const list = await json<AdminTicketsResponse>(await t.call('GET', '/app/api/admin/support?status=new', { cookie: igor }));
    expect(list.tickets.map((x) => x.id)).toContain(id);

    const opened = await json<AdminTicketDto>(await t.call('GET', `/app/api/admin/support/${id}`, { cookie: igor }));
    const done = await json<AdminTicketDto>(await t.call('PATCH', `/app/api/admin/support/${id}`, { cookie: igor, body: { status: 'resolved', reply: 'Обновили сроки в базе знаний', seen: opened.updatedAt } }));
    // A page opened before this answer does not overwrite it.
    const stale = await t.call('PATCH', `/app/api/admin/support/${id}`, { cookie: igor, body: { status: 'in_progress', reply: 'Другой ответ', seen: opened.updatedAt } });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('APP_SUPPORT_STALE');
    expect(done).toMatchObject({ status: 'resolved', reply: 'Обновили сроки в базе знаний', handledBy: 'Игорь' });
    const told = await t.db.query<{ title: string }>(`SELECT title FROM app.notifications WHERE user_id = $1 AND kind = 'support_reply'`, [olgaId]);
    expect(told.rows.map((r) => r.title)).toContain(`Ответ на обращение №${id}`);

    const mine = await json<MyTicketsResponse>(await t.call('GET', '/app/api/me/support', { cookie: olga }));
    expect(mine.tickets.find((x) => x.id === id)).toMatchObject({ status: 'resolved', reply: 'Обновили сроки в базе знаний', agentName: 'Продажи' });
    expect((await json<MyTicketsResponse>(await t.call('GET', '/app/api/me/support', { cookie: petr }))).tickets).toEqual([]);

    // A closed ticket only opens again.
    expect((await t.call('PATCH', `/app/api/admin/support/${id}`, { cookie: igor, body: { status: 'rejected', reply: null, seen: done.updatedAt } })).status).toBe(409);
    expect((await json<AdminTicketDto>(await t.call('PATCH', `/app/api/admin/support/${id}`, { cookie: igor, body: { status: 'in_progress', reply: 'Смотрим ещё', seen: done.updatedAt } }))).status).toBe('in_progress');
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

describe('requests straight to the support', () => {
  const file = (name: string, content: string | Uint8Array) => new File([content], name);
  function form(fields: { subject?: string; text?: string; files?: File[] }): FormData {
    const f = new FormData();
    if (fields.subject !== undefined) f.append('subject', fields.subject);
    if (fields.text !== undefined) f.append('text', fields.text);
    for (const x of fields.files ?? []) f.append('files', x);
    return f;
  }
  const send = (cookie: string, body: FormData) => t.app.request('/app/api/me/support/requests', { method: 'POST', body, headers: { cookie, origin: TEST_PUBLIC_URL } });
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  it('makes a ticket of the subject, the text and the files attached — nothing of a conversation — and tells the support', async () => {
    const res = await send(olga, form({ subject: '  Не приходит письмо со сводкой  ', text: 'Вчера и сегодня сводки не было.', files: [file('экран.png', 'PNG-байты'), file('лог.txt', 'строка')] }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as SupportRequestResponse;

    const row = (await json<AdminTicketsResponse>(await t.call('GET', '/app/api/admin/support', { cookie: igor }))).tickets.find((x) => x.id === id);
    expect(row).toMatchObject({ kind: 'request', subject: 'Не приходит письмо со сводкой', author: 'Ольга Смирнова', agentId: null, agentName: null, status: 'new' });
    const detail = await json<AdminTicketDto>(await t.call('GET', `/app/api/admin/support/${id}`, { cookie: igor }));
    expect(detail).toMatchObject({ kind: 'request', comment: 'Вчера и сегодня сводки не было.', turn: null, snapshot: [], models: [], instructionsAt: null, taskId: null });
    expect(detail.files).toEqual([
      { ord: 0, name: 'экран.png', size: Buffer.byteLength('PNG-байты'), state: 'copied' },
      { ord: 1, name: 'лог.txt', size: Buffer.byteLength('строка'), state: 'copied' },
    ]);
    expect(await (await t.call('GET', `/app/api/admin/support/${id}/files/1`, { cookie: igor })).text()).toBe('строка');

    const told = await t.db.query<{ title: string; link: string }>(`SELECT title, link FROM app.notifications WHERE user_id = $1 AND kind = 'support_new' AND subject_ref = $2`, [igorId, `ticket:${id}`]);
    expect(told.rows).toEqual([{ title: `Новое обращение №${id}`, link: `/admin/support/${id}` }]);

    const mine = (await json<MyTicketsResponse>(await t.call('GET', '/app/api/me/support', { cookie: olga }))).tickets.find((x) => x.id === id);
    expect(mine).toMatchObject({ kind: 'request', subject: 'Не приходит письмо со сводкой', agentName: null, comment: 'Вчера и сегодня сводки не было.', files: ['экран.png', 'лог.txt'], status: 'new', reply: null });
  });

  it('takes a request without files, and each one is its own ticket', async () => {
    const first = (await (await send(olga, form({ subject: 'Доступ к CRM', text: 'Нет доступа' }))).json()) as SupportRequestResponse;
    const second = (await (await send(olga, form({ subject: 'Доступ к CRM', text: 'Нет доступа' }))).json()) as SupportRequestResponse;
    expect(first.id).not.toBe(second.id);
    expect((await json<AdminTicketDto>(await t.call('GET', `/app/api/admin/support/${second.id}`, { cookie: igor }))).files).toEqual([]);
  });

  it('counts a line break as one character, as the text box did: a long text of many lines is taken whole', async () => {
    // A form with files carries each line break as «\r\n».
    const text = `${'строка\n'.repeat(570)}конец`;
    expect(text.length).toBeLessThanOrEqual(4000);
    const res = await send(olga, form({ subject: 'Лог', text }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as SupportRequestResponse;
    expect((await json<AdminTicketDto>(await t.call('GET', `/app/api/admin/support/${id}`, { cookie: igor }))).comment).toBe(text);
  });

  it('refuses a request without a subject or a text, with too many files or files over the limit', async () => {
    expect(await code(await send(olga, form({ subject: '   ', text: 'Текст' })))).toBe('APP_VALIDATION_FAILED');
    expect(await code(await send(olga, form({ subject: 'Тема' })))).toBe('APP_VALIDATION_FAILED');
    expect(await code(await send(olga, form({ subject: 'Т'.repeat(201), text: 'Текст' })))).toBe('APP_VALIDATION_FAILED');
    // A zero character Postgres cannot keep: refused, not a failure of the server.
    expect(await code(await send(olga, form({ subject: 'Т\0ема', text: 'Текст' })))).toBe('APP_VALIDATION_FAILED');
    expect(await code(await send(olga, form({ subject: 'Тема', text: 'Текст', files: [file('a\0b.txt', 'x')] })))).toBe('APP_VALIDATION_FAILED');
    const many = Array.from({ length: SUPPORT_REQUEST_FILES_MAX + 1 }, (_, i) => file(`${i}.txt`, 'x'));
    expect(await code(await send(olga, form({ subject: 'Тема', text: 'Текст', files: many })))).toBe('APP_SUPPORT_TOO_MANY_FILES');
    const big = await send(olga, form({ subject: 'Тема', text: 'Текст', files: [file('a.bin', new Uint8Array(SUPPORT_FILES_MAX_BYTES / 2)), file('b.bin', new Uint8Array(SUPPORT_FILES_MAX_BYTES / 2 + 1))] }));
    expect(big.status).toBe(413);
    expect(await code(big)).toBe('APP_SUPPORT_FILES_TOO_LARGE');
    const { rows } = await t.db.query(`SELECT 1 FROM app.support_tickets WHERE subject = 'Тема'`);
    expect(rows).toEqual([]);
  });

  it('tells the open page of the employee at once when the support answers', async () => {
    const { id } = (await (await send(olga, form({ subject: 'Ответьте', text: 'Жду ответа' }))).json()) as SupportRequestResponse;
    const opened = await json<AdminTicketDto>(await t.call('GET', `/app/api/admin/support/${id}`, { cookie: igor }));
    const page = await t.call('GET', '/app/api/me/events', { cookie: olga });
    const reader = page.body!.getReader();
    const decoder = new TextDecoder();
    let stream = '';
    const readUntil = async (marker: string) => {
      while (!stream.includes(marker)) {
        const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
        if (chunk.done) throw new Error(`the stream ended before «${marker}»: ${stream}`);
        stream += decoder.decode(chunk.value);
      }
    };
    try {
      await readUntil('event: ready');
      await json<AdminTicketDto>(await t.call('PATCH', `/app/api/admin/support/${id}`, { cookie: igor, body: { status: 'resolved', reply: 'Готово', seen: opened.updatedAt } }));
      await readUntil('event: changed');
    } finally {
      await reader.cancel();
    }
    const told = await t.db.query<{ title: string; link: string }>(`SELECT title, link FROM app.notifications WHERE user_id = $1 AND kind = 'support_reply' AND subject_ref = $2`, [olgaId, `ticket:${id}`]);
    expect(told.rows).toEqual([{ title: `Ответ на обращение №${id}`, link: '/settings/requests' }]);
  });
});
