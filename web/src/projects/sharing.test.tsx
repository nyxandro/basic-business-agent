// Shared projects in the interface (spec, section 8.20): the window of a new project with who it is
// open to, a colleague's page of a shared project, the marks in «Проекты», the notice above the input
// of a conversation whose project is gone, and «Скачать» of a file that left the folder.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { FileBlockView } from '../genui/FileBlock.tsx';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const AGENTS = [{ id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', starters: [], mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } }];
const OWN = { id: 'p1', name: 'Мой проект', instructions: '', threadCount: 0, lastActiveAt: '2026-11-10T08:00:00Z', pinned: false, createdAt: '2026-11-10T08:00:00Z', role: 'owner' as const, owner: { id: 'u1', name: 'Ольга' }, shared: false, unseen: false, access: { mode: 'private' as const, departments: [], people: [] }, archivedAt: null };
const SHARED = { ...OWN, id: 'p2', name: 'Тендер Игоря', instructions: 'Заказчик — ООО Пример.', role: 'member' as const, owner: { id: 'u9', name: 'Игорь Петров' }, shared: true, unseen: true, access: null };
const DEPARTMENTS = [
  { id: 'd1', name: 'Отдел продаж', members: 8 },
  { id: 'd2', name: 'Бухгалтерия', members: 3 },
];

function server(extra: Record<string, Parameters<typeof mockServer>[0][string]> = {}) {
  return mockServer({
    'GET /app/api/me': { body: ME },
    'GET /app/api/agents': { body: { agents: AGENTS } },
    'GET /app/api/threads': { body: { threads: [], next: null } },
    'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: 3000, resetsOn: '2026-12-01' }, daily: null } },
    'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' } } } },
    'GET /app/api/projects': { body: { projects: [OWN, SHARED], archivedCount: 0 } },
    'GET /app/api/projects/p1': { body: OWN },
    'GET /app/api/projects/p2': { body: { ...SHARED, unseen: false } },
    'GET /app/api/projects/p1/files': { body: { files: [] } },
    'GET /app/api/projects/p2/files': { body: { files: [] } },
    'GET /app/api/projects/p2/memory': { body: { entries: [], usedChars: 0, maxChars: 6000, readOnly: false } },
    'GET /app/api/projects/p1/trash': { body: { batches: [] } },
    'GET /app/api/projects/p2/trash': { body: { batches: [] } },
    'GET /app/api/departments': { body: { departments: DEPARTMENTS } },
    ...extra,
  });
}

