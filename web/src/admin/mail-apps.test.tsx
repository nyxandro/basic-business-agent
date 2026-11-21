// «Почта сотрудников» in «Подключения» (spec, section 8.24): how many connected, and the sign-in of the
// services set up once with the app the admin registered; the return address is offered to copy.
import type { AdminMailResponse } from '@bba/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const STATE: AdminMailResponse = {
  apps: [
    { provider: 'google', clientId: null, tenant: null, configured: false },
    { provider: 'microsoft', clientId: null, tenant: null, configured: false },
    { provider: 'yandex', clientId: 'yandex-app', tenant: null, configured: true },
  ],
  redirectUri: 'https://agent.alfa.ru/app/api/mail/oauth/callback',
  connected: 7,
  authErrors: 1,
};

describe('«Почта сотрудников»', () => {
  it('shows who connected and sets up the sign-in of Microsoft with its organisation', async () => {
    const s = mockServer({
      'GET /app/api/me': { body: { ...ME, permissions: ['connections'] } },
      'GET /app/api/admin/connections': { body: { connections: [] } },
      'GET /app/api/admin/mail': { body: STATE },
      'PUT /app/api/admin/mail/oauth/microsoft': { body: { ...STATE, apps: STATE.apps.map((a) => (a.provider === 'microsoft' ? { ...a, clientId: 'ms-app', tenant: 'common', configured: true } : a)) } },
    });
    renderApp('/admin/connections');
    const user = userEvent.setup();
    expect(await screen.findByText('Подключили: 7')).toBeInTheDocument();
    expect(screen.getByText('Ошибка доступа: 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Адрес возврата — укажите его в приложении сервиса')).toHaveValue('https://agent.alfa.ru/app/api/mail/oauth/callback');
    const rows = screen.getAllByRole('listitem');
    const microsoft = rows.find((r) => within(r).queryByText('Microsoft'))!;
    expect(within(microsoft).getByText('Не настроен')).toBeInTheDocument();
    await user.click(within(microsoft).getByRole('button', { name: 'Настроить' }));
    await user.type(within(microsoft).getByLabelText('Client ID'), 'ms-app');
    await user.type(within(microsoft).getByLabelText('Client Secret'), 'ms-secret');
    expect(within(microsoft).getByLabelText('Организация (tenant)')).toHaveValue('common');
    await user.click(within(microsoft).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ clientId: 'ms-app', clientSecret: 'ms-secret', tenant: 'common' }));
    expect(await within(microsoft).findByText('Включён')).toBeInTheDocument();
  });

  it('turns a sign-in off after asking', async () => {
    const s = mockServer({
      'GET /app/api/me': { body: { ...ME, permissions: ['connections'] } },
      'GET /app/api/admin/connections': { body: { connections: [] } },
      'GET /app/api/admin/mail': { body: STATE },
      'DELETE /app/api/admin/mail/oauth/yandex': { body: { ...STATE, apps: STATE.apps.map((a) => (a.provider === 'yandex' ? { ...a, clientId: null, configured: false } : a)) } },
    });
    renderApp('/admin/connections');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Выключить' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Выключить вход через Яндекс?' });
    await user.click(within(ask).getByRole('button', { name: 'Выключить' }));
    await waitFor(() => expect(s.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Выключить' })).not.toBeInTheDocument();
  });
});
