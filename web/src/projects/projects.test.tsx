import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const AGENTS = [
  { id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', starters: [], actions: {}, systems: { tools: {}, prefixes: {} } },
  { id: 'assistant', name: 'Общий помощник', description: 'Вопросы и заметки', starters: [], actions: {}, systems: { tools: {}, prefixes: {} } },
];
const TENDER = { id: 'p1', name: 'Тендер Альфа', instructions: '', threadCount: 0, createdAt: '2026-11-10T08:00:00Z' };
const REPORTS = { id: 'p2', name: 'Отчёты', instructions: 'Кратко', threadCount: 3, createdAt: '2026-11-11T08:00:00Z' };

function server(extra: Record<string, Parameters<typeof mockServer>[0][string]> = {}) {
  return mockServer({
    'GET /app/api/me': { body: ME },
    'GET /app/api/agents': { body: { agents: AGENTS } },
    'GET /app/api/threads': { body: { threads: [], next: null } },
    'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: 3000, resetsOn: '2026-12-01' }, daily: null } },
    'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' }, assistant: { name: 'assistant', description: '', className: 'MastraAgent' } } } },
    'GET /app/api/projects': { body: { projects: [TENDER, REPORTS] } },
    'GET /app/api/projects/p1': { body: TENDER },
    'GET /app/api/projects/p2': { body: REPORTS },
    'GET /app/api/projects/p1/files': { body: { files: [] } },
    ...extra,
  });
}

