// Mailboxes of employees and the sign-in apps of the services in the database (spec, section 8.24). The
// password or the tokens are sealed with the installation's key; nothing secret leaves this module unsealed
// except to the mail connection itself.
import { randomUUID } from 'node:crypto';
import type { MailAccountDto, MailOAuthProvider, MailServers } from '@bba/contracts';
import { MAIL_PRESETS } from '@bba/contracts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { notices } from '../notifications/kinds.ts';
import { notify } from '../notifications/notify.ts';

export type SealedMailSecret = { kind: 'password'; password: string } | { kind: 'oauth'; provider: MailOAuthProvider; accessToken: string; refreshToken: string | null; expiresAt: string | null };

export interface MailAccount {
  id: string;
  userId: string;
  email: string;
  provider: string;
  auth: 'password' | 'oauth';
  login: string;
  servers: MailServers;
  status: 'connected' | 'auth_error';
  checkedAt: Date | null;
}

interface AccountRow {
  id: string;
  user_id: string;
  email: string;
  provider: string;
  auth: 'password' | 'oauth';
  imap_host: string;
  imap_port: number;
  imap_security: 'tls' | 'starttls';
  smtp_host: string;
  smtp_port: number;
  smtp_security: 'tls' | 'starttls';
  login: string;
  status: 'connected' | 'auth_error';
  checked_at: Date | null;
}

const COLUMNS = 'id, user_id, email, provider, auth, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, login, status, checked_at';

function toAccount(r: AccountRow): MailAccount {
  return {
    id: r.id,
    userId: r.user_id,
    email: r.email,
    provider: r.provider,
    auth: r.auth,
    login: r.login,
    servers: { imap: { host: r.imap_host, port: r.imap_port, security: r.imap_security }, smtp: { host: r.smtp_host, port: r.smtp_port, security: r.smtp_security } },
    status: r.status,
    checkedAt: r.checked_at,
  };
}

export const titleOf = (provider: string, email: string) => MAIL_PRESETS.find((p) => p.id === provider)?.title ?? email.split('@').pop() ?? email;

export function accountDto(a: MailAccount): MailAccountDto {
  return { id: a.id, email: a.email, provider: a.provider, title: titleOf(a.provider, a.email), auth: a.auth, status: a.status, checkedAt: a.checkedAt?.toISOString() ?? null, servers: a.servers };
}

export async function listAccounts(db: Db, userId: string): Promise<MailAccount[]> {
  const { rows } = await db.query<AccountRow>(`SELECT ${COLUMNS} FROM app.mail_accounts WHERE user_id = $1 ORDER BY created_at, email`, [userId]);
  return rows.map(toAccount);
}

export async function findAccount(db: Db, userId: string, id: string): Promise<MailAccount | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const { rows } = await db.query<AccountRow>(`SELECT ${COLUMNS} FROM app.mail_accounts WHERE user_id = $1 AND id = $2`, [userId, id]);
  return rows[0] ? toAccount(rows[0]) : null;
}

export function decryptFailed(cause: unknown): AppError {
  return new AppError({
    code: 'APP_MAIL_DECRYPT_FAILED',
    message: 'stored mail credential cannot be decrypted',
    userMessage: 'Не удалось прочитать ваш доступ к почте — проблема на сервере.',
    nextStep: 'Подключите почту заново в «Настройки → Подключения»; если повторяется — сообщите администратору код ошибки.',
    status: 500,
    cause,
  });
}

export async function loadSecret(db: Db, box: SecretBox, id: string): Promise<SealedMailSecret> {
  const { rows } = await db.query<{ ciphertext: Buffer; iv: Buffer; key_version: number }>('SELECT ciphertext, iv, key_version FROM app.mail_accounts WHERE id = $1', [id]);
  if (!rows[0]) throw new Error(`mail account ${id} is gone`);
  try {
    return JSON.parse(box.open({ ciphertext: rows[0].ciphertext, iv: rows[0].iv, keyVersion: rows[0].key_version })) as SealedMailSecret;
  } catch (error) {
    throw decryptFailed(error);
  }
}

