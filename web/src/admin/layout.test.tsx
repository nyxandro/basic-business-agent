import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { PHONE_WIDTH, stubSystemTheme } from '../test/match-media.ts';
import { renderApp } from '../test/render.tsx';

const ACCOUNTANT = { ...ME, permissions: ['usage', 'journal'] };
const USAGE = { body: { rows: [], totalRub: 0, orgLimitRub: null } };

describe('the frame of the admin panel', () => {
  it('sends a person without the right to the chat with a plain notice', async () => {
    mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/agents': { body: { agents: [{ id: 'sales', name: 'Продажи', description: '', mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } }] } },
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
    expect(within(chips).getAllByRole('link').map((a) => a.textContent)).toEqual(['Лимиты и расходы', 'Польза от агентов', 'Журнал действий']);
    expect(screen.getByRole('link', { name: 'Вернуться в чат' })).toBeInTheDocument();
  });

  // The red counter of «Поддержка» (owner 24.11, F8–F9): the tickets waiting for the support's answer, from the counters
  // of the bell.
  it('shows the tickets waiting for the support as a red counter, on a computer and on a phone, and nothing when none wait', async () => {
    const SUPPORT = { ...ME, permissions: ['agents', 'journal'] };
    const counters = (supportWaiting: number) => ({ body: { pendingApprovals: 0, unread: 0, latest: null, threads: {}, supportWaiting } });
    const routes = { 'GET /app/api/me': { body: SUPPORT }, 'GET /app/api/admin/journal': { body: { entries: [], total: 0 } } };
    mockServer({ ...routes, 'GET /app/api/me/notifications': counters(3) });
    const computer = renderApp('/admin/journal');
    const nav = await screen.findByRole('navigation', { name: 'Разделы админки' });
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Поддержка, ждут ответа: 3' })).toBeInTheDocument());
    computer.unmount();

    stubSystemTheme('light', PHONE_WIDTH);
    mockServer({ ...routes, 'GET /app/api/me/notifications': counters(120) });
    const phone = renderApp('/admin/journal');
    const chips = await screen.findByRole('navigation', { name: 'Разделы админки' });
    await waitFor(() => expect(within(chips).getByRole('link', { name: 'Поддержка, ждут ответа: 120' })).toHaveTextContent('99+'));
    phone.unmount();

    const none = mockServer({ ...routes, 'GET /app/api/me/notifications': counters(0) });
    renderApp('/admin/journal');
    // Only after the server's answer: before it the counter is not drawn anyway.
    await waitFor(() => expect(none.pings.length).toBeGreaterThan(0));
    await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'Разделы админки' })).getByRole('link', { name: 'Поддержка' })).toBeInTheDocument());
  });

  it('reads the counter again the moment the server says «changed», and keeps no channel for one who does not handle the support', async () => {
    class FakeSource {
      static made: FakeSource[] = [];
      listeners = new Map<string, () => void>();
      url: string;
      constructor(url: string) {
        this.url = url;
        FakeSource.made.push(this);
      }
      addEventListener(type: string, listener: () => void) {
        this.listeners.set(type, listener);
      }
      close() {}
    }
    vi.stubGlobal('EventSource', FakeSource);
    const counters = (supportWaiting: number | null) => ({ body: { pendingApprovals: 0, unread: 0, latest: null, threads: {}, supportWaiting } });
    const s = mockServer({ 'GET /app/api/me': { body: { ...ME, permissions: ['agents', 'journal'] } }, 'GET /app/api/admin/journal': { body: { entries: [], total: 0 } }, 'GET /app/api/me/notifications': counters(1) });
    const support = renderApp('/admin/journal');
    const nav = await screen.findByRole('navigation', { name: 'Разделы админки' });
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Поддержка, ждут ответа: 1' })).toBeInTheDocument());
    s.set('GET /app/api/me/notifications', counters(2));
    act(() => FakeSource.made.at(-1)!.listeners.get('changed')!());
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Поддержка, ждут ответа: 2' })).toBeInTheDocument());
    support.unmount();

    FakeSource.made = [];
    mockServer({ 'GET /app/api/me': { body: ACCOUNTANT }, 'GET /app/api/admin/usage': USAGE, 'GET /app/api/admin/usage/daily': { body: { days: [] } }, 'GET /app/api/me/notifications': counters(null) });
    renderApp('/admin/limits');
    await screen.findByRole('navigation', { name: 'Разделы админки' });
    expect(FakeSource.made).toEqual([]);
    vi.unstubAllGlobals();
  });
});
