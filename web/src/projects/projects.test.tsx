import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';
import { PICKER_SORT_KEY } from './picker.ts';

const AGENTS = [
  { id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', starters: [], mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } },
  { id: 'assistant', name: 'Общий помощник', description: 'Вопросы и заметки', starters: [], mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } },
];
const TENDER = { id: 'p1', name: 'Тендер Альфа', instructions: '', threadCount: 0, lastActiveAt: '2026-11-10T08:00:00Z', pinned: false, createdAt: '2026-11-10T08:00:00Z', role: 'owner' as const, owner: { id: 'u-olga', name: 'Ольга' }, shared: false, unseen: false, access: { mode: 'private' as const, departments: [], people: [] }, archivedAt: null };
const REPORTS = { id: 'p2', name: 'Отчёты', instructions: 'Кратко', threadCount: 3, lastActiveAt: '2026-11-16T08:00:00Z', pinned: false, createdAt: '2026-11-11T08:00:00Z', role: 'owner' as const, owner: { id: 'u-olga', name: 'Ольга' }, shared: false, unseen: false, access: { mode: 'private' as const, departments: [], people: [] }, archivedAt: null };

function server(extra: Record<string, Parameters<typeof mockServer>[0][string]> = {}) {
  return mockServer({
    'GET /app/api/me': { body: ME },
    'GET /app/api/agents': { body: { agents: AGENTS } },
    'GET /app/api/threads': { body: { threads: [], next: null } },
    'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: 3000, resetsOn: '2026-12-01' }, daily: null } },
    'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' }, assistant: { name: 'assistant', description: '', className: 'MastraAgent' } } } },
    'GET /app/api/projects': { body: { projects: [TENDER, REPORTS], archivedCount: 0 } },
    'GET /app/api/projects/p1': { body: TENDER },
    'GET /app/api/projects/p2': { body: REPORTS },
    'GET /app/api/projects/p1/files': { body: { files: [] } },
    'GET /app/api/projects/p1/trash': { body: { batches: [] } },
    'GET /app/api/projects/p2/files': { body: { files: [] } },
    'GET /app/api/projects/p2/trash': { body: { batches: [] } },
    'GET /app/api/projects/p1/memory': { body: { entries: [], usedChars: 0, maxChars: 6000, readOnly: false } },
    'GET /app/api/projects/p2/memory': { body: { entries: [], usedChars: 0, maxChars: 6000, readOnly: false } },
    'GET /app/api/departments': { body: { departments: [] } },
    ...extra,
  });
}