describe('projects of conversations', () => {
  it('creates a project from the side panel by Enter and opens its page', async () => {
    const s = server({ 'POST /app/api/projects': { status: 201, body: { ...TENDER, id: 'p9', name: 'Новый тендер' } } });
    s.set('GET /app/api/projects/p9', { body: { ...TENDER, id: 'p9', name: 'Новый тендер' } });
    s.set('GET /app/api/projects/p9/files', { body: { files: [] } });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Новый проект' }));
    await user.type(screen.getByRole('textbox', { name: 'Название проекта' }), 'Новый тендер{Enter}');
    expect(s.calls.find((c) => c.method === 'POST' && c.path === '/app/api/projects')?.body).toEqual({ name: 'Новый тендер' });
    expect(await screen.findByRole('heading', { name: 'Новый тендер' })).toBeInTheDocument();
  });

  it('lists the projects with the number of their conversations', async () => {
    server();
    renderApp('/agents/sales?thread=t1');
    const link = await screen.findByRole('link', { name: /Отчёты/ });
    expect(link).toHaveAttribute('href', '/projects/p2');
    expect(within(link).getByText('3')).toBeInTheDocument();
  });

  it('saves the instructions for the agent', async () => {
    const s = server({ 'PUT /app/api/projects/p1': (call) => ({ body: { ...TENDER, ...(call.body as object) } }) });
    renderApp('/projects/p1');
    const user = userEvent.setup();
    expect(await screen.findByText(/Добавьте инструкции и файлы/)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Инструкции для агента' }), 'Заказчик — ООО «Альфа»');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Сохранено')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ instructions: 'Заказчик — ООО «Альфа»' });
  });

  it('uploads a file, and removes one only after the question', async () => {
    const s = server({ 'POST /app/api/projects/p1/files': { status: 201, body: { path: 'смета.xlsx', bytes: 2048 } }, 'DELETE /app/api/projects/p1/file': { body: { ok: true } } });
    renderApp('/projects/p1');
    const user = userEvent.setup();
    expect(await screen.findByText(/Файлов пока нет/)).toBeInTheDocument();
    s.set('GET /app/api/projects/p1/files', { body: { files: [{ path: 'смета.xlsx', bytes: 2048 }] } });
    await user.upload(screen.getByLabelText('Загрузить файл', { selector: 'input' }), new File(['x'], 'смета.xlsx'));
    expect(await screen.findByText('2 КБ')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Удалить смета.xlsx' }));
    const question = screen.getByRole('alertdialog', { name: 'Удалить файл «смета.xlsx»?' });
    expect(within(question).getByText('Агент больше не сможет его прочитать.')).toBeInTheDocument();
    await user.click(within(question).getByRole('button', { name: 'Отмена' }));
    expect(s.calls.some((c) => c.method === 'DELETE')).toBe(false);

    s.set('GET /app/api/projects/p1/files', { body: { files: [] } });
    await user.click(screen.getByRole('button', { name: 'Удалить смета.xlsx' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить' }));
    expect(await screen.findByText(/Файлов пока нет/)).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'DELETE')?.path).toBe('/app/api/projects/p1/file');
  });

  it('refuses a file over the limit with its own code and no repeat', async () => {
    const s = server();
    renderApp('/projects/p1');
    const user = userEvent.setup();
    await screen.findByText(/Файлов пока нет/);
    const big = new File(['x'], 'огромный.pdf');
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await user.upload(screen.getByLabelText('Загрузить файл', { selector: 'input' }), big);
    expect(await screen.findByText(/APP_UPLOAD_TOO_LARGE|больше 20 МБ/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
    expect(s.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('starts a new conversation in the project with the chosen agent', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
    const thread = '/app/api/threads/00000000-0000-4000-8000-000000000001/project';
    let linked: string | null = null;
    const s = server({
      [`PUT ${thread}`]: (call) => ((linked = (call.body as { projectId: string }).projectId), { body: { ok: true } }),
      [`GET ${thread}`]: () => ({ body: { projectId: linked } }),
    });
    renderApp('/projects/p1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Новый разговор в проекте' }));
    await user.click(screen.getByRole('menuitem', { name: /Общий помощник/ }));
    expect(await screen.findByRole('button', { name: /Тендер Альфа/ })).toHaveAttribute('aria-haspopup', 'menu');
    expect(s.calls.find((c) => c.method === 'PUT' && c.path === thread)?.body).toEqual({ projectId: 'p1' });
  });

  // «Новый разговор» of the side panel inside a project (decision of the owner 15.11).
  describe('«Новый разговор» of the side panel', () => {
    const NEW_ID = '00000000-0000-4000-8000-000000000003';
    const newThread = `/app/api/threads/${NEW_ID}/project`;
    // The new conversation remembers the project it was put into.
    function withNewThread(extra: Record<string, Parameters<typeof mockServer>[0][string]> = {}) {
      vi.spyOn(crypto, 'randomUUID').mockReturnValue(NEW_ID);
      let linked: string | null = null;
      return server({
        [`PUT ${newThread}`]: (call) => ((linked = (call.body as { projectId: string }).projectId), { body: { ok: true } }),
        [`GET ${newThread}`]: () => ({ body: { projectId: linked } }),
        ...extra,
      });
    }
    const startNew = async () => userEvent.setup().click(await screen.findByRole('button', { name: 'Новый разговор' }));

    it('puts the conversation into the project whose page is open', async () => {
      const s = withNewThread();
      renderApp('/projects/p1');
      await screen.findByRole('heading', { name: 'Тендер Альфа' });
      await startNew();
      expect(await screen.findByRole('button', { name: /Тендер Альфа/, expanded: false })).toHaveAttribute('aria-haspopup', 'menu');
      expect(s.calls.find((c) => c.method === 'PUT' && c.path === newThread)?.body).toEqual({ projectId: 'p1' });
    });

    it('puts the conversation into the project of the open conversation', async () => {
      const s = withNewThread({ 'GET /app/api/threads/t1/project': { body: { projectId: 'p2' } } });
      renderApp('/agents/sales?thread=t1');
      await screen.findByRole('button', { name: /Отчёты/, expanded: false });
      await startNew();
      await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT' && c.path === newThread)?.body).toEqual({ projectId: 'p2' }));
      expect(await screen.findByRole('button', { name: /Отчёты/, expanded: false })).toBeInTheDocument();
    });

    it('starts the conversation without a project outside of one', async () => {
      const s = withNewThread({ 'GET /app/api/threads/t1/project': { body: { projectId: null } } });
      renderApp('/agents/sales?thread=t1');
      await screen.findByRole('button', { name: /Без проекта/ });
      await startNew();
      await waitFor(() => expect(s.calls.some((c) => c.method === 'GET' && c.path === newThread)).toBe(true));
      expect(s.calls.some((c) => c.method === 'PUT')).toBe(false);
    });
  });

  it('keeps the chip working and says why when the new conversation could not go into the project', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000002');
    const thread = '/app/api/threads/00000000-0000-4000-8000-000000000002/project';
    server({
      [`PUT ${thread}`]: apiError('APP_NOT_FOUND', 'Проект не найден.', 404),
      [`GET ${thread}`]: { body: { projectId: null } },
    });
    renderApp('/projects/p1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Новый разговор в проекте' }));
    await user.click(screen.getByRole('menuitem', { name: /Продажи/ }));
    expect(await screen.findByRole('button', { name: /Без проекта/ })).toBeInTheDocument();
    expect(screen.getAllByRole('alert').some((a) => a.textContent === 'Проект не найден.')).toBe(true);
  });

  it('shows only the folder on the chip of a conversation without a project (decision of the owner 15.11)', async () => {
    server({ 'GET /app/api/threads/t1/project': { body: { projectId: null } } });
    renderApp('/agents/sales?thread=t1');
    const chip = await screen.findByRole('button', { name: 'Проект разговора: Без проекта' });
    expect(chip).toHaveTextContent(/^$/);
  });

  it('moves the conversation into a project from the chip of the input', async () => {
    const s = server({ 'GET /app/api/threads/t1/project': { body: { projectId: null } }, 'PUT /app/api/threads/t1/project': { body: { ok: true } } });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Без проекта/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: /Отчёты/ }));
    expect(await screen.findByRole('button', { name: /Отчёты/, expanded: false })).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ projectId: 'p2' });
  });

  it('says what goes away with the project before removing it', async () => {
    const s = server({ 'DELETE /app/api/projects/p1': { body: { ok: true } } });
    s.set('GET /app/api/projects/p1/files', { body: { files: [{ path: 'a.pdf', bytes: 1 }, { path: 'b.pdf', bytes: 1 }] } });
    renderApp('/projects/p1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Удалить' }));
    const question = await screen.findByRole('alertdialog', { name: 'Удалить проект «Тендер Альфа»?' });
    expect(within(question).getByText('Удалятся инструкции и 2 файла проекта. Разговоры останутся, без проекта.')).toBeInTheDocument();
    await user.click(within(question).getByRole('button', { name: 'Удалить' }));
    expect(await screen.findByText('Проект удалён')).toBeInTheDocument();
    await waitFor(() => expect(s.calls.some((c) => c.method === 'DELETE' && c.path === '/app/api/projects/p1')).toBe(true));
  });

  it('tells about a project that is not there', async () => {
    const s = server();
    s.set('GET /app/api/projects/p1', apiError('APP_NOT_FOUND', 'Проект не найден.', 404));
    renderApp('/projects/p1');
    expect(await screen.findByText('Проект не найден.')).toBeInTheDocument();
  });
});
