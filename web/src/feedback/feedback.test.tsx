// Complaints, samples, «Поддержка», «Мои обращения», «Польза от агентов» (docs/specs/[20.11.2026]-feedback-and-value.md,
// steps 3–5 and 7; F6, owner 24.11): «Пожаловаться» only under an answer that ended, its text kept when sending fails; the
// heart of samples only on a document the agent made, on its block and in its viewer; the support answers and the
// employee reads it; the report shows hours and spend.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { TurnFooter } from '../chat/AssistantMessage.tsx';
import { FileCall } from '../genui/FileBlock.tsx';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';
import { ToastProvider } from '../ui/Toast.tsx';
import { WithMemory } from '../test/memory.tsx';

// PDF.js does not draw in jsdom (viewer/viewer.test.tsx): the viewer's pages are a stand-in.
vi.mock('../viewer/PdfPages.tsx', () => ({ default: () => <div data-testid="pdf-pages" /> }));

const inApp = (node: React.ReactNode) => render(<MemoryRouter><WithMemory><ToastProvider>{node}</ToastProvider></WithMemory></MemoryRouter>);
const fileCall = (made: boolean | undefined, name = 'КП-Вектор.docx') => ({
  toolCallId: 'c1',
  status: 'complete' as const,
  parameters: { path: name },
  result: JSON.stringify({ shown: true, path: name, name, bytes: 2048, ...(made === undefined ? {} : { made }) }),
});

describe('«Пожаловаться»', () => {
  it('is under an answer that ended, never under one being written', () => {
    const { unmount } = inApp(<TurnFooter text="Готово" streaming interrupted={false} complaint={{ threadId: 't-1', turn: 2 }} />);
    expect(screen.queryByRole('button', { name: 'Пожаловаться' })).not.toBeInTheDocument();
    unmount();
    inApp(<TurnFooter text="Готово" streaming={false} interrupted={false} />);
    expect(screen.queryByRole('button', { name: 'Пожаловаться' })).not.toBeInTheDocument();
  });

  it('sends the complaint about the turn with the warning, and keeps the text when sending fails', async () => {
    const s = mockServer({
      'GET /app/api/me/support/turn': { body: { ticket: null } },
      'POST /app/api/me/support': apiError('APP_SUPPORT_FAILED', 'Жалоба не отправилась. Попробуйте ещё раз.', 500),
    });
    const user = userEvent.setup();
    inApp(<TurnFooter text="Готово" streaming={false} interrupted={false} complaint={{ threadId: 't-1', turn: 2 }} />);
    await user.click(screen.getByRole('button', { name: 'Пожаловаться' }));
    const dialog = await screen.findByRole('dialog', { name: 'Что было не так?' });
    expect(within(dialog).getByText('К жалобе приложится весь этот разговор и его файлы — их увидит поддержка.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Отправить в поддержку' }));
    expect(within(dialog).getByText('Напишите, что было не так — это поможет поддержке.')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox'), 'Цена из старого прайса');
    await user.click(within(dialog).getByRole('button', { name: 'Отправить в поддержку' }));
    expect(await within(dialog).findByText(/Жалоба не отправилась/)).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox')).toHaveValue('Цена из старого прайса');
    expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({ threadId: 't-1', turn: 2, comment: 'Цена из старого прайса' });

    s.set('POST /app/api/me/support', { status: 201, body: { id: '14', appended: false } });
    await user.click(within(dialog).getByRole('button', { name: 'Отправить в поддержку' }));
    expect(await screen.findByText('Жалоба №14 отправлена. Ответ придёт в уведомления')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says a complaint about the same answer was sent and adds to it', async () => {
    mockServer({ 'GET /app/api/me/support/turn': { body: { ticket: { id: '14', status: 'new' } } } });
    const user = userEvent.setup();
    inApp(<TurnFooter text="Готово" streaming={false} interrupted={false} complaint={{ threadId: 't-1', turn: 1 }} />);
    await user.click(screen.getByRole('button', { name: 'Пожаловаться' }));
    const dialog = await screen.findByRole('dialog', { name: 'Что было не так?' });
    expect(within(dialog).getByText('Вы уже отправили жалобу №14 на этот ответ. Можно дописать к ней.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Дописать' })).toBeInTheDocument();
  });
});

