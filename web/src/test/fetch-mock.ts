// A stand-in for the server in web tests: answers by "METHOD /path" and records every call.
import { vi } from 'vitest';

export interface MockCall {
  method: string;
  path: string;
  body: unknown;
}

type Reply = { status?: number; body?: unknown; raw?: string };
type Route = Reply | ((call: MockCall) => Reply);

export function apiError(code: string, message: string, status: number): Reply {
  return { status, body: { error: { code, message } } };
}

export function mockServer(routes: Record<string, Route>): { calls: MockCall[]; set: (key: string, route: Route) => void } {
  // The menu counters are asked on every screen; tests that care override them.
  // CopilotKit asks its runtime which agents exist when the provider mounts.
  const table = new Map<string, Route>([
    ['GET /app/api/me/notifications', { body: { pendingApprovals: 0, unreadResults: 0 } }],
    ['GET /app/api/copilotkit/info', { body: { agents: {} } }],
    ...Object.entries(routes),
  ]);
  const calls: MockCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const call = { method, path: url.pathname, body };
      calls.push(call);
      const route = table.get(`${method} ${url.pathname}`);
      if (!route) return Promise.resolve(new Response(JSON.stringify({ error: { code: 'APP_NOT_FOUND', message: 'нет такого адреса в тесте' } }), { status: 404 }));
      const reply = typeof route === 'function' ? route(call) : route;
      const text = reply.raw ?? JSON.stringify(reply.body ?? {});
      return Promise.resolve(new Response(text, { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
  return { calls, set: (key, route) => table.set(key, route) };
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
};
