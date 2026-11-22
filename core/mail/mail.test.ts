// The mailbox of an employee (spec, section 8.24): found by the address, connected with a password or the
// service's sign-in after a real check of IMAP and SMTP, used by the agent — reading without asking,
// sending only after «Да» — and kept only encrypted.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { AdminMailResponse, MailAccountsResponse, MailDiscovery } from '@bba/contracts';
import { simpleParser } from 'mailparser';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FakeRequest } from '../models/fake-openai.ts';
import { LIST_NOTE } from '../widgets/prompt.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { chatRoot, conversationRoot } from '../workspace/layout.ts';
import type { MailLogin } from './client.ts';
import { discoverMail, parseAutoconfig, type DiscoverDeps } from './discover.ts';
import { deliver, inbox, TEST_MAIL_SERVERS, testMailbox, testMailReady } from './test-server.ts';

let t: TestApp;
let olga: string;
let olgaId: string;
let igor: string;
let tokens: Server;
let tokenUrl: string;
const tokenCalls: URLSearchParams[] = [];
let tokenAnswer: { status: number; body: unknown } = { status: 200, body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 } };
const checked: MailLogin[] = [];

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const noNetwork: DiscoverDeps = {
  resolveMx: () => Promise.resolve([]),
  resolveSrv: () => Promise.resolve([]),
  fetchConfig: () => Promise.resolve(null),
  answers: () => Promise.resolve(false),
};

async function run(threadId: string, text: string | null, resume?: unknown): Promise<{ body: string; said: string; interrupt: { id: string } | undefined }> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie: olga,
    body: { threadId, runId: randomUUID(), messages: text ? [{ id: randomUUID(), role: 'user', content: text }] : [], tools: [], context: [], state: {}, forwardedProps: {}, ...(resume ? { resume } : {}) },
  });
  const body = await res.text();
  const events = body
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as { type: string; delta?: string; outcome?: { interrupts?: { id: string }[] } });
  const said = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta ?? '').join('');
  return { body, said, interrupt: events.find((e) => e.type === 'RUN_FINISHED')?.outcome?.interrupts?.[0] };
}

const call = (req: FakeRequest, name: string, args: Record<string, unknown>) => ({ toolCalls: [{ name: (req.tools ?? []).some((x) => x.function.name === name) ? name : `missing_${name}`, args }] });
const lastToolResult = () => JSON.stringify(t.model.requests.at(-1)?.messages.at(-1));
// The result of the last tool call the model got, parsed.
const lastResult = <T>() => JSON.parse((t.model.requests.at(-1)?.messages.at(-1) as { content: string }).content) as T;

beforeAll(async () => {
  await testMailReady();
  tokens = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      tokenCalls.push(new URLSearchParams(raw));
      res.writeHead(tokenAnswer.status, { 'content-type': 'application/json' }).end(JSON.stringify(tokenAnswer.body));
    });
  });
  await new Promise<void>((resolve) => tokens.listen(0, '127.0.0.1', resolve));
  tokenUrl = `http://127.0.0.1:${(tokens.address() as AddressInfo).port}/token`;
  t = await createTestApp({
    sandbox: true,
    mailDiscover: noNetwork,
    mailEndpoints: () => ({ authorizeUrl: 'https://accounts.example.test/authorize', tokenUrl }),
    mailCheck: async (servers, login) => {
      checked.push(login);
      // Tokens are not taken by the test mail server: a sign-in by token is only recorded.
      if (login.secret.kind === 'oauth') return;
      const { checkMailbox } = await import('./client.ts');
      await checkMailbox(servers, login, login.login, { trustSelfSigned: true });
    },
  });
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова' });
  await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  const dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [dep, olgaId]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [dep]);
  olga = await t.signIn('olga@example.com');
  igor = await t.signIn('igor@example.com');
});
afterAll(async () => {
  await t.close();
  await new Promise<void>((resolve) => tokens.close(() => resolve()));
});
beforeEach(() => t.model.clear());

