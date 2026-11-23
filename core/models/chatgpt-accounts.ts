// The pool of ChatGPT subscription accounts (spec, scenario 9, section 8.1). The admin connects an
// account by a device code; its tokens are kept encrypted in app.chatgpt_accounts, and the working
// copy is the file <authDir>/<account>.json in the volume shared with LiteLLM, which refreshes the
// token in it. Each subscription model gets a deployment per active account (gateway-sync.ts).
// Changes of LiteLLM go first and our database second, through the queue of the gateway writer.
import { randomBytes } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatGptAccountDto, ChatGptLoginDto, ChatGptLoginStatus } from '@bba/contracts';
import { z } from 'zod';
import { writeAudit } from '../audit/audit.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { logEvent } from '../log/log.ts';
import type { AccountFailure } from './account-events.ts';
import { identityOf, jwtClaims, type ChatGptAuthClient, type ChatGptAuthFile } from './chatgpt-login.ts';
import type { GatewayWriter } from './gateway-writer.ts';
import { COOLDOWN_SECONDS } from './litellm-config.ts';

// OpenAI keeps a device code for 15 minutes.
const LOGIN_TTL_MINUTES = 15;
// What the access errors of an account look like: LiteLLM turns a refused or failed token refresh
// into 401 (GetAccessTokenError), and ChatGPT answers 401 to a revoked token. A 403 (e.g. a
// country ChatGPT does not serve) is not cured by a new login, so it does not count.
// A refresh that failed for a moment (OpenAI's 5xx, a broken connection) also comes as 401, so
// the account leaves LiteLLM only when a second 401 comes after its cooldown with no success in
// between: LiteLLM has tried to refresh the token again meanwhile.
const ACCESS_ERROR = 401;
// While a poll asks OpenAI (two requests of up to 15 s and the gateway queue), nobody else asks.
const POLL_BUSY_SECONDS = 90;
// LiteLLM rewrites a login file in place (empty first, then written): a file read empty or broken
// is read once more before the server replaces it.
const REREAD_DELAY_MS = 500;
const SUCCESS_WINDOW_DAYS = 30;
// A login file of an account, or a temporary one left by a write that did not finish.
const AUTH_FILE_NAME = /^(a-[0-9a-f]{8})\.json(\.[0-9a-f]{8}\.tmp)?$/;

const authFileSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1),
  // LiteLLM writes null when the access token carries no exp; then the token's own claim counts.
  expires_at: z.number().nullable(),
  account_id: z.string().nullable(),
});

// What an error says in a log without its text: a JSON error quotes a piece of the file (a token).
// A login file of LiteLLM from its text; expires_at always set (from the access token if need be).
function parseAuth(text: string): ChatGptAuthFile {
  const file = authFileSchema.parse(JSON.parse(text));
  const exp = file.expires_at ?? jwtClaims(file.access_token).exp;
  if (typeof exp !== 'number') throw new Error('login file without an expiry');
  return { ...file, expires_at: exp };
}

function errorKind(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: typeof error };
  const code = (error as { code?: unknown }).code;
  return { name: error.name, ...(typeof code === 'string' ? { code } : {}) };
}

export interface ChatGptAccountsDeps {
  db: Db;
  box: SecretBox;
  writer: GatewayWriter;
  auth: ChatGptAuthClient;
  // Where the server writes the login files (APP_CHATGPT_AUTH_DIR); LiteLLM sees them in GATEWAY_AUTH_DIR.
  authDir: string;
  timezone: string;
}

export interface ChatGptAccounts {
  list(): Promise<ChatGptAccountDto[]>;
  startLogin(actorUserId: string, accountId: string | null): Promise<ChatGptLoginDto>;
  // Asked by the admin's page every `intervalSeconds`; a login is never polled by a timer here.
  pollLogin(actorUserId: string, loginId: string): Promise<ChatGptLoginStatus>;
  disconnect(actorUserId: string, accountId: string): Promise<void>;
  // LiteLLM reported a failed attempt of an account; a confirmed access error takes it out of LiteLLM.
  attemptFailed(failure: Pick<AccountFailure, 'accountId' | 'status' | 'at'>): Promise<void>;
  // At the start, before the copy into LiteLLM: every account's file in place, with the fresher token.
  prepare(): Promise<void>;
}

