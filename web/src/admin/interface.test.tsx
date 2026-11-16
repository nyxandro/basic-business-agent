// «Интерфейс» (spec, section 8.17; decision of the owner 16.11): only whether the chat shows the marks
// of the agents — the marks themselves are set on the pages of the agents. The switch saves at once
// and the admin's own chat changes at once.
import type { InterfaceAdminState } from '@bba/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, permissions: ['interface'] };

function server(state: InterfaceAdminState = { showAgentMark: true }, me: object = ADMIN) {
  return mockServer({
    'GET /app/api/me': { body: me },
    'GET /app/api/admin/interface': { body: state },
    'PUT /app/api/admin/interface': (call) => ({ body: call.body }),
  });
}
const puts = (s: ReturnType<typeof mockServer>) => s.calls.filter((c) => c.method === 'PUT' && c.path === '/app/api/admin/interface');

describe('«Интерфейс»', () => {
  it('is in the menu only for a person with its right', async () => {
    server();
    const first = renderApp('/admin/interface');
    expect(await screen.findByRole('heading', { name: 'Интерфейс' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Разделы админки' })).getByRole('link', { name: 'Интерфейс' })).toBeInTheDocument();
    first.unmount();
    mockServer({ 'GET /app/api/me': { body: { ...ME, permissions: ['users'] } }, 'GET /app/api/admin/users': { body: { users: [] } } });
    renderApp('/admin/users');
    expect(await screen.findByRole('navigation', { name: 'Разделы админки' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Интерфейс' })).not.toBeInTheDocument();
  });

  it('has only the switch of the marks; turning it off saves at once and refreshes the admin’s own chat', async () => {
    const s = server();
    renderApp('/admin/interface');
    const user = userEvent.setup();
    const show = await screen.findByRole('switch', { name: 'Показывать значок агента в чате' });
    expect(show).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    await user.click(show);
    expect(await screen.findByText('Сохранено')).toBeInTheDocument();
    expect(puts(s).map((c) => c.body)).toEqual([{ showAgentMark: false }]);
    expect(show).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Значков нет: ответы агентов начинаются от левого края.')).toBeInTheDocument();
    await waitFor(() => expect(s.calls.filter((c) => c.path === '/app/api/me')).toHaveLength(2));
    await user.click(show);
    await waitFor(() => expect(puts(s).map((c) => c.body)).toEqual([{ showAgentMark: false }, { showAgentMark: true }]));
  });

  it('leads to the agents for whoever may set them up', async () => {
    server({ showAgentMark: true }, { ...ADMIN, permissions: ['interface', 'agents'] });
    renderApp('/admin/interface');
    expect(await screen.findByRole('link', { name: 'Перейти к агентам' })).toHaveAttribute('href', '/admin/agents');
  });

  it('keeps the switch as it was when the server refuses', async () => {
    const s = server();
    s.set('PUT /app/api/admin/interface', apiError('APP_INTERNAL', 'Что-то пошло не так на сервере.', 500));
    renderApp('/admin/interface');
    const show = await screen.findByRole('switch', { name: 'Показывать значок агента в чате' });
    await userEvent.setup().click(show);
    expect(await screen.findByText(/Что-то пошло не так на сервере/)).toBeInTheDocument();
    expect(show).toHaveAttribute('aria-checked', 'true');
  });
});
