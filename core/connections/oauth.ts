// OAuth 2.0 authorisation code with PKCE for personal connections (spec, section 8.8), our own code:
// tokens then go to the MCP server as headers. Many systems issue single-use refresh tokens, so a
// refresh runs under a lock per (employee, connection) and starts before the access token expires.
import { createHash, randomBytes } from 'node:crypto';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { inTransaction } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import type { McpDefinition } from '../plugins/public/index.ts';
import { loadCredential, saveCredential, setCredentialStatus, type StoredCredential } from './credentials.ts';
import { authFailed, notConnected, unavailable } from './errors.ts';

export type OAuthConfig = NonNullable<McpDefinition['oauth']>;

const STATE_TTL_MS = 10 * 60 * 1000;
export const REFRESH_AHEAD_MS = 5 * 60 * 1000;

export interface OAuthTarget {
  userId: string;
  connectorId: string;
  title: string;
  config: OAuthConfig;
  redirectUri: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const b64url = (b: Buffer) => b.toString('base64url');

export async function startOAuth(db: Db, t: OAuthTarget): Promise<string> {
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  await db.query('DELETE FROM app.oauth_states WHERE expires_at < now()');
  await db.query('INSERT INTO app.oauth_states (state_hash, user_id, connector_id, code_verifier, expires_at) VALUES ($1, $2, $3, $4, $5)', [
    b64url(sha256(state)),
    t.userId,
    t.connectorId,
    verifier,
    new Date(Date.now() + STATE_TTL_MS),
  ]);
  const url = new URL(t.config.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', t.config.clientId);
  url.searchParams.set('redirect_uri', t.redirectUri);
  url.searchParams.set('scope', t.config.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', b64url(sha256(verifier)));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

async function tokenRequest(t: OAuthTarget, params: Record<string, string>): Promise<{ ok: boolean; status: number; body: TokenResponse }> {
  let res: Response;
  try {
    res = await fetch(t.config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: t.config.clientId, client_secret: t.config.clientSecret, ...params }),
    });
  } catch (error) {
    throw unavailable(t.title, t.connectorId, error);
  }
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  return { ok: res.ok && typeof body.access_token === 'string', status: res.status, body };
}

function toCredential(body: TokenResponse, previousRefresh: string | null): StoredCredential {
  return {
    kind: 'oauth',
    accessToken: body.access_token!,
    refreshToken: body.refresh_token ?? previousRefresh,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null,
  };
}

export async function completeOAuth(db: Db, box: SecretBox, t: OAuthTarget, input: { state: string; code: string }): Promise<void> {
  const { rows } = await db.query<{ code_verifier: string }>(
    'DELETE FROM app.oauth_states WHERE state_hash = $1 AND user_id = $2 AND connector_id = $3 AND expires_at > now() RETURNING code_verifier',
    [b64url(sha256(input.state)), t.userId, t.connectorId],
  );
  if (!rows[0]) throw appError('APP_VALIDATION_FAILED', 'unknown, foreign or expired OAuth state', { userMessage: 'Ссылка входа устарела. Нажмите «Подключить» ещё раз.' });
  const res = await tokenRequest(t, { grant_type: 'authorization_code', code: input.code, redirect_uri: t.redirectUri, code_verifier: rows[0].code_verifier });
  if (!res.ok) throw authFailed(t.title, t.connectorId, new Error(`token endpoint answered ${res.status}: ${res.body.error ?? 'no access_token'}`));
  await saveCredential(db, box, { userId: t.userId, connectorId: t.connectorId, credential: toCredential(res.body, null), status: 'connected' });
}

function nearExpiry(c: StoredCredential): boolean {
  return c.kind === 'oauth' && c.expiresAt !== null && new Date(c.expiresAt).getTime() - Date.now() < REFRESH_AHEAD_MS;
}

export async function freshAccessToken(db: Db, box: SecretBox, t: Omit<OAuthTarget, 'redirectUri'>): Promise<string> {
  const record = await loadCredential(db, box, t.userId, t.connectorId, t.title);
  if (!record || record.credential.kind !== 'oauth') throw notConnected(t.title, t.connectorId);
  if (record.status === 'auth_error') throw authFailed(t.title, t.connectorId);
  if (!nearExpiry(record.credential)) return record.credential.accessToken;

  return inTransaction(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('oauth:' || $1 || ':' || $2))", [t.userId, t.connectorId]);
    // Another request may have refreshed while we waited for the lock.
    const latest = await loadCredential(db, box, t.userId, t.connectorId, t.title);
    if (!latest || latest.credential.kind !== 'oauth') throw notConnected(t.title, t.connectorId);
    if (!nearExpiry(latest.credential)) return latest.credential.accessToken;
    if (!latest.credential.refreshToken) {
      await setCredentialStatus(db, t.userId, t.connectorId, 'auth_error', 'APP_CONNECTOR_AUTH_FAILED');
      throw authFailed(t.title, t.connectorId);
    }
    const res = await tokenRequest({ ...t, redirectUri: '' }, { grant_type: 'refresh_token', refresh_token: latest.credential.refreshToken });
    if (!res.ok) {
      await setCredentialStatus(db, t.userId, t.connectorId, 'auth_error', 'APP_CONNECTOR_AUTH_FAILED');
      throw authFailed(t.title, t.connectorId, new Error(`refresh answered ${res.status}: ${res.body.error ?? 'no access_token'}`));
    }
    const next = toCredential(res.body, latest.credential.refreshToken);
    await saveCredential(db, box, { userId: t.userId, connectorId: t.connectorId, credential: next, status: 'connected' });
    return (next as { accessToken: string }).accessToken;
  });
}
