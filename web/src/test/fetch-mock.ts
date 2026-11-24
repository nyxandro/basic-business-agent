// A stand-in for the server in web tests: answers by "METHOD /path" and records every call.
import { vi } from 'vitest';

export interface MockCall {
  method: string;
  path: string;
  // The query string as an object: ?q=a&scope=all → { q: 'a', scope: 'all' }.
  query: Record<string, string>;
  body: unknown;
  // Fields of a multipart body: text as it is, a file by its name.
  form?: Record<string, string>;
}

export type Reply = { status?: number; body?: unknown; raw?: string };
// A route may answer later (a Promise) to test answers that come out of order.
export type Route = Reply | ((call: MockCall) => Reply | Promise<Reply>);

const PRESENCE_PATH = '/app/api/me/presence';

const answerOf = (route: Route | undefined, call: MockCall): Reply | Promise<Reply> => (route === undefined ? { status: 404 } : typeof route === 'function' ? route(call) : route);

export function apiError(code: string, message: string, status: number): Reply {
  return { status, body: { error: { code, message } } };
}

// `pings` — the presence of a visible tab (every screen sends it, docs/specs/[20.11.2026]-notifications.md): kept apart
// from `calls`, so a test looking for «the POST» of its screen is not misled.
export function mockServer(routes: Record<string, Route>): { calls: MockCall[]; pings: MockCall[]; set: (key: string, route: Route) => void } {
  // The menu counters are asked on every screen; tests that care override them.
  // CopilotKit asks its runtime which agents exist when the provider mounts.
  const table: Map<string, Route> = new Map<string, Route>([
    ['GET /app/api/me/notifications', { body: { pendingApprovals: 0, unread: 0, latest: null, threads: {} } }],
    // A visible tab tells the server it is here and gets the bell's counters (docs/specs/[20.11.2026]-notifications.md):
    // the same answer as the counters themselves, whatever a test set for them.
    ['POST /app/api/me/presence', (call: MockCall): Reply | Promise<Reply> => answerOf(table.get('GET /app/api/me/notifications'), call)],
    ['GET /app/api/copilotkit/info', { body: { agents: {} } }],
    // «Подключения» show the mailbox in every installation (spec, section 8.24).
    ['GET /app/api/me/mail', { body: { accounts: [], oauth: [], readBy: [] } }],
    // Multi-step approvals (docs/specs/[20.11.2026]-multi-step-approvals.md): no rule on any action, no requests.
    ['POST /app/api/approval-chains/preview', { body: { stages: null } }],
    ['GET /app/api/approval-chains', { body: { forMe: [], mine: [] } }],
    ['GET /app/api/admin/mail', { body: { apps: [], redirectUri: 'http://localhost/app/api/mail/oauth/callback', connected: 0, authErrors: 0 } }],
    // MCP servers the admin added (docs/specs/[20.11.2026]-mcp-connections.md): none unless a test adds them.
    ['GET /app/api/admin/mcp-servers', { body: { servers: [] } }],
    ['GET /app/api/me/connections/mcp', { body: { servers: [] } }],
    ...Object.entries(routes),
  ]);
  const calls: MockCall[] = [];
  const pings: MockCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const form = init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : v.name])) : undefined;
      const call = { method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, ...(form ? { form } : {}) };
      (method === 'POST' && url.pathname === PRESENCE_PATH ? pings : calls).push(call);
      const route = table.get(`${method} ${url.pathname}`);
      if (!route) return Promise.resolve(new Response(JSON.stringify({ error: { code: 'APP_NOT_FOUND', message: 'нет такого адреса в тесте' } }), { status: 404 }));
      return Promise.resolve(typeof route === 'function' ? route(call) : route).then((reply) => {
        const text = reply.raw ?? JSON.stringify(reply.body ?? {});
        return new Response(text, { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
      });
    }),
  );
  // Uploads that tell how far they are go by XMLHttpRequest (api/client.ts): the same table answers them,
  // and half of the body is told sent before the answer, all of it when it comes.
  vi.stubGlobal('XMLHttpRequest', TableXhr);
  return { calls, pings, set: (key, route) => table.set(key, route) };
}

const bodySize = (body: unknown) =>
  body instanceof FormData ? [...body.values()].reduce((sum, value) => sum + (typeof value === 'string' ? value.length : value.size), 0) : 0;

class TableXhr {
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  responseText = '';
  private method = 'GET';
  private url = '';
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  send(body?: FormData): void {
    const total = Math.max(1, bodySize(body));
    this.upload.onprogress?.({ lengthComputable: true, loaded: Math.floor(total / 2), total });
    void fetch(this.url, { method: this.method, ...(body ? { body } : {}) }).then(
      async (res) => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: total, total });
        this.status = res.status;
        this.responseText = await res.text();
        this.onload?.();
      },
      () => this.onerror?.(),
    );
  }
}

export const ME = {
  user: { id: 'u1', email: 'olga@example.com', name: 'Ольга' },
  permissions: [],
  isSuperadmin: false,
  departmentIds: ['d1'],
  departmentNames: ['Отдел продаж'],
  voiceAvailable: false,
  organisation: { name: 'Альфа-Строй' },
  modelsConfigured: true,
  interface: { showAgentMark: true, documentSamples: false },
};