// The heart of samples (docs/specs/[20.11.2026]-feedback-and-value.md, F6; owner 24.11).
describe('the heart of samples', () => {
  const ADD = /^Добавить в референсы/;
  const IN = /^В референсах/;
  const SALES = { scope: 'department', departmentId: 'dep-1', name: 'Продажи' };
  const marks = (saved: string[], bases: object[] = [SALES]) => ({ body: { bases, saved } });
  const heartOn = async (name: RegExp) => {
    const heart = await screen.findByRole('button', { name });
    await waitFor(() => expect(heart).toBeEnabled());
    return heart;
  };

  it('is only on a document the agent made, where samples are offered, before «Открыть»', async () => {
    mockServer({ 'GET /app/api/me/examples': marks([]) });
    const made = inApp(<FileCall call={fileCall(true)} threadId="t-1" samples />);
    const heart = await heartOn(ADD);
    expect(heart).toHaveAttribute('aria-pressed', 'false');
    // A screen reader hears the file; the hint on hover says what the heart does.
    expect(heart).toHaveAccessibleName('Добавить в референсы: КП-Вектор.docx');
    expect(heart).toHaveAttribute('title', 'Добавить в референсы: агент будет опираться на этот документ, когда будет делать похожие');
    expect(heart.compareDocumentPosition(screen.getByRole('button', { name: 'Открыть КП-Вектор.docx' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    made.unmount();
    for (const [call, samples] of [[fileCall(false), true], [fileCall(true, 'схема.png'), true], [fileCall(true), false]] as const) {
      const other = inApp(<FileCall call={call} threadId="t-1" samples={samples} />);
      expect(screen.queryByRole('button', { name: ADD })).not.toBeInTheDocument();
      other.unmount();
    }
  });

  it('puts the document into the base of the department at one press, and takes it out at the next', async () => {
    const s = mockServer({
      'GET /app/api/me/examples': marks([]),
      'POST /app/api/me/examples': () => {
        s.set('GET /app/api/me/examples', marks(['КП-Вектор.docx']));
        return { status: 201, body: { documentId: 'doc-1' } };
      },
      'DELETE /app/api/me/examples': () => {
        s.set('GET /app/api/me/examples', marks([]));
        return { body: { ok: true } };
      },
    });
    const user = userEvent.setup();
    inApp(<FileCall call={fileCall(true)} threadId="t-1" samples />);
    await user.click(await heartOn(ADD));
    expect(await screen.findByText('Добавлено в референсы: база «Продажи»')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({ threadId: 't-1', path: 'КП-Вектор.docx', base: { scope: 'department', departmentId: 'dep-1' } });
    const filled = await heartOn(IN);
    expect(filled).toHaveAttribute('aria-pressed', 'true');
    await user.click(filled);
    expect(await screen.findByText('Убрано из референсов')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'DELETE')?.query).toEqual({ threadId: 't-1', path: 'КП-Вектор.docx' });
    expect(await heartOn(ADD)).toHaveAttribute('aria-pressed', 'false');
  });

  it('asks where to when the person may put it into several bases', async () => {
    const s = mockServer({
      'GET /app/api/me/examples': marks([], [SALES, { scope: 'department', departmentId: 'dep-2', name: 'Закупки' }, { scope: 'org', name: 'Вся организация' }]),
      'POST /app/api/me/examples': { status: 201, body: { documentId: 'doc-1' } },
    });
    const user = userEvent.setup();
    inApp(<FileCall call={fileCall(true)} threadId="t-1" samples />);
    await user.click(await heartOn(ADD));
    const menu = await screen.findByRole('menu', { name: 'Куда добавить' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Продажи', 'Закупки', 'Вся организация']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Вся организация' }));
    expect(await screen.findByText('Добавлено в референсы: база «Вся организация»')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ base: { scope: 'org' } });
  });

  it('says why it did not, with the code, and stays as it was', async () => {
    const s = mockServer({
      'GET /app/api/me/examples': marks([]),
      'POST /app/api/me/examples': apiError('APP_EXAMPLE_NOT_MADE', 'В референсы можно добавить только документ, который сделал агент.', 409),
    });
    const user = userEvent.setup();
    inApp(<FileCall call={fileCall(true)} threadId="t-1" samples />);
    await user.click(await heartOn(ADD));
    expect(await screen.findByText('В референсы можно добавить только документ, который сделал агент. Код: APP_EXAMPLE_NOT_MADE')).toBeInTheDocument();
    expect(await heartOn(ADD)).toHaveAttribute('aria-pressed', 'false');
    expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('says there is nowhere to put it for a person without a department, and asks nothing', async () => {
    const s = mockServer({ 'GET /app/api/me/examples': marks([], []) });
    const user = userEvent.setup();
    inApp(<FileCall call={fileCall(true)} threadId="t-1" samples />);
    await user.click(await heartOn(ADD));
    expect(await screen.findByText('Документ некуда добавить: вы не состоите ни в одном отделе. Попросите администратора добавить вас в отдел.')).toBeInTheDocument();
    expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('fills the heart of the block when the viewer it was pressed in closed before the answer', async () => {
    let answer!: () => void;
    const s = mockServer({
      'GET /app/api/me/examples': marks([]),
      'GET /app/api/threads/t-1/file/status': { body: { state: 'ok', version: 'v1' } },
      'GET /app/api/threads/t-1/file/preview': { raw: '%PDF' },
      'POST /app/api/me/examples': () =>
        new Promise((resolve) => {
          answer = () => {
            s.set('GET /app/api/me/examples', marks(['КП-Вектор.docx']));
            resolve({ status: 201, body: { documentId: 'doc-1' } });
          };
        }),
    });
    const asked = () => s.calls.filter((c) => c.method === 'GET' && c.path === '/app/api/me/examples').length;
    const user = userEvent.setup();
    inApp(<FileCall call={fileCall(true)} threadId="t-1" samples />);
    await user.click(screen.getByRole('button', { name: 'Открыть КП-Вектор.docx' }));
    const viewer = await screen.findByRole('dialog', { name: 'КП-Вектор.docx' });
    const inBar = await within(viewer).findByRole('button', { name: ADD });
    await waitFor(() => expect(inBar).toBeEnabled());
    await user.click(inBar);
    await user.click(within(viewer).getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const before = asked();
    answer();
    expect(await screen.findByText('Добавлено в референсы: база «Продажи»')).toBeInTheDocument();
    await waitFor(() => expect(asked()).toBeGreaterThan(before));
    expect(await heartOn(IN)).toHaveAttribute('aria-pressed', 'true');
  });

  it('says why when the marks did not load, asks again at a press, and adds nothing', async () => {
    const s = mockServer({ 'GET /app/api/me/examples': apiError('APP_INTERNAL', 'Что-то пошло не так на сервере.', 500) });
    const user = userEvent.setup();
    inApp(<FileCall call={fileCall(true)} threadId="t-1" samples />);
    const heart = await heartOn(ADD);
    s.set('GET /app/api/me/examples', marks(['КП-Вектор.docx']));
    await user.click(heart);
    expect(await screen.findByText(/Код: APP_INTERNAL$/)).toBeInTheDocument();
    expect(await heartOn(IN)).toHaveAttribute('aria-pressed', 'true');
    expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('is in the bar of the viewer opened from the block, and both hearts show the same', async () => {
    const s = mockServer({
      'GET /app/api/me/examples': marks([]),
      'GET /app/api/threads/t-1/file/status': { body: { state: 'ok', version: 'v1' } },
      'GET /app/api/threads/t-1/file/preview': { raw: '%PDF' },
      'POST /app/api/me/examples': () => {
        s.set('GET /app/api/me/examples', marks(['КП-Вектор.docx']));
        return { status: 201, body: { documentId: 'doc-1' } };
      },
    });
    const user = userEvent.setup();
    inApp(<FileCall call={fileCall(true)} threadId="t-1" samples />);
    await user.click(screen.getByRole('button', { name: 'Открыть КП-Вектор.docx' }));
    const viewer = await screen.findByRole('dialog', { name: 'КП-Вектор.docx' });
    const inBar = await within(viewer).findByRole('button', { name: ADD });
    await waitFor(() => expect(inBar).toBeEnabled());
    await user.click(inBar);
    await waitFor(() => expect(within(viewer).getByRole('button', { name: IN })).toHaveAttribute('aria-pressed', 'true'));
    // The heart of the block under the viewer is filled as well.
    await waitFor(() => expect(screen.getAllByRole('button', { name: IN, hidden: true })).toHaveLength(2));
  });
});

const TICKET = {
  id: '14',
  author: 'Ольга Смирнова',
  agentId: 'sales',
  agentName: 'Продажи',
  status: 'new',
  createdAt: '2026-11-22T06:00:00Z',
  updatedAt: '2026-11-22T06:00:00Z',
  comment: 'Цена на С21 из прошлогоднего прайса',
  turn: 1,
  snapshot: [
    { role: 'user', at: '2026-11-22T05:58:00Z', text: 'Сколько стоит С21?', marks: [], turn: 1 },
    { role: 'assistant', at: '2026-11-22T05:58:10Z', text: '400 ₽ за лист', marks: ['файл: КП.docx'], turn: 1 },
  ],
  files: [
    { ord: 0, name: 'КП.docx', size: 2048, state: 'copied' },
    { ord: 1, name: 'Видео.mp4', size: 80_000_000, state: 'too_large' },
  ],
  models: ['qwen3.8-flash'],
  instructionsAt: null,
  taskId: null,
  reply: null,
  handledBy: null,
};

describe('«Поддержка»', () => {
  it('lists the complaints and answers one, its answer going to the employee', async () => {
    const agents = { ...ME, permissions: ['agents'] };
    const s = mockServer({
      'GET /app/api/me': { body: agents },
      'GET /app/api/admin/support': { body: { tickets: [TICKET] } },
      'GET /app/api/admin/support/14': { body: TICKET },
      'PATCH /app/api/admin/support/14': { body: { ...TICKET, status: 'resolved', reply: 'Обновили прайс', handledBy: 'Игорь' } },
    });
    renderApp('/admin/support');
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Поддержка' });
    await user.click(within(list).getByRole('link', { name: /№14/ }));
    expect(await screen.findByText('Цена на С21 из прошлогоднего прайса')).toBeInTheDocument();
    expect(screen.getByLabelText('Ответ, на который пожаловались')).toHaveTextContent('400 ₽ за лист');
    expect(screen.getByText(/не приложен: больше 50 МБ/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Скачать' })).toHaveAttribute('href', '/app/api/admin/support/14/files/0');
    expect(screen.getByText(/qwen3.8-flash · инструкции из файла агента/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Ответ сотруднику'), 'Обновили прайс');
    await user.selectOptions(screen.getByLabelText('Состояние'), 'resolved');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Ответ отправлен')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'resolved', reply: 'Обновили прайс', seen: '2026-11-22T06:00:00Z' });
  });

  it('is not in the panel without «Агенты»', async () => {
    const s = mockServer({ 'GET /app/api/me': { body: { ...ME, permissions: ['usage'] } }, 'GET /app/api/admin/value': apiError('APP_INTERNAL', 'нет', 500) });
    renderApp('/admin/support');
    expect(await screen.findByRole('link', { name: 'Польза от агентов' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Поддержка' })).not.toBeInTheDocument();
    expect(s.calls.some((c) => c.path.startsWith('/app/api/admin/support'))).toBe(false);
  });
});

describe('«Мои обращения»', () => {
  it('shows the person’s complaints and the answer of the support', async () => {
    mockServer({ 'GET /app/api/me': { body: ME }, 'GET /app/api/me/support': { body: { tickets: [{ id: '14', agentName: 'Продажи', status: 'resolved', comment: 'Цена старая', reply: 'Обновили прайс', createdAt: '2026-11-22T06:00:00Z', updatedAt: '2026-11-22T07:00:00Z' }] } } });
    renderApp('/settings/requests');
    expect(await screen.findByText('Обновили прайс')).toBeInTheDocument();
    expect(screen.getByText('Решена')).toBeInTheDocument();
    expect(screen.getByText('Цена старая')).toBeInTheDocument();
  });
});

describe('«Польза от агентов»', () => {
  it('shows the hours by the norms beside the spend, and how they are counted', async () => {
    const zero = { document: 0, action: 0, email: 0, background_run: 0, web_research: 0, knowledge_answer: 0 };
    mockServer({
      'GET /app/api/me': { body: { ...ME, permissions: ['usage'] } },
      'GET /app/api/admin/value': {
        body: {
          from: '2026-11',
          to: '2026-11',
          factsSince: '2026-11-22T00:00:00Z',
          norms: { document: 20, action: 3, email: 5, background_run: 5, web_research: 10, knowledge_answer: 5 },
          hourRub: null,
          total: { people: 4, conversations: 9, facts: { ...zero, document: 6, email: 3 }, minutes: 135 },
          departments: [{ id: 'd1', name: 'Продажи', people: 3, conversations: 7, facts: { ...zero, document: 6 }, minutes: 120 }],
          otherDepartments: { people: 1, conversations: 2, facts: { ...zero, email: 3 }, minutes: 15 },
          agents: [{ id: 'sales', name: 'Продажи', people: 4, conversations: 9, facts: { ...zero, document: 6, email: 3 }, minutes: 135 }],
          otherAgents: null,
          hidden: true,
          spendRub: 4830,
          subscriptionCalls: 1920,
        },
      },
    });
    renderApp('/admin/value');
    expect(await screen.findByText('Оценка: около 2,3 ч работы')).toBeInTheDocument();
    expect(screen.getByText('Расход на модели: 4 830 ₽')).toBeInTheDocument();
    expect(screen.getByText(/1 920 обращений/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'По отделам' })).toHaveTextContent('Другие отделы');
    expect(screen.getByText(/Оценка эквивалентной работы по нормам/)).toBeInTheDocument();
    expect(screen.getByText(/Группы, где работали меньше 3 человек/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Скачать отчёт' })).toHaveAttribute('href', '/app/api/admin/value.csv?from=2026-11&to=2026-11');
  });
});
