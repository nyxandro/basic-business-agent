// The mailboxes of employees (spec, section 8.24): finding the settings by the address, connecting with a
// password or the service's sign-in (checked by IMAP and SMTP before it is saved), the list of a person's
// mailboxes, the sign-in apps of the admin, and the way in for the agent's tools.
import { MAIL_OAUTH_PROVIDERS, MAIL_PRESETS, type AdminMailResponse, type MailAccountsResponse, type MailConnectInput, type MailDiscovery, type MailOAuthAppInput, type MailOAuthProvider } from '@bba/contracts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { logEvent } from '../server/log.ts';
import { accountCounts, accountDto, deleteAccount, deleteApp, listAccounts, listApps, saveAccount, saveApp, setAccountStatus, type MailAccount } from './accounts.ts';
import { checkMailbox, type MailLogin, type MailTransportOptions } from './client.ts';
import { discoverMail, type DiscoverDeps } from './discover.ts';
import { completeMailOAuth, freshMailSecret, startMailOAuth, type EndpointsOf, type OAuthDeps } from './oauth.ts';

export interface MailDeps {
  db: Db;
  box: SecretBox;
  publicUrl: string;
  transport: MailTransportOptions;
  discover: DiscoverDeps;
  endpoints: EndpointsOf;
  // Signs in by IMAP and SMTP before a mailbox is saved; tests of the services' sign-in replace it, as
  // their test mail server takes no tokens.
  check?: typeof checkMailbox;
  // The ports a person may point the server at: the mail ports (IMAP_PORTS, SMTP_PORTS) — the server
  // connects where the person says, so nothing else of the network is reached through it. The test mail
  // server listens on its own ports.
  ports: { imap: readonly number[]; smtp: readonly number[] };
}

export interface MailService {
  readonly redirectUri: string;
  readonly transport: MailTransportOptions;
  discover(email: string): Promise<MailDiscovery>;
  connectWithPassword(userId: string, input: MailConnectInput): Promise<MailAccountsResponse>;
  oauthStart(userId: string, input: { email: string; provider: MailOAuthProvider }): Promise<string>;
  oauthComplete(userId: string, input: { state: string; code: string }): Promise<{ email: string }>;
  accounts(userId: string): Promise<MailAccountsResponse>;
  // The person's mailboxes the agent may use.
  connected(userId: string): Promise<MailAccount[]>;
  disconnect(userId: string, accountId: string): Promise<void>;
  // The way into a mailbox for one action: a token refreshed when needed.
  loginOf(account: MailAccount): Promise<MailLogin>;
  // The server refused the way in: the mailbox shows «Ошибка доступа» until connected again.
  refused(account: MailAccount): Promise<void>;
  adminState(): Promise<AdminMailResponse>;
  saveApp(provider: MailOAuthProvider, input: MailOAuthAppInput): Promise<void>;
  deleteApp(provider: MailOAuthProvider): Promise<void>;
}

const presetOf = (id: string) => MAIL_PRESETS.find((p) => p.id === id);

