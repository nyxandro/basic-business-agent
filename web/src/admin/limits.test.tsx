import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const USERS = [{ id: 'u1', email: 'olga@example.com', name: 'Ольга Смирнова', position: '', blocked: false, roleIds: [], departmentIds: [], createdAt: '' }];
const DAYS = [
  { day: '2026-11-01', costRub: 0 },
  { day: '2026-11-02', costRub: 1240 },
  { day: '2026-11-03', costRub: 310 },
];

function server(permissions: string[]) {
  return mockServer({
    'GET /app/api/me': { body: { ...ME, permissions } },
    'GET /app/api/admin/usage': { body: { rows: [{ key: 'u1', label: 'Ольга Смирнова', calls: 42, inputTokens: 1000, outputTokens: 500, costRub: 1550, lastCallAt: null }], totalRub: 1550, orgLimitRub: 80000 } },
    'GET /app/api/admin/usage/daily': { body: { days: DAYS } },
    'GET /app/api/admin/limits': { body: { orgMonthlyRub: 80000, defaultUserMonthlyRub: 3000, defaultDailySubscriptionTokens: null } },
    'GET /app/api/admin/limits/users': { body: { users: [] } },
    'GET /app/api/admin/users': { body: { users: USERS } },
    'PUT /app/api/admin/limits': { body: { ok: true } },
    'PUT /app/api/admin/users/u1/limits': { body: { ok: true } },
  });
}

describe('«Лимиты и расходы»', () => {
  it('shows the spend of the month and the chart by day to someone with the right «Расходы» only', async () => {
    server(['usage']);
    renderApp('/admin/limits');
    const org = (await screen.findByText('из 80 000 ₽ в месяц')).parentElement!;
    expect(within(org).getByText('1 550 ₽')).toBeInTheDocument();
    expect(within(org).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
    const days = screen.getByRole('table', { name: 'Расход по дням, рубли' });
    expect(within(days).getAllByRole('row').map((r) => r.textContent?.replace(/\s/g, ' '))).toContain(`${new Date('2026-11-02T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}1 240 ₽`.replace(/\s/g, ' '));
    expect(await screen.findByRole('table', { name: 'Расходы за период' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Настройки лимитов' })).not.toBeInTheDocument();
  });

  it('shows only the settings to someone with the right «Лимиты» only', async () => {
    server(['limits']);
    renderApp('/admin/limits');
    expect(await screen.findByRole('heading', { name: 'Настройки лимитов' })).toBeInTheDocument();
    expect(screen.queryByText('Расход по дням')).not.toBeInTheDocument();
  });

  it('saves the organisation limits and one person’s own limit', async () => {
    const s = server(['limits', 'usage']);
    renderApp('/admin/limits');
    const user = userEvent.setup();
    const ceiling = await screen.findByLabelText('Общий потолок организации, ₽ в месяц');
    await user.clear(ceiling);
    await user.type(ceiling, '90000');
    await user.selectOptions(screen.getByLabelText('Личный лимит'), 'Ольга Смирнова: без личного лимита');
    await user.type(screen.getByLabelText('₽ в месяц'), '5000');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(s.calls.find((c) => c.path === '/app/api/admin/users/u1/limits')?.body).toEqual({ monthlyRub: 5000, dailySubscriptionTokens: null }));
    expect(s.calls.find((c) => c.path === '/app/api/admin/limits' && c.method === 'PUT')?.body).toEqual({ orgMonthlyRub: 90000, defaultUserMonthlyRub: 3000, defaultDailySubscriptionTokens: null });
  });

  it('refuses a negative number in plain words', async () => {
    const s = server(['limits']);
    renderApp('/admin/limits');
    const user = userEvent.setup();
    const ceiling = await screen.findByLabelText('Общий потолок организации, ₽ в месяц');
    await user.clear(ceiling);
    await user.type(ceiling, '-5');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Нужно число не меньше нуля; для токенов — целое.');
    expect(s.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
