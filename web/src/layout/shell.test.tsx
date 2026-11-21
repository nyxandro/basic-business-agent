import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { PHONE_WIDTH, stubSystemTheme } from '../test/match-media.ts';
import { renderApp } from '../test/render.tsx';
import { LAST_AGENT_KEY } from './AppShell.tsx';

const AGENTS = [
  { id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', starters: [], mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } },
  { id: 'assistant', name: 'Общий помощник', description: 'Вопросы и заметки', starters: [], mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } },
];
const USAGE = { month: { spentRub: 1740, limitRub: 3000, resetsOn: '2026-12-01' }, daily: null };
const THREADS = {
  threads: [
    { id: 't1', title: 'Сделки без движения', kind: 'chat', unread: false, updatedAt: '2026-11-14T08:00:00Z', agentId: 'sales', projectId: null },
    { id: 't2', title: 'Задача: Утренняя сводка', kind: 'background', unread: true, updatedAt: '2026-11-14T06:00:00Z', agentId: 'sales', projectId: null },
  ],
  next: null,
};

function server(me: object = ME, agents: unknown = { agents: AGENTS }) {
  return mockServer({
    'GET /app/api/me': { body: me },
    'GET /app/api/agents': { body: agents },
    'GET /app/api/threads': { body: THREADS },
    'GET /app/api/me/usage': { body: USAGE },
    // CopilotKit learns from its runtime which agents the chat may talk to.
    'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' }, assistant: { name: 'assistant', description: '', className: 'MastraAgent' } } } },
    'GET /app/api/me/connections': { body: { connections: [{ id: 'crm', title: 'CRM', auth: 'static', fields: [], status: 'connected', checkedAt: null }, { id: 'mail', title: 'Почта', auth: 'oauth', fields: [], status: 'not_connected', checkedAt: null }] } },
  });
}

