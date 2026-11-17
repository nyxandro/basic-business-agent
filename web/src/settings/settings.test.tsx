import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

describe('my spend', () => {
  it('shows the rest of the monthly limit and today’s tokens of subscription models', async () => {
    mockServer({ 'GET /app/api/me': { body: ME }, 'GET /app/api/me/usage': { body: { month: { spentRub: 1760, limitRub: 3000, resetsOn: '2026-12-01' }, daily: { usedTokens: 120_000, capTokens: 500_000 } } } });
    renderApp('/settings/usage');
    expect(await screen.findByText('Израсходовано 1 760 ₽ из 3 000 ₽, обновится 1 декабря')).toBeInTheDocument();
    expect(screen.getByText('Сегодня: 120 тыс. из 500 тыс. токенов, обновится завтра')).toBeInTheDocument();
  });

  it('shows only the sum without a personal limit, and an empty month plainly', async () => {
    const server = mockServer({ 'GET /app/api/me': { body: ME }, 'GET /app/api/me/usage': { body: { month: { spentRub: 250, limitRub: null, resetsOn: '2026-12-01' }, daily: null } } });
    const { unmount } = renderApp('/settings/usage');
    expect(await screen.findByText('Израсходовано 250 ₽ в этом месяце')).toBeInTheDocument();
    unmount();
    server.set('GET /app/api/me/usage', { body: { month: { spentRub: 0, limitRub: null, resetsOn: '2026-12-01' }, daily: null } });
    renderApp('/settings/usage');
    expect(await screen.findByText('В этом месяце расходов пока нет')).toBeInTheDocument();
  });
});

describe('my connections', () => {
  const STATIC = { id: 'bitrix24', title: 'Битрикс24', auth: 'static', fields: [{ name: 'webhook', label: 'Адрес вебхука', secret: true }], status: 'not_connected', checkedAt: null };

  it('keeps what was typed when the system refuses the key', async () => {
    mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/me/connections': { body: { connections: [STATIC] } },
      'PUT /app/api/me/connections/bitrix24': apiError('APP_CONNECTOR_AUTH_FAILED', 'Битрикс24 не приняла ваш доступ — возможно, он истёк. Переподключите её в настройках.', 400),
    });
    renderApp('/settings/connections');
    const user = userEvent.setup();
    expect(await screen.findByText('Не подключено')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Адрес вебхука'), 'https://example.bitrix24.ru/rest/1/abc/');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText(/не приняла ваш доступ/)).toBeInTheDocument();
    expect(screen.getByLabelText('Адрес вебхука')).toHaveValue('https://example.bitrix24.ru/rest/1/abc/');
  });

  it('sends the person to the system’s sign-in page and greets them back', async () => {
    const oauth = { ...STATIC, auth: 'oauth', fields: [], status: 'connected', checkedAt: '2026-11-14T08:00:00.000Z' };
    mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/me/connections': { body: { connections: [oauth] } },
      'POST /app/api/me/connections/bitrix24/oauth/start': { body: { url: 'https://example.bitrix24.ru/oauth/authorize?state=s' } },
    });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    renderApp('/settings/connections?connected=bitrix24');
    expect(await screen.findByText('«Битрикс24» подключена.')).toBeInTheDocument();
    expect(screen.getByText(/Подключено · проверено/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Переподключить' }));
    expect(assign).toHaveBeenCalledWith('https://example.bitrix24.ru/oauth/authorize?state=s');
  });
});
