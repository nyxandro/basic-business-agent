import { z } from 'zod';

// The mailbox of an employee (spec, section 8.24): each person connects their own mail in «Настройки →
// Подключения», and the agent reads and searches it, saves attachments into the working folder and sends
// letters — a letter only after «Да». Popular services are found by the address alone; any other — by the
// settings its domain publishes (autoconfig, SRV records), by its mail exchanger, or entered by hand.

export const MAIL_SECURITY = ['tls', 'starttls'] as const;
export type MailSecurity = (typeof MAIL_SECURITY)[number];
// The ports a mail server answers on; others are refused (the server connects where the person points).
export const IMAP_PORTS = [993, 143] as const;
export const SMTP_PORTS = [465, 587, 25, 2525] as const;

export const MAIL_OAUTH_PROVIDERS = ['google', 'microsoft', 'yandex'] as const;
export type MailOAuthProvider = (typeof MAIL_OAUTH_PROVIDERS)[number];

export interface MailServer {
  host: string;
  port: number;
  security: MailSecurity;
}

export interface MailServers {
  imap: MailServer;
  smtp: MailServer;
}

// A preset of a popular service. `password` — how to get a password for mail programs there (most services
// do not take the account's own password); null — the service takes no password at all (Microsoft).
export interface MailPreset {
  id: string;
  title: string;
  servers: MailServers;
  oauth: MailOAuthProvider | null;
  password: { help: string; url: string | null } | null;
}

export const MAIL_PRESETS: readonly MailPreset[] = [
  {
    id: 'yandex',
    title: 'Яндекс Почта',
    servers: { imap: { host: 'imap.yandex.ru', port: 993, security: 'tls' }, smtp: { host: 'smtp.yandex.ru', port: 465, security: 'tls' } },
    oauth: 'yandex',
    password: {
      help: 'Яндекс ID → Безопасность → Пароли приложений → «Почта» — создайте пароль и вставьте сюда. В настройках почты должен быть включён доступ по IMAP («Почтовые программы»).',
      url: 'https://id.yandex.ru/security/app-passwords',
    },
  },
  {
    id: 'mailru',
    title: 'Почта Mail',
    servers: { imap: { host: 'imap.mail.ru', port: 993, security: 'tls' }, smtp: { host: 'smtp.mail.ru', port: 465, security: 'tls' } },
    oauth: null,
    password: { help: 'Настройки аккаунта → Безопасность → Пароли для внешних приложений — создайте пароль для «Почты» и вставьте сюда.', url: 'https://account.mail.ru/user/2-step-auth/passwords/' },
  },
  {
    id: 'google',
    title: 'Gmail',
    servers: { imap: { host: 'imap.gmail.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' } },
    oauth: 'google',
    password: { help: 'Аккаунт Google → Безопасность → Пароли приложений (нужна двухэтапная проверка) — создайте пароль и вставьте сюда.', url: 'https://myaccount.google.com/apppasswords' },
  },
  {
    id: 'microsoft',
    title: 'Outlook и Microsoft 365',
    servers: { imap: { host: 'outlook.office365.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' } },
    oauth: 'microsoft',
    password: null,
  },
  {
    id: 'icloud',
    title: 'iCloud Почта',
    servers: { imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' } },
    oauth: null,
    password: { help: 'Apple ID → Вход и безопасность → Пароли приложений — создайте пароль и вставьте сюда.', url: 'https://account.apple.com/account/manage' },
  },
  {
    id: 'rambler',
    title: 'Рамблер Почта',
    servers: { imap: { host: 'imap.rambler.ru', port: 993, security: 'tls' }, smtp: { host: 'smtp.rambler.ru', port: 465, security: 'tls' } },
    oauth: null,
    password: { help: 'В настройках почты Рамблера включите «Доступ к почтовому ящику с помощью почтовых клиентов» и введите пароль от почты.', url: 'https://mail.rambler.ru/settings/mailapps' },
  },
  {
    id: 'yahoo',
    title: 'Yahoo Mail',
    servers: { imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' } },
    oauth: null,
    password: { help: 'Yahoo Account Security → Generate app password — создайте пароль и вставьте сюда.', url: 'https://login.yahoo.com/account/security' },
  },
];

// How settings for a manual entry or a found server are described to the person.
export const OTHER_MAIL_PASSWORD_HELP = 'Пароль от почты или пароль для почтовых программ, если ваш сервис их выдаёт.';

const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$/, 'Адрес сервера: латинские буквы, цифры, точки и дефисы');
// Which ports are taken is the server's to check (IMAP_PORTS, SMTP_PORTS).
const server = z.object({ host, port: z.number().int().min(1).max(65535), security: z.enum(MAIL_SECURITY) });

export const mailDiscoverSchema = z.object({ email: z.email() });

// «Подключить» with a password: the preset (or «custom») and the servers as the person saw them.
export const mailConnectSchema = z.object({
  email: z.email(),
  provider: z.string().min(1).max(40),
  login: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(512),
  imap: server,
  smtp: server,
});
export type MailConnectInput = z.infer<typeof mailConnectSchema>;

export const mailOAuthStartSchema = z.object({ email: z.email(), provider: z.enum(MAIL_OAUTH_PROVIDERS) });

// POST /app/api/me/mail/discover: what was found for the address.
export interface MailDiscovery {
  email: string;
  // Where the settings came from: a preset by the domain or by its mail exchanger, the domain's own
  // published settings, its SRV records, a server that answered at a usual name, or nothing (manual).
  source: 'preset' | 'mx' | 'autoconfig' | 'srv' | 'guess' | 'none';
  provider: string;
  title: string;
  servers: MailServers | null;
  // Sign-in on the service's site, when the admin has set it up for this service.
  oauth: MailOAuthProvider | null;
  // How to get the password, or null when the service takes none (only sign-in on its site).
  password: { help: string; url: string | null } | null;
}

export interface MailAccountDto {
  id: string;
  email: string;
  provider: string;
  title: string;
  auth: 'password' | 'oauth';
  status: 'connected' | 'auth_error';
  checkedAt: string | null;
  servers: MailServers;
}

export interface MailAccountsResponse {
  accounts: MailAccountDto[];
  // Services whose sign-in on their site the admin has set up.
  oauth: MailOAuthProvider[];
}

// «Подключения → Почта» of the admin panel: the apps of the services' sign-in. Secrets never leave the server.
export interface MailOAuthAppDto {
  provider: MailOAuthProvider;
  clientId: string | null;
  // Microsoft only: the organisation (tenant) or «common».
  tenant: string | null;
  configured: boolean;
}

export interface AdminMailResponse {
  apps: MailOAuthAppDto[];
  // The address to give the service as the return address of the sign-in.
  redirectUri: string;
  // Employees with a mailbox connected, and with one whose access broke.
  connected: number;
  authErrors: number;
}

export const mailOAuthAppSchema = z.object({
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().trim().min(1).max(1024),
  tenant: z.string().trim().max(128).optional(),
});
export type MailOAuthAppInput = z.infer<typeof mailOAuthAppSchema>;