describe('finding the settings by the address', () => {
  const ready = new Set<'google' | 'microsoft' | 'yandex'>();

  it('knows popular services by the domain and company domains by their mail exchanger', async () => {
    expect(await discoverMail(noNetwork, 'olga@yandex.ru', ready)).toMatchObject({ source: 'preset', provider: 'yandex', title: 'Яндекс Почта', oauth: null, servers: { imap: { host: 'imap.yandex.ru', port: 993, security: 'tls' } } });
    expect((await discoverMail(noNetwork, 'olga@inbox.ru', ready)).provider).toBe('mailru');
    const yandex360 = { ...noNetwork, resolveMx: () => Promise.resolve([{ exchange: 'mx.yandex.net', priority: 10 }]) };
    expect(await discoverMail(yandex360, 'olga@alfa-stroy.ru', ready)).toMatchObject({ source: 'mx', provider: 'yandex' });
    const m365 = { ...noNetwork, resolveMx: () => Promise.resolve([{ exchange: 'alfa-ru.mail.protection.outlook.com', priority: 0 }]) };
    // Microsoft takes no password; its sign-in is offered once the admin set it up.
    expect(await discoverMail(m365, 'olga@alfa.ru', new Set(['microsoft']))).toMatchObject({ provider: 'microsoft', password: null, oauth: 'microsoft' });
  });

  it('reads the settings a domain publishes, then its SRV records, then a server that answers', async () => {
    const xml = `<clientConfig version="1.1"><emailProvider id="beta.test">
      <incomingServer type="pop3"><hostname>pop.beta.test</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
      <incomingServer type="imap"><hostname>imap.beta.test</hostname><port>143</port><socketType>plain</socketType></incomingServer>
      <incomingServer type="imap"><hostname>mail.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
      <outgoingServer type="smtp"><hostname>smtp.beta.test</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer></emailProvider></clientConfig>`;
    expect(parseAutoconfig(xml, 'beta.test')).toEqual({ imap: { host: 'mail.beta.test', port: 993, security: 'tls' }, smtp: { host: 'smtp.beta.test', port: 587, security: 'starttls' } });
    const auto = { ...noNetwork, fetchConfig: (url: string) => Promise.resolve(url.startsWith('https://autoconfig.beta.test/') ? xml : null) };
    expect(await discoverMail(auto, 'olga@beta.test', ready)).toMatchObject({ source: 'autoconfig', provider: 'custom', servers: { imap: { host: 'mail.beta.test' } } });
    const srv = {
      ...noNetwork,
      resolveSrv: (name: string) => Promise.resolve(name === '_imaps._tcp.gamma.test' ? [{ name: 'imap.host.test', port: 993, priority: 0 }] : name === '_submission._tcp.gamma.test' ? [{ name: 'smtp.host.test.', port: 587, priority: 0 }] : []),
    };
    expect(await discoverMail(srv, 'olga@gamma.test', ready)).toMatchObject({ source: 'srv', servers: { imap: { host: 'imap.host.test', port: 993, security: 'tls' }, smtp: { host: 'smtp.host.test', port: 587, security: 'starttls' } } });
    const guess = { ...noNetwork, resolveMx: () => Promise.resolve([{ exchange: 'mx1.hoster.test', priority: 10 }]), answers: (host: string, port: number) => Promise.resolve((host === 'imap.hoster.test' && port === 993) || (host === 'smtp.hoster.test' && port === 587)) };
    expect(await discoverMail(guess, 'olga@delta.test', ready)).toMatchObject({ source: 'guess', servers: { imap: { host: 'imap.hoster.test' }, smtp: { host: 'smtp.hoster.test', port: 587, security: 'starttls' } } });
    expect(await discoverMail(noNetwork, 'olga@nothing.test', ready)).toMatchObject({ source: 'none', servers: null });
  });

  it('is asked through the server by the person', async () => {
    const found = await json<MailDiscovery>(await t.call('POST', '/app/api/me/mail/discover', { cookie: olga, body: { email: 'olga@gmail.com' } }));
    expect(found).toMatchObject({ provider: 'google', title: 'Gmail', oauth: null });
    expect(found.password?.url).toBe('https://myaccount.google.com/apppasswords');
  });
});

