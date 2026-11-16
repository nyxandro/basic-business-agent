import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { PHONE_WIDTH, stubSystemTheme } from '../test/match-media.ts';
import { renderApp } from '../test/render.tsx';

const ACCOUNTANT = { ...ME, permissions: ['usage', 'journal'] };
const USAGE = { body: { rows: [], totalRub: 0, orgLimitRub: null } };

describe('the frame of the admin panel', () => {
  it('sends a person without the right to the chat with a plain notice', async () => {
    mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/agents': { body: { agents: [{ id: 'sales', name: 'Продажи', description: '', starters: [], mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } }] } },
      'GET /app/api/threads': { body: { threads: [], next: null } },
      'GET /app/api/projects': { body: { projects: [] } },
      'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' } } } },
    });
    renderApp('/admin/users');
    expect(await screen.findByRole('button', { name: /Продажи\. Выбрать агента/ })).toBeInTheDocument();
    expect(await screen.findByText('Этот раздел вам недоступен. Если он нужен для работы, обратитесь к администратору.')).toBeInTheDocument();
    expect(screen.getByText(/APP_ADMIN_FORBIDDEN/)).toBeInTheDocument();
  });

  it('shows only the sections of the role in their groups and opens the first of them', async () => {
    mockServer({ 'GET /app/api/me': { body: ACCOUNTANT }, 'GET /app/api/admin/usage': USAGE, 'GET /app/api/admin/usage/daily': { body: { days: [] } }, 'GET /app/api/agents': { body: { agents: [] } } });
    const { unmount } = renderApp('/admin');
    const nav = await screen.findByRole('navigation', { name: 'Разделы админки' });
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Лимиты и расходы' })).toHaveAttribute('aria-current', 'page'));
    expect(within(nav).getByRole('link', { name: 'Журнал действий' })).toBeInTheDocument();
    expect(within(nav).getByText('Система')).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Сотрудники' })).not.toBeInTheDocument();
    expect(within(nav).queryByText('Люди')).not.toBeInTheDocument();
    expect(screen.getByText('Альфа-Строй')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Вернуться в чат' })).toHaveAttribute('href', '/');
    unmount();
    renderApp('/admin/masking');
    expect(await screen.findByText(/Этот раздел вам недоступен/)).toBeInTheDocument();
  });

  it('turns the sections into chips on a phone', async () => {
    stubSystemTheme('light', PHONE_WIDTH);
    mockServer({ 'GET /app/api/me': { body: ACCOUNTANT }, 'GET /app/api/admin/usage': USAGE, 'GET /app/api/admin/usage/daily': { body: { days: [] } } });
    renderApp('/admin/limits');
    const chips = await screen.findByRole('navigation', { name: 'Разделы админки' });
    expect(within(chips).getAllByRole('link').map((a) => a.textContent)).toEqual(['Лимиты и расходы', 'Журнал действий']);
    expect(screen.getByRole('link', { name: 'Вернуться в чат' })).toBeInTheDocument();
  });
});
