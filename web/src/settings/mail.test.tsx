// «Почта» in «Подключения» (spec, section 8.24): the address first, the settings are found by the server,
// then one step — the service's sign-in or the password for mail programs; any other mail by hand.
import type { MailAccountsResponse, MailDiscovery } from '@bba/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const YANDEX: MailDiscovery = {
  email: 'olga@yandex.ru',
  source: 'preset',
  provider: 'yandex',
  title: 'Яндекс Почта',
  servers: { imap: { host: 'imap.yandex.ru', port: 993, security: 'tls' }, smtp: { host: 'smtp.yandex.ru', port: 465, security: 'tls' } },
  oauth: null,
  password: { help: 'Яндекс ID → Безопасность → Пароли приложений.', url: 'https://id.yandex.ru/security/app-passwords' },
};
const CONNECTED: MailAccountsResponse = {
  accounts: [{ id: 'a1', email: 'olga@yandex.ru', provider: 'yandex', title: 'Яндекс Почта', auth: 'password', status: 'connected', checkedAt: '2026-11-17T02:00:00.000Z', servers: YANDEX.servers! }],
  oauth: [],
};

function server(extra: Record<string, unknown> = {}) {
  return mockServer({
    'GET /app/api/me': { body: ME },
    'GET /app/api/me/connections': { body: { connections: [] } },
    'POST /app/api/me/mail/discover': (call) => ({ body: { ...YANDEX, email: (call.body as { email: string }).email } }),
    'POST /app/api/me/mail': { body: CONNECTED },
    ...(extra as Record<string, never>),
  });
}

