// Test helper: OpenAI as a ChatGPT subscription sees it — the login by a device code
// (auth.openai.com) and ChatGPT's Codex backend (chatgpt.com/backend-api/codex), in one server.
// The person "enters the code" with approve() or on the page /codex/device (the browser stand);
// every account answers as told by answer().
// The test LiteLLM sends subscription requests here (CHATGPT_API_BASE, deploy/compose.dev.yaml).
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const AUTH_CLAIM = 'https://api.openai.com/auth';
const PROFILE_CLAIM = 'https://api.openai.com/profile';
// Far from expiring: LiteLLM would otherwise refresh it at the real auth.openai.com.
const TOKEN_LIFETIME_SECONDS = 10 * 24 * 3600;
export const FAKE_SUBSCRIPTION_ANSWER = 'Ответ подписки';

export type AccountAnswer = 'ok' | { status: number; code: string };

export interface FakeChatGpt {
  // The auth base of the login (OPENAI_AUTH_BASE in tests).
  url: string;
  // The person entered the code and logged in as `email` (in the workspace `workspace`).
  approve(userCode: string, who: { email: string; workspace?: string }): void;
  // OpenAI refused the login.
  refuse(userCode: string): void;
  answer(email: string, answer: AccountAnswer): void;
  // Emails of the accounts the requests to ChatGPT came with, in order.
  calls: string[];
  close(): Promise<void>;
}

export function fakeJwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.sig`;
}

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

// OpenAI's page where the person enters the code; here the person also says who they are.
const DEVICE_PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>OpenAI (заглушка стенда)</title></head>
<body><form method="post"><h1>Вход по коду (заглушка OpenAI)</h1>
<label>Код <input name="code" required></label><label>Почта аккаунта <input name="email" type="email" required></label>
<button type="submit">Продолжить</button></form></body></html>`;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

// The Responses API stream ChatGPT answers with (LiteLLM always asks it to stream).
function responsesStream(res: ServerResponse, text: string): void {
  const item = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
  const response = {
    id: 'resp_1',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: 'gpt-5.4',
    status: 'completed',
    output: [item],
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  };
  const events: Record<string, unknown>[] = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text },
    { type: 'response.content_part.done', item_id: 'msg_1', output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  events.forEach((e, i) => res.write(`event: ${String(e.type)}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`));
  res.end();
}

export async function startFakeChatGpt(opts: { port?: number; host?: '127.0.0.1' | '0.0.0.0' } = {}): Promise<FakeChatGpt> {
  const approved = new Map<string, { email: string; workspace: string }>();
  const refused = new Set<string>();
  const answers = new Map<string, AccountAnswer>();
  const codes = new Map<string, { email: string; workspace: string }>();
  const calls: string[] = [];
  let n = 0;

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const path = req.url ?? '';
      if (path === '/codex/device') {
        if (req.method === 'POST') {
          const form = new URLSearchParams(body);
          const email = form.get('email') ?? '';
          approved.set(form.get('code') ?? '', { email, workspace: `ws-${email}` });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ru"><body><h1>Вход выполнен. Вернитесь в приложение.</h1></body></html>');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DEVICE_PAGE);
        return;
      }
      if (path === '/api/accounts/deviceauth/usercode') {
        n += 1;
        json(res, 200, { device_auth_id: `dev-${n}`, user_code: `CODE-${n}`, interval: 1 });
        return;
      }
      if (path === '/api/accounts/deviceauth/token') {
        const { user_code: userCode } = JSON.parse(body) as { user_code: string };
        if (refused.has(userCode)) return json(res, 400, { error: { message: 'access denied' } });
        const who = approved.get(userCode);
        if (!who) return json(res, 403, { error: { message: 'authorization pending' } });
        approved.delete(userCode);
        codes.set(`auth-${userCode}`, who);
        json(res, 200, { authorization_code: `auth-${userCode}`, code_challenge: 'challenge', code_verifier: 'verifier' });
        return;
      }
      if (path === '/oauth/token') {
        const form = new URLSearchParams(body);
        const who = codes.get(form.get('code') ?? '');
        if (!who || form.get('code_verifier') !== 'verifier') return json(res, 400, { error: 'invalid_grant' });
        const exp = Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS;
        const auth = { chatgpt_account_id: who.workspace };
        json(res, 200, {
          access_token: fakeJwt({ exp, [AUTH_CLAIM]: auth, [PROFILE_CLAIM]: { email: who.email } }),
          refresh_token: `refresh-${who.email}`,
          id_token: fakeJwt({ email: who.email, [AUTH_CLAIM]: auth }),
        });
        return;
      }
      if (path.endsWith('/responses')) {
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        const profile = claimsOf(token)[PROFILE_CLAIM] as { email?: string } | undefined;
        const email = profile?.email ?? 'unknown';
        calls.push(email);
        const answer = answers.get(email) ?? 'ok';
        if (answer === 'ok') return responsesStream(res, FAKE_SUBSCRIPTION_ANSWER);
        json(res, answer.status, { error: { type: answer.code, code: answer.code, message: `fake ChatGPT: ${answer.code}` } });
        return;
      }
      json(res, 404, { error: { message: `fake ChatGPT has no ${path}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    approve: (userCode, who) => void approved.set(userCode, { email: who.email, workspace: who.workspace ?? `ws-${who.email}` }),
    refuse: (userCode) => void refused.add(userCode),
    answer: (email, answer) => void answers.set(email, answer),
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
