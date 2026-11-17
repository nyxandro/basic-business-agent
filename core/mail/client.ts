// Connections to a mail server (spec, section 8.24): IMAP through imapflow, SMTP through nodemailer, with
// the person's password or the token of the service's sign-in (XOAUTH2). One connection per action of the
// agent: opened, used, closed — the timeouts keep a silent server from holding an answer.
import type { MailServers } from '@bba/contracts';
import { ImapFlow } from 'imapflow';
import nodemailer, { type Transporter } from 'nodemailer';
import { AppError } from '../errors/app-error.ts';

export type MailSecret = { kind: 'password'; password: string } | { kind: 'oauth'; accessToken: string };

export interface MailLogin {
  login: string;
  secret: MailSecret;
}

// Tests talk to a mail server with a self-signed certificate; an installation always checks certificates.
export interface MailTransportOptions {
  trustSelfSigned: boolean;
}

const CONNECT_MS = 15_000;
const SOCKET_MS = 60_000;

export function mailAuthFailed(email: string, cause?: unknown): AppError {
  return new AppError({
    code: 'APP_MAIL_AUTH_FAILED',
    message: `mail server refused the sign-in of ${email.replace(/^[^@]*/, '***')}`,
    userMessage: `Почтовый сервер не принял вход в ${email}: пароль неверный, отозван или сервис требует пароль для внешних приложений.`,
    nextStep: 'Создайте пароль приложения в настройках почтового сервиса или войдите заново в «Настройки → Подключения».',
    status: 400,
    cause,
  });
}

function mailUnreachable(host: string, cause: unknown): AppError {
  return new AppError({
    code: 'APP_MAIL_SERVER_UNREACHABLE',
    message: `mail server ${host} did not answer: ${(cause as NodeJS.ErrnoException)?.code ?? (cause instanceof Error ? cause.name : 'unknown')}`,
    userMessage: `Почтовый сервер ${host} не отвечает.`,
    nextStep: 'Проверьте адрес и порт сервера или попробуйте позже.',
    status: 502,
    cause,
  });
}

function mailTlsFailed(host: string, cause: unknown): AppError {
  return new AppError({
    code: 'APP_MAIL_TLS_FAILED',
    message: `TLS with mail server ${host} failed: ${(cause as NodeJS.ErrnoException)?.code ?? 'unknown'}`,
    userMessage: `Не удалось установить защищённое соединение с ${host}: сертификат сервера недействителен или выбран не тот способ защиты.`,
    nextStep: 'Проверьте порт и защиту (SSL/TLS для 993 и 465, STARTTLS для 143 и 587).',
    status: 502,
    cause,
  });
}

const NETWORK = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'ETIMEOUT', 'NoConnection', 'EConnectionClosed', 'ESOCKET', 'ECONNECTION']);
const TLS = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|wrong version number/i;

// A failure of a mail server as the person reads it; an AppError passes as it is.
export function mailError(error: unknown, email: string, host: string): AppError {
  if (error instanceof AppError) return error;
  const e = error as { code?: string; authenticationFailed?: boolean; responseCode?: number; message?: string } | undefined;
  if (e?.authenticationFailed || e?.code === 'EAUTH' || e?.responseCode === 535 || e?.responseCode === 534) return mailAuthFailed(email, error);
  if (e?.code && NETWORK.has(e.code)) return mailUnreachable(host, error);
  if ((e?.code && TLS.test(e.code)) || (e?.message && TLS.test(e.message))) return mailTlsFailed(host, error);
  return new AppError({
    code: 'APP_MAIL_FAILED',
    message: `mail server ${host} failed: ${e?.code ?? (error instanceof Error ? error.name : 'unknown')}`,
    userMessage: `Почтовый сервер ${host} ответил ошибкой.`,
    nextStep: 'Попробуйте ещё раз; если повторяется — сообщите администратору код ошибки.',
    status: 502,
    cause: error,
  });
}

export function imapClient(servers: MailServers, who: MailLogin, options: MailTransportOptions): ImapFlow {
  const { host, port, security } = servers.imap;
  return new ImapFlow({
    host,
    port,
    secure: security === 'tls',
    ...(security === 'starttls' ? { doSTARTTLS: true } : {}),
    auth: who.secret.kind === 'password' ? { user: who.login, pass: who.secret.password } : { user: who.login, accessToken: who.secret.accessToken },
    tls: { rejectUnauthorized: !options.trustSelfSigned, servername: host },
    logger: false,
    connectionTimeout: CONNECT_MS,
    greetingTimeout: CONNECT_MS,
    socketTimeout: SOCKET_MS,
    disableAutoIdle: true,
  });
}

// Work with the mailbox over one connection, closed afterwards whatever happens.
export async function withImap<T>(servers: MailServers, who: MailLogin, email: string, options: MailTransportOptions, work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = imapClient(servers, who, options);
  // A connection that breaks after the work is done is no failure of the work.
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (error) {
    throw mailError(error, email, servers.imap.host);
  }
  try {
    return await work(client);
  } catch (error) {
    throw mailError(error, email, servers.imap.host);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export function smtpTransport(servers: MailServers, who: MailLogin, options: MailTransportOptions): Transporter {
  const { host, port, security } = servers.smtp;
  return nodemailer.createTransport({
    host,
    port,
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    auth: who.secret.kind === 'password' ? { user: who.login, pass: who.secret.password } : { type: 'OAuth2', user: who.login, accessToken: who.secret.accessToken },
    tls: { rejectUnauthorized: !options.trustSelfSigned, servername: host },
    connectionTimeout: CONNECT_MS,
    greetingTimeout: CONNECT_MS,
    socketTimeout: SOCKET_MS,
  });
}

// «Подключить»: the server lets the person in by IMAP and by SMTP.
export async function checkMailbox(servers: MailServers, who: MailLogin, email: string, options: MailTransportOptions): Promise<void> {
  await withImap(servers, who, email, options, () => Promise.resolve());
  const smtp = smtpTransport(servers, who, options);
  try {
    await smtp.verify();
  } catch (error) {
    throw mailError(error, email, servers.smtp.host);
  } finally {
    smtp.close();
  }
}