describe('the frame of the application', () => {
  // The agents of the panel carry the mark set on each agent — an icon or a picture, the spark when none was set —
  // even with «Показывать значок агента в чате» off: that switch is about the chat (request of the owner 17.11).
  it('shows each agent in the panel with its own mark, whatever the switch of the chat', async () => {
    const marked = [
      { ...AGENTS[0], mark: { kind: 'icon', icon: 'chart' } },
      { ...AGENTS[1], mark: { kind: 'image', url: '/app/api/agents/assistant/mark?v=abc' } },
      { ...AGENTS[0], id: 'tenders', name: 'Тендерный специалист', mark: { kind: 'icon', icon: 'spark' } },
    ];
    server({ ...ME, interface: { showAgentMark: false } }, { agents: marked });
    renderApp('/agents/sales');
    const markOf = async (name: string) => (await screen.findByRole('link', { name })).querySelector('[data-side-mark]');
    expect(await markOf('Продажи')).toHaveAttribute('data-icon', 'chart');
    expect((await markOf('Общий помощник'))?.querySelector('img')).toHaveAttribute('src', '/app/api/agents/assistant/mark?v=abc');
    expect(await markOf('Тендерный специалист')).toHaveAttribute('data-icon', 'spark');
    // No initials any more.
    expect(screen.queryByText('ТС')).not.toBeInTheDocument();
  });

  it('opens a new conversation with the last agent on «/»', async () => {
    localStorage.setItem(LAST_AGENT_KEY, 'assistant');
    server();
    renderApp('/');
    expect(await screen.findByRole('button', { name: /Общий помощник\. Выбрать агента/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Общий помощник/ })).toHaveAttribute('aria-current', 'page');
  });

  // The browser remembers an agent of another installation at the same address (the test stand),
  // or the admin took the agent from the person's department.
  it('never opens a remembered agent the person does not have: «/» and «Новый разговор» go to an available one', async () => {
    localStorage.setItem(LAST_AGENT_KEY, 'gone');
    const s = server(ME, { agents: [AGENTS[1]] });
    s.set('GET /app/api/approvals', { body: { pending: [], failed: [] } });
    const first = renderApp('/');
    expect(await screen.findByRole('button', { name: /Общий помощник\. Выбрать агента/ })).toBeInTheDocument();
    first.unmount();
    // From another page «Новый разговор» has no open agent to go on with.
    localStorage.setItem(LAST_AGENT_KEY, 'gone');
    renderApp('/approvals');
    await screen.findByText('Решений не ждёт ни одно действие.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Новый разговор' }));
    expect(await screen.findByRole('button', { name: /Общий помощник\. Выбрать агента/ })).toBeInTheDocument();
    expect(screen.queryByText(/У вас нет доступа к этому агенту/)).not.toBeInTheDocument();
  });

  it('opens an available agent with a line why, when a link leads to an agent the person does not have', async () => {
    localStorage.setItem(LAST_AGENT_KEY, 'sales');
    server(ME, { agents: [AGENTS[1]] });
    renderApp('/agents/sales?thread=t1');
    expect(await screen.findByText('У вас нет доступа к этому агенту. Если он нужен для работы, обратитесь к администратору.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Общий помощник\. Выбрать агента/ })).toBeInTheDocument();
    expect(localStorage.getItem(LAST_AGENT_KEY)).toBe('assistant');
  });

  it('shows the agents, recent conversations with «новое», the limit and the person', async () => {
    server();
    renderApp('/');
    const side = await screen.findByText('Недавние');
    const panel = side.parentElement!;
    const fresh = await within(panel).findByRole('link', { name: /Задача: Утренняя сводка/ });
    expect(fresh).toHaveAttribute('href', '/agents/sales?thread=t2');
    expect(within(fresh).getByText('новое')).toBeInTheDocument();
    expect(within(panel).getByText('58%')).toBeInTheDocument();
    expect(within(panel).getByText('Отдел продаж')).toBeInTheDocument();
    // Nothing waits for a decision: no «Ждёт подтверждения» at all.
    expect(within(panel).queryByRole('link', { name: /Ждёт подтверждения/ })).not.toBeInTheDocument();
  });

  it('shows «Ждёт подтверждения» only while something waits, with how many', async () => {
    const s = server();
    s.set('GET /app/api/me/notifications', { body: { pendingApprovals: 2, unread: 0, latest: null } });
    renderApp('/');
    const link = await screen.findByRole('link', { name: /^Ждёт подтверждения/ });
    expect(link).toHaveAttribute('href', '/approvals');
    expect(link).toHaveTextContent('2');
  });

  it('hides «Админка» from a person without rights and shows it with one', async () => {
    server();
    const first = renderApp('/');
    await screen.findByText('Недавние');
    expect(screen.queryByRole('link', { name: 'Админка' })).not.toBeInTheDocument();
    first.unmount();
    server({ ...ME, permissions: ['users'] });
    renderApp('/');
    expect(await screen.findByRole('link', { name: 'Админка' })).toHaveAttribute('href', '/admin');
  });

  it('keeps «Выйти», the theme and the person’s settings under the gear', async () => {
    server();
    renderApp('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Настройки' }));
    const menu = screen.getByRole('dialog', { name: 'Настройки' });
    expect(within(menu).getByRole('menuitem', { name: /Выйти/ })).toBeInTheDocument();
    expect(await within(menu).findByText('1 из 2')).toBeInTheDocument();
    await user.click(within(menu).getByRole('radio', { name: /Тёмная/ }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('tells an employee that models are not set up instead of the input', async () => {
    server({ ...ME, modelsConfigured: false });
    renderApp('/agents/sales?thread=t1');
    expect(await screen.findByText('Модели ещё не настроены. Обратитесь к администратору.')).toBeInTheDocument();
  });

  it('sends the superadmin of an installation without models to set them up', async () => {
    server({ ...ME, isSuperadmin: true, permissions: ['users', 'models'], modelsConfigured: false });
    renderApp('/');
    expect(await screen.findByRole('navigation', { name: 'Разделы админки' })).toBeInTheDocument();
  });

  it('says how to get an agent when none is open', async () => {
    server(ME, { agents: [] });
    renderApp('/');
    expect((await screen.findAllByText('Вам пока не назначены агенты. Обратитесь к администратору.')).length).toBeGreaterThan(0);
  });

  it('shows a failure to load the agents with a repeat, and the repeat shows them', async () => {
    const s = server(ME, null);
    s.set('GET /app/api/agents', apiError('APP_INTERNAL', 'Что-то пошло не так на сервере.', 500));
    renderApp('/settings/memory');
    expect(await screen.findByText('Не удалось загрузить список агентов')).toBeInTheDocument();
    s.set('GET /app/api/agents', { body: { agents: AGENTS } });
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Повторить' })[0]!);
    expect(await screen.findByRole('link', { name: /Продажи/ })).toHaveAttribute('href', '/agents/sales');
  });

  it('renames a conversation from its three dots in «Недавние», in place', async () => {
    const s = server();
    s.set('PATCH /app/api/threads/t1', (call) => ({ body: { thread: { id: 't1', title: (call.body as { title: string }).title } } }));
    renderApp('/');
    const user = userEvent.setup();
    const panel = (await screen.findByText('Недавние')).parentElement!;
    await user.click(await within(panel).findByRole('button', { name: 'Действия с разговором «Сделки без движения»' }));
    await user.click(within(panel).getByRole('menuitem', { name: 'Переименовать' }));
    const field = within(panel).getByRole('textbox', { name: 'Название разговора' });
    expect(field).toHaveValue('Сделки без движения');
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, 'Сделки для отчёта{Enter}');

    const renamed = await within(panel).findByRole('link', { name: 'Сделки для отчёта' });
    expect(renamed).toHaveAttribute('href', '/agents/sales?thread=t1');
    // The keyboard stays on the conversation, not lost on the page.
    expect(renamed).toHaveFocus();
    expect(s.calls.filter((c) => c.method === 'PATCH')).toEqual([expect.objectContaining({ path: '/app/api/threads/t1', body: { title: 'Сделки для отчёта' } })]);
    // The rest of the list stays as it was.
    expect(within(panel).getByRole('link', { name: /Задача: Утренняя сводка/ })).toBeInTheDocument();
  });

  it('Esc leaves the name as it was; a refusal keeps the field with the reason', async () => {
    const s = server();
    s.set('PATCH /app/api/threads/t1', apiError('APP_NOT_FOUND', 'Разговор не найден.', 404));
    renderApp('/');
    const user = userEvent.setup();
    const panel = (await screen.findByText('Недавние')).parentElement!;
    const rename = async () => {
      await user.click(await within(panel).findByRole('button', { name: 'Действия с разговором «Сделки без движения»' }));
      await user.click(within(panel).getByRole('menuitem', { name: 'Переименовать' }));
      return within(panel).getByRole('textbox', { name: 'Название разговора' });
    };

    await user.type(await rename(), ' за ноябрь{Escape}');
    expect(within(panel).getByRole('link', { name: 'Сделки без движения' })).toHaveFocus();
    expect(s.calls.some((c) => c.method === 'PATCH')).toBe(false);

    const field = await rename();
    await user.type(field, ' за ноябрь{Enter}');
    expect(await within(panel).findByText(/Разговор не найден/)).toBeInTheDocument();
    expect(field).toHaveValue('Сделки без движения за ноябрь');
  });

  it('turns the side panel into a drawer on a phone', async () => {
    stubSystemTheme('light', PHONE_WIDTH);
    server();
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Меню' }));
    const drawer = screen.getByRole('dialog', { name: 'Меню' });
    expect(drawer).not.toHaveAttribute('aria-hidden', 'true');
    await user.click(within(drawer).getByRole('button', { name: 'Закрыть меню' }));
    expect(drawer).toHaveAttribute('aria-hidden', 'true');
  });
});
