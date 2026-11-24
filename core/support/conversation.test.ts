// Tickets as a conversation (docs/specs/[20.11.2026]-feedback-and-value.md, F7–F9; owner 24.11): a request straight from
// «Мои обращения» — a subject, a text, the files attached; inside a ticket both sides write as many messages as they
// need, with files; who wrote last sets the state; «Проблема решена» of the employee closes it for both sides, the support
// closes as resolved or rejected and may open it again; nobody writes into a closed ticket. Each side is told, and the
// open pages hear it at once. The red counter of «Поддержка» — the tickets waiting for the support's answer.
import { SUPPORT_FILES_MAX_BYTES, SUPPORT_REQUEST_FILES_MAX, type AdminTicketDto, type AdminTicketsResponse, type MyTicketDto, type MyTicketsResponse, type NotificationsResponse, type SupportRequestResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { createRequest } from './requests.ts';
import { withoutHolders } from './test-db.ts';

let t: TestApp;
let olgaId: string;
let igorId: string;
let annaId: string;
let olga: string;
let petr: string;
let igor: string;
let anna: string;

const json = async <T>(res: Response): Promise<T> => {
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return (await res.json()) as T;
};
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const message = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;
const file = (name: string, content: string | Uint8Array) => new File([content], name);
function form(fields: { subject?: string; text?: string; files?: File[] }): FormData {
  const f = new FormData();
  if (fields.subject !== undefined) f.append('subject', fields.subject);
  if (fields.text !== undefined) f.append('text', fields.text);
  for (const x of fields.files ?? []) f.append('files', x);
  return f;
}
const post = (path: string, cookie: string, body: FormData) => t.app.request(path, { method: 'POST', body, headers: { cookie, origin: TEST_PUBLIC_URL } });
const request = (cookie: string, body: FormData) => post('/app/api/me/support/requests', cookie, body);
const employeeWrites = (cookie: string, id: string, body: FormData) => post(`/app/api/me/support/${id}/messages`, cookie, body);
const supportWrites = (cookie: string, id: string, body: FormData) => post(`/app/api/admin/support/${id}/messages`, cookie, body);
const mine = async (cookie: string, id: string) => json<MyTicketDto>(await t.call('GET', `/app/api/me/support/${id}`, { cookie }));
const theirs = async (id: string) => json<AdminTicketDto>(await t.call('GET', `/app/api/admin/support/${id}`, { cookie: igor }));
async function newRequest(subject = 'Не приходит сводка', text = 'Вчера и сегодня сводки не было.'): Promise<string> {
  return (await json<SupportRequestResponse>(await request(olga, form({ subject, text })))).id;
}
const toldTo = async (userId: string, ticketId: string, kind: string) =>
  (await t.db.query<{ title: string; link: string }>(`SELECT title, link FROM app.notifications WHERE user_id = $1 AND kind = $2 AND subject_ref = $3 ORDER BY created_at`, [userId, kind, `ticket:${ticketId}`])).rows;

// Reads the instant channel of a person until the marker; a stream that ends first fails the test instead of spinning.
async function heard(cookie: string, act: () => Promise<unknown>): Promise<void> {
  const page = await t.call('GET', '/app/api/me/events', { cookie });
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
    await act();
    await readUntil('event: changed');
  } finally {
    await reader.cancel();
  }
}

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова' });
  await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
  igorId = await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  const agentsRole = (await t.db.query<{ id: string }>(`INSERT INTO app.roles (name, permissions) VALUES ('Агенты', '["agents"]') RETURNING id`)).rows[0]!.id;
  annaId = await t.createUser({ email: 'anna@example.com', name: 'Анна', roleIds: [agentsRole] });
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
  igor = await t.signIn('igor@example.com');
  anna = await t.signIn('anna@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('a request straight to the support', () => {
  it('makes a ticket of the subject and the first message with the files attached — nothing of a conversation — and tells the support', async () => {
    const res = await request(olga, form({ subject: '  Не приходит письмо со сводкой  ', text: 'Вчера и сегодня сводки не было.', files: [file('экран.png', 'PNG-байты'), file('лог.txt', 'строка')] }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as SupportRequestResponse;

    const row = (await json<AdminTicketsResponse>(await t.call('GET', '/app/api/admin/support', { cookie: igor }))).tickets.find((x) => x.id === id);
    expect(row).toMatchObject({ kind: 'request', subject: 'Не приходит письмо со сводкой', author: 'Ольга Смирнова', agentId: null, agentName: null, status: 'open' });
    const detail = await theirs(id);
    expect(detail).toMatchObject({ kind: 'request', turn: null, snapshot: [], contextFiles: [], models: [], instructionsAt: null, taskId: null, closedAt: null, closedSide: null });
    expect(detail.messages).toMatchObject([
      {
        side: 'employee',
        author: 'Ольга Смирнова',
        text: 'Вчера и сегодня сводки не было.',
        files: [
          { ord: 0, name: 'экран.png', size: Buffer.byteLength('PNG-байты'), state: 'copied' },
          { ord: 1, name: 'лог.txt', size: Buffer.byteLength('строка'), state: 'copied' },
        ],
      },
    ]);
    expect(await (await t.call('GET', `/app/api/admin/support/${id}/files/1`, { cookie: igor })).text()).toBe('строка');
    expect(await (await t.call('GET', `/app/api/me/support/${id}/files/1`, { cookie: olga })).text()).toBe('строка');
    expect(await toldTo(igorId, id, 'support_new')).toEqual([{ title: `Новое обращение №${id}`, link: `/admin/support/${id}` }]);

    const listed = (await json<MyTicketsResponse>(await t.call('GET', '/app/api/me/support', { cookie: olga }))).tickets.find((x) => x.id === id);
    expect(listed).toMatchObject({ kind: 'request', subject: 'Не приходит письмо со сводкой', agentName: null, status: 'open' });
  });

  it('counts a line break as one character, as the text box did: a long text of many lines is taken whole', async () => {
    // A form with files carries each line break as «\r\n».
    const text = `${'строка\n'.repeat(570)}конец`;
    expect(text.length).toBeLessThanOrEqual(4000);
    const { id } = await json<SupportRequestResponse>(await request(olga, form({ subject: 'Лог', text })));
    expect((await theirs(id)).messages[0]!.text).toBe(text);
  });

  it('refuses a request without a subject or a text, a zero character, too many files or files over the limit', async () => {
    expect(await code(await request(olga, form({ subject: '   ', text: 'Текст' })))).toBe('APP_VALIDATION_FAILED');
    expect(await code(await request(olga, form({ subject: 'Тема' })))).toBe('APP_VALIDATION_FAILED');
    expect(await code(await request(olga, form({ subject: 'Т'.repeat(201), text: 'Текст' })))).toBe('APP_VALIDATION_FAILED');
    expect(await code(await request(olga, form({ subject: 'Т\0ема', text: 'Текст' })))).toBe('APP_VALIDATION_FAILED');
    expect(await code(await request(olga, form({ subject: 'Тема', text: 'Текст', files: [file('a\0b.txt', 'x')] })))).toBe('APP_VALIDATION_FAILED');
    const many = Array.from({ length: SUPPORT_REQUEST_FILES_MAX + 1 }, (_, i) => file(`${i}.txt`, 'x'));
    expect(await code(await request(olga, form({ subject: 'Тема', text: 'Текст', files: many })))).toBe('APP_SUPPORT_TOO_MANY_FILES');
    const big = await request(olga, form({ subject: 'Тема', text: 'Текст', files: [file('a.bin', new Uint8Array(SUPPORT_FILES_MAX_BYTES / 2)), file('b.bin', new Uint8Array(SUPPORT_FILES_MAX_BYTES / 2 + 1))] }));
    expect(big.status).toBe(413);
    expect(await code(big)).toBe('APP_SUPPORT_FILES_TOO_LARGE');
    expect((await t.db.query(`SELECT 1 FROM app.support_tickets WHERE subject = 'Тема'`)).rows).toEqual([]);
  });
});

describe('the conversation of a ticket', () => {
  it('goes both ways: the support answers, the employee writes again, each told, the state set by who wrote last', async () => {
    const id = await newRequest();
    const answered = await supportWrites(anna, id, form({ text: 'Проверили — сводка уходила в спам. Посмотрите там?', files: [file('инструкция.pdf', 'PDF')] }));
    expect(answered.status).toBe(201);
    expect(await mine(olga, id)).toMatchObject({ status: 'answered' });
    expect(await toldTo(olgaId, id, 'support_reply')).toEqual([{ title: `Ответ на обращение №${id}`, link: `/settings/requests/${id}` }]);

    expect((await employeeWrites(olga, id, form({ text: 'В спаме нет. Скриншот приложила.', files: [file('спам.png', 'PNG')] }))).status).toBe(201);
    const ticket = await mine(olga, id);
    expect(ticket.status).toBe('open');
    expect(ticket.messages.map((m) => [m.side, m.author, m.text, m.files.map((f) => f.name)])).toEqual([
      ['employee', 'Ольга Смирнова', 'Вчера и сегодня сводки не было.', []],
      ['support', 'Анна', 'Проверили — сводка уходила в спам. Посмотрите там?', ['инструкция.pdf']],
      ['employee', 'Ольга Смирнова', 'В спаме нет. Скриншот приложила.', ['спам.png']],
    ]);
    // The support's file is the employee's to download, and the employee's — the support's.
    const supportFile = ticket.messages[1]!.files[0]!;
    expect(await (await t.call('GET', `/app/api/me/support/${id}/files/${supportFile.ord}`, { cookie: olga })).text()).toBe('PDF');
    expect(await (await t.call('GET', `/app/api/admin/support/${id}/files/${ticket.messages[2]!.files[0]!.ord}`, { cookie: igor })).text()).toBe('PNG');
    // Every message of the employee tells the support.
    expect((await toldTo(annaId, id, 'support_new')).map((n) => n.title)).toEqual([`Новое обращение №${id}`, `Новое сообщение в обращении №${id}`]);
  });

  it('is closed for both sides by «Проблема решена» of the employee; the support may open it again', async () => {
    const id = await newRequest();
    await json(await supportWrites(igor, id, form({ text: 'Готово' })));
    expect((await t.call('POST', `/app/api/me/support/${id}/resolve`, { cookie: olga })).status).toBe(200);
    expect(await mine(olga, id)).toMatchObject({ status: 'resolved', closedSide: 'employee' });
    expect((await mine(olga, id)).closedAt).not.toBeNull();
    // Nobody writes into a closed ticket.
    expect(await code(await employeeWrites(olga, id, form({ text: 'Ещё вопрос' })))).toBe('APP_SUPPORT_CLOSED');
    expect(await code(await supportWrites(igor, id, form({ text: 'Ещё ответ' })))).toBe('APP_SUPPORT_CLOSED');
    // A second «Проблема решена» (another tab): closed already — nothing about writing.
    const again = await t.call('POST', `/app/api/me/support/${id}/resolve`, { cookie: olga });
    expect(again.status).toBe(409);
    expect(await again.clone().json()).toMatchObject({ error: { code: 'APP_SUPPORT_ALREADY_CLOSED', message: 'Обращение уже закрыто. Обновите страницу.' } });

    expect(await theirs(id)).toMatchObject({ status: 'resolved', closedSide: 'employee' });
    const reopened = await json<AdminTicketDto>(await t.call('POST', `/app/api/admin/support/${id}/status`, { cookie: igor, body: { status: 'open' } }));
    expect(reopened).toMatchObject({ status: 'open', closedAt: null, closedSide: null });
    expect((await toldTo(olgaId, id, 'support_reply')).map((n) => n.title)).toEqual([`Ответ на обращение №${id}`, `Обращение №${id} открыто снова`]);
    expect((await employeeWrites(olga, id, form({ text: 'Спасибо, теперь вижу' }))).status).toBe(201);
  });

  it('is closed by the support as resolved or rejected, the employee told; only an open ticket closes, only a closed one opens', async () => {
    const id = await newRequest();
    expect(await code(await t.call('POST', `/app/api/admin/support/${id}/status`, { cookie: igor, body: { status: 'open' } }))).toBe('APP_SUPPORT_STATE');
    expect(await json<AdminTicketDto>(await t.call('POST', `/app/api/admin/support/${id}/status`, { cookie: igor, body: { status: 'rejected' } }))).toMatchObject({ status: 'rejected', closedSide: 'support' });
    expect(await code(await t.call('POST', `/app/api/admin/support/${id}/status`, { cookie: igor, body: { status: 'resolved' } }))).toBe('APP_SUPPORT_STATE');
    expect(await toldTo(olgaId, id, 'support_reply')).toEqual([{ title: `Обращение №${id} отклонено`, link: `/settings/requests/${id}` }]);
    expect((await t.call('POST', `/app/api/admin/support/${id}/status`, { cookie: igor, body: { status: 'answered' } })).status).toBe(400);

    const other = await newRequest();
    await json(await t.call('POST', `/app/api/admin/support/${other}/status`, { cookie: igor, body: { status: 'resolved' } }));
    expect((await toldTo(olgaId, other, 'support_reply')).map((n) => n.title)).toEqual([`Обращение №${other} решено`]);
  });

  it('is the person’s own: another employee neither reads, writes, closes nor downloads it', async () => {
    const id = await newRequest();
    await json(await supportWrites(igor, id, form({ text: 'Ответ', files: [file('a.txt', 'x')] })));
    expect((await t.call('GET', `/app/api/me/support/${id}`, { cookie: petr })).status).toBe(404);
    expect((await employeeWrites(petr, id, form({ text: 'Чужое' }))).status).toBe(404);
    expect((await t.call('POST', `/app/api/me/support/${id}/resolve`, { cookie: petr })).status).toBe(404);
    expect((await t.call('GET', `/app/api/me/support/${id}/files/0`, { cookie: petr })).status).toBe(404);
    expect((await json<MyTicketsResponse>(await t.call('GET', '/app/api/me/support', { cookie: petr }))).tickets).toEqual([]);
    expect((await t.call('GET', '/app/api/me/support/not-a-number', { cookie: olga })).status).toBe(404);
  });

  it('refuses an empty message and files over the limits, on both sides', async () => {
    const id = await newRequest();
    const empty = await employeeWrites(olga, id, form({ text: '  ' }));
    expect(await empty.clone().json()).toMatchObject({ error: { code: 'APP_VALIDATION_FAILED', message: 'Напишите сообщение — до 4000 знаков.' } });
    expect(await message(await request(olga, form({ subject: 'Тема' })))).toBe('Заполните поля формы: тема — до 200 знаков, текст — до 4000.');
    expect(await code(await supportWrites(igor, id, form({})))).toBe('APP_VALIDATION_FAILED');
    const many = Array.from({ length: SUPPORT_REQUEST_FILES_MAX + 1 }, (_, i) => file(`${i}.txt`, 'x'));
    expect(await code(await supportWrites(igor, id, form({ text: 'Файлы', files: many })))).toBe('APP_SUPPORT_TOO_MANY_FILES');
    expect((await theirs(id)).messages).toHaveLength(1);
  });

  it('reaches the open page of the employee at once when the support answers', async () => {
    const id = await newRequest();
    await heard(olga, async () => json(await supportWrites(igor, id, form({ text: 'Смотрим' }))));
  });

  it('reaches the open pages of the support at once when the employee writes or closes it', async () => {
    const id = await newRequest();
    await json(await supportWrites(igor, id, form({ text: 'Ответ' })));
    await heard(anna, async () => json(await employeeWrites(olga, id, form({ text: 'Ещё' }))));
    await heard(anna, async () => json(await t.call('POST', `/app/api/me/support/${id}/resolve`, { cookie: olga })));
  });

  it('tells the other people of the support of a ticket of one of them, never the one who wrote', async () => {
    const id = (await json<SupportRequestResponse>(await request(anna, form({ subject: 'Свой вопрос', text: 'Не вижу отчёт' })))).id;
    await json(await employeeWrites(anna, id, form({ text: 'Дополню' })));
    expect(await toldTo(annaId, id, 'support_new')).toEqual([]);
    expect((await toldTo(igorId, id, 'support_new')).map((n) => n.title)).toEqual([`Новое обращение №${id}`, `Новое сообщение в обращении №${id}`]);
  });

  it('keeps a request made and answers it as made when whom to tell cannot be read: sent again, it would be a second one', async () => {
    const before = (await t.db.query(`SELECT 1 FROM app.support_tickets`)).rowCount;
    const { id } = await createRequest(withoutHolders(t.db), olgaId, { subject: 'Без оповещения', text: 'Текст' }, []);
    expect((await t.db.query(`SELECT 1 FROM app.support_tickets`)).rowCount).toBe((before ?? 0) + 1);
    expect(await mine(olga, id)).toMatchObject({ subject: 'Без оповещения', status: 'open' });
  });
});

// The red counter of «Поддержка» in the menu of the admin panel (owner 24.11, F8–F9): the tickets waiting for the
// support's answer.
describe('the counter of tickets waiting for the support', () => {
  const countsOf = async (cookie: string) => json<NotificationsResponse>(await t.call('GET', '/app/api/me/notifications', { cookie }));
  const waiting = async () => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.support_tickets WHERE status = 'open'`)).rows[0]!.n;

  it('is for the people who handle the support only, in the bell’s counters and in the answer to presence', async () => {
    await newRequest();
    expect((await countsOf(igor)).supportWaiting).toBe(await waiting());
    expect((await countsOf(olga)).supportWaiting).toBeNull();
    const pinged = await json<NotificationsResponse>(await t.call('POST', '/app/api/me/presence', { cookie: anna, body: { tab: 'counter-tab', visible: true, threadId: null } }));
    expect(pinged.supportWaiting).toBe(await waiting());
  });

  it('goes down at once on the open pages of the support when one of them answers, and up when the employee writes', async () => {
    const id = await newRequest();
    const before = (await countsOf(igor)).supportWaiting!;
    // Anna answers: Igor's page hears it, though the notification of the answer goes to the employee.
    await heard(igor, async () => json(await supportWrites(anna, id, form({ text: 'Ответ' }))));
    expect((await countsOf(igor)).supportWaiting).toBe(before - 1);
    await json(await employeeWrites(olga, id, form({ text: 'Не помогло' })));
    expect((await countsOf(igor)).supportWaiting).toBe(before);
  });
});
