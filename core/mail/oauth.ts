// Sign-in to a mailbox on the service's own site (spec, section 8.24): Google, Microsoft and Yandex give mail
// programs a token (XOAUTH2) instead of a password, Microsoft gives nothing else. The app of the service is
// registered once by the admin; the person only clicks «Войти через …». Authorisation code with PKCE; the
// token is refreshed ahead of expiry under a lock per mailbox — some services issue single-use refresh tokens.
import { createHash, randomBytes } from 'node:crypto';
import type { MailOAuthProvider } from '@bba/contracts';
import type { SecretBox } from '../crypto/secret-box.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { loadApp, loadSecret, replaceSecret, setAccountStatus, type MailAccount, type OAuthApp, type SealedMailSecret } from './accounts.ts';
import { mailAuthFailed } from './client.ts';

const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_AHEAD_MS = 5 * 60 * 1000;

export interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
}

// The services' addresses; tests point them at a fake.
export type EndpointsOf = (provider: MailOAuthProvider, tenant: string | null) => OAuthEndpoints;

export const realEndpoints: EndpointsOf = (provider, tenant) => {
  switch (provider) {
    case 'google':
      return { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token' };
    case 'microsoft': {
      const t = encodeURIComponent(tenant || 'common');
      return { authorizeUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`, tokenUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token` };
    }
    case 'yandex':
      return { authorizeUrl: 'https://oauth.yandex.ru/authorize', tokenUrl: 'https://oauth.yandex.ru/token' };
  }
};

// What the mailbox needs of each service, and how it is asked to remember the person (a refresh token).
const SCOPES: Record<MailOAuthProvider, string[]> = {
  google: ['https://mail.google.com/'],
  microsoft: ['https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send', 'offline_access'],
  yandex: ['mail:imap_full', 'mail:smtp'],
};
const EXTRA: Record<MailOAuthProvider, Record<string, string>> = {
  google: { access_type: 'offline', prompt: 'consent' },
  microsoft: { prompt: 'select_account' },
  yandex: { force_confirm: 'yes' },
};

export const PROVIDER_TITLES: Record<MailOAuthProvider, string> = { google: 'Google', microsoft: 'Microsoft', yandex: 'Яндекс' };

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const b64url = (b: Buffer) => b.toString('base64url');

export function oauthNotConfigured(provider: MailOAuthProvider): AppError {
  return new AppError({
    code: 'APP_MAIL_OAUTH_NOT_CONFIGURED',
    message: `sign-in app of ${provider} is not set up`,
    userMessage: `Вход через ${PROVIDER_TITLES[provider]} в этой установке ещё не включён.`,
    nextStep: 'Попросите администратора включить его в «Подключения → Почта» или подключите почту паролем приложения.',
    status: 409,
  });
}

export interface OAuthDeps {
  db: Db;
  box: SecretBox;
  redirectUri: string;
  endpoints: EndpointsOf;
}

async function appOf(deps: OAuthDeps, provider: MailOAuthProvider): Promise<OAuthApp> {
  const app = await loadApp(deps.db, deps.box, provider);
  if (!app) throw oauthNotConfigured(provider);
  return app;
}

export async function startMailOAuth(deps: OAuthDeps, userId: string, provider: MailOAuthProvider, email: string): Promise<string> {
  const app = await appOf(deps, provider);
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  await deps.db.query('DELETE FROM app.mail_oauth_states WHERE expires_at < now()');
  await deps.db.query('INSERT INTO app.mail_oauth_states (state_hash, user_id, provider, email, code_verifier, expires_at) VALUES ($1, $2, $3, $4, $5, $6)', [
    b64url(sha256(state)),
    userId,
    provider,
    email.toLowerCase(),
    verifier,
    new Date(Date.now() + STATE_TTL_MS),
  ]);
  const url = new URL(deps.endpoints(provider, app.tenant).authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', app.clientId);
  url.searchParams.set('redirect_uri', deps.redirectUri);
  url.searchParams.set('scope', SCOPES[provider].join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', b64url(sha256(verifier)));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('login_hint', email);
  for (const [k, v] of Object.entries(EXTRA[provider])) url.searchParams.set(k, v);
  return url.toString();
}

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

async function tokenRequest(deps: OAuthDeps, app: OAuthApp, params: Record<string, string>): Promise<TokenBody & { ok: boolean; status: number }> {
  let res: Response;
  try {
    res = await fetch(deps.endpoints(app.provider, app.tenant).tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...params }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new AppError({
      code: 'APP_MAIL_OAUTH_FAILED',
      message: `token endpoint of ${app.provider} did not answer`,
      userMessage: `Сервис входа ${PROVIDER_TITLES[app.provider]} не ответил.`,
      nextStep: 'Попробуйте ещё раз через минуту.',
      status: 502,
      cause: error,
    });
  }
  const body = (await res.json().catch(() => ({}))) as TokenBody;
  return { ...body, ok: res.ok && typeof body.access_token === 'string', status: res.status };
}

const expiresAt = (seconds: number | undefined) => (seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null);

// The service sent the person back: the code becomes tokens of the mailbox the person named before leaving.
export async function completeMailOAuth(deps: OAuthDeps, userId: string, input: { state: string; code: string }): Promise<{ provider: MailOAuthProvider; email: string; secret: SealedMailSecret }> {
  const { rows } = await deps.db.query<{ provider: MailOAuthProvider; email: string; code_verifier: string }>(
    'DELETE FROM app.mail_oauth_states WHERE state_hash = $1 AND user_id = $2 AND expires_at > now() RETURNING provider, email, code_verifier',
    [b64url(sha256(input.state)), userId],
  );
  const pending = rows[0];
  if (!pending) throw appError('APP_VALIDATION_FAILED', 'unknown, foreign or expired mail sign-in state', { userMessage: 'Ссылка входа устарела. Нажмите «Подключить почту» ещё раз.' });
  const app = await appOf(deps, pending.provider);
  const res = await tokenRequest(deps, app, { grant_type: 'authorization_code', code: input.code, redirect_uri: deps.redirectUri, code_verifier: pending.code_verifier });
  if (!res.ok) throw mailAuthFailed(pending.email, new Error(`token endpoint answered ${res.status}: ${res.error ?? 'no access_token'}`));
  return {
    provider: pending.provider,
    email: pending.email,
    secret: { kind: 'oauth', provider: pending.provider, accessToken: res.access_token!, refreshToken: res.refresh_token ?? null, expiresAt: expiresAt(res.expires_in) },
  };
}

const nearExpiry = (s: SealedMailSecret) => s.kind === 'oauth' && s.expiresAt !== null && new Date(s.expiresAt).getTime() - Date.now() < REFRESH_AHEAD_MS;

// The token of a mailbox, refreshed when it is about to expire. A refusal marks the mailbox «Ошибка доступа».
export async function freshMailSecret(deps: OAuthDeps, account: MailAccount): Promise<SealedMailSecret> {
  const secret = await loadSecret(deps.db, deps.box, account.id);
  if (!nearExpiry(secret)) return secret;
  return inTransaction(deps.db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('mail-oauth:' || $1))", [account.id]);
    const latest = await loadSecret(deps.db, deps.box, account.id);
    if (latest.kind !== 'oauth' || !nearExpiry(latest)) return latest;
    const refused = async (cause: Error) => {
      await setAccountStatus(deps.db, account.id, 'auth_error', 'APP_MAIL_AUTH_FAILED');
      return mailAuthFailed(account.email, cause);
    };
    if (!latest.refreshToken) throw await refused(new Error('no refresh token'));
    const res = await tokenRequest(deps, await appOf(deps, latest.provider), { grant_type: 'refresh_token', refresh_token: latest.refreshToken });
    if (!res.ok) throw await refused(new Error(`refresh answered ${res.status}: ${res.error ?? 'no access_token'}`));
    const next: SealedMailSecret = { ...latest, accessToken: res.access_token!, refreshToken: res.refresh_token ?? latest.refreshToken, expiresAt: expiresAt(res.expires_in) };
    await replaceSecret(deps.db, deps.box, account.id, next);
    return next;
  });
}
