// The sign-in on the system's site for MCP servers by the MCP standard (docs/specs/[20.11.2026]-mcp-connections.md,
// sections 8 and 18, step 4): `auth()` of @modelcontextprotocol/client 2.4.0 does discovery, registration, PKCE,
// the exchange and the checks of the issuer; our provider keeps everything in the database:
// - the app of the installation is registered once per server — the admin's app, else the system's registration on
//   the fly, else (only on an installation opened by public https) the client document — sealed with the server;
// - tokens are each employee's own, sealed in app.connector_credentials and bound to their issuer;
// - a token is refreshed ahead of expiry under a lock per (employee, server): `auth()` refreshes only after a 401 and
//   without a lock, and many systems issue single-use refresh tokens;
// - a sign-in never starts in the middle of an agent's turn: there is nobody to press «войти».
// Plugins whose code names the sign-in addresses go the same way (`pluginTarget`; the owner's decision F4, 21.11).
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import {
  auth,
  RegistrationRejectedError,
  type FetchLike,
  type OAuthClientMetadata,
  type OAuthMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type pg from 'pg';
import type { SecretBox } from '../crypto/secret-box.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { isPublicAddress } from '../net/public-address.ts';
import type { McpDefinition } from '../plugins/public/index.ts';
import { loadCredential, saveCredential, setCredentialStatus, type StoredCredential } from './credentials.ts';
import { authFailed, notConnected, signInNotFinished, unavailable } from './errors.ts';
import { isNetworkFailure, safeCause } from './log-safe.ts';
import { signInChallenge } from './probe.ts';
import { loadOAuthServer, mcpConnectorId, saveServerClient, type OAuthServer } from './servers.ts';

// The one address the browser returns to from the sign-in of any MCP server (section 17).
export const MCP_CALLBACK_PATH = '/app/api/connections/oauth/callback';
// The client document of the installation (SEP-991): its address is the app's client_id.
export const MCP_CLIENT_DOCUMENT_PATH = '/app/api/connections/oauth/client.json';
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_AHEAD_MS = 5 * 60 * 1000;
const OAUTH_TIMEOUT_MS = 15_000;
const CLIENT_NAME = 'Бизнес-агент';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

type Queryable = Db | pg.PoolClient;

export interface McpAuthDeps {
  db: Db;
  box: SecretBox;
  publicUrl: string;
}

// `connect` — an employee turns a server on for themselves; `check` — the admin checks a server with their access.
export type SignInPurpose = 'connect' | 'check';

const b64url = (b: Buffer) => b.toString('base64url');
const stateHash = (state: string) => b64url(createHash('sha256').update(state).digest());
const timed: FetchLike = (url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(OAUTH_TIMEOUT_MS) });
const callbackUrl = (publicUrl: string) => new URL(MCP_CALLBACK_PATH, publicUrl).toString();

// Without https the code and the tokens would cross the network in the open; on this machine there is no network.
export function assertSignInPossible(publicUrl: string, title: string): void {
  const url = new URL(publicUrl);
  if (url.protocol === 'https:' || LOCAL_HOSTS.has(url.hostname)) return;
  throw appError('APP_MCP_OAUTH_NEEDS_HTTPS', `sign-in to ${title} needs an https installation`);
}

// The system downloads the client document itself, so only an installation it can reach by public https has one.
export function clientDocumentUrl(publicUrl: string): string | undefined {
  const url = new URL(publicUrl);
  const literal = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (url.protocol !== 'https:' || LOCAL_HOSTS.has(url.hostname) || (isIP(literal) !== 0 && !isPublicAddress(literal))) return undefined;
  return new URL(MCP_CLIENT_DOCUMENT_PATH, publicUrl).toString();
}

