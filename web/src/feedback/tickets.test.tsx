// Tickets as a conversation (docs/specs/[20.11.2026]-feedback-and-value.md, F7–F9; owner 24.11, by the classic help desks):
// «Новое обращение» opens the new ticket; on a ticket the employee and the support write to each other with files, each
// side's page reads the ticket again the moment the server says there is news; «Проблема решена» closes it for both
// sides; the support closes as resolved or rejected and opens a closed one again; a complaint shows the support the
// conversation complained about above the messages.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

afterEach(() => vi.unstubAllGlobals());

const file = (name: string, bytes = 10) => new File([new Uint8Array(bytes)], name);
const at = (minute: number) => `2026-11-24T06:${String(minute).padStart(2, '0')}:00Z`;

const msg = (id: string, side: 'employee' | 'support', author: string | null, text: string, files: { ord: number; name: string }[] = []) => ({
  id,
  side,
  author,
  text,
  at: at(Number(id)),
  files: files.map((f) => ({ ...f, size: 2048, state: 'copied' })),
});

const MY_TICKET = {
  id: '21',
  kind: 'request',
  subject: 'Не приходит сводка',
  agentName: null,
  status: 'answered',
  createdAt: at(0),
  updatedAt: at(2),
  lastSide: 'support',
  closedAt: null,
  closedSide: null,
  messages: [msg('1', 'employee', 'Ольга', 'Вчера сводки не было.', [{ ord: 0, name: 'экран.png' }]), msg('2', 'support', 'Анна', 'Посмотрите в спаме.', [{ ord: 1, name: 'инструкция.pdf' }])],
};

const { messages: _messages, closedAt: _closedAt, closedSide: _closedSide, ...MY_ROW } = MY_TICKET;

// A stand-in for the browser's EventSource: the test plays the server's «changed».
class FakeSource {
  static last: FakeSource | null = null;
  listeners = new Map<string, () => void>();
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSource.last = this;
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
  close() {}
}

describe('«Мои обращения»', () => {
  it('lists the tickets, a request by its subject and a complaint by its agent, each opening its conversation', async () => {
    mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/me/support': { body: { tickets: [MY_ROW, { ...MY_ROW, id: '14', kind: 'complaint', subject: null, agentName: 'Продажи', status: 'resolved' }] } },
      'GET /app/api/me/support/21': { body: MY_TICKET },
    });
    renderApp('/settings/requests');
    const list = await screen.findByRole('list', { name: 'Мои обращения' });
    expect(within(list).getByText('Жалоба на ответ агента «Продажи»')).toBeInTheDocument();
    expect(within(list).getByText('Поддержка ответила')).toBeInTheDocument();
    await userEvent.setup().click(within(list).getByRole('link', { name: /Не приходит сводка/ }));
    expect(await screen.findByText('Посмотрите в спаме.')).toBeInTheDocument();
  });

  it('opens «Новое обращение», sends the subject, the text and the files, and opens the new ticket', async () => {
    const s = mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/me/support': { body: { tickets: [] } },
      'POST /app/api/me/support/requests': { status: 201, body: { id: '21' } },
      'GET /app/api/me/support/21': { body: { ...MY_TICKET, status: 'open', messages: [MY_TICKET.messages[0]] } },
    });
    renderApp('/settings/requests');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Новое обращение' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новое обращение' });
    await user.click(within(dialog).getByRole('button', { name: 'Отправить' }));
    expect(within(dialog).getByText('Укажите тему.')).toBeInTheDocument();
    expect(within(dialog).getByText('Опишите вопрос.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Тема'), 'Не приходит сводка');
    await user.type(within(dialog).getByLabelText('Описание'), 'Вчера сводки не было.');
    await user.upload(within(dialog).getByLabelText('Прикрепить файлы'), [file('экран.png'), file('лог.txt')]);
    await user.click(within(dialog).getByRole('button', { name: 'Убрать лог.txt' }));
    await user.click(within(dialog).getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByText('Обращение №21 отправлено. Ответ придёт в уведомления')).toBeInTheDocument();
    const sent = s.calls.find((c) => c.method === 'POST');
    expect(sent?.form).toMatchObject({ subject: 'Не приходит сводка', text: 'Вчера сводки не было.' });
    expect(sent?.files).toEqual(['экран.png']);
    expect(await screen.findByRole('heading', { name: 'Не приходит сводка' })).toBeInTheDocument();
    expect(screen.getByText('Ждёт ответа поддержки')).toBeInTheDocument();
  });

  it('keeps to 10 files and 50 MB together, saying why', async () => {
    mockServer({ 'GET /app/api/me': { body: ME }, 'GET /app/api/me/support': { body: { tickets: [] } } });
    renderApp('/settings/requests');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Новое обращение' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новое обращение' });
    const input = within(dialog).getByLabelText('Прикрепить файлы');
    await user.upload(input, Array.from({ length: 11 }, (_, i) => file(`${i}.txt`)));
    expect(within(dialog).getByText('Можно приложить не больше 10 файлов.')).toBeInTheDocument();
    await user.upload(input, [file('большой.zip', 50 * 1024 * 1024 + 1)]);
    expect(within(dialog).getByText('Файлы вместе больше 50 МБ — уберите часть или сожмите их.')).toBeInTheDocument();
    expect(within(dialog).queryByText('большой.zip')).not.toBeInTheDocument();
  });
});