describe('«Почта» in «Подключения»', () => {
  it('connects Yandex with an app password in two steps: the address is the person’s own by default', async () => {
    const s = server();
    renderApp('/settings/connections');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Подключить почту' }));
    const dialog = await screen.findByRole('dialog', { name: 'Подключение почты' });
    const address = within(dialog).getByLabelText('Адрес почты');
    expect(address).toHaveValue('olga@example.com');
    await user.clear(address);
    await user.type(address, 'olga@yandex.ru{Enter}');
    expect(await within(dialog).findByText('Яндекс Почта')).toBeInTheDocument();
    expect(within(dialog).getByText('Настройки известны — осталось войти.')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Создать пароль приложения ↗' })).toHaveAttribute('href', 'https://id.yandex.ru/security/app-passwords');
    await user.type(within(dialog).getByLabelText('Пароль приложения'), 'abcdefghijklmnop');
    s.set('GET /app/api/me/mail', { body: CONNECTED });
    await user.click(within(dialog).getByRole('button', { name: 'Подключить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(s.calls.find((c) => c.method === 'POST' && c.path === '/app/api/me/mail')?.body).toEqual({
      email: 'olga@yandex.ru',
      provider: 'yandex',
      login: 'olga@yandex.ru',
      password: 'abcdefghijklmnop',
      imap: YANDEX.servers!.imap,
      smtp: YANDEX.servers!.smtp,
    });
    expect(await screen.findByText('olga@yandex.ru')).toBeInTheDocument();
    expect(screen.getByText('Яндекс Почта · пароль приложения')).toBeInTheDocument();
  });

  it('a refusal of the server is shown in the window and what was typed stays', async () => {
    const s = server({ 'POST /app/api/me/mail': { status: 400, body: { error: { code: 'APP_MAIL_AUTH_FAILED', message: 'Почтовый сервер не принял вход в olga@yandex.ru.', nextStep: 'Создайте пароль приложения.' } } } });
    renderApp('/settings/connections');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Подключить почту' }));
    await user.click(await screen.findByRole('button', { name: 'Далее' }));
    await user.type(await screen.findByLabelText('Пароль приложения'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Подключить' }));
    const dialog = screen.getByRole('dialog', { name: 'Подключение почты' });
    expect(await within(dialog).findByText('Почтовый сервер не принял вход в olga@yandex.ru.')).toBeInTheDocument();
    expect(screen.getByLabelText('Пароль приложения')).toHaveValue('wrong');
    expect(s.calls.filter((c) => c.path === '/app/api/me/mail' && c.method === 'POST')).toHaveLength(1);
  });

  it('a service with sign-in goes to its site', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    server({
      'POST /app/api/me/mail/discover': (call: { body: { email: string } }) =>
        call.body.email.endsWith('gmail.com')
          ? { body: { ...YANDEX, email: call.body.email, provider: 'google', title: 'Gmail', oauth: 'google' } }
          : { body: { ...YANDEX, email: call.body.email, provider: 'microsoft', title: 'Outlook и Microsoft 365', oauth: null, password: null } },
      'POST /app/api/me/mail/oauth/start': { body: { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' } },
    });
    renderApp('/settings/connections');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Подключить почту' }));
    await user.clear(screen.getByLabelText('Адрес почты'));
    await user.type(screen.getByLabelText('Адрес почты'), 'olga@gmail.com{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Войти через Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
    vi.unstubAllGlobals();
  });

  it('Microsoft without its sign-in set up says whom to ask', async () => {
    server({ 'POST /app/api/me/mail/discover': (call: { body: { email: string } }) => ({ body: { ...YANDEX, email: call.body.email, provider: 'microsoft', title: 'Outlook и Microsoft 365', oauth: null, password: null } }) });
    renderApp('/settings/connections');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Подключить почту' }));
    await user.clear(screen.getByLabelText('Адрес почты'));
    await user.type(screen.getByLabelText('Адрес почты'), 'olga@outlook.com{Enter}');
    expect(await screen.findByText(/подключается только входом через сайт сервиса/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Пароль приложения')).not.toBeInTheDocument();
  });

  it('any other mail is entered by hand when nothing is found', async () => {
    const s = server({ 'POST /app/api/me/mail/discover': { body: { email: 'olga@firma.ru', source: 'none', provider: 'custom', title: 'firma.ru', servers: null, oauth: null, password: { help: 'Пароль от почты.', url: null } } } });
    renderApp('/settings/connections');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Подключить почту' }));
    await user.clear(screen.getByLabelText('Адрес почты'));
    await user.type(screen.getByLabelText('Адрес почты'), 'olga@firma.ru{Enter}');
    expect(await screen.findByText(/Настройки сервера найти не удалось/)).toBeInTheDocument();
    const imap = screen.getByRole('group', { name: 'Входящая почта (IMAP)' });
    expect(within(imap).getByLabelText('Сервер')).toHaveValue('imap.firma.ru');
    await user.clear(within(imap).getByLabelText('Сервер'));
    await user.type(within(imap).getByLabelText('Сервер'), 'mail.firma.ru');
    const smtp = screen.getByRole('group', { name: 'Исходящая почта (SMTP)' });
    await user.selectOptions(within(smtp).getByLabelText('Порт'), '587');
    await user.selectOptions(within(smtp).getByLabelText('Защита'), 'starttls');
    await user.type(screen.getByLabelText('Пароль'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Подключить' }));
    await waitFor(() =>
      expect(s.calls.find((c) => c.method === 'POST' && c.path === '/app/api/me/mail')?.body).toMatchObject({
        provider: 'custom',
        imap: { host: 'mail.firma.ru', port: 993, security: 'tls' },
        smtp: { host: 'smtp.firma.ru', port: 587, security: 'starttls' },
      }),
    );
  });

  it('a broken mailbox offers to connect it again; coming back from a sign-in says how it went', async () => {
    server({ 'GET /app/api/me/mail': { body: { accounts: [{ ...CONNECTED.accounts[0], status: 'auth_error' }], oauth: [] } } });
    renderApp('/settings/connections?mailError=APP_MAIL_AUTH_FAILED');
    expect(await screen.findByText('Ошибка доступа')).toBeInTheDocument();
    expect(screen.getByText(/Почтовый сервер не принял вход: на сайте сервиса выбран другой аккаунт/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Подключить заново' }));
    expect(within(await screen.findByRole('dialog')).getByLabelText('Адрес почты')).toHaveValue('olga@yandex.ru');
  });
});