describe('connecting a mailbox with a password', () => {
  it('a wrong password is refused with what to do; the right one connects, kept only encrypted', async () => {
    const box = await testMailbox('olga');
    const body = { email: box.email, provider: 'custom', login: box.email, imap: TEST_MAIL_SERVERS.imap, smtp: TEST_MAIL_SERVERS.smtp };
    const wrong = await t.call('POST', '/app/api/me/mail', { cookie: olga, body: { ...body, password: 'wrong' } });
    expect(wrong.status).toBe(400);
    expect(await json(wrong)).toMatchObject({ error: { code: 'APP_MAIL_AUTH_FAILED' } });
    expect((await json<MailAccountsResponse>(await t.call('GET', '/app/api/me/mail', { cookie: olga }))).accounts).toEqual([]);
    const ok = await t.call('POST', '/app/api/me/mail', { cookie: olga, body: { ...body, password: box.password } });
    expect(ok.status).toBe(200);
    const listed = await json<MailAccountsResponse>(ok);
    expect(listed.accounts).toMatchObject([{ email: box.email, auth: 'password', status: 'connected' }]);
    expect(JSON.stringify(listed)).not.toContain(box.password);
    const { rows } = await t.db.query<{ ciphertext: Buffer }>('SELECT ciphertext FROM app.mail_accounts');
    expect(rows[0]!.ciphertext.toString('utf8')).not.toContain(box.password);
    // Disconnected only by the person themselves.
    const id = listed.accounts[0]!.id;
    expect((await t.call('DELETE', `/app/api/me/mail/${id}`, { cookie: igor })).status).toBe(404);
    expect((await json<MailAccountsResponse>(await t.call('DELETE', `/app/api/me/mail/${id}`, { cookie: olga }))).accounts).toEqual([]);
  }, 30_000);

  it('Microsoft takes no password; ports other than mail ports are refused', async () => {
    const body = { email: 'olga@outlook.com', provider: 'microsoft', login: 'olga@outlook.com', password: 'x', imap: { host: 'outlook.office365.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' } };
    expect(await json(await t.call('POST', '/app/api/me/mail', { cookie: olga, body }))).toMatchObject({ error: { message: 'Этот сервис подключается только входом через его сайт.' } });
    const port = await t.call('POST', '/app/api/me/mail', { cookie: olga, body: { ...body, provider: 'custom', imap: { host: '10.0.0.5', port: 5432, security: 'tls' } } });
    expect(port.status).toBe(400);
    expect((await json<{ error: { message: string } }>(port)).error.message).toContain('Порт IMAP — 993 или 143');
  });
});

