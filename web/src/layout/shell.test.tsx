import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { PHONE_WIDTH, stubSystemTheme } from '../test/match-media.ts';
import { renderApp } from '../test/render.tsx';
import { LAST_AGENT_KEY } from './AppShell.tsx';

const AGENTS = [
  { id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', starters: [], actions: {}, systems: { tools: {}, prefixes: {} } },
  { id: 'assistant', name: 'Общий помощник', description: 'Вопросы и заметки', starters: [], actions: {}, systems: { tools: {}, prefixes: {} } },
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
    renderApp('/');
    expect(await screen.findByRole('button', { name: /Общий помощник\. Выбрать агента/ })).toBeInTheDocument();
    // From another page «Новый разговор» has no open agent to go on with.
    localStorage.setItem(LAST_AGENT_KEY, 'gone');
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: /^Ждёт подтверждения/ }));
    await screen.findByText('Решений не ждёт ни одно действие.');
    await user.click(screen.getByRole('button', { name: 'Новый разговор' }));
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
    expect(within(panel).getByRole('link', { name: /Ждёт подтверждения/ })).toHaveAttribute('href', '/approvals');
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