export function createMailService(deps: MailDeps): MailService {
  const redirectUri = new URL('/app/api/mail/oauth/callback', deps.publicUrl).toString();
  const oauth: OAuthDeps = { db: deps.db, box: deps.box, redirectUri, endpoints: deps.endpoints };
  const ready = async () => new Set((await listApps(deps.db)).map((a) => a.provider));
  const check = deps.check ?? checkMailbox;

  async function accounts(userId: string): Promise<MailAccountsResponse> {
    return { accounts: (await listAccounts(deps.db, userId)).map(accountDto), oauth: [...(await ready())] };
  }

  return {
    redirectUri,
    transport: deps.transport,
    async discover(email) {
      return discoverMail(deps.discover, email, await ready());
    },

    async connectWithPassword(userId, input) {
      // Microsoft takes no password from mail programs: only its sign-in.
      if (presetOf(input.provider)?.password === null) {
        throw appError('APP_VALIDATION_FAILED', `${input.provider} takes no password`, { userMessage: 'Этот сервис подключается только входом через его сайт.' });
      }
      if (!deps.ports.imap.includes(input.imap.port) || !deps.ports.smtp.includes(input.smtp.port)) {
        throw appError('APP_VALIDATION_FAILED', `mail ports ${input.imap.port}/${input.smtp.port} are not mail ports`, { userMessage: `Порт IMAP — ${deps.ports.imap.join(' или ')}, порт SMTP — ${deps.ports.smtp.join(', ')}.` });
      }
      const servers = { imap: input.imap, smtp: input.smtp };
      await check(servers, { login: input.login, secret: { kind: 'password', password: input.password } }, input.email, deps.transport);
      await saveAccount(deps.db, deps.box, { userId, email: input.email, provider: presetOf(input.provider) ? input.provider : 'custom', login: input.login, servers, secret: { kind: 'password', password: input.password } });
      logEvent('info', 'mail_connected', { userId, provider: input.provider, auth: 'password' });
      return accounts(userId);
    },

    oauthStart(userId, input) {
      return startMailOAuth(oauth, userId, input.provider, input.email);
    },

    async oauthComplete(userId, input) {
      const { provider, email, secret } = await completeMailOAuth(oauth, userId, input);
      const preset = presetOf(provider)!;
      const login = { login: email, secret: { kind: 'oauth' as const, accessToken: secret.kind === 'oauth' ? secret.accessToken : '' } };
      await check(preset.servers, login, email, deps.transport);
      await saveAccount(deps.db, deps.box, { userId, email, provider, login: email, servers: preset.servers, secret });
      logEvent('info', 'mail_connected', { userId, provider, auth: 'oauth' });
      return { email };
    },

    accounts,
    async connected(userId) {
      return (await listAccounts(deps.db, userId)).filter((a) => a.status === 'connected');
    },

    async disconnect(userId, accountId) {
      if (!(await deleteAccount(deps.db, userId, accountId))) throw appError('APP_NOT_FOUND', 'no such mailbox of the person', { userMessage: 'Такой почты среди подключённых нет.' });
    },

    async loginOf(account) {
      const secret = await freshMailSecret(oauth, account);
      return { login: account.login, secret: secret.kind === 'password' ? { kind: 'password', password: secret.password } : { kind: 'oauth', accessToken: secret.accessToken } };
    },

    async refused(account) {
      await setAccountStatus(deps.db, account.id, 'auth_error', 'APP_MAIL_AUTH_FAILED');
    },

    async adminState() {
      const apps = await listApps(deps.db);
      return {
        apps: MAIL_OAUTH_PROVIDERS.map((provider) => {
          const app = apps.find((a) => a.provider === provider);
          return { provider, clientId: app?.clientId ?? null, tenant: app?.tenant ?? null, configured: !!app };
        }),
        redirectUri,
        ...(await accountCounts(deps.db)),
      };
    },

    async saveApp(provider, input) {
      await saveApp(deps.db, deps.box, { provider, clientId: input.clientId, clientSecret: input.clientSecret, tenant: provider === 'microsoft' ? input.tenant || null : null });
    },

    deleteApp: (provider) => deleteApp(deps.db, provider),
  };
}

// The mailbox a tool works with: the one named, or the person's only one; none — the agent is told why.
export async function pickAccount(mail: Pick<MailService, 'connected'>, userId: string, email: string | undefined): Promise<MailAccount> {
  const all = await mail.connected(userId);
  if (all.length === 0) {
    throw new AppError({ code: 'APP_MAIL_NOT_CONNECTED', message: 'the person has no working mailbox', userMessage: 'Почта не подключена или доступ к ней сломался.', nextStep: 'Подключите почту в «Настройки → Подключения».', status: 409 });
  }
  if (!email) return all[0]!;
  const found = all.find((a) => a.email === email.toLowerCase());
  if (!found) throw appError('APP_VALIDATION_FAILED', 'mailbox not connected', { userMessage: `Ящик ${email} не подключён. Подключённые: ${all.map((a) => a.email).join(', ')}.` });
  return found;
}