function clientMetadataOf(publicUrl: string): OAuthClientMetadata {
  return { client_name: CLIENT_NAME, redirect_uris: [callbackUrl(publicUrl)], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
}

// The client document: a public client (PKCE, no secret) whose client_id is the document's own address.
export function clientDocument(publicUrl: string): Record<string, unknown> | null {
  const address = clientDocumentUrl(publicUrl);
  return address ? { client_id: address, ...clientMetadataOf(publicUrl), token_endpoint_auth_method: 'none' } : null;
}

interface ProviderParts {
  publicUrl: string;
  state?: string;
  client(): Promise<StoredOAuthClientInformation | undefined>;
  saveClient(info: StoredOAuthClientInformation): Promise<void>;
  tokens(): StoredOAuthTokens | undefined;
  saveTokens(tokens: StoredOAuthTokens): Promise<void>;
  discovery: OAuthDiscoveryState | undefined;
  codeVerifier: string | undefined;
}

// What `auth()` handed over instead of doing it: the page of the sign-in, the PKCE verifier, where the addresses are.
interface Captured {
  authorizationUrl?: URL;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
  tokensGone: boolean;
}

function providerOf(parts: ProviderParts, captured: Captured): OAuthClientProvider {
  const documentUrl = clientDocumentUrl(parts.publicUrl);
  return {
    get redirectUrl() {
      return callbackUrl(parts.publicUrl);
    },
    ...(documentUrl ? { clientMetadataUrl: documentUrl } : {}),
    get clientMetadata() {
      return clientMetadataOf(parts.publicUrl);
    },
    ...(parts.state ? { state: () => parts.state! } : {}),
    clientInformation: () => parts.client(),
    saveClientInformation: (info) => parts.saveClient(info),
    tokens: () => (captured.tokensGone ? undefined : parts.tokens()),
    saveTokens: (tokens) => parts.saveTokens(tokens),
    // Only remembered: the browser is sent there by whoever started the sign-in, never during a turn.
    redirectToAuthorization: (url) => {
      captured.authorizationUrl = url;
    },
    saveCodeVerifier: (verifier) => {
      captured.codeVerifier = verifier;
    },
    codeVerifier: () => {
      if (!parts.codeVerifier) throw appError('APP_INTERNAL', 'the sign-in has no PKCE verifier');
      return parts.codeVerifier;
    },
    discoveryState: () => captured.discovery ?? parts.discovery,
    saveDiscoveryState: (state) => {
      captured.discovery = state;
    },
    // A refused refresh token is forgotten for this attempt; the stored record is marked by the caller.
    invalidateCredentials: (scope) => {
      if (scope === 'tokens' || scope === 'all') captured.tokensGone = true;
    },
  };
}

function credentialOf(tokens: StoredOAuthTokens, discovery: OAuthDiscoveryState | undefined, previousRefresh: string | null): StoredCredential {
  return {
    kind: 'oauth',
    accessToken: tokens.access_token,
    // A system that does not rotate refresh tokens keeps the old one valid.
    refreshToken: tokens.refresh_token ?? previousRefresh,
    expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
    ...(tokens.issuer ? { issuer: tokens.issuer } : {}),
    ...(discovery ? { discovery } : {}),
  };
}

// Whom a sign-in is for: an MCP server the admin added, or the system of a plugin, whose sign-in addresses its code
// names (`McpDefinition.oauth`; the owner's decision F4, 21.11: one sign-in for both).
export interface SignInTarget {
  connectorId: string;
  title: string;
  serverUrl: string;
  // The app of the installation at the system; at a start it is read under the start's lock (`db` — its transaction).
  client(db: Queryable): Promise<StoredOAuthClientInformation | undefined>;
  // Keeps the app registered on the fly or bound to its issuer; a plugin's app lives in its code.
  saveClient(db: pg.PoolClient, info: StoredOAuthClientInformation): Promise<void>;
  // Sign-in addresses known in advance: the standard discovery is skipped.
  knownDiscovery?: OAuthDiscoveryState;
  scope?: string;
  // What «Подключить» means besides the tokens.
  afterConnect?(userId: string): Promise<void>;
}

export type PluginOAuth = NonNullable<McpDefinition['oauth']>;

export function mcpTarget(deps: McpAuthDeps, server: OAuthServer): SignInTarget {
  return {
    connectorId: mcpConnectorId(server.id),
    title: server.title,
    serverUrl: server.url,
    client: async (db) => (await loadOAuthServer(db, deps.box, server.id)).client,
    saveClient: (db, info) => saveServerClient(db, deps.box, server.id, info),
    // «Подключить» is how an employee turns a server on for themselves (the owner's decision F2, 21.11).
    afterConnect: async (userId) => {
      await deps.db.query('INSERT INTO app.mcp_server_users (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [server.id, userId]);
    },
  };
}

// A plugin names its addresses and its app; the client secret goes in the body, as plugins expect. The issuer of a
// plugin's system is not known in advance, so `iss` of its answer is not compared (it was not before F4 either).
export function pluginTarget(connector: { id: string; title: string; url: string; oauth: PluginOAuth }): SignInTarget {
  const { oauth } = connector;
  const authorizationServerUrl = new URL(oauth.tokenUrl).origin;
  const metadata = {
    authorization_endpoint: oauth.authorizeUrl,
    token_endpoint: oauth.tokenUrl,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
  };
  return {
    connectorId: connector.id,
    title: connector.title,
    serverUrl: connector.url,
    client: () => Promise.resolve({ client_id: oauth.clientId, client_secret: oauth.clientSecret }),
    saveClient: () => Promise.resolve(),
    // Without `issuer` the library binds tokens to the sign-in address and skips the `iss` comparison.
    knownDiscovery: { authorizationServerUrl, authorizationServerMetadata: metadata as unknown as OAuthMetadata },
    scope: oauth.scopes.join(' '),
  };
}

// The library has no error class for «the system registers no apps on the fly», only this text.
const NO_REGISTRATION = /does not support dynamic client registration/;

function startFailure(target: SignInTarget, publicUrl: string, error: unknown): AppError {
  const facts = { connectorId: target.connectorId };
  if (error instanceof RegistrationRejectedError || (error instanceof Error && NO_REGISTRATION.test(error.message))) {
    return appError('APP_MCP_OAUTH_REGISTRATION', `${target.title}: the app could not be registered`, {
      cause: safeCause(error),
      details: facts,
      userMessage: `Система не разрешает подключать сторонние программы автоматически. Заведите приложение в настройках системы и введите Client ID и Client Secret в «Дополнительно»; адрес возврата — ${callbackUrl(publicUrl)}.`,
    });
  }
  if (isNetworkFailure(error)) return appError('APP_MCP_UNREACHABLE', `${target.title}: the sign-in addresses do not answer`, { cause: safeCause(error), details: facts });
  return new AppError({
    code: 'APP_CONNECTOR_AUTH_FAILED',
    message: `${target.title}: the sign-in could not start`,
    userMessage: `Не удалось начать вход в ${target.title}: система отвечает не так, как требует стандарт MCP. Сообщите администратору код ошибки.`,
    status: 502,
    details: facts,
    cause: safeCause(error),
  });
}

// The address of the system's sign-in page for this person.
export async function startSignIn(deps: McpAuthDeps, target: SignInTarget, input: { userId: string; purpose: SignInPurpose }): Promise<string> {
  assertSignInPossible(deps.publicUrl, target.title);
  // Asked before the lock: the server may take seconds to answer.
  const resourceMetadataUrl = target.knownDiscovery ? undefined : await signInChallenge(new URL(target.serverUrl));
  const state = b64url(randomBytes(32));
  const captured: Captured = { tokensGone: false };
  // One registration per server: the sign-ins of two people started at once wait for each other here.
  await inTransaction(deps.db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('oauth-client:' || $1))", [target.connectorId]);
    const provider = providerOf(
      {
        publicUrl: deps.publicUrl,
        state,
        client: () => target.client(client),
        saveClient: (info) => target.saveClient(client, info),
        // A sign-in always asks the person: an old token is not quietly refreshed instead.
        tokens: () => undefined,
        saveTokens: () => Promise.reject(appError('APP_INTERNAL', 'tokens before an authorization code')),
        discovery: target.knownDiscovery,
        codeVerifier: undefined,
      },
      captured,
    );
    let result: Awaited<ReturnType<typeof auth>>;
    try {
      result = await auth(provider, { serverUrl: target.serverUrl, ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(target.scope ? { scope: target.scope } : {}), fetchFn: timed });
    } catch (error) {
      throw startFailure(target, deps.publicUrl, error);
    }
    if (result !== 'REDIRECT' || !captured.authorizationUrl || !captured.codeVerifier) throw appError('APP_INTERNAL', `${target.title}: the sign-in gave no page to go to`);
  });
  await deps.db.query('DELETE FROM app.oauth_states WHERE expires_at < now()');
  await deps.db.query(
    'INSERT INTO app.oauth_states (state_hash, user_id, connector_id, code_verifier, discovery_state, purpose, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [stateHash(state), input.userId, target.connectorId, captured.codeVerifier, JSON.stringify(captured.discovery ?? target.knownDiscovery ?? null), input.purpose, new Date(Date.now() + STATE_TTL_MS)],
  );
  return captured.authorizationUrl!.toString();
}

