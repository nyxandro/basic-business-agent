// Login to a ChatGPT account by a device code (spec, section 8.1, V22): the protocol of OpenAI's
// Codex CLI, the same LiteLLM v1.109.1 uses (litellm/llms/chatgpt/authenticator.py). The person
// opens OpenAI's page, enters the code there, and the server exchanges the result for the tokens.
// The server only asks; the person's page polls it every `interval` seconds, so no timer runs here.
import { appError } from '../errors/catalog.ts';

export const OPENAI_AUTH_BASE = 'https://auth.openai.com';
// The public client of the Codex CLI, which LiteLLM also uses for ChatGPT subscriptions.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REQUEST_TIMEOUT_MS = 15_000;
// RFC 8628: without an interval in the answer the client polls every 5 seconds.
const DEFAULT_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 60;
const AUTH_CLAIM = 'https://api.openai.com/auth';

export interface DeviceCode {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
}

// LiteLLM's login file of one account (chatgpt_auth_file of its deployments).
export interface ChatGptAuthFile {
  access_token: string;
  refresh_token: string;
  id_token: string;
  // Seconds since 1970 when the access token expires; LiteLLM refreshes it a minute before.
  expires_at: number;
  account_id: string | null;
}

export interface ChatGptIdentity {
  email: string;
  // The workspace of the subscription (personal or a team's).
  chatgptAccountId: string | null;
}

export interface ChatGptAuthClient {
  // Where the person enters the code.
  verifyUrl: string;
  requestDeviceCode(): Promise<DeviceCode>;
  // null — the person has not entered the code yet.
  poll(code: Pick<DeviceCode, 'deviceAuthId' | 'userCode'>): Promise<ChatGptAuthFile | null>;
}

const failed = (message: string, cause?: unknown) => appError('APP_CHATGPT_LOGIN_FAILED', message, cause === undefined ? {} : { cause });

export function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw failed('ChatGPT token is not a JWT');
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof claims !== 'object' || claims === null) throw new Error('claims are not an object');
    return claims as Record<string, unknown>;
  } catch (error) {
    throw failed('ChatGPT token has unreadable claims', error);
  }
}

function chatgptAccountIdOf(idToken: string): string | null {
  const auth = jwtClaims(idToken)[AUTH_CLAIM];
  const id = typeof auth === 'object' && auth !== null ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
  return typeof id === 'string' && id ? id : null;
}

export function identityOf(file: ChatGptAuthFile): ChatGptIdentity {
  const email = jwtClaims(file.id_token).email;
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email)) throw failed('ChatGPT id_token has no email claim');
  return { email, chatgptAccountId: file.account_id };
}

// The login file as LiteLLM builds it after a login or a refresh (_build_auth_record).
export function authFileOf(tokens: { access_token: string; refresh_token: string; id_token: string }): ChatGptAuthFile {
  const exp = jwtClaims(tokens.access_token).exp;
  if (typeof exp !== 'number') throw failed('ChatGPT access token has no exp claim');
  return { ...tokens, expires_at: exp, account_id: chatgptAccountIdOf(tokens.id_token) };
}

function str(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === 'string' && v ? v : null;
}

export function createChatGptAuthClient(authBase: string): ChatGptAuthClient {
  async function post(path: string, init: { json?: unknown; form?: Record<string, string> }): Promise<Response> {
    try {
      return await fetch(`${authBase}${path}`, {
        method: 'POST',
        headers: { 'content-type': init.form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: init.form ? new URLSearchParams(init.form).toString() : JSON.stringify(init.json),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw failed(`OpenAI auth ${path} did not answer`, error);
    }
  }

  async function json(res: Response, what: string): Promise<Record<string, unknown>> {
    if (!res.ok) throw failed(`OpenAI ${what} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data: unknown = await res.json().catch((error: unknown) => {
      throw failed(`OpenAI ${what} answered with no JSON`, error);
    });
    if (typeof data !== 'object' || data === null) throw failed(`OpenAI ${what} answered with no object`);
    return data as Record<string, unknown>;
  }

  return {
    verifyUrl: `${authBase}/codex/device`,

    async requestDeviceCode() {
      const data = await json(await post('/api/accounts/deviceauth/usercode', { json: { client_id: CLIENT_ID } }), 'device code');
      const deviceAuthId = str(data, 'device_auth_id');
      const userCode = str(data, 'user_code') ?? str(data, 'usercode');
      if (!deviceAuthId || !userCode) throw failed(`OpenAI device code answer misses fields: ${Object.keys(data).join(', ')}`);
      const interval = Number(data.interval ?? DEFAULT_INTERVAL_SECONDS);
      const intervalSeconds = Number.isFinite(interval) ? Math.min(Math.max(Math.ceil(interval), 1), MAX_INTERVAL_SECONDS) : DEFAULT_INTERVAL_SECONDS;
      return { deviceAuthId, userCode, intervalSeconds };
    },

    async poll({ deviceAuthId, userCode }) {
      const res = await post('/api/accounts/deviceauth/token', { json: { device_auth_id: deviceAuthId, user_code: userCode } });
      // OpenAI answers 403 or 404 while the person has not entered the code.
      if (res.status === 403 || res.status === 404) return null;
      const grant = await json(res, 'device token');
      const code = str(grant, 'authorization_code');
      const verifier = str(grant, 'code_verifier');
      if (!code || !verifier) throw failed('OpenAI device token answer misses the authorization code');
      const tokens = await json(
        await post('/oauth/token', {
          form: { grant_type: 'authorization_code', code, redirect_uri: `${authBase}/deviceauth/callback`, client_id: CLIENT_ID, code_verifier: verifier },
        }),
        'token exchange',
      );
      const access = str(tokens, 'access_token');
      const refresh = str(tokens, 'refresh_token');
      const id = str(tokens, 'id_token');
      if (!access || !refresh || !id) throw failed('OpenAI token exchange answer misses tokens');
      return authFileOf({ access_token: access, refresh_token: refresh, id_token: id });
    },
  };
}