describe('projects of conversations', () => {
  it('creates a project from the side panel by Enter and opens its page', async () => {
    const s = server({ 'POST /app/api/projects': { status: 201, body: { ...TENDER, id: 'p9', name: 'Новый тендер' } } });
    s.set('GET /app/api/projects/p9', { body: { ...TENDER, id: 'p9', name: 'Новый тендер' } });
    s.set('GET /app/api/projects/p9/files', { body: { files: [] } });
    s.set('GET /app/api/projects/p9/trash', { body: { batches: [] } });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Новый проект' }));
    await user.type(screen.getByRole('textbox', { name: 'Название проекта' }), 'Новый тендер{Enter}');
    expect(s.calls.find((c) => c.method === 'POST' && c.path === '/app/api/projects')?.body).toEqual({ name: 'Новый тендер', access: { mode: 'private', departmentIds: [], userIds: [] } });
    expect(await screen.findByRole('heading', { name: 'Новый тендер' })).toBeInTheDocument();
  });

  it('loads a project while the pointer is over it, so the click opens it at once (spec, section 8.22)', async () => {
    let answer: (() => void) | null = null;
    const s = server();
    renderApp('/agents/sales?thread=t1');
    const link = await screen.findByRole('link', { name: 'Отчёты' });
    const asked = (path: string) => s.calls.filter((c) => c.method === 'GET' && c.path === path).length;
    // The pointer passing over another project loads nothing.
    const passing = screen.getByRole('link', { name: 'Тендер Альфа' });
    fireEvent.mouseEnter(passing);
    fireEvent.mouseLeave(passing);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(asked('/app/api/projects/p1')).toBe(0);
    fireEvent.mouseEnter(link);
    await waitFor(() => expect(asked('/app/api/projects/p2')).toBe(1));
    expect(asked('/app/api/projects/p2/files')).toBe(1);
    expect(asked('/app/api/projects/p2/trash')).toBe(1);
    expect(s.calls.some((c) => c.path === '/app/api/threads' && c.query.projectId === 'p2')).toBe(true);
    // Another pass over it a moment later does not ask again.
    fireEvent.mouseLeave(link);
    fireEvent.mouseEnter(link);
    fireEvent.focus(link);
    expect(asked('/app/api/projects/p2')).toBe(1);
    // The server is slow now: what was loaded over the link is shown at once on the click.
    s.set('GET /app/api/projects/p2', () => new Promise((resolve) => (answer = () => resolve({ body: REPORTS }))));
    await userEvent.setup().click(link);
    expect(screen.getByRole('heading', { name: 'Отчёты' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Разговоры проекта' })).toBeInTheDocument();
    if (answer) (answer as () => void)();
  });

  it('lists the projects without the number of their conversations (decision of the owner 15.11)', async () => {
    server();
    renderApp('/agents/sales?thread=t1');
    const link = await screen.findByRole('link', { name: 'Отчёты' });
    expect(link).toHaveAttribute('href', '/projects/p2');
    expect(link).toHaveTextContent(/^Отчёты$/);
  });

  // «Проекты» of the side panel (spec, section 8.12; decisions of the owner 15.11).
  describe('order of «Проекты»', () => {
    const PLAN = { ...TENDER, id: 'p3', name: 'План', pinned: true, lastActiveAt: '2026-11-01T08:00:00Z' };
    const TENDER_PINNED = { ...TENDER, pinned: true };
    const REPORTS_PINNED = { ...REPORTS, pinned: true };
    const PROJECT_LINK = 'a[href^="/projects/"]';
    const panel = () =>
      screen.getAllByRole('link').filter((a) => a.matches(PROJECT_LINK)).map((a) => `${a.textContent}${within(a).queryByRole('img', { name: 'Закреплён' }) ? '*' : ''}`);
    const openMenu = async (name: string) => {
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: `Действия с проектом «${name}»` }));
      return user;
    };

    // jsdom lays nothing out: each project row gets 40 px in the order of the page.
    const layOutPanel = () =>
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const all = [...document.querySelectorAll(PROJECT_LINK)];
        const inside = this.matches(PROJECT_LINK) ? [this] : [...this.querySelectorAll(PROJECT_LINK)];
        if (inside.length === 0) return new DOMRect(0, 0, 0, 0);
        return new DOMRect(0, all.indexOf(inside[0]!) * 40, 240, inside.length * 40 - 4);
      });
    const dragUpByKeyboard = async (name: string | RegExp) => {
      const user = userEvent.setup();
      screen.getByRole('link', { name }).focus();
      await user.keyboard(' ');
      await user.keyboard('{ArrowUp}');
      await user.keyboard(' ');
      return user;
    };

    afterEach(() => vi.restoreAllMocks());

    // Decision of the owner 17.11: the unpinned ones go by the person's latest work.
    it('pins a project after the pinned ones; an unpinned one goes among the rest by its latest work', async () => {
      const s = server({
        'GET /app/api/projects': { body: { projects: [PLAN, TENDER, REPORTS], archivedCount: 0 } },
        'PUT /app/api/projects/p2': { body: { ...REPORTS, pinned: true } },
        'PUT /app/api/projects/p3': { body: { ...PLAN, pinned: false } },
      });
      renderApp('/agents/sales?thread=t1');
      await screen.findByRole('link', { name: /План/ });
      expect(panel()).toEqual(['План*', 'Тендер Альфа', 'Отчёты']);

      let user = await openMenu('Отчёты');
      await user.click(screen.getByRole('menuitem', { name: 'Закрепить' }));
      expect(panel()).toEqual(['План*', 'Отчёты*', 'Тендер Альфа']);
      // The row went over to the other group: its link has the keyboard.
      expect(screen.getByRole('link', { name: /Отчёты/ })).toHaveFocus();
      await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT' && c.path === '/app/api/projects/p2')?.body).toEqual({ pinned: true }));

      user = await openMenu('План');
      await user.click(screen.getByRole('menuitem', { name: 'Открепить' }));
      expect(panel()).toEqual(['Отчёты*', 'Тендер Альфа', 'План']);
      await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT' && c.path === '/app/api/projects/p3')?.body).toEqual({ pinned: false }));
    });

    it('drags a pinned project with the keyboard: the space bar picks it up, the arrows move it, the space bar leaves it', async () => {
      layOutPanel();
      const s = server({
        'GET /app/api/projects': { body: { projects: [PLAN, REPORTS_PINNED, TENDER], archivedCount: 0 } },
        'PUT /app/api/projects/order': { body: { ok: true } },
      });
      renderApp('/agents/sales?thread=t1');
      await screen.findByRole('link', { name: /Отчёты/ });
      // An unpinned project goes by work: the space bar does not pick it up.
      await dragUpByKeyboard('Тендер Альфа');
      expect(panel()).toEqual(['План*', 'Отчёты*', 'Тендер Альфа']);
      const user = await dragUpByKeyboard(/Отчёты/);
      expect(panel()).toEqual(['Отчёты*', 'План*', 'Тендер Альфа']);
      await waitFor(() => expect(s.calls.find((c) => c.path === '/app/api/projects/order')?.body).toEqual({ ids: ['p2', 'p3'] }));
      expect(s.calls.filter((c) => c.path === '/app/api/projects/order')).toHaveLength(1);
      // A drop opens nothing; Enter still opens the project.
      expect(screen.getByRole('link', { name: /Отчёты/ })).toHaveFocus();
      expect(screen.queryByRole('heading', { name: 'Отчёты' })).not.toBeInTheDocument();
      await user.keyboard('{Enter}');
      expect(await screen.findByRole('heading', { name: 'Отчёты' })).toBeInTheDocument();
    });

    it('a mouse drop does not let the browser follow the link; a click after it opens the project', async () => {
      layOutPanel();
      const s = server({ 'GET /app/api/projects': { body: { projects: [TENDER_PINNED, REPORTS_PINNED], archivedCount: 0 } }, 'PUT /app/api/projects/order': { body: { ok: true } } });
      renderApp('/agents/sales?thread=t1');
      const link = await screen.findByRole('link', { name: /Отчёты/ });
      fireEvent.mouseDown(link, { button: 0, clientX: 20, clientY: 60 });
      fireEvent.mouseMove(document, { clientX: 20, clientY: 40 });
      fireEvent.mouseMove(document, { clientX: 20, clientY: 20 });
      fireEvent.mouseUp(document, { clientX: 20, clientY: 20 });
      const click = createEvent.click(link, { button: 0 });
      fireEvent(link, click);
      expect(click.defaultPrevented).toBe(true);
      expect(panel()).toEqual(['Отчёты*', 'Тендер Альфа*']);
      await waitFor(() => expect(s.calls.find((c) => c.path === '/app/api/projects/order')?.body).toEqual({ ids: ['p2', 'p1'] }));
      await userEvent.setup().click(screen.getByRole('link', { name: /Отчёты/ }));
      expect(await screen.findByRole('heading', { name: 'Отчёты' })).toBeInTheDocument();
    });

    it('a list that loads while an order is being saved does not bring the old order back', async () => {
      layOutPanel();
      let answerList: (() => void) | null = null;
      const s = server({
        'GET /app/api/projects': { body: { projects: [TENDER_PINNED, REPORTS_PINNED], archivedCount: 0 } },
        'PUT /app/api/projects/order': { body: { ok: true } },
        'PUT /app/api/projects/p1': { body: { ...TENDER_PINNED, name: 'Тендер Бета' } },
      });
      renderApp('/agents/sales?thread=t1');
      await screen.findByRole('link', { name: /Отчёты/ });
      // The rename loads the list again; that list (the old order) answers only after the drop.
      s.set('GET /app/api/projects', () => new Promise((resolve) => (answerList = () => resolve({ body: { projects: [{ ...TENDER_PINNED, name: 'Тендер Бета' }, REPORTS_PINNED], archivedCount: 0 } }))));
      const user = await openMenu('Тендер Альфа');
      await user.click(screen.getByRole('menuitem', { name: 'Переименовать' }));
      await user.clear(screen.getByRole('textbox', { name: 'Название проекта' }));
      await user.type(screen.getByRole('textbox', { name: 'Название проекта' }), 'Тендер Бета{Enter}');
      await waitFor(() => expect(answerList).not.toBeNull());
      await dragUpByKeyboard(/Отчёты/);
      await waitFor(() => expect(s.calls.some((c) => c.path === '/app/api/projects/order')).toBe(true));
      s.set('GET /app/api/projects', { body: { projects: [REPORTS_PINNED, { ...TENDER_PINNED, name: 'Тендер Бета' }], archivedCount: 0 } });
      answerList!();
      await waitFor(() => expect(s.calls.filter((c) => c.method === 'GET' && c.path === '/app/api/projects')).toHaveLength(3));
      await waitFor(() => expect(panel()).toEqual(['Отчёты*', 'Тендер Бета*']));
    });

    it('says when the order was not saved and shows the order of the server again', async () => {
      const s = server({ 'PUT /app/api/projects/p2': apiError('APP_INTERNAL', 'Что-то пошло не так на сервере.', 500) });
      renderApp('/agents/sales?thread=t1');
      const user = await openMenu('Отчёты');
      await user.click(screen.getByRole('menuitem', { name: 'Закрепить' }));
      expect(await screen.findByText('Изменение в «Проектах» не сохранилось')).toBeInTheDocument();
      await waitFor(() => expect(panel()).toEqual(['Тендер Альфа', 'Отчёты']));
      expect(s.calls.filter((c) => c.method === 'GET' && c.path === '/app/api/projects')).toHaveLength(2);
    });

    it('renames a project from its three dots, and its open page shows the new name', async () => {
      const renamed = { ...TENDER, name: 'Тендер Бета' };
      const s = server({
        'PUT /app/api/projects/p1': () => {
          s.set('GET /app/api/projects/p1', { body: renamed });
          s.set('GET /app/api/projects', { body: { projects: [renamed, REPORTS], archivedCount: 0 } });
          return { body: renamed };
        },
      });
      renderApp('/projects/p1');
      await screen.findByRole('heading', { name: 'Тендер Альфа' });
      const user = await openMenu('Тендер Альфа');
      await user.click(screen.getByRole('menuitem', { name: 'Переименовать' }));
      const field = screen.getByRole('textbox', { name: 'Название проекта' });
      await user.clear(field);
      await user.type(field, 'Тендер Бета{Enter}');
      expect(await screen.findByRole('heading', { name: 'Тендер Бета' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Тендер Бета' })).toHaveFocus();
      expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ name: 'Тендер Бета' });
    });
  });

  // The page of a project (requests of the owner 17.11): the tabs «Разговоры» (first) and «Файлы»; in the title row
  // three icons — «Переименовать», «В архив», and the gear with the instructions, the memory and the folder of the computer.
  it('has the tabs «Разговоры» and «Файлы» and the icons of the title row, the gear opening the settings', async () => {
    server();
    renderApp('/projects/p1');
    const user = userEvent.setup();
    const tabs = await screen.findByRole('navigation', { name: 'Разделы проекта' });
    expect(within(tabs).getAllByRole('link').map((l) => l.textContent)).toEqual(['Разговоры', 'Файлы']);
    const gear = screen.getByRole('button', { name: 'Настройки проекта' });
    expect([...gear.parentElement!.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Закрепить в панели', 'Переименовать', 'В архив', 'Настройки проекта']);
    expect(within(tabs).getByRole('link', { name: 'Разговоры' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Новый разговор в проекте' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Файлы проекта' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Инструкции для агента' })).not.toBeInTheDocument();

    await user.click(within(tabs).getByRole('link', { name: 'Файлы' }));
    expect(await screen.findByRole('heading', { name: 'Файлы проекта' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Новый разговор в проекте' })).not.toBeInTheDocument();
    expect(within(tabs).getByRole('link', { name: 'Файлы' })).toHaveAttribute('aria-current', 'page');

    await user.click(gear);
    expect(await screen.findByRole('textbox', { name: 'Инструкции для агента' })).toBeInTheDocument();
    expect(gear).toHaveAttribute('aria-pressed', 'true');
    expect(within(tabs).queryByRole('link', { current: 'page' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Память проекта' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Папка на компьютере' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Файлы проекта' })).not.toBeInTheDocument();
  });

  // Decision of the owner 17.11: a project far down the list is put into the panel from its page.
  it('pins the project from the title row, and the panel shows it among the pinned', async () => {
    const s = server({ 'PUT /app/api/projects/p1': { body: { ...TENDER, pinned: true } } });
    renderApp('/projects/p1');
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'Закрепить в панели' });
    s.set('GET /app/api/projects/p1', { body: { ...TENDER, pinned: true } });
    await user.click(button);
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT' && c.path === '/app/api/projects/p1')?.body).toEqual({ pinned: true }));
    expect(await screen.findByRole('button', { name: 'Открепить от панели' })).toBeInTheDocument();
    // The panel asks for the list again.
    await waitFor(() => expect(s.calls.filter((c) => c.method === 'GET' && c.path === '/app/api/projects')).toHaveLength(2));
  });

  it('a colleague pins a shared project from its page too', async () => {
    server({ 'GET /app/api/projects/p1': { body: { ...TENDER, role: 'member' as const, access: null, shared: true } } });
    renderApp('/projects/p1');
    const gear = await screen.findByRole('button', { name: 'Настройки проекта' });
    expect([...gear.parentElement!.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Закрепить в панели', 'Настройки проекта']);
  });

  it('renames the project from the pencil of the title row', async () => {
    const s = server({ 'PUT /app/api/projects/p1': (call) => ({ body: { ...TENDER, ...(call.body as object) } }) });
    renderApp('/projects/p1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Переименовать' }));
    const field = screen.getByRole('textbox', { name: 'Название проекта' });
    expect(field).toHaveValue('Тендер Альфа');
    await user.clear(field);
    await user.type(field, 'Тендер Бета');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByRole('heading', { name: 'Тендер Бета' })).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ name: 'Тендер Бета' });
    expect(screen.getByRole('button', { name: 'Переименовать' })).toBeInTheDocument();
  });

  it('saves the instructions for the agent', async () => {
    const s = server({ 'PUT /app/api/projects/p1': (call) => ({ body: { ...TENDER, ...(call.body as object) } }) });
    renderApp('/projects/p1?tab=settings');
    const user = userEvent.setup();
    expect(await screen.findByText(/Добавьте инструкции и файлы/)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Инструкции для агента' }), 'Заказчик — ООО «Альфа»');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Сохранено')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ instructions: 'Заказчик — ООО «Альфа»' });
  });

  // A removed file goes into the project's trash at once, «Вернуть» brings it back (spec, section 8.20).
  it('uploads a file, and removes one into the trash with «Вернуть» in the notice', async () => {
    const s = server({
      'POST /app/api/projects/p1/files': { status: 201, body: { path: 'смета.xlsx', bytes: 2048 } },
      'DELETE /app/api/projects/p1/file': { body: { ok: true, trashId: 'tr1' } },
      'POST /app/api/projects/p1/trash/restore': { body: { restored: ['смета.xlsx'] } },
    });
    renderApp('/projects/p1?tab=files');
    const user = userEvent.setup();
    expect(await screen.findByText(/Файлов пока нет/)).toBeInTheDocument();
    s.set('GET /app/api/projects/p1/files', { body: { files: [{ path: 'смета.xlsx', bytes: 2048 }] } });
    await user.upload(screen.getByLabelText('Загрузить файл', { selector: 'input' }), new File(['x'], 'смета.xlsx'));
    expect(await screen.findByText('2 КБ')).toBeInTheDocument();

    s.set('GET /app/api/projects/p1/files', { body: { files: [] } });
    s.set('GET /app/api/projects/p1/trash', { body: { batches: [{ id: 'b1', via: 'page', deletedBy: 'Ольга', deletedAt: '2026-11-16T08:00:00Z', overlapped: false, items: [{ id: 'tr1', path: 'смета.xlsx', bytes: 2048, kind: 'deleted', expiresAt: '2026-12-16T08:00:00Z' }] }] } });
    await user.click(screen.getByRole('button', { name: 'Удалить смета.xlsx' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await screen.findByText(/Файлов пока нет/)).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'DELETE')?.path).toBe('/app/api/projects/p1/file');
    expect(await screen.findByRole('button', { name: 'Корзина · 1' })).toBeInTheDocument();
    expect(await screen.findByText(/Файл «смета.xlsx» в корзине/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Вернуть' }));
    await waitFor(() => expect(s.calls.find((c) => c.path === '/app/api/projects/p1/trash/restore')?.body).toEqual({ ids: ['tr1'] }));
  });

  // Versions of one document in any format are one stack (decision of the owner 18.11).
  it('gathers the versions of a document into a stack that opens into its files and does not close', async () => {
    const top = ['v2.pdf', 'v2.pptx', 'v3.pdf', 'v3.pptx', '.pdf', '.pptx'].map((end) => ({ path: `Топ нейросетей для бизнес-агентов${end.startsWith('.') ? '' : ' '}${end}`, bytes: 136192 }));
    server({ 'GET /app/api/projects/p1/files': { body: { files: [{ path: 'Акт.pdf', bytes: 2048 }, ...top] } } });
    renderApp('/projects/p1?tab=files');
    const user = userEvent.setup();
    const stack = await screen.findByRole('button', { name: /Топ нейросетей для бизнес-агентов/ });
    expect(stack).toHaveAttribute('aria-expanded', 'false');
    expect(stack).toHaveTextContent('6 файлов · 3 версии · 3 PDF · 3 PowerPoint');
    expect(screen.getByText('Акт.pdf')).toBeInTheDocument();
    expect(screen.queryByText('Топ нейросетей для бизнес-агентов v2.pdf')).not.toBeInTheDocument();

    await user.click(stack);
    for (const f of top) expect(screen.getByText(f.path)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /6 файлов/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Топ нейросетей для бизнес-агентов v2.pdf' })).toHaveFocus();
  });

  it('refuses a file over the limit with its own code and no repeat', async () => {
    const s = server();
    renderApp('/projects/p1?tab=files');
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
    expect(await screen.findByRole('button', { name: 'Тендер Альфа' })).toHaveAttribute('aria-haspopup', 'menu');
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
      expect(await screen.findByRole('button', { name: 'Тендер Альфа', expanded: false })).toHaveAttribute('aria-haspopup', 'menu');
      expect(s.calls.find((c) => c.method === 'PUT' && c.path === newThread)?.body).toEqual({ projectId: 'p1' });
    });

    it('puts the conversation into the project of the open conversation', async () => {
      const s = withNewThread({ 'GET /app/api/threads/t1/project': { body: { projectId: 'p2' } } });
      renderApp('/agents/sales?thread=t1');
      await screen.findByRole('button', { name: 'Отчёты', expanded: false });
      await startNew();
      await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT' && c.path === newThread)?.body).toEqual({ projectId: 'p2' }));
      expect(await screen.findByRole('button', { name: 'Отчёты', expanded: false })).toBeInTheDocument();
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
    const s = server({ 'GET /app/api/threads/t1/project': { body: { projectId: null, lost: null } }, 'PUT /app/api/threads/t1/project': { body: { ok: true } } });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Без проекта/ }));
    // The server has the conversation in the project once it is moved: the chip reads it again.
    s.set('GET /app/api/threads/t1/project', { body: { projectId: 'p2', lost: null } });
    await user.click(await screen.findByRole('menuitemradio', { name: /Отчёты/ }));
    expect(await screen.findByRole('button', { name: 'Отчёты', expanded: false })).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ projectId: 'p2' });
  });

  // The picker of the chip (owner 17.11): more than 5 projects scroll, with a small button that switches
  // the order between «недавние» and «по алфавиту»; more than 20 get a search line at the top.
  describe('the project picker of the input', () => {
    const at = (day: number) => new Date(Date.UTC(2026, 10, day, 8)).toISOString();
    const named = (name: string, day: number, id = name) => ({ ...TENDER, id, name, lastActiveAt: at(day) });
    async function openPicker(projects: ReturnType<typeof named>[]) {
      const s = server({
        'GET /app/api/projects': { body: { projects, archivedCount: 0 } },
        'GET /app/api/threads/t1/project': { body: { projectId: null, lost: null } },
        'PUT /app/api/threads/t1/project': { body: { ok: true } },
      });
      renderApp('/agents/sales?thread=t1');
      const user = userEvent.setup();
      const chip = await screen.findByRole('button', { name: 'Проект разговора: Без проекта' });
      await user.click(chip);
      const menu = await screen.findByRole('menu', { name: 'Проект разговора' });
      await within(menu).findByRole('menuitemradio', { name: projects[0]!.name });
      return { s, user, chip, menu };
    }
    // The projects of the menu in their order, without «Без проекта».
    const listed = (menu: HTMLElement) => within(menu).getAllByRole('menuitemradio').map((item) => item.textContent).filter((name) => name !== 'Без проекта');

    it('five projects go most recent first, a colleague\'s new one above all, without the order button or the search', async () => {
      // «По алфавиту» chosen when there were more: without the button it could not be switched back.
      localStorage.setItem(PICKER_SORT_KEY, 'name');
      const { menu } = await openPicker([named('Бюджет', 3), named('Акты', 9), { ...named('Общий от Игоря', 1), unseen: true }, named('Сверка', 7), named('Договоры', 5)]);
      expect(listed(menu)).toEqual(['Общий от Игоря', 'Акты', 'Сверка', 'Договоры', 'Бюджет']);
      expect(within(menu).queryByRole('button', { name: /^Порядок/ })).not.toBeInTheDocument();
      expect(within(menu).queryByRole('searchbox')).not.toBeInTheDocument();
    });

    it('from six projects the small button switches to alphabetical, and the choice stays for the next opening', async () => {
      const six = [named('Проект 10', 2), named('бюджет', 6), named('Акты', 1), named('Проект 9', 4), named('Ёлка', 5), named('Сверка', 3)];
      const { user, chip, menu } = await openPicker(six);
      expect(listed(menu)).toEqual(['бюджет', 'Ёлка', 'Проект 9', 'Сверка', 'Проект 10', 'Акты']);
      expect(within(menu).queryByRole('searchbox')).not.toBeInTheDocument();
      await user.click(within(menu).getByRole('button', { name: 'Порядок: сначала недавние' }));
      expect(listed(menu)).toEqual(['Акты', 'бюджет', 'Ёлка', 'Проект 9', 'Проект 10', 'Сверка']);
      expect(within(menu).getByRole('button', { name: 'Порядок: по алфавиту' })).toBeInTheDocument();
      await user.click(chip);
      await user.click(chip);
      expect(listed(await screen.findByRole('menu', { name: 'Проект разговора' }))).toEqual(['Акты', 'бюджет', 'Ёлка', 'Проект 9', 'Проект 10', 'Сверка']);
    });

    it('from 21 projects the search at the top narrows the list as typed, ё like е, and Enter picks the first one left', async () => {
      const many = Array.from({ length: 20 }, (_, i) => named(`Проект ${i + 1}`, i + 1, `m${i + 1}`));
      const { s, user, menu } = await openPicker([...many, named('Счёт Семёнову', 25, 'bill')]);
      const search = within(menu).getByRole('searchbox', { name: 'Найти проект' });
      expect(search).toHaveFocus();
      expect(within(menu).getByRole('button', { name: 'Порядок: сначала недавние' })).toBeInTheDocument();
      // Nothing typed yet: Enter does not move the conversation into the first project.
      await user.keyboard('{Enter}');
      expect(s.calls.some((c) => c.method === 'PUT')).toBe(false);
      expect(menu).toBeInTheDocument();
      await user.type(search, 'семен');
      expect(listed(menu)).toEqual(['Счёт Семёнову']);
      await user.clear(search);
      await user.type(search, 'ПРОЕКТ 2');
      expect(listed(menu)).toEqual(['Проект 20', 'Проект 2']);
      // «Без проекта» is not a project: it stays above whatever the search leaves.
      expect(within(menu).getByRole('menuitemradio', { name: 'Без проекта' })).toBeInTheDocument();
      await user.type(search, 'Ъ');
      expect(listed(menu)).toEqual([]);
      expect(within(menu).getByText('Нет совпадений')).toBeInTheDocument();
      await user.type(search, '{Backspace}{Enter}');
      await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ projectId: 'm20' }));
      // The keyboard stays at the chip, not at the start of the page.
      await waitFor(() => expect(document.activeElement).toHaveAttribute('aria-haspopup', 'menu'));
    });

    it('Esc closes the menu and puts the keyboard back on the chip', async () => {
      const { user, chip, menu } = await openPicker(Array.from({ length: 21 }, (_, i) => named(`Проект ${i + 1}`, i + 1, `m${i + 1}`)));
      await user.type(within(menu).getByRole('searchbox', { name: 'Найти проект' }), 'про');
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu', { name: 'Проект разговора' })).not.toBeInTheDocument();
      expect(chip).toHaveFocus();
    });

    it('a touch screen does not get the cursor in the search: its keyboard would cover the list', async () => {
      const system = window.matchMedia.bind(window);
      vi.stubGlobal('matchMedia', (query: string) => (query === '(pointer: fine)' ? { ...system(query), matches: false } : system(query)));
      const { menu } = await openPicker(Array.from({ length: 21 }, (_, i) => named(`Проект ${i + 1}`, i + 1, `m${i + 1}`)));
      expect(within(menu).getByRole('searchbox', { name: 'Найти проект' })).not.toHaveFocus();
    });
  });

  // A project is archived, not removed (decision of the owner 16.11): «Вернуть» in the notice.
  it('archives the project with «Вернуть» in the notice', async () => {
    const s = server({ 'POST /app/api/projects/p1/archive': { body: { ok: true } }, 'POST /app/api/projects/p1/unarchive': { body: { ok: true } } });
    renderApp('/projects/p1');
    const user = userEvent.setup();
    expect(screen.queryByRole('button', { name: 'Удалить' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'В архив' }));
    expect(await screen.findByText('Проект «Тендер Альфа» в архиве')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Вернуть' }));
    await waitFor(() => expect(s.calls.some((c) => c.path === '/app/api/projects/p1/unarchive')).toBe(true));
  });

  it('an archived project is read only; «Удалить навсегда» waits 30 days, then says what goes', async () => {
    const s = server({ 'DELETE /app/api/projects/p1': { body: { ok: true } } });
    s.set('GET /app/api/projects/p1', { body: { ...TENDER, archivedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() } });
    renderApp('/projects/p1');
    const user = userEvent.setup();
    expect(await screen.findByText(/Проект в архиве с/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Удалить навсегда' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Новый разговор в проекте' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Файлы' }));
    expect(await screen.findByRole('heading', { name: 'Файлы проекта' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Загрузить файл' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Переименовать' })).not.toBeInTheDocument();
    // An archived project is in no one's panel.
    expect(screen.queryByRole('button', { name: 'Закрепить в панели' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Настройки проекта' }));
    expect(await screen.findByRole('heading', { name: 'Инструкции для агента' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Инструкции для агента' })).not.toBeInTheDocument();
  });

  it('removes a project 30 days in the archive for good, after the question', async () => {
    const s = server({ 'DELETE /app/api/projects/p1': { body: { ok: true } } });
    s.set('GET /app/api/projects/p1', { body: { ...TENDER, archivedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() } });
    s.set('GET /app/api/projects/p1/files', { body: { files: [{ path: 'a.pdf', bytes: 1 }, { path: 'b.pdf', bytes: 1 }] } });
    renderApp('/projects/p1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Удалить навсегда' }));
    const question = await screen.findByRole('alertdialog', { name: 'Удалить проект «Тендер Альфа» навсегда?' });
    expect(within(question).getByText('Удалятся инструкции, 2 файла и корзина проекта. Разговоры — ваши и коллег — останутся, без проекта. Это нельзя отменить.')).toBeInTheDocument();
    await user.click(within(question).getByRole('button', { name: 'Удалить навсегда' }));
    expect(await screen.findByText('Проект удалён')).toBeInTheDocument();
    await waitFor(() => expect(s.calls.some((c) => c.method === 'DELETE' && c.path === '/app/api/projects/p1')).toBe(true));
  });

  it('tells about a project that is not there or no longer open to the person', async () => {
    const s = server();
    s.set('GET /app/api/projects/p1', apiError('APP_NOT_FOUND', 'Проект недоступен. Возможно, его перенесли в архив или закрыли к нему доступ.', 404));
    renderApp('/projects/p1');
    expect(await screen.findByText('Проект недоступен. Возможно, его перенесли в архив или закрыли к нему доступ.')).toBeInTheDocument();
  });
});

// Seven projects in the panel and «Ещё» for the rest, as «Недавние» (request of the owner 17.11).
describe('seven projects in the panel', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ ...TENDER, id: `q${i + 1}`, name: `Проект ${i + 1}` }));
  const panelLinks = () => screen.getAllByRole('link').filter((a) => !a.closest('nav[aria-label="Разделы проекта"]') && /^\/projects\/q\d$/.test(a.getAttribute('href') ?? ''));

  function manyServer() {
    const s = server({ 'GET /app/api/projects': { body: { projects: many, archivedCount: 0 } } });
    for (const p of many) {
      s.set(`GET /app/api/projects/${p.id}`, { body: p });
      s.set(`GET /app/api/projects/${p.id}/files`, { body: { files: [] } });
      s.set(`GET /app/api/projects/${p.id}/trash`, { body: { batches: [] } });
      s.set(`GET /app/api/projects/${p.id}/memory`, { body: { entries: [], usedChars: 0, maxChars: 6000, readOnly: false } });
      s.set(`GET /app/api/threads/${p.id}`, { body: { threads: [], next: null } });
    }
    return s;
  }

  it('shows the first seven in the order of the panel and «Ещё», which opens all of them in the search on «Проекты»', async () => {
    manyServer();
    renderApp('/agents/sales?thread=t1');
    expect(await screen.findByRole('link', { name: /Проект 7/ })).toBeInTheDocument();
    expect(panelLinks().map((a) => a.textContent)).toEqual(['Проект 1', 'Проект 2', 'Проект 3', 'Проект 4', 'Проект 5', 'Проект 6', 'Проект 7'].map((n) => expect.stringContaining(n) as unknown as string));
    expect(screen.queryByRole('link', { name: /Проект 8/ })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ещё' }));
    const dialog = screen.getByRole('dialog', { name: 'Поиск' });
    expect(within(dialog).getByRole('button', { name: 'Проекты', pressed: true })).toBeInTheDocument();
    expect(await within(dialog).findByText('Проект 9')).toBeInTheDocument();
  });

  it('shows the open project beyond the seven as the eighth, so it can be pinned from its row', async () => {
    manyServer();
    renderApp('/projects/q9');
    expect(await screen.findByRole('heading', { name: 'Проект 9' })).toBeInTheDocument();
    await waitFor(() => expect(panelLinks()).toHaveLength(8));
    expect(panelLinks().at(-1)?.textContent).toContain('Проект 9');
    expect(screen.queryByRole('link', { name: /Проект 8/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ещё' })).toBeInTheDocument();
  });

  // Decision of the owner 17.11: the pinned ones are all shown; the rest fill the panel up to seven.
  it('shows every pinned project, and the rest only up to seven in all', async () => {
    const pinned = many.slice(0, 3).map((p) => ({ ...p, pinned: true }));
    server({ 'GET /app/api/projects': { body: { projects: [...pinned, ...many.slice(3)], archivedCount: 0 } } });
    renderApp('/agents/sales?thread=t1');
    expect(await screen.findByRole('link', { name: /Проект 7/ })).toBeInTheDocument();
    expect(panelLinks()).toHaveLength(7);
    expect(screen.getByRole('button', { name: 'Ещё' })).toBeInTheDocument();
  });

  // The row and its menu are gone: the keyboard goes to «Ещё», where the project now is.
  it('an unpinned project that goes beyond the seven leaves the keyboard on «Ещё»', async () => {
    // Nothing done in Проект 1 for long: unpinned, it goes under the others.
    const pinned = many.slice(0, 7).map((p, i) => ({ ...p, pinned: true, ...(i === 0 ? { lastActiveAt: '2026-01-01T08:00:00Z' } : {}) }));
    const s = manyServer();
    s.set('GET /app/api/projects', { body: { projects: [...pinned, ...many.slice(7)], archivedCount: 0 } });
    s.set('PUT /app/api/projects/q1', { body: { ...pinned[0]!, pinned: false } });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия с проектом «Проект 1»' }));
    await user.click(screen.getByRole('menuitem', { name: 'Открепить' }));
    expect(screen.queryByRole('link', { name: /Проект 1$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ещё' })).toHaveFocus();
  });

  it('shows all the pinned ones even beyond seven, with no unpinned one', async () => {
    const pinned = many.slice(0, 8).map((p) => ({ ...p, pinned: true }));
    server({ 'GET /app/api/projects': { body: { projects: [...pinned, many[8]!], archivedCount: 0 } } });
    renderApp('/agents/sales?thread=t1');
    expect(await screen.findByRole('link', { name: /Проект 8/ })).toBeInTheDocument();
    expect(panelLinks()).toHaveLength(8);
    expect(screen.queryByRole('link', { name: /Проект 9/ })).not.toBeInTheDocument();
  });

  it('has no «Ещё» with seven projects or fewer', async () => {
    server({ 'GET /app/api/projects': { body: { projects: many.slice(0, 7), archivedCount: 0 } } });
    renderApp('/agents/sales?thread=t1');
    expect(await screen.findByRole('link', { name: /Проект 7/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ещё' })).not.toBeInTheDocument();
  });
});
