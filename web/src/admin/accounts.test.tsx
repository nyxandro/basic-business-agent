import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, permissions: ['models'] };
const SUB = { id: 'm-sub00001', kind: 'chat', label: 'GPT по подписке', connection: 'chatgpt', providerModel: 'chatgpt/gpt-5.4', apiBase: null, vision: true, enabled: true, prices: null, pricePerMinute: null, keys: [], agentIds: [] };
const SETTINGS = { primaryModelId: 'm-sub00001', fallbackModelId: null, transcriptionModelId: null, agentsChooseModel: false };
const ACCOUNT = { connectedAt: '2026-11-10T08:00:00Z', failureStatus: null, cooldownUntil: null, lastSuccessAt: null, tokensToday: 0 };
const WORKS = { ...ACCOUNT, id: 'a-00000001', email: 'sales.gpt@example.com', state: 'works', lastSuccessAt: '2026-11-14T08:10:00Z', tokensToday: 210_000 };
// 14:32 of this machine's clock, as the admin's browser shows it.
const BACK_AT = new Date(2026, 10, 14, 14, 32).toISOString();
const COOLING = { ...ACCOUNT, id: 'a-00000002', email: 'busy.gpt@example.com', state: 'cooldown', failureStatus: 429, cooldownUntil: BACK_AT, tokensToday: 390_000 };
const REVOKED = { ...ACCOUNT, id: 'a-00000003', email: 'old.gpt@example.com', state: 'auth_error', failureStatus: 401 };
const SILENT = { ...ACCOUNT, id: 'a-00000004', email: 'new.gpt@example.com', state: 'no_requests' };
const LOGIN = { id: 'l-00000001', userCode: 'ABCD-EFGH', verifyUrl: 'https://auth.openai.com/codex/device', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), intervalSeconds: 1 };

function server(accounts: object[] = [WORKS, COOLING, REVOKED, SILENT]) {
  return mockServer({
    'GET /app/api/me': { body: ADMIN },
    'GET /app/api/admin/models': { body: { models: [SUB], settings: SETTINGS, accounts, gateway: { reachable: true, checkedAt: '2026-11-14T08:00:00Z', pendingModelIds: [] } } },
    'POST /app/api/admin/chatgpt/logins': { status: 201, body: LOGIN },
  });
}