describe('the agent with the mailbox', () => {
  let box: { email: string; password: string };
  let client: { email: string; password: string };

  beforeAll(async () => {
    box = await testMailbox('olga-agent');
    client = await testMailbox('client');
    const connected = await t.call('POST', '/app/api/me/mail', { cookie: olga, body: { email: box.email, provider: 'custom', login: box.email, password: box.password, imap: TEST_MAIL_SERVERS.imap, smtp: TEST_MAIL_SERVERS.smtp } });
    expect(connected.status, await connected.clone().text()).toBe(200);
    await deliver(box.email, client, { subject: 'Счёт за октябрь', text: 'Добрый день! Счёт во вложении.', attachments: [{ filename: 'счёт.pdf', content: '%PDF-1.4 счёт' }] });
  }, 30_000);

  it('lists and reads letters without asking, and leaves them unread', async () => {
    const threadId = randomUUID();
    t.model.script((req) => call(req, 'mailbox_list', {}), (req) => {
      const listed = lastResult<{ letters: { uid: number }[] }>();
      return call(req, 'mailbox_read', { uid: listed.letters[0]!.uid });
    }, { text: 'Прочитал.' });
    expect((await run(threadId, 'Что пришло на почту?')).said).toBe('Прочитал.');
    const read = JSON.stringify(t.model.requests.at(-1)?.messages);
    expect(read).toContain('Счёт за октябрь');
    expect(read).toContain('Добрый день! Счёт во вложении.');
    expect(read).toContain('счёт.pdf');
    // The chat names the actions of the mail.
    const agents = await json<{ agents: { id: string; actions: Record<string, { title: string; readOnly: boolean }>; systems: { tools: Record<string, string> } }[] }>(await t.call('GET', '/app/api/agents', { cookie: olga }));
    const sales = agents.agents.find((a) => a.id === 'sales')!;
    expect(sales.actions.mailbox_send).toMatchObject({ title: 'Отправить письмо из почты сотрудника', readOnly: false });
    expect(sales.actions.mailbox_read?.readOnly).toBe(true);
    expect(sales.systems.tools.mailbox_list).toBe('Почта');
    const listed = await inbox(box);
    expect(listed[0]!.subject).toBe('Счёт за октябрь');
  }, 60_000);

  // Issue #32: a summary of 20 letters went out as text. With widgets on, a list of three and more letters carries the
  // constant line that tells the agent to show them as a widget; a shorter list does not.
  it('asks for a widget when three and more letters are listed and widgets are on', async () => {
    t.model.script((req) => call(req, 'mailbox_list', {}), { text: 'Одно письмо.' });
    await run(randomUUID(), 'Что пришло?');
    expect(lastResult<Record<string, unknown>>().note).toBeUndefined();
    await deliver(box.email, client, { subject: 'Акт сверки', text: 'Акт.' });
    await deliver(box.email, client, { subject: 'Приглашение на тендер', text: 'Тендер.' });
    t.model.script((req) => call(req, 'mailbox_list', {}), { text: 'Три письма.' });
    await run(randomUUID(), 'А теперь?');
    expect(lastResult<{ note?: string; letters: unknown[] }>()).toMatchObject({ note: LIST_NOTE });
  }, 60_000);

  it('saves an attachment into the working folder', async () => {
    t.model.script((req) => call(req, 'mailbox_search', { text: 'октябрь' }), (req) => {
      const found = lastResult<{ letters: { uid: number }[] }>();
      return call(req, 'mailbox_save_attachment', { uid: found.letters[0]!.uid, number: 1 });
    }, { text: 'Сохранил.' });
    const threadId = randomUUID();
    await run(threadId, 'Сохрани счёт');
    expect(lastToolResult()).toContain('Почта/счёт.pdf');
    expect(readFileSync(join(chatRoot(t.workspaceRoot, olgaId, threadId), 'Почта', 'счёт.pdf'), 'utf8')).toBe('%PDF-1.4 счёт');
  }, 60_000);

  it('sends a reply only after «Да», in the same thread, from the person', async () => {
    const threadId = randomUUID();
    // The file attached to the reply lies in this conversation's folder.
    const folder = conversationRoot(t.workspaceRoot, { userId: olgaId, threadId, project: null });
    mkdirSync(join(folder, 'Почта'), { recursive: true });
    writeFileSync(join(folder, 'Почта', 'счёт.pdf'), '%PDF-1.4 счёт');
    t.model.script((req) => call(req, 'mailbox_search', { from: client.email }), (req) => {
      const found = lastResult<{ letters: { uid: number }[] }>();
      return call(req, 'mailbox_send', { to: [client.email], text: 'Спасибо, оплатим в пятницу.', replyToUid: found.letters[0]!.uid, attachments: ['Почта/счёт.pdf'] });
    }, { text: 'Отправил.' });
    const first = await run(threadId, 'Ответь клиенту, что оплатим в пятницу');
    expect(first.interrupt).toBeTruthy();
    // Nothing went out before «Да».
    expect(await inbox(client)).toEqual([]);
    const second = await run(threadId, null, [{ interruptId: first.interrupt!.id, status: 'resolved', payload: { approved: true } }]);
    expect(second.said).toBe('Отправил.');
    const got = await inbox(client);
    expect(got.map((l) => l.subject)).toEqual(['Re: Счёт за октябрь']);
    const parsed = await simpleParser(got[0]!.source);
    expect(parsed.from?.value[0]).toMatchObject({ name: 'Ольга Смирнова', address: box.email });
    expect(parsed.attachments.map((a) => a.filename)).toEqual(['счёт.pdf']);
    expect(got[0]!.source).toMatch(/In-Reply-To: <.+>/);
    const { rows } = await t.db.query<{ tool: string; result: string }>("SELECT tool, result FROM app.action_journal WHERE tool = 'mailbox_send'");
    expect(rows).toEqual([{ tool: 'mailbox_send', result: 'ok' }]);
  }, 60_000);

  it('a mailbox whose password stopped working shows «Ошибка доступа» and the agent is told what to do', async () => {
    await t.db.query('UPDATE app.mail_accounts SET login = $1 WHERE user_id = $2', ['nobody@alfa.test', olgaId]);
    t.model.script((req) => call(req, 'mailbox_list', {}), { text: 'Не вышло.' });
    await run(randomUUID(), 'Что на почте?');
    expect(lastToolResult()).toContain('APP_MAIL_AUTH_FAILED');
    const listed = await json<MailAccountsResponse>(await t.call('GET', '/app/api/me/mail', { cookie: olga }));
    expect(listed.accounts[0]!.status).toBe('auth_error');
    // Without a working mailbox the agent has no mail tools at all.
    t.model.script({ text: 'Почты нет.' });
    await run(randomUUID(), 'Что на почте?');
    expect((t.model.requests.at(-1)?.tools ?? []).some((x) => x.function.name.startsWith('mailbox_'))).toBe(false);
  }, 60_000);
});