// One mailbox per address of a person: connecting it again replaces the way in.
export async function saveAccount(
  db: Db,
  box: SecretBox,
  input: { userId: string; email: string; provider: string; login: string; servers: MailServers; secret: SealedMailSecret },
): Promise<string> {
  const sealed = box.seal(JSON.stringify(input.secret));
  const { imap, smtp } = input.servers;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO app.mail_accounts (id, user_id, email, provider, auth, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, login, ciphertext, iv, key_version, status, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'connected', now())
     ON CONFLICT (user_id, email) DO UPDATE SET provider = EXCLUDED.provider, auth = EXCLUDED.auth, imap_host = EXCLUDED.imap_host, imap_port = EXCLUDED.imap_port,
       imap_security = EXCLUDED.imap_security, smtp_host = EXCLUDED.smtp_host, smtp_port = EXCLUDED.smtp_port, smtp_security = EXCLUDED.smtp_security, login = EXCLUDED.login,
       ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, key_version = EXCLUDED.key_version, status = 'connected', last_error_code = NULL, checked_at = now(), updated_at = now()
     RETURNING id`,
    [randomUUID(), input.userId, input.email.toLowerCase(), input.provider, input.secret.kind, imap.host, imap.port, imap.security, smtp.host, smtp.port, smtp.security, input.login, sealed.ciphertext, sealed.iv, sealed.keyVersion],
  );
  return rows[0]!.id;
}

export async function replaceSecret(db: Db, box: SecretBox, id: string, secret: SealedMailSecret): Promise<void> {
  const sealed = box.seal(JSON.stringify(secret));
  await db.query('UPDATE app.mail_accounts SET ciphertext = $2, iv = $3, key_version = $4, updated_at = now() WHERE id = $1', [id, sealed.ciphertext, sealed.iv, sealed.keyVersion]);
}

// The mail service refused the mailbox: «Ошибка доступа», and the employee is told — once per breakage, when the
// mailbox turns from working to broken (docs/specs/[20.11.2026]-notifications.md).
export async function markMailboxBroken(db: Db, account: Pick<MailAccount, 'id' | 'userId' | 'email'>, code: string): Promise<void> {
  const { rows } = await db.query<{ was: 'connected' | 'auth_error' }>(
    `UPDATE app.mail_accounts a SET status = 'auth_error', last_error_code = $2, checked_at = now(), updated_at = now()
       FROM (SELECT id, status AS was FROM app.mail_accounts WHERE id = $1 FOR UPDATE) o WHERE a.id = o.id RETURNING o.was`,
    [account.id, code],
  );
  if (rows[0]?.was === 'connected') {
    await notify(db, notices.connectionBroken({ userId: account.userId, connectionKey: `mail:${account.id}`, title: `почте ${account.email}`, brokenAt: new Date() }));
  }
}

export async function deleteAccount(db: Db, userId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM app.mail_accounts WHERE user_id = $1 AND id = $2', [userId, id]);
  return (rowCount ?? 0) > 0;
}

export async function hasAccounts(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM app.mail_accounts WHERE user_id = $1 LIMIT 1', [userId]);
  return rows.length > 0;
}

export async function accountCounts(db: Db): Promise<{ connected: number; authErrors: number }> {
  const { rows } = await db.query<{ connected: string; errors: string }>(
    "SELECT count(DISTINCT user_id) AS connected, count(DISTINCT user_id) FILTER (WHERE status = 'auth_error') AS errors FROM app.mail_accounts",
  );
  return { connected: Number(rows[0]?.connected ?? 0), authErrors: Number(rows[0]?.errors ?? 0) };
}

// The sign-in apps of the services.
export interface OAuthApp {
  provider: MailOAuthProvider;
  clientId: string;
  clientSecret: string;
  tenant: string | null;
}

export async function listApps(db: Db): Promise<{ provider: MailOAuthProvider; clientId: string; tenant: string | null }[]> {
  const { rows } = await db.query<{ provider: MailOAuthProvider; client_id: string; tenant: string | null }>('SELECT provider, client_id, tenant FROM app.mail_oauth_apps ORDER BY provider');
  return rows.map((r) => ({ provider: r.provider, clientId: r.client_id, tenant: r.tenant }));
}

export async function loadApp(db: Db, box: SecretBox, provider: MailOAuthProvider): Promise<OAuthApp | null> {
  const { rows } = await db.query<{ client_id: string; tenant: string | null; ciphertext: Buffer; iv: Buffer; key_version: number }>(
    'SELECT client_id, tenant, ciphertext, iv, key_version FROM app.mail_oauth_apps WHERE provider = $1',
    [provider],
  );
  const row = rows[0];
  if (!row) return null;
  let clientSecret: string;
  try {
    clientSecret = box.open({ ciphertext: row.ciphertext, iv: row.iv, keyVersion: row.key_version });
  } catch (error) {
    throw decryptFailed(error);
  }
  return { provider, clientId: row.client_id, clientSecret, tenant: row.tenant };
}

export async function saveApp(db: Db, box: SecretBox, app: OAuthApp): Promise<void> {
  const sealed = box.seal(app.clientSecret);
  await db.query(
    `INSERT INTO app.mail_oauth_apps (provider, client_id, tenant, ciphertext, iv, key_version) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (provider) DO UPDATE SET client_id = EXCLUDED.client_id, tenant = EXCLUDED.tenant, ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv,
       key_version = EXCLUDED.key_version, updated_at = now()`,
    [app.provider, app.clientId, app.tenant, sealed.ciphertext, sealed.iv, sealed.keyVersion],
  );
}

export async function deleteApp(db: Db, provider: MailOAuthProvider): Promise<void> {
  await db.query('DELETE FROM app.mail_oauth_apps WHERE provider = $1', [provider]);
}
