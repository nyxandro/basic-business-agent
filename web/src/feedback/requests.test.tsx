// A request straight to the support (docs/specs/[20.11.2026]-feedback-and-value.md, F7; owner 24.11): «Новое обращение» on
// «Мои обращения» — a subject, a text, files — goes as a form and the list shows it; the support sees its subject, text and
// files, without the blocks of a conversation.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const REQUEST = {
  id: '21',
  kind: 'request',
  subject: 'Не приходит сводка',
  agentName: null,
  status: 'new',
  comment: 'Вчера и сегодня сводки не было.',
  files: ['экран.png'],
  reply: null,
  createdAt: '2026-11-24T06:00:00Z',
  updatedAt: '2026-11-24T06:00:00Z',
};
const file = (name: string, bytes = 10) => new File([new Uint8Array(bytes)], name);

async function openForm() {
  renderApp('/settings/requests');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Новое обращение' }));
  return { user, dialog: await screen.findByRole('dialog', { name: 'Новое обращение' }) };
}

describe('«Новое обращение»', () => {
  it('sends the subject, the text and the files attached, and the list shows the request', async () => {
    const s = mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/me/support': { body: { tickets: [] } },
      'POST /app/api/me/support/requests': () => {
        s.set('GET /app/api/me/support', { body: { tickets: [REQUEST] } });
        return { status: 201, body: { id: '21' } };
      },
    });
    const { user, dialog } = await openForm();
    await user.type(within(dialog).getByLabelText('Тема'), 'Не приходит сводка');
    await user.type(within(dialog).getByLabelText('Описание'), 'Вчера и сегодня сводки не было.');
    await user.upload(within(dialog).getByLabelText('Прикрепить файлы'), [file('экран.png'), file('лог.txt')]);
    expect(within(dialog).getByText('экран.png')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Убрать лог.txt' }));
    expect(within(dialog).queryByText('лог.txt')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByText('Обращение №21 отправлено. Ответ придёт в уведомления')).toBeInTheDocument();
    const sent = s.calls.find((c) => c.method === 'POST');
    expect(sent?.form).toMatchObject({ subject: 'Не приходит сводка', text: 'Вчера и сегодня сводки не было.' });
    expect(sent?.files).toEqual(['экран.png']);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText(/№21 · Не приходит сводка/)).toBeInTheDocument();
    expect(screen.getByText('Файлы: экран.png')).toBeInTheDocument();
  });

  it('asks for a subject and a text before sending, and sends nothing', async () => {
    const s = mockServer({ 'GET /app/api/me': { body: ME }, 'GET /app/api/me/support': { body: { tickets: [] } } });
    const { user, dialog } = await openForm();
    await user.click(within(dialog).getByRole('button', { name: 'Отправить' }));
    expect(within(dialog).getByText('Укажите тему.')).toBeInTheDocument();
    expect(within(dialog).getByText('Опишите вопрос.')).toBeInTheDocument();
    expect(s.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('keeps to 10 files and 50 MB together, saying why', async () => {
    mockServer({ 'GET /app/api/me': { body: ME }, 'GET /app/api/me/support': { body: { tickets: [] } } });
    const { user, dialog } = await openForm();
    const input = within(dialog).getByLabelText('Прикрепить файлы');
    await user.upload(input, Array.from({ length: 11 }, (_, i) => file(`${i}.txt`)));
    expect(within(dialog).getByText('Можно приложить не больше 10 файлов.')).toBeInTheDocument();
    expect(within(dialog).queryByText('0.txt')).not.toBeInTheDocument();
    await user.upload(input, [file('большой.zip', 50 * 1024 * 1024 + 1)]);
    expect(within(dialog).getByText('Файлы вместе больше 50 МБ — уберите часть или сожмите их.')).toBeInTheDocument();
    expect(within(dialog).queryByText('большой.zip')).not.toBeInTheDocument();
  });

  it('keeps what was written when sending fails, and says why with the code', async () => {
    mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/me/support': { body: { tickets: [] } },
      'POST /app/api/me/support/requests': apiError('APP_SUPPORT_FILES_TOO_LARGE', 'Файлы вместе больше 50 МБ. Уберите часть файлов или сожмите их.', 413),
    });
    const { user, dialog } = await openForm();
    await user.type(within(dialog).getByLabelText('Тема'), 'Тема');
    await user.type(within(dialog).getByLabelText('Описание'), 'Текст');
    await user.click(within(dialog).getByRole('button', { name: 'Отправить' }));
    expect(await within(dialog).findByText(/Файлы вместе больше 50 МБ/)).toBeInTheDocument();
    expect(within(dialog).getByText(/APP_SUPPORT_FILES_TOO_LARGE/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Тема')).toHaveValue('Тема');
  });
});

describe('a request in «Поддержка»', () => {
  const ADMIN_REQUEST = {
    id: '21',
    author: 'Ольга Смирнова',
    kind: 'request',
    subject: 'Не приходит сводка',
    agentId: null,
    agentName: null,
    status: 'new',
    createdAt: '2026-11-24T06:00:00Z',
    updatedAt: '2026-11-24T06:00:00Z',
    comment: 'Вчера и сегодня сводки не было.',
    turn: null,
    snapshot: [],
    files: [{ ord: 0, name: 'экран.png', size: 2048, state: 'copied' }],
    models: [],
    instructionsAt: null,
    taskId: null,
    reply: null,
    handledBy: null,
  };

  it('shows its subject in the list, and its text and files without the blocks of a conversation', async () => {
    mockServer({
      'GET /app/api/me': { body: { ...ME, permissions: ['agents'] } },
      'GET /app/api/admin/support': { body: { tickets: [ADMIN_REQUEST] } },
      'GET /app/api/admin/support/21': { body: ADMIN_REQUEST },
    });
    renderApp('/admin/support');
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Поддержка' });
    expect(within(list).getByText(/Ольга Смирнова · обращение/)).toBeInTheDocument();
    await user.click(within(list).getByRole('link', { name: /№21 · Не приходит сводка/ }));
    expect(await screen.findByText('Вчера и сегодня сводки не было.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Не приходит сводка' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Скачать' })).toHaveAttribute('href', '/app/api/admin/support/21/files/0');
    expect(screen.queryByText('Разговор на момент жалобы')).not.toBeInTheDocument();
    expect(screen.queryByText('Агент и модель')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Ответ сотруднику')).toBeInTheDocument();
  });
});