interface AccountRow {
  id: string;
  email: string;
  chatgpt_account_id: string | null;
  auth_ciphertext: Buffer;
  auth_iv: Buffer;
  auth_key_version: number;
  auth_updated_at: Date;
  status: 'active' | 'auth_error';
  connected_at: Date;
}

interface LoginRow {
  id: string;
  device_ciphertext: Buffer;
  device_iv: Buffer;
  device_key_version: number;
  user_code: string;
  account_id: string | null;
  expires_at: Date;
  expired: boolean;
}

interface StateRow {
  id: string;
  email: string;
  status: 'active' | 'auth_error';
  connected_at: Date;
  last_success_at: Date | null;
  tokens_today: string;
  failure_status: number | null;
  failure_at: Date | null;
  cooldown_until: Date | null;
}

const newId = (prefix: string) => `${prefix}-${randomBytes(4).toString('hex')}`;
const invalid = (message: string, userMessage: string) => appError('APP_VALIDATION_FAILED', message, { userMessage });
const notFound = (message: string, userMessage: string) => appError('APP_NOT_FOUND', message, { userMessage });

function stateOf(r: StateRow, now: Date): ChatGptAccountDto {
  const base = { id: r.id, email: r.email, connectedAt: r.connected_at.toISOString(), lastSuccessAt: r.last_success_at?.toISOString() ?? null, tokensToday: Number(r.tokens_today) };
  if (r.status === 'auth_error') return { ...base, state: 'auth_error', failureStatus: r.failure_status, cooldownUntil: null };
  // A success after the failure means LiteLLM did not skip the account.
  const failedLast = r.failure_at !== null && (r.last_success_at === null || r.failure_at > r.last_success_at);
  if (failedLast && r.cooldown_until && r.cooldown_until > now) return { ...base, state: 'cooldown', failureStatus: r.failure_status, cooldownUntil: r.cooldown_until.toISOString() };
  return { ...base, state: r.last_success_at ? 'works' : 'no_requests', failureStatus: null, cooldownUntil: null };
}

