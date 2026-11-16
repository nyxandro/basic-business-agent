import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, permissions: ['masking', 'connections', 'journal', 'org_profile'] };

describe('«Маскирование»', () => {
  it('saves a switch at once and the example shows the real e-mail once it is off', async () => {
    const s = mockServer({ 'GET /app/api/me': { body: ADMIN }, 'GET /app/api/admin/masking': { body: { kinds: ['passport', 'phone', 'email'] } }, 'PUT /app/api/admin/masking': { body: { ok: true } } });
    renderApp('/admin/masking');
    const seen = (await screen.findByText('Модель видит')).parentElement!;
    expect(within(seen).getByText('[ПОЧТА_1]')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Электронная почта' }));
    expect(within(seen).queryByText('[ПОЧТА_1]')).not.toBeInTheDocument();
    expect(within(seen).getByText('a.petrov@example.com')).toBeInTheDocument();
    expect(within(seen).getByText('[ТЕЛЕФОН_1]')).toBeInTheDocument();
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ kinds: ['passport', 'phone'] }));
  });
});

describe('a form opened again (spec, section 8.22)', () => {
  it('shows what was saved, not what was loaded before: a form is loaded anew at every opening', async () => {
    let kinds = ['passport', 'phone', 'email'];
    const s = mockServer({
      'GET /app/api/me': { body: ADMIN },
      'GET /app/api/admin/masking': () => ({ body: { kinds } }),
      'PUT /app/api/admin/masking': (call) => {
        kinds = (call.body as { kinds: string[] }).kinds;
        return { body: { ok: true } };
      },
      'GET /app/api/admin/journal': { body: { entries: [], total: 0 } },
    });
    renderApp('/admin/masking');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Электронная почта' }));
    await waitFor(() => expect(s.calls.some((c) => c.method === 'PUT')).toBe(true));
    const nav = screen.getByRole('navigation', { name: 'Разделы админки' });
    await user.click(within(nav).getByRole('link', { name: 'Журнал действий' }));
    // The server answers slowly now: a form from memory would show the state before the save meanwhile.
    let answer: (() => void) | null = null;
    s.set('GET /app/api/admin/masking', () => new Promise((resolve) => (answer = () => resolve({ body: { kinds } }))));
    await user.click(within(nav).getByRole('link', { name: 'Маскирование' }));
    await waitFor(() => expect(answer).not.toBeNull());
    // Never the state before the save, not even for a moment: the next save would take it back.
    expect(screen.queryByRole('switch', { name: 'Электронная почта' })).toBeNull();
    act(() => (answer as unknown as () => void)());
    expect(await screen.findByRole('switch', { name: 'Электронная почта' })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('«Профиль организации»', () => {
  it('saves the name and the tone chosen from the presets', async () => {
    const s = mockServer({
      'GET /app/api/me': { body: ADMIN },
      'GET /app/api/admin/org-profile': { body: { name: 'Альфа-Строй', tone: '', requisites: '', industry: '' } },
      'PUT /app/api/admin/org-profile': { body: { ok: true } },
    });
    renderApp('/admin/org-profile');
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Название');
    await user.clear(name);
    await user.type(name, 'ООО «Альфа-Строй»');
    await user.click(screen.getByRole('radio', { name: 'Дружелюбный' }));
    expect(screen.getByRole('radio', { name: 'Дружелюбный' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Сохранено')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ name: 'ООО «Альфа-Строй»', tone: 'Дружелюбный: на «вы», тепло и просто, без канцелярита.', requisites: '', industry: '' });
  });
});

describe('«Подключения» and «Журнал действий»', () => {
  it('shows how many employees connected a system and its access errors', async () => {
    mockServer({
      'GET /app/api/me': { body: ADMIN },
      'GET /app/api/admin/connections': { body: { connections: [{ id: 'crm', title: 'Тестовая CRM', mode: 'personal', auth: 'oauth', employees: { connected: 3, unverified: 1, auth_error: 1 } }], employeesTotal: 5 } },
    });
    renderApp('/admin/connections');
    expect(await screen.findByText('3 из 5')).toBeInTheDocument();
    expect(screen.getByText('Ошибка доступа: 1')).toBeInTheDocument();
    expect(screen.getByText('Сохранили ключ, но система его ещё не проверила: 1')).toBeInTheDocument();
    expect(screen.getByText('вход через сайт системы')).toBeInTheDocument();
  });

  it('shows the mode, the action and who said «Да»', async () => {
    mockServer({
      'GET /app/api/me': { body: ADMIN },
      'GET /app/api/admin/journal': {
        body: {
          entries: [{ id: 'j1', at: '2026-11-14T06:00:00Z', user: 'Ольга', agent: 'Продажи', runKind: 'background', event: 'tool_call', tool: 'mail_send', args: { to: 'client@example.com' }, approvedBy: 'Ольга', result: 'ok', errorCode: null }],
          pageSize: 100,
        },
      },
    });
    renderApp('/admin/journal');
    const row = (await screen.findByText('mail_send')).closest('tr')!;
    expect(within(row).getByText('фон')).toBeInTheDocument();
    expect(within(row).getByText('Выполнено')).toBeInTheDocument();
    expect(within(row).getByText('«Да» — Ольга')).toBeInTheDocument();
  });
});