// «Подключить» / «Проверить своим доступом» for a server the admin added.
export async function startMcpSignIn(deps: McpAuthDeps, input: { userId: string; serverId: string; purpose: SignInPurpose }): Promise<string> {
  const server = await loadOAuthServer(deps.db, deps.box, input.serverId);
  if (input.purpose === 'connect' && server.status !== 'enabled') {
    throw appError('APP_NOT_FOUND', `mcp server ${server.id} is not turned on`, { userMessage: 'Это подключение сейчас недоступно. Обновите страницу.' });
  }
  return startSignIn(deps, mcpTarget(deps, server), input);
}

// The browser is back with the code: the tokens are this person's, the issuer is the one the sign-in started with.
// `targetOf` finds whom the sign-in was for by its connector. A failure carries `details.connectorId` and
// `details.purpose` when they are known, for the page to return to.
export async function completeSignIn(
  deps: McpAuthDeps,
  input: { userId: string; state: string; code: string; iss: string | undefined },
  targetOf: (connectorId: string) => Promise<SignInTarget>,
): Promise<{ connectorId: string; purpose: SignInPurpose }> {
  const { rows } = await deps.db.query<{ connector_id: string; code_verifier: string; discovery_state: OAuthDiscoveryState | null; purpose: SignInPurpose }>(
    `DELETE FROM app.oauth_states WHERE state_hash = $1 AND user_id = $2 AND purpose IS NOT NULL AND expires_at > now()
     RETURNING connector_id, code_verifier, discovery_state, purpose`,
    [stateHash(input.state), input.userId],
  );
  const started = rows[0];
  if (!started) throw signInNotFinished('систему', {});
  const facts = { connectorId: started.connector_id, purpose: started.purpose };
  const target = await targetOf(started.connector_id);
  const captured: Captured = { tokensGone: false };
  let saved = false;
  const provider = providerOf(
    {
      publicUrl: deps.publicUrl,
      client: () => target.client(deps.db),
      saveClient: (info) => inTransaction(deps.db, (client) => target.saveClient(client, info)),
      tokens: () => undefined,
      saveTokens: async (tokens) => {
        const credential = credentialOf(tokens, captured.discovery ?? started.discovery_state ?? undefined, null);
        await saveCredential(deps.db, deps.box, { userId: input.userId, connectorId: started.connector_id, credential, status: 'connected' });
        saved = true;
      },
      discovery: started.discovery_state ?? undefined,
      codeVerifier: started.code_verifier,
    },
    captured,
  );
  try {
    await auth(provider, { serverUrl: target.serverUrl, authorizationCode: input.code, iss: input.iss, fetchFn: timed });
  } catch (error) {
    if (isNetworkFailure(error)) throw appError('APP_MCP_UNREACHABLE', `${target.title}: the token address does not answer`, { cause: safeCause(error), details: facts });
    throw signInNotFinished(target.title, facts, safeCause(error));
  }
  if (!saved) throw appError('APP_INTERNAL', `${target.title}: the sign-in ended without tokens`, { details: facts });
  if (started.purpose === 'connect') await target.afterConnect?.(input.userId);
  return facts;
}