export function createChatGptAccounts(deps: ChatGptAccountsDeps): ChatGptAccounts {
  const { db, box, writer, auth } = deps;
  const fileOf = (accountId: string) => join(deps.authDir, `${accountId}.json`);

  // Atomically: LiteLLM never reads half a file.
  async function writeAuthFile(accountId: string, file: ChatGptAuthFile): Promise<void> {
    const path = fileOf(accountId);
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
    await rename(tmp, path);
  }

  // The file as it is, 'missing', or 'broken' (unreadable JSON or fields).
  async function readOnce(accountId: string): Promise<ChatGptAuthFile | 'missing' | 'broken'> {
    let text: string;
    try {
      text = await readFile(fileOf(accountId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
    try {
      return parseAuth(text);
    } catch {
      return 'broken';
    }
  }

  async function readAuthFile(accountId: string): Promise<ChatGptAuthFile | null> {
    let file = await readOnce(accountId);
    if (file === 'broken') {
      await new Promise((r) => setTimeout(r, REREAD_DELAY_MS));
      file = await readOnce(accountId);
    }
    if (file === 'broken') logEvent('warn', 'chatgpt_auth_file_invalid', { accountId });
    return typeof file === 'string' ? null : file;
  }

  function openAuth(r: AccountRow): ChatGptAuthFile {
    return parseAuth(box.open({ ciphertext: r.auth_ciphertext, iv: r.auth_iv, keyVersion: r.auth_key_version }));
  }

  async function accountRow(accountId: string): Promise<AccountRow | undefined> {
    const { rows } = await db.query<AccountRow>('SELECT * FROM app.chatgpt_accounts WHERE id = $1', [accountId]);
    return rows[0];
  }

  async function list(): Promise<ChatGptAccountDto[]> {
    const { rows } = await db.query<StateRow>(
      `SELECT a.id, a.email, a.status, a.connected_at,
              (SELECT max(u.at) FROM app.usage_events u
                WHERE u.is_subscription AND split_part(u.deployment, ':', 2) = a.id AND u.at >= now() - make_interval(days => $2)) AS last_success_at,
              (SELECT coalesce(sum(u.input_tokens + u.output_tokens), 0) FROM app.usage_events u
                WHERE u.is_subscription AND split_part(u.deployment, ':', 2) = a.id
                  AND u.at >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)) AS tokens_today,
              e.status AS failure_status, e.at AS failure_at, e.cooldown_until
         FROM app.chatgpt_accounts a
         LEFT JOIN LATERAL (SELECT status, at, cooldown_until FROM app.account_events WHERE account_id = a.id ORDER BY at DESC, id DESC LIMIT 1) e ON true
        ORDER BY a.connected_at, a.id`,
      [deps.timezone, SUCCESS_WINDOW_DAYS],
    );
    const now = new Date();
    return rows.map((r) => stateOf(r, now));
  }

  async function dtoOf(accountId: string): Promise<ChatGptAccountDto> {
    const found = (await list()).find((a) => a.id === accountId);
    if (!found) throw new Error(`account ${accountId} vanished right after it was saved`);
    return found;
  }

  // A login ended: who it is decides between a new account and «Войти заново» of the one asked for.
  async function complete(actorUserId: string, login: LoginRow, file: ChatGptAuthFile): Promise<ChatGptAccountDto> {
    const who = identityOf(file);
    return writer.serial(async () => {
      const { rows: same } = await db.query<AccountRow>('SELECT * FROM app.chatgpt_accounts WHERE lower(email) = lower($1) AND chatgpt_account_id IS NOT DISTINCT FROM $2', [
        who.email,
        who.chatgptAccountId,
      ]);
      let accountId: string;
      if (login.account_id) {
        const target = await accountRow(login.account_id);
        if (!target) throw notFound(`account ${login.account_id} is gone`, 'Аккаунт уже отключён. Подключите его заново.');
        if (same[0]?.id !== target.id) {
          throw invalid(`re-login of ${login.account_id} came as another account`, `Вы вошли в ${who.email}, а входили заново в ${target.email}. Войдите в нужный аккаунт.`);
        }
        accountId = target.id;
      } else {
        if (same[0]) throw invalid(`account ${same[0].id} is already connected`, `Этот аккаунт уже подключён: ${same[0].email}.`);
        accountId = newId('a');
      }
      await writeAuthFile(accountId, file);
      try {
        await save();
      } catch (error) {
        // A new account that was not saved leaves neither deployments in LiteLLM nor tokens in the
        // volume; a new login of an existing one keeps the fresher file for the next start.
        if (!login.account_id) {
          await writer.apply(await writer.state()).catch((cleanup: unknown) => logEvent('error', 'gateway_sync_failed', { code: 'APP_GATEWAY_SYNC_FAILED', accountId, error: cleanup }));
          await rm(fileOf(accountId), { force: true });
        }
        throw error;
      }
      return dtoOf(accountId);

      async function save(): Promise<void> {
        const state = await writer.state();
        await writer.apply({ ...state, accounts: state.accounts.some((a) => a.id === accountId) ? state.accounts : [...state.accounts, { id: accountId }] });
        const sealed = box.seal(JSON.stringify(file));
        await inTransaction(db, async (c) => {
          if (login.account_id) {
            await c.query("UPDATE app.chatgpt_accounts SET auth_ciphertext = $2, auth_iv = $3, auth_key_version = $4, auth_updated_at = now(), status = 'active' WHERE id = $1", [
              accountId,
              sealed.ciphertext,
              sealed.iv,
              sealed.keyVersion,
            ]);
          } else {
            await c.query(
              'INSERT INTO app.chatgpt_accounts (id, email, chatgpt_account_id, auth_ciphertext, auth_iv, auth_key_version, connected_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
              [accountId, who.email, who.chatgptAccountId, sealed.ciphertext, sealed.iv, sealed.keyVersion, actorUserId],
            );
          }
          await writeAudit(c, { actorUserId, action: login.account_id ? 'chatgpt.relogin' : 'chatgpt.connect', target: accountId, details: { email: who.email } });
        });
      }
    });
  }

  async function dropLogin(loginId: string): Promise<void> {
    await db.query('DELETE FROM app.chatgpt_logins WHERE id = $1', [loginId]);
  }

  return {
    list,

    async startLogin(actorUserId, accountId) {
      if (accountId !== null && !(await accountRow(accountId))) throw notFound(`account ${accountId}`, 'Аккаунт не найден. Обновите страницу.');
      // Logins nobody finished are cleaned here, not by a timer.
      await db.query('DELETE FROM app.chatgpt_logins WHERE expires_at < now()');
      const code = await auth.requestDeviceCode();
      const sealed = box.seal(code.deviceAuthId);
      const id = newId('l');
      const { rows } = await db.query<{ expires_at: Date }>(
        `INSERT INTO app.chatgpt_logins (id, device_ciphertext, device_iv, device_key_version, user_code, interval_seconds, account_id, expires_at, started_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8), $9) RETURNING expires_at`,
        [id, sealed.ciphertext, sealed.iv, sealed.keyVersion, code.userCode, code.intervalSeconds, accountId, LOGIN_TTL_MINUTES, actorUserId],
      );
      return {
        id,
        userCode: code.userCode,
        verifyUrl: auth.verifyUrl,
        expiresAt: rows[0]!.expires_at.toISOString(),
        expiresInSeconds: LOGIN_TTL_MINUTES * 60,
        intervalSeconds: code.intervalSeconds,
      };
    },

    async pollLogin(actorUserId, loginId) {
      // One question to OpenAI per interval, whoever asks (two tabs of the admin ask twice as often);
      // the login is taken for the time of the question and given back when OpenAI says «not yet».
      const { rows: due } = await db.query<LoginRow>(
        `UPDATE app.chatgpt_logins SET polled_at = now() + make_interval(secs => $2)
          WHERE id = $1 AND (polled_at IS NULL OR polled_at <= now() - make_interval(secs => interval_seconds))
          RETURNING *, expires_at <= now() AS expired`,
        [loginId, POLL_BUSY_SECONDS],
      );
      const login = due[0] ?? (await db.query<LoginRow>('SELECT *, expires_at <= now() AS expired FROM app.chatgpt_logins WHERE id = $1', [loginId])).rows[0];
      if (!login) throw notFound(`login ${loginId}`, 'Вход не найден: он уже завершился или истёк. Начните заново.');
      if (login.expired) {
        await dropLogin(loginId);
        throw appError('APP_CHATGPT_LOGIN_EXPIRED', `login ${loginId} expired`);
      }
      if (!due[0]) return { status: 'pending', expiresAt: login.expires_at.toISOString() };
      const deviceAuthId = box.open({ ciphertext: login.device_ciphertext, iv: login.device_iv, keyVersion: login.device_key_version });
      let file: ChatGptAuthFile | null;
      try {
        file = await auth.poll({ deviceAuthId, userCode: login.user_code });
      } catch (error) {
        await dropLogin(loginId);
        throw error;
      }
      if (!file) {
        await db.query('UPDATE app.chatgpt_logins SET polled_at = now() WHERE id = $1', [loginId]);
        return { status: 'pending', expiresAt: login.expires_at.toISOString() };
      }
      try {
        return { status: 'connected', account: await complete(actorUserId, login, file) };
      } finally {
        await dropLogin(loginId);
      }
    },

    disconnect: (actorUserId, accountId) =>
      writer.serial(async () => {
        if (!(await accountRow(accountId))) throw notFound(`account ${accountId}`, 'Аккаунт не найден. Обновите страницу.');
        const state = await writer.state();
        await writer.apply({ ...state, accounts: state.accounts.filter((a) => a.id !== accountId) });
        await inTransaction(db, async (c) => {
          await c.query('DELETE FROM app.chatgpt_accounts WHERE id = $1', [accountId]);
          await writeAudit(c, { actorUserId, action: 'chatgpt.disconnect', target: accountId });
        });
        await rm(fileOf(accountId), { force: true });
      }),

    attemptFailed: ({ accountId, status, at }) =>
      status !== ACCESS_ERROR
        ? Promise.resolve()
        : writer.serial(async () => {
            // An attempt with the token of before the last login says nothing of the new one; the
            // earlier 401 must be at least a cooldown back, with no success of the account since.
            const { rows } = await db.query<{ status: string; confirmed: boolean }>(
              `SELECT a.status,
                      EXISTS (SELECT 1 FROM app.account_events e
                               WHERE e.account_id = a.id AND e.status = $3 AND e.at > a.auth_updated_at AND e.at <= $2::timestamptz - make_interval(secs => $4)
                                 AND NOT EXISTS (SELECT 1 FROM app.usage_events u
                                                  WHERE u.is_subscription AND split_part(u.deployment, ':', 2) = a.id AND u.at > e.at AND u.at <= $2)) AS confirmed
                 FROM app.chatgpt_accounts a WHERE a.id = $1 AND $2 > a.auth_updated_at`,
              [accountId, at, ACCESS_ERROR, COOLDOWN_SECONDS],
            );
            if (rows[0]?.status !== 'active' || !rows[0].confirmed) return;
            const state = await writer.state();
            await writer.apply({ ...state, accounts: state.accounts.filter((a) => a.id !== accountId) });
            await db.query("UPDATE app.chatgpt_accounts SET status = 'auth_error' WHERE id = $1", [accountId]);
            logEvent('warn', 'chatgpt_account_auth_failed', { accountId, status });
          }),

    async prepare() {
      const { rows } = await db.query<AccountRow>('SELECT * FROM app.chatgpt_accounts ORDER BY connected_at, id');
      // Tokens of no account do not stay in the volume (an account removed while a write failed).
      const known = new Set(rows.map((r) => r.id));
      let names: string[];
      try {
        names = await readdir(deps.authDir);
      } catch (error) {
        throw new Error(`APP_CONFIG_INVALID: .env: APP_CHATGPT_AUTH_DIR: cannot read ${deps.authDir}`, { cause: error });
      }
      for (const name of names) {
        const owner = AUTH_FILE_NAME.exec(name);
        if (owner && (!known.has(owner[1]!) || owner[2])) await rm(join(deps.authDir, name), { force: true });
      }
      for (const r of rows) {
        // One broken account does not stop the server: without its file LiteLLM answers 401 for
        // it, and the admin sees «Ошибка доступа — войдите заново».
        try {
          await prepareOne(r);
        } catch (error) {
          logEvent('error', 'chatgpt_auth_prepare_failed', { accountId: r.id, error: errorKind(error) });
        }
      }
    },
  };

  async function prepareOne(r: AccountRow): Promise<void> {
    const saved = openAuth(r);
    const inVolume = await readAuthFile(r.id);
    // LiteLLM refreshed the token in the file: keep the fresher one, or the next restart would
    // bring back a refresh token OpenAI has already replaced (V19).
    if (inVolume && inVolume.expires_at > saved.expires_at) {
      const sealed = box.seal(JSON.stringify(inVolume));
      await db.query('UPDATE app.chatgpt_accounts SET auth_ciphertext = $2, auth_iv = $3, auth_key_version = $4, auth_updated_at = now() WHERE id = $1', [
        r.id,
        sealed.ciphertext,
        sealed.iv,
        sealed.keyVersion,
      ]);
      logEvent('info', 'chatgpt_token_taken_from_gateway', { accountId: r.id });
    } else if (!inVolume || inVolume.expires_at < saved.expires_at) {
      await writeAuthFile(r.id, saved);
    }
  }
}