describe('a ticket of the employee', () => {
  it('shows the conversation, the person’s messages as theirs, the support’s by name, each with its files', async () => {
    mockServer({ 'GET /app/api/me': { body: ME }, 'GET /app/api/me/support/21': { body: MY_TICKET } });
    renderApp('/settings/requests/21');
    const conversation = await screen.findByRole('list', { name: 'Переписка' });
    const [mine, theirs] = within(conversation).getAllByRole('listitem').filter((li) => li.parentElement === conversation);
    expect(mine).toHaveTextContent(/^Вы ·/);
    expect(theirs).toHaveTextContent(/^Поддержка · Анна ·/);
    expect(within(theirs!).getByRole('link', { name: 'Скачать инструкция.pdf' })).toHaveAttribute('href', '/app/api/me/support/21/files/1');
    expect(screen.getByRole('button', { name: 'Проблема решена' })).toBeInTheDocument();
  });

  it('writes a message with files, and keeps it when sending fails', async () => {
    const s = mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/me/support/21': { body: MY_TICKET },
      'POST /app/api/me/support/21/messages': apiError('APP_SUPPORT_CLOSED', 'Обращение закрыто — писать в него нельзя.', 409),
    });
    renderApp('/settings/requests/21');
    const user = userEvent.setup();
    const field = await screen.findByLabelText('Сообщение');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(screen.getByText('Напишите сообщение.')).toBeInTheDocument();
    await user.type(field, 'В спаме нет');
    await user.upload(screen.getByLabelText('Прикрепить файлы'), [file('спам.png')]);
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(await screen.findByText(/Обращение закрыто/)).toBeInTheDocument();
    expect(field).toHaveValue('В спаме нет');

    s.set('POST /app/api/me/support/21/messages', () => {
      s.set('GET /app/api/me/support/21', { body: { ...MY_TICKET, status: 'open', messages: [...MY_TICKET.messages, msg('3', 'employee', 'Ольга', 'В спаме нет', [{ ord: 2, name: 'спам.png' }])] } });
      return { status: 201, body: { messageId: '3' } };
    });
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(await screen.findByText('Ждёт ответа поддержки')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Переписка' })).getByText('В спаме нет')).toBeInTheDocument();
    expect(field).toHaveValue('');
    const posted = s.calls.filter((c) => c.method === 'POST').at(-1);
    expect(posted?.form).toMatchObject({ text: 'В спаме нет' });
    expect(posted?.files).toEqual(['спам.png']);
  });

  it('closes for both sides by «Проблема решена», asked first; a closed one takes no messages and offers a new one', async () => {
    const s = mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/me/support/21': { body: MY_TICKET },
      'POST /app/api/me/support/21/resolve': () => {
        const closed = { ...MY_TICKET, status: 'resolved', closedSide: 'employee', closedAt: at(5) };
        s.set('GET /app/api/me/support/21', { body: closed });
        return { body: closed };
      },
    });
    renderApp('/settings/requests/21');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Проблема решена' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Закрыть обращение?' });
    await user.click(within(ask).getByRole('button', { name: 'Закрыть' }));
    expect(await screen.findByText(/^Вы закрыли обращение: решено ·.*Писать в него больше нельзя\.$/)).toBeInTheDocument();
    expect(s.calls.some((c) => c.method === 'POST' && c.path === '/app/api/me/support/21/resolve')).toBe(true);
    expect(screen.queryByLabelText('Сообщение')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Создать новое обращение' })).toBeInTheDocument();
  });

  it('reads the ticket again the moment the server says «changed»: an answer of the support appears', async () => {
    vi.stubGlobal('EventSource', FakeSource);
    const s = mockServer({ 'GET /app/api/me': { body: ME }, 'GET /app/api/me/support/21': { body: { ...MY_TICKET, status: 'open', messages: [MY_TICKET.messages[0]] } } });
    renderApp('/settings/requests/21');
    expect(await screen.findByText('Вчера сводки не было.')).toBeInTheDocument();
    expect(screen.queryByText('Посмотрите в спаме.')).not.toBeInTheDocument();
    s.set('GET /app/api/me/support/21', { body: MY_TICKET });
    act(() => FakeSource.last!.listeners.get('changed')!());
    expect(await screen.findByText('Посмотрите в спаме.')).toBeInTheDocument();
  });
});

