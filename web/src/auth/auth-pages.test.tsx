import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';
import { safeNextPath } from './next-path.ts';

const SIGNED_OUT = apiError('APP_AUTH_SESSION_EXPIRED', 'Сессия истекла. Войдите заново — разговоры сохранены.', 401);
const NO_AGENTS = { body: { agents: [] } };

describe('sign-in', () => {
  it('keeps the e-mail after a wrong password and shows the reason with its code', async () => {
    mockServer({
      'GET /app/api/me': SIGNED_OUT,
      'POST /app/api/auth/sign-in/email': apiError('APP_AUTH_INVALID_CREDENTIALS', 'Неверная почта или пароль. Проверьте раскладку и попробуйте ещё раз.', 401),
    });
    renderApp('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Почта'), 'olga@example.com');
    await user.type(screen.getByLabelText('Пароль'), 'неверный-пароль');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('Неверная почта или пароль. Проверьте раскладку и попробуйте ещё раз.')).toBeInTheDocument();
    expect(screen.getByText(/APP_AUTH_INVALID_CREDENTIALS/)).toBeInTheDocument();
    expect(screen.getByLabelText('Почта')).toHaveValue('olga@example.com');
    expect(screen.getByLabelText('Пароль')).toHaveValue('');
  });

  it('sends a person without a session to sign-in and brings them back after it', async () => {
    const server = mockServer({ 'GET /app/api/me': SIGNED_OUT, 'GET /app/api/agents': NO_AGENTS });
    server.set('POST /app/api/auth/sign-in/email', () => {
      server.set('GET /app/api/me', { body: ME });
      return { body: {} };
    });
    renderApp('/');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Почта'), 'olga@example.com');
    await user.type(screen.getByLabelText('Пароль'), 'верный-пароль-1');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect((await screen.findAllByText(/Вам пока не назначены агенты/)).length).toBeGreaterThan(0);
    expect(server.calls.find((c) => c.path === '/app/api/auth/sign-in/email')?.body).toEqual({ email: 'olga@example.com', password: 'верный-пароль-1' });
  });

  it('goes back only to a path inside the site', () => {
    expect(safeNextPath('/agents/sales?x=1')).toBe('/agents/sales?x=1');
    // Browsers drop tabs and newlines from addresses: "/\t/evil" would become "//evil", another site.
    for (const bad of [null, '', 'https://evil.example', '//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', ' //evil.example']) expect(safeNextPath(bad)).toBe('/');
  });
});

describe('invite and reset links', () => {
  it('shows the server text for a used link and no form', async () => {
    mockServer({
      'GET /app/api/me': SIGNED_OUT,
      'GET /app/api/invites/used-token': apiError('APP_INVITE_INVALID', 'Ссылка-приглашение недействительна или уже использована. Попросите администратора прислать новую.', 410),
    });
    renderApp('/invite/used-token');
    expect(await screen.findByText(/Ссылка-приглашение недействительна/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Новый пароль')).not.toBeInTheDocument();
  });

  it('checks the password in the browser, then saves it and signs the person in', async () => {
    const server = mockServer({
      'GET /app/api/me': SIGNED_OUT,
      'GET /app/api/agents': NO_AGENTS,
      'GET /app/api/invites/good-token': { body: { email: 'olga@example.com', name: 'Ольга' } },
      'POST /app/api/invites/good-token/accept': { body: { email: 'olga@example.com' } },
    });
    server.set('POST /app/api/auth/sign-in/email', () => {
      server.set('GET /app/api/me', { body: ME });
      return { body: {} };
    });
    renderApp('/invite/good-token');
    const user = userEvent.setup();
    expect(await screen.findByText('Здравствуйте, Ольга! Придумайте пароль для входа.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Новый пароль'), 'короткий');
    await user.type(screen.getByLabelText('Повторите пароль'), 'короткий');
    await user.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));
    expect(screen.getByText('Пароль слишком короткий: нужно не меньше 10 символов.')).toBeInTheDocument();
    expect(server.calls.some((c) => c.path.endsWith('/accept'))).toBe(false);

    await user.clear(screen.getByLabelText('Новый пароль'));
    await user.clear(screen.getByLabelText('Повторите пароль'));
    await user.type(screen.getByLabelText('Новый пароль'), 'длинный-пароль');
    await user.type(screen.getByLabelText('Повторите пароль'), 'другой-пароль!');
    await user.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));
    expect(screen.getByText('Пароли не совпадают.')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Повторите пароль'));
    await user.type(screen.getByLabelText('Повторите пароль'), 'длинный-пароль');
    await user.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));
    expect((await screen.findAllByText(/Вам пока не назначены агенты/)).length).toBeGreaterThan(0);
    expect(server.calls.find((c) => c.path.endsWith('/accept'))?.body).toEqual({ password: 'длинный-пароль' });
  });

  it('opens the reset link with the e-mail it belongs to', async () => {
    mockServer({ 'GET /app/api/me': SIGNED_OUT, 'GET /app/api/password-resets/r1': { body: { email: 'olga@example.com' } } });
    renderApp('/reset/r1');
    expect(await screen.findByText('Новый пароль для olga@example.com.')).toBeInTheDocument();
  });
});
