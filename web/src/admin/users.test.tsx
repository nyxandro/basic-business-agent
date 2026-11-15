import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, user: { id: 'u0', email: 'igor@example.com', name: 'Игорь' }, permissions: ['users', 'limits', 'usage'] };
const ROLES = [
  { id: 'r-emp', name: 'Сотрудник', permissions: [], builtin: 'employee', userCount: 2 },
  { id: 'r-head', name: 'Руководитель продаж', permissions: ['usage'], builtin: null, userCount: 0 },
];
const DEPARTMENTS = [
  { id: 'd1', name: 'Продажи', userIds: ['u1'], agentIds: [] },
  { id: 'd2', name: 'Бухгалтерия', userIds: ['u2'], agentIds: [] },
];
const USERS = [
  { id: 'u1', email: 'olga@example.com', name: 'Ольга Смирнова', position: '', blocked: false, roleIds: ['r-emp'], departmentIds: ['d1'], createdAt: '2026-11-01T00:00:00Z', projects: { total: 0, shared: 0 } },
  { id: 'u2', email: 'nina@example.com', name: 'Нина Орлова', position: '', blocked: true, roleIds: ['r-emp'], departmentIds: ['d2'], createdAt: '2026-11-01T00:00:00Z', projects: { total: 0, shared: 0 } },
];
const INVITES = [{ id: 'i1', email: 'pavel@example.com', name: 'Павел Сорокин', createdAt: '2026-11-13T00:00:00Z', expiresAt: '2026-11-20T00:00:00Z' }];

function server(me: object = ADMIN) {
  return mockServer({
    'GET /app/api/me': { body: me },
    'GET /app/api/admin/users': { body: { users: USERS } },
    'GET /app/api/admin/roles': { body: { roles: ROLES } },
    'GET /app/api/admin/departments': { body: { departments: DEPARTMENTS } },
    'GET /app/api/admin/invites': { body: { invites: INVITES } },
    'GET /app/api/admin/usage': { body: { rows: [{ key: 'u1', label: 'Ольга Смирнова', calls: 10, inputTokens: 0, outputTokens: 0, costRub: 1760, lastCallAt: null }], totalRub: 1760, orgLimitRub: null } },
    'GET /app/api/admin/limits': { body: { orgMonthlyRub: null, defaultUserMonthlyRub: 3000, defaultDailySubscriptionTokens: null } },
    'GET /app/api/admin/limits/users': { body: { users: [{ userId: 'u2', monthlyRub: 5000, dailySubscriptionTokens: null }] } },
  });
}

const row = (name: string) => screen.getByText(name).closest('tr')!;