describe('a ticket in «Поддержка»', () => {
  const SUPPORT = { ...ME, user: { id: 'u9', email: 'anna@example.com', name: 'Анна' }, permissions: ['agents'] };
  const ADMIN_TICKET = {
    ...MY_TICKET,
    status: 'open',
    lastSide: 'employee',
    author: 'Ольга Смирнова',
    agentId: null,
    messages: [MY_TICKET.messages[0]],
    turn: null,
    snapshot: [],
    contextFiles: [],
    models: [],
    instructionsAt: null,
    taskId: null,
  };
  const COMPLAINT = {
    ...ADMIN_TICKET,
    id: '14',
    kind: 'complaint',
    subject: null,
    agentId: 'sales',
    agentName: 'Продажи',
    turn: 1,
    models: ['qwen3.8-flash'],
    snapshot: [
      { role: 'user', at: at(0), text: 'Сколько стоит С21?', marks: [], turn: 1 },
      { role: 'assistant', at: at(0), text: '400 ₽ за лист', marks: ['файл: КП.docx'], turn: 1 },
    ],
    contextFiles: [
      { ord: 0, name: 'КП.docx', size: 2048, state: 'copied' },
      { ord: 1, name: 'Видео.mp4', size: 80_000_000, state: 'too_large' },
    ],
  };

  it('lists the tickets with the state filter; a request by its subject, a complaint by its agent', async () => {
    const s = mockServer({ 'GET /app/api/me': { body: SUPPORT }, 'GET /app/api/admin/support': { body: { tickets: [ADMIN_TICKET, COMPLAINT] } } });
    renderApp('/admin/support');
    const list = await screen.findByRole('list', { name: 'Поддержка' });
    expect(within(list).getByRole('link', { name: /№21 · Не приходит сводка/ })).toHaveTextContent(/Ольга Смирнова · обращение/);
    expect(within(list).getByRole('link', { name: /№14/ })).toHaveTextContent(/жалоба на агента «Продажи»/);
    await userEvent.setup().click(within(screen.getByRole('group', { name: 'Состояние' })).getByRole('button', { name: 'Ждёт ответа поддержки' }));
    await waitFor(() => expect(s.calls.some((c) => c.path === '/app/api/admin/support' && c.query.status === 'open')).toBe(true));
  });

  it('answers the employee with files; the request shows no blocks of a conversation', async () => {
    const s = mockServer({
      'GET /app/api/me': { body: SUPPORT },
      'GET /app/api/admin/support/21': { body: ADMIN_TICKET },
      'POST /app/api/admin/support/21/messages': () => {
        s.set('GET /app/api/admin/support/21', { body: { ...ADMIN_TICKET, status: 'answered', messages: [...ADMIN_TICKET.messages, msg('2', 'support', 'Анна', 'Посмотрите в спаме.', [{ ord: 1, name: 'инструкция.pdf' }])] } });
        return { status: 201, body: { messageId: '2' } };
      },
    });
    renderApp('/admin/support/21');
    const user = userEvent.setup();
    expect(await screen.findByText('Вчера сводки не было.')).toBeInTheDocument();
    expect(screen.queryByText('Разговор на момент жалобы')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Скачать экран.png' })).toHaveAttribute('href', '/app/api/admin/support/21/files/0');
    await user.type(screen.getByLabelText('Сообщение'), 'Посмотрите в спаме.');
    await user.upload(screen.getByLabelText('Прикрепить файлы'), [file('инструкция.pdf')]);
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(await screen.findByText('Поддержка ответила')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Переписка' })).getByText(/^Поддержка · Анна ·/)).toBeInTheDocument();
    const posted = s.calls.find((c) => c.method === 'POST');
    expect(posted?.form).toMatchObject({ text: 'Посмотрите в спаме.' });
    expect(posted?.files).toEqual(['инструкция.pdf']);
  });

  it('shows a complaint’s conversation, its files and the agent above the messages', async () => {
    mockServer({ 'GET /app/api/me': { body: SUPPORT }, 'GET /app/api/admin/support/14': { body: COMPLAINT } });
    renderApp('/admin/support/14');
    expect(await screen.findByLabelText('Ответ, на который пожаловались')).toHaveTextContent('400 ₽ за лист');
    expect(screen.getByText(/не приложен: больше 50 МБ/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Скачать КП.docx' })).toHaveAttribute('href', '/app/api/admin/support/14/files/0');
    expect(screen.getByText(/qwen3.8-flash · инструкции из файла агента/)).toBeInTheDocument();
  });

  it('closes as resolved, then opens again; a closed ticket takes no messages', async () => {
    const closed = { ...ADMIN_TICKET, status: 'resolved', closedSide: 'support', closedAt: at(9) };
    const s = mockServer({
      'GET /app/api/me': { body: SUPPORT },
      'GET /app/api/admin/support/21': { body: ADMIN_TICKET },
      'POST /app/api/admin/support/21/status': (call) => {
        const next = (call.body as { status: string }).status === 'open' ? ADMIN_TICKET : closed;
        s.set('GET /app/api/admin/support/21', { body: next });
        return { body: next };
      },
    });
    renderApp('/admin/support/21');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Закрыть: решено' }));
    expect(await screen.findByText('Обращение закрыто как решённое')).toBeInTheDocument();
    expect(screen.getByText(/^Закрыто поддержкой: решено ·/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Сообщение')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Открыть снова' }));
    expect(await screen.findByLabelText('Сообщение')).toBeInTheDocument();
    expect(s.calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ status: 'resolved' }, { status: 'open' }]);
  });
});