function nearExpiry(credential: StoredCredential): boolean {
  return credential.kind === 'oauth' && credential.expiresAt !== null && new Date(credential.expiresAt).getTime() - Date.now() < REFRESH_AHEAD_MS;
}

// The access token of an employee for a call to the system, refreshed ahead of expiry. A token that cannot be
// refreshed marks the connection «Ошибка доступа» instead of starting a sign-in (section 8).
export async function accessToken(deps: McpAuthDeps, target: SignInTarget, userId: string): Promise<string> {
  const { connectorId, title } = target;
  const record = await loadCredential(deps.db, deps.box, userId, connectorId, title);
  if (record?.credential.kind !== 'oauth') throw notConnected(title, connectorId);
  if (record.status === 'auth_error') throw authFailed(title, connectorId);
  if (!nearExpiry(record.credential)) return record.credential.accessToken;

  return inTransaction(deps.db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('oauth:' || $1 || ':' || $2))", [userId, connectorId]);
    // Another request may have refreshed while this one waited for the lock.
    const latest = await loadCredential(deps.db, deps.box, userId, connectorId, title);
    if (latest?.credential.kind !== 'oauth') throw notConnected(title, connectorId);
    if (latest.status === 'auth_error') throw authFailed(title, connectorId);
    const credential = latest.credential;
    if (!nearExpiry(credential)) return credential.accessToken;

    const captured: Captured = { tokensGone: false };
    const fresh: { token?: string } = {};
    const discovery = credential.discovery ?? target.knownDiscovery;
    const provider = providerOf(
      {
        publicUrl: deps.publicUrl,
        client: () => target.client(deps.db),
        saveClient: (info) => inTransaction(deps.db, (c) => target.saveClient(c, info)),
        tokens: () =>
          credential.refreshToken ? { access_token: credential.accessToken, token_type: 'Bearer', refresh_token: credential.refreshToken, ...(credential.issuer ? { issuer: credential.issuer } : {}) } : undefined,
        saveTokens: async (tokens) => {
          const next = credentialOf(tokens, captured.discovery ?? discovery, credential.refreshToken);
          await saveCredential(deps.db, deps.box, { userId, connectorId, credential: next, status: 'connected' });
          fresh.token = tokens.access_token;
        },
        discovery,
        codeVerifier: undefined,
      },
      captured,
    );
    let result: Awaited<ReturnType<typeof auth>>;
    try {
      result = await auth(provider, { serverUrl: target.serverUrl, fetchFn: timed });
    } catch (error) {
      if (isNetworkFailure(error)) throw unavailable(title, connectorId, safeCause(error));
      await setCredentialStatus(deps.db, userId, connectorId, 'auth_error', 'APP_CONNECTOR_AUTH_FAILED');
      throw authFailed(title, connectorId, safeCause(error));
    }
    // A refresh that did not work ends in a new sign-in page — and nobody is there to open it.
    if (result !== 'AUTHORIZED' || !fresh.token) {
      await setCredentialStatus(deps.db, userId, connectorId, 'auth_error', 'APP_CONNECTOR_AUTH_FAILED');
      throw authFailed(title, connectorId);
    }
    return fresh.token;
  });
}

export async function mcpAccessToken(deps: McpAuthDeps, input: { userId: string; serverId: string }): Promise<string> {
  return accessToken(deps, mcpTarget(deps, await loadOAuthServer(deps.db, deps.box, input.serverId)), input.userId);
}