describe('«Сотрудники»', () => {
  it('lists people with department, role, spend of the month and state, invites as «Приглашён»', async () => {
    server();
    renderApp('/admin/users');
    expect(await screen.findByRole('heading', { name: 'Сотрудники' })).toBeInTheDocument();
    await screen.findByText('Ольга Смирнова');
    const olga = row('Ольга Смирнова');
    expect(within(olga).getByText('Продажи')).toBeInTheDocument();
    expect(within(olga).getByText('1 760 ₽ из 3 000 ₽')).toBeInTheDocument();
    expect(within(olga).getByText('Активен')).toBeInTheDocument();
    expect(within(row('Нина Орлова')).getByText('0 ₽ из 5 000 ₽')).toBeInTheDocument();
    expect(within(row('Нина Орлова')).getByText('Заблокирован')).toBeInTheDocument();
    expect(within(row('Павел Сорокин')).getByText('Приглашён')).toBeInTheDocument();
  });

  it('hides the spend without the rights to see it', async () => {
    server({ ...ADMIN, permissions: ['users'] });
    renderApp('/admin/users');
    await screen.findByText('Ольга Смирнова');
    expect(screen.queryByRole('columnheader', { name: 'Расход / лимит' })).not.toBeInTheDocument();
  });

  it('finds by name or e-mail and filters by department', async () => {
    server();
    renderApp('/admin/users');
    const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox', { name: 'Поиск сотрудника' }), 'nina@');
    expect(screen.queryByText('Ольга Смирнова')).not.toBeInTheDocument();
    expect(screen.getByText('Нина Орлова')).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Поиск сотрудника' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Отдел' }), 'Продажи');
    expect(screen.getByText('Ольга Смирнова')).toBeInTheDocument();
    expect(screen.queryByText('Нина Орлова')).not.toBeInTheDocument();
    expect(screen.queryByText('Павел Сорокин')).not.toBeInTheDocument();
  });

  it('acts from the menu of a row: reset link, block, removal after the question', async () => {
    const s = server();
    s.set('POST /app/api/admin/password-resets', { body: { id: 'p1', link: 'http://localhost:8080/reset/tok', expiresAt: '2026-11-15T00:00:00Z' } });
    s.set('POST /app/api/admin/users/u1/block', { body: { ok: true } });
    s.set('DELETE /app/api/admin/users/u1', { body: { ok: true } });
    renderApp('/admin/users');
    const user = userEvent.setup();
    const menuOf = async () => {
      await user.click(within(row('Ольга Смирнова')).getByRole('button', { name: 'Действия: Ольга Смирнова' }));
      return screen.getByRole('menu', { name: 'Действия: Ольга Смирнова' });
    };
    await screen.findByText('Ольга Смирнова');
    await user.click(within(await menuOf()).getByRole('menuitem', { name: 'Сбросить пароль' }));
    expect(await screen.findByText('Ссылка для смены пароля создана. Она действует 24 часа — отправьте её сотруднику.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ссылка' })).toHaveValue('http://localhost:8080/reset/tok');

    await user.click(within(await menuOf()).getByRole('menuitem', { name: 'Заблокировать' }));
    expect(await screen.findByText('Заблокирован', { selector: '[role="status"]' })).toBeInTheDocument();

    await user.click(within(await menuOf()).getByRole('menuitem', { name: 'Удалить' }));
    const question = screen.getByRole('alertdialog', { name: 'Удалить сотрудника Ольга Смирнова?' });
    await user.click(within(question).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(s.calls.some((c) => c.method === 'DELETE' && c.path === '/app/api/admin/users/u1')).toBe(true));
  });

  it('invites with roles and departments and gives the link to copy', async () => {
    const s = server();
    s.set('POST /app/api/admin/invites', { status: 201, body: { id: 'i2', link: 'http://localhost:8080/invite/tok', expiresAt: '2026-11-21T00:00:00.000Z' } });
    renderApp('/admin/users');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Пригласить' }));
    const dialog = screen.getByRole('dialog', { name: 'Пригласить сотрудника' });
    await user.type(within(dialog).getByLabelText('Почта'), 'denis@example.com');
    await user.type(within(dialog).getByLabelText('Имя'), 'Денис');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Продажи' }));
    await user.click(within(dialog).getByRole('button', { name: 'Создать приглашение' }));
    expect(await screen.findByText('Приглашение создано. Ссылка действует 7 дней — отправьте её сотруднику.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ссылка' })).toHaveValue('http://localhost:8080/invite/tok');
    expect(s.calls.find((c) => c.path === '/app/api/admin/invites' && c.method === 'POST')?.body).toEqual({ email: 'denis@example.com', name: 'Денис', roleIds: ['r-emp'], departmentIds: ['d1'] });
  });

  it('changes the position and roles in the editor', async () => {
    const s = server();
    s.set('PUT /app/api/admin/users/u1/profile', { body: { ok: true } });
    s.set('PUT /app/api/admin/users/u1/roles', { body: { ok: true } });
    renderApp('/admin/users');
    const user = userEvent.setup();
    await screen.findByText('Ольга Смирнова');
    await user.click(within(row('Ольга Смирнова')).getByRole('button', { name: 'Действия: Ольга Смирнова' }));
    await user.click(screen.getByRole('menuitem', { name: 'Изменить' }));
    const dialog = screen.getByRole('dialog', { name: 'Ольга Смирнова' });
    await user.type(within(dialog).getByLabelText('Должность'), 'Менеджер');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Руководитель продаж' }));
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(s.calls.find((c) => c.path === '/app/api/admin/users/u1/roles')?.body).toEqual({ roleIds: ['r-emp', 'r-head'] }));
    expect(s.calls.find((c) => c.path === '/app/api/admin/users/u1/profile')?.body).toEqual({ name: 'Ольга Смирнова', position: 'Менеджер' });
  });
});