describe('«Пул аккаунтов подписки»', () => {
  it('shows every account with its state and today’s tokens; the tile counts the active ones', async () => {
    server();
    renderApp('/admin/models');
    const pool = await screen.findByRole('list', { name: 'Аккаунты подписки' });
    const row = (email: string) => within(pool).getByText(email).closest('li')!;
    expect(within(row('sales.gpt@example.com')).getByText(/^Работает · последний успешный запрос/)).toBeInTheDocument();
    expect(within(row('sales.gpt@example.com')).getByText('210 тыс. токенов сегодня')).toBeInTheDocument();
    expect(within(row('busy.gpt@example.com')).getByText('Охлаждение — ошибка 429, вернётся в 14:32')).toBeInTheDocument();
    expect(within(row('old.gpt@example.com')).getByText('Ошибка доступа — войдите заново')).toBeInTheDocument();
    expect(within(row('new.gpt@example.com')).getByText('Нет запросов')).toBeInTheDocument();
    expect(screen.getByText('2 из 4 активны')).toBeInTheDocument();
    expect(screen.getByText('один в охлаждении, один — ошибка доступа')).toBeInTheDocument();
    expect(screen.getAllByText('пул из 4 аккаунтов').length).toBeGreaterThan(0);
  });

  it('connects an account by the code: the code, OpenAI’s page, the countdown, then the account', async () => {
    const s = server([]);
    s.set('GET /app/api/admin/chatgpt/logins/l-00000001', () => {
      s.set('GET /app/api/admin/models', { body: { models: [SUB], settings: SETTINGS, accounts: [SILENT], gateway: { reachable: true, checkedAt: '2026-11-14T08:00:00Z', pendingModelIds: [] } } });
      return { body: { status: 'connected', account: SILENT } };
    });
    renderApp('/admin/models');
    const user = userEvent.setup();
    expect(await screen.findByText('Аккаунтов пока нет')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Подключить аккаунт ChatGPT' }));
    const dialog = await screen.findByRole('dialog', { name: 'Подключить аккаунт ChatGPT' });
    expect(await within(dialog).findByLabelText('Код входа')).toHaveTextContent('ABCD-EFGH');
    expect(within(dialog).getByRole('link', { name: 'Открыть сайт OpenAI' })).toHaveAttribute('href', LOGIN.verifyUrl);
    expect(within(dialog).getByText(/Жду входа… осталось 1[45]:\d\d/)).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({ accountId: null });
    expect(await screen.findByText('Аккаунт подключён: new.gpt@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Подключить аккаунт ChatGPT' })).not.toBeInTheDocument();
    expect(await screen.findByText('Нет запросов')).toBeInTheDocument();
  });

  it('says the time is out and starts again with a new code', async () => {
    const s = server([]);
    s.set('GET /app/api/admin/chatgpt/logins/l-00000001', apiError('APP_CHATGPT_LOGIN_EXPIRED', 'Время на вход вышло. Начните заново.', 410));
    renderApp('/admin/models');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Подключить аккаунт ChatGPT' }));
    const dialog = await screen.findByRole('dialog', { name: 'Подключить аккаунт ChatGPT' });
    expect(await within(dialog).findByText('Время на вход вышло. Начните заново.')).toBeInTheDocument();
    s.set('POST /app/api/admin/chatgpt/logins', { status: 201, body: { ...LOGIN, id: 'l-00000002', userCode: 'WXYZ-1234' } });
    s.set('GET /app/api/admin/chatgpt/logins/l-00000002', { body: { status: 'pending', expiresAt: LOGIN.expiresAt } });
    await user.click(within(dialog).getByRole('button', { name: 'Начать заново' }));
    expect(await within(dialog).findByLabelText('Код входа')).toHaveTextContent('WXYZ-1234');
    expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('logs into a refused account again from its row', async () => {
    const s = server();
    s.set('GET /app/api/admin/chatgpt/logins/l-00000001', { body: { status: 'pending', expiresAt: LOGIN.expiresAt } });
    renderApp('/admin/models');
    const user = userEvent.setup();
    const pool = await screen.findByRole('list', { name: 'Аккаунты подписки' });
    await user.click(within(within(pool).getByText('old.gpt@example.com').closest('li')!).getByRole('button', { name: 'Войти заново' }));
    expect(await screen.findByRole('dialog', { name: 'Войти заново: old.gpt@example.com' })).toBeInTheDocument();
    await waitFor(() => expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({ accountId: 'a-00000003' }));
  });

  it('disconnects an account only after the question', async () => {
    const s = server();
    s.set('DELETE /app/api/admin/chatgpt/accounts/a-00000002', { body: { ok: true } });
    renderApp('/admin/models');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия: busy.gpt@example.com' }));
    await user.click(screen.getByRole('menuitem', { name: 'Отключить' }));
    const question = screen.getByRole('alertdialog', { name: 'Отключить busy.gpt@example.com?' });
    await user.click(within(question).getByRole('button', { name: 'Отключить' }));
    expect(await screen.findByText('Аккаунт отключён')).toBeInTheDocument();
    expect(s.calls.some((c) => c.method === 'DELETE' && c.path === '/app/api/admin/chatgpt/accounts/a-00000002')).toBe(true);
  });

  it('adds a subscription model without a key and prices', async () => {
    const s = server();
    s.set('POST /app/api/admin/models', { status: 201, body: { ...SUB, id: 'm-sub00002', label: 'GPT-5.4 mini' } });
    renderApp('/admin/models');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Добавить модель' }));
    const dialog = screen.getByRole('dialog', { name: 'Добавить модель' });
    await user.click(within(dialog).getByRole('button', { name: 'Подписка ChatGPT' }));
    expect(within(dialog).queryByLabelText('Ключ')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Цены, ₽ за 1 млн токенов')).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Название'), 'GPT-5.4 mini');
    await user.type(within(dialog).getByLabelText('Провайдер и модель'), 'chatgpt/gpt-5.4-mini');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Модель добавлена')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'POST' && c.path === '/app/api/admin/models')?.body).toEqual({
      kind: 'chat',
      label: 'GPT-5.4 mini',
      connection: 'chatgpt',
      providerModel: 'chatgpt/gpt-5.4-mini',
      vision: true,
    });
  });
});
