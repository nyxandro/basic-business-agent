import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, permissions: ['roles', 'departments'] };
const ROLES = [
  { id: 'r-su', name: 'Суперадминистратор', permissions: [], builtin: 'superadmin', userCount: 1 },
  { id: 'r-emp', name: 'Сотрудник', permissions: [], builtin: 'employee', userCount: 5 },
  { id: 'r-head', name: 'Руководитель продаж', permissions: ['usage'], builtin: null, userCount: 1 },
];

describe('«Роли»', () => {
  it('saves a mark of the table at once and keeps the superadmin column as it is', async () => {
    const s = mockServer({ 'GET /app/api/me': { body: ADMIN }, 'GET /app/api/admin/roles': { body: { roles: ROLES } }, 'PUT /app/api/admin/roles/r-head': { body: { ok: true } } });
    renderApp('/admin/roles');
    const user = userEvent.setup();
    const journal = await screen.findByRole('checkbox', { name: 'Руководитель продаж: Журнал действий' });
    expect(journal).toHaveAttribute('aria-checked', 'false');
    await user.click(journal);
    expect(journal).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByText('Сохранено')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ name: 'Руководитель продаж', permissions: ['usage', 'journal'] });

    const locked = screen.getByRole('checkbox', { name: 'Суперадминистратор: Журнал действий' });
    expect(locked).toHaveAttribute('aria-checked', 'true');
    await user.click(locked);
    expect(locked).toHaveAttribute('aria-checked', 'true');
    expect(s.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('puts a mark back when the save fails', async () => {
    mockServer({
      'GET /app/api/me': { body: ADMIN },
      'GET /app/api/admin/roles': { body: { roles: ROLES } },
      'PUT /app/api/admin/roles/r-head': { status: 500, body: { error: { code: 'APP_INTERNAL', message: 'Что-то пошло не так на сервере.' } } },
    });
    renderApp('/admin/roles');
    const mark = await screen.findByRole('checkbox', { name: 'Руководитель продаж: Расходы' });
    await userEvent.setup().click(mark);
    expect(await screen.findByText('Что-то пошло не так на сервере.')).toBeInTheDocument();
    expect(mark).toHaveAttribute('aria-checked', 'true');
  });
});

describe('«Отделы»', () => {
  const server = () =>
    mockServer({
      'GET /app/api/me': { body: ADMIN },
      'GET /app/api/admin/departments': { body: { departments: [{ id: 'd1', name: 'Продажи', userIds: ['u1'], agentIds: ['sales'] }] } },
      'GET /app/api/admin/users': {
        body: {
          users: [
            { id: 'u1', email: 'olga@example.com', name: 'Ольга Смирнова', position: '', blocked: false, roleIds: [], departmentIds: ['d1'], createdAt: '' },
            { id: 'u2', email: 'denis@example.com', name: 'Денис Котов', position: '', blocked: false, roleIds: [], departmentIds: [], createdAt: '' },
          ],
        },
      },
      'GET /app/api/admin/agents': { body: { agents: [{ id: 'sales', name: 'Продажи', description: '', modelId: null }, { id: 'assistant', name: 'Общий помощник', description: '', modelId: null }], missingAgents: [] } },
      'PUT /app/api/admin/departments/d1/members': { body: { ok: true } },
      'DELETE /app/api/admin/departments/d1': { body: { ok: true } },
    });

  it('shows the people and agents of a department and saves its new members', async () => {
    const s = server();
    renderApp('/admin/departments');
    const user = userEvent.setup();
    const card = await screen.findByRole('button', { name: 'Отдел Продажи: изменить' });
    expect(within(card).getByText('1 сотрудник')).toBeInTheDocument();
    expect(within(card).getByText('ОС')).toBeInTheDocument();
    await user.click(card);
    const dialog = screen.getByRole('dialog', { name: 'Продажи' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Денис Котов' }));
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(s.calls.find((c) => c.path === '/app/api/admin/departments/d1/members')?.body).toEqual({ userIds: ['u1', 'u2'] }));
    expect(s.calls.some((c) => c.path.endsWith('/agents') && c.method === 'PUT')).toBe(false);
  });

  it('removes a department only after the question', async () => {
    const s = server();
    renderApp('/admin/departments');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Отдел Продажи: изменить' }));
    await user.click(screen.getByRole('button', { name: 'Удалить отдел' }));
    const question = screen.getByRole('alertdialog', { name: 'Удалить отдел «Продажи»?' });
    expect(within(question).getByText('Сотрудники останутся, но потеряют агентов этого отдела.')).toBeInTheDocument();
    await user.click(within(question).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(s.calls.some((c) => c.method === 'DELETE')).toBe(true));
  });
});