describe('shared projects', () => {
  it('makes a project open to a department and a colleague found by name, in one window', async () => {
    const s = server({
      'GET /app/api/colleagues': { body: { colleagues: [{ id: 'u5', name: 'Пётр Иванов', email: 'petr@example.com', departments: ['Бухгалтерия'] }] } },
      'POST /app/api/projects': { status: 201, body: { ...OWN, id: 'p9', name: 'Тендер', shared: true } },
    });
    s.set('GET /app/api/projects/p9', { body: { ...OWN, id: 'p9', name: 'Тендер', shared: true } });
    s.set('GET /app/api/projects/p9/files', { body: { files: [] } });
    s.set('GET /app/api/projects/p9/trash', { body: { batches: [] } });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Новый проект' }));
    // The window draws itself anew as the access changes: its parts are looked up each time.
    const dialog = () => screen.getByRole('dialog', { name: 'Новый проект' });
    await screen.findByRole('dialog', { name: 'Новый проект' });
    await user.type(within(dialog()).getByRole('textbox', { name: 'Название проекта' }), 'Тендер');
    await user.click(within(dialog()).getByRole('radio', { name: 'Выбранным' }));
    // «Выбранным» with nobody chosen opens the project to nobody: «Создать» waits.
    expect(within(dialog()).getByRole('button', { name: 'Создать проект' })).toBeDisabled();
    const own = await within(dialog()).findByRole('checkbox', { name: /^Отдел продаж\s*·\s*8 человек\s*·\s*ваш отдел$/ });
    await user.click(own);
    await user.type(within(dialog()).getByRole('textbox', { name: 'Имя, фамилия или почта' }), 'петр');
    await user.click(await within(dialog()).findByRole('button', { name: /Пётр Иванов/ }));
    expect(within(dialog()).getByRole('button', { name: 'Убрать Пётр Иванов' })).toBeInTheDocument();
    await user.click(within(dialog()).getByRole('button', { name: 'Создать проект' }));
    await waitFor(() =>
      expect(s.calls.find((c) => c.method === 'POST' && c.path === '/app/api/projects')?.body).toEqual({ name: 'Тендер', access: { mode: 'list', departmentIds: ['d1'], userIds: ['u5'] } }),
    );
    expect(s.calls.find((c) => c.path === '/app/api/colleagues')?.query).toEqual({ q: 'петр' });
  });

  it('marks a shared project in «Проекты» and gives a colleague only pinning in its menu', async () => {
    server();
    renderApp('/agents/sales?thread=t1');
    const link = await screen.findByRole('link', { name: /Тендер Игоря/ });
    expect(within(link).getByRole('img', { name: 'Открыл(а): Игорь Петров' })).toBeInTheDocument();
    expect(within(link).getByText('новое')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Действия с проектом «Тендер Игоря»' }));
    const menu = screen.getByRole('menu', { name: 'Действия с проектом «Тендер Игоря»' });
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Закрепить']);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Действия с проектом «Мой проект»' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Переименовать', 'Закрепить', 'Настроить доступ', 'В архив']);
  });

  it('shows a colleague the project with its creator and instructions to read, and only their own conversations', async () => {
    server();
    renderApp('/projects/p2');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Тендер Игоря' })).toBeInTheDocument();
    expect(screen.getByText('Открыл(а): Игорь Петров')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Переименовать' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'В архив' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Настроить доступ' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ваши разговоры в проекте' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Файлы' }));
    expect(await screen.findByText('Файлы и вложения из разговоров проекта видят все, кому он открыт.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Настройки проекта' }));
    expect(await screen.findByText('Инструкции меняет создатель проекта.')).toBeInTheDocument();
    expect(screen.getByText('Заказчик — ООО Пример.')).toBeInTheDocument();
  });

  it('lets the creator change who the project is open to', async () => {
    const s = server({ 'PUT /app/api/projects/p1/access': { body: { ...OWN, shared: true, access: { mode: 'org', departments: [], people: [] } } } });
    renderApp('/projects/p1');
    const user = userEvent.setup();
    expect(await screen.findByText('Только вы')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Настроить доступ' }));
    const dialog = await screen.findByRole('dialog', { name: 'Кому открыт проект' });
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await user.click(within(dialog).getByRole('radio', { name: 'Всей организации' }));
    // The server has the new access once it is saved: the page reads it again.
    s.set('GET /app/api/projects/p1', { body: { ...OWN, shared: true, access: { mode: 'org', departments: [], people: [] } } });
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT' && c.path === '/app/api/projects/p1/access')?.body).toEqual({ mode: 'org', departmentIds: [], userIds: [] }));
    expect(await screen.findByText('Открыт всей организации')).toBeInTheDocument();
  });

  it('says above the input why the conversation’s project is gone; «Понятно» takes it out for good', async () => {
    const s = server({
      'GET /app/api/threads/t1/project': { body: { projectId: null, lost: { projectId: 'p7', name: 'Тендер ЖК Северный', reason: 'access', ownerName: 'Ольга Смирнова', canUnarchive: false } } },
      'PUT /app/api/threads/t1/project': { body: { ok: true } },
    });
    renderApp('/agents/sales?thread=t1');
    expect(
      await screen.findByText(
        'Проект «Тендер ЖК Северный» вам больше недоступен: доступ закрыт. Разговор остался у вас, но агент больше не видит файлы и инструкции проекта. Если проект нужен — попросите доступ у создателя: Ольга Смирнова.',
      ),
    ).toBeInTheDocument();
    s.set('GET /app/api/threads/t1/project', { body: { projectId: null, lost: null } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Понятно' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT' && c.path === '/app/api/threads/t1/project')?.body).toEqual({ projectId: null }));
    await waitFor(() => expect(screen.queryByText(/вам больше недоступен/)).not.toBeInTheDocument());
  });

  it('«Скачать» of a removed file says it is in the trash, offers it from there and brings it back', async () => {
    const s = server({ 'POST /app/api/projects/p1/trash/restore': { body: { restored: ['КП.docx'] } } });
    const status = { state: 'trash' as const, name: 'КП.docx', projectId: 'p1', trashId: 'tr1', expiresAt: '2026-12-16T08:00:00Z' };
    render(<FileBlockView name="КП.docx" bytes={1024} href="/app/api/threads/t1/file?path=x" checkFile={() => Promise.resolve(status)} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'Скачать КП.docx' }));
    expect(await screen.findByText('Файл «КП.docx» удалён из рабочей папки. Он в корзине проекта до 16 декабря 2026.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Скачать из корзины' })).toHaveAttribute('href', '/app/api/projects/p1/trash/tr1/file');
    await user.click(screen.getByRole('button', { name: 'Вернуть в папку' }));
    await waitFor(() => expect(s.calls.find((c) => c.path === '/app/api/projects/p1/trash/restore')?.body).toEqual({ ids: ['tr1'] }));
    await waitFor(() => expect(screen.queryByText(/удалён из рабочей папки/)).not.toBeInTheDocument());
  });

  it('«Скачать» of a file gone for good says so', async () => {
    server();
    render(<FileBlockView name="старое.docx" bytes={10} href="/x" checkFile={() => Promise.resolve({ state: 'deleted', name: 'старое.docx' })} />);
    await userEvent.setup().click(screen.getByRole('link', { name: 'Скачать старое.docx' }));
    expect(await screen.findByText('Файл «старое.docx» удалён из рабочей папки — скачать его нельзя.')).toBeInTheDocument();
  });
});