describe('sign-in on the service’s site', () => {
  it('the admin sets up the app; the person signs in; the token is refreshed ahead of expiry and a refusal marks the mailbox', async () => {
    expect((await t.call('PUT', '/app/api/admin/mail/oauth/google', { cookie: olga, body: { clientId: 'cid', clientSecret: 'secret' } })).status).toBe(403);
    const saved = await json<AdminMailResponse>(await t.call('PUT', '/app/api/admin/mail/oauth/google', { cookie: igor, body: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'very-secret' } }));
    expect(saved.apps.find((a) => a.provider === 'google')).toEqual({ provider: 'google', clientId: 'cid.apps.googleusercontent.com', tenant: null, configured: true });
    expect(saved.redirectUri).toBe('http://localhost:8080/app/api/mail/oauth/callback');
    expect(JSON.stringify(saved)).not.toContain('very-secret');
    expect((await json<MailDiscovery>(await t.call('POST', '/app/api/me/mail/discover', { cookie: olga, body: { email: 'olga@gmail.com' } }))).oauth).toBe('google');

    const { url } = await json<{ url: string }>(await t.call('POST', '/app/api/me/mail/oauth/start', { cookie: olga, body: { email: 'olga@gmail.com', provider: 'google' } }));
    const sent = new URL(url);
    expect(sent.searchParams.get('client_id')).toBe('cid.apps.googleusercontent.com');
    expect(sent.searchParams.get('scope')).toBe('https://mail.google.com/');
    expect(sent.searchParams.get('login_hint')).toBe('olga@gmail.com');
    expect(sent.searchParams.get('access_type')).toBe('offline');
    expect(sent.searchParams.get('code_challenge_method')).toBe('S256');
    const back = await t.call('GET', `/app/api/mail/oauth/callback?state=${sent.searchParams.get('state')}&code=the-code`, { cookie: olga });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/settings/connections?mail=olga%40gmail.com');
    expect(tokenCalls.at(-1)?.get('code')).toBe('the-code');
    expect(tokenCalls.at(-1)?.get('code_verifier')).toBeTruthy();
    expect(checked.at(-1)).toEqual({ login: 'olga@gmail.com', secret: { kind: 'oauth', accessToken: 'access-1' } });
    const listed = await json<MailAccountsResponse>(await t.call('GET', '/app/api/me/mail', { cookie: olga }));
    const gmail = listed.accounts.find((a) => a.email === 'olga@gmail.com')!;
    expect(gmail).toMatchObject({ auth: 'oauth', provider: 'google', title: 'Gmail', servers: { imap: { host: 'imap.gmail.com' } } });
    // A state is single-use.
    const again = await t.call('GET', `/app/api/mail/oauth/callback?state=${sent.searchParams.get('state')}&code=the-code`, { cookie: olga });
    expect(again.headers.get('location')).toBe('/settings/connections?mailError=APP_VALIDATION_FAILED');

    // Near expiry: refreshed once, under the lock.
    await t.db.query("UPDATE app.mail_accounts SET status = 'connected' WHERE email = 'olga@gmail.com'");
    const { rows } = await t.db.query<{ id: string }>("SELECT id FROM app.mail_accounts WHERE email = 'olga@gmail.com'");
    const account = (await t.mail.connected(olgaId)).find((a) => a.id === rows[0]!.id)!;
    const { box } = { box: (await import('../crypto/secret-box.ts')).createSecretBox((await import('../server/test-app.ts')).TEST_ENCRYPTION_KEYS) };
    const { replaceSecret } = await import('./accounts.ts');
    await replaceSecret(t.db, box, account.id, { kind: 'oauth', provider: 'google', accessToken: 'old', refreshToken: 'refresh-1', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    tokenAnswer = { status: 200, body: { access_token: 'access-2', expires_in: 3600 } };
    expect((await t.mail.loginOf(account)).secret).toEqual({ kind: 'oauth', accessToken: 'access-2' });
    expect(tokenCalls.at(-1)?.get('grant_type')).toBe('refresh_token');
    expect((await t.mail.loginOf(account)).secret).toEqual({ kind: 'oauth', accessToken: 'access-2' });
    await replaceSecret(t.db, box, account.id, { kind: 'oauth', provider: 'google', accessToken: 'old', refreshToken: 'refresh-1', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    // A busy service is no refusal: the mailbox stays as it was, the next action tries again.
    tokenAnswer = { status: 503, body: { error: 'temporarily_unavailable' } };
    await expect(t.mail.loginOf(account)).rejects.toMatchObject({ code: 'APP_MAIL_OAUTH_FAILED' });
    expect((await t.mail.accounts(olgaId)).accounts.find((a) => a.id === account.id)?.status).toBe('connected');
    tokenAnswer = { status: 400, body: { error: 'invalid_grant' } };
    await expect(t.mail.loginOf(account)).rejects.toMatchObject({ code: 'APP_MAIL_AUTH_FAILED' });
    expect((await t.mail.accounts(olgaId)).accounts.find((a) => a.id === account.id)?.status).toBe('auth_error');
  }, 30_000);
});
