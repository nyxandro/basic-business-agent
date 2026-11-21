// The browser's handler of notifications (docs/specs/[20.11.2026]-notifications.md, step 6): it shows every push — an
// unreadable one too, never silent — opens the address of a notification in a tab of the app, never another site, and
// hands a renewed subscription to the server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: never) => void;

interface Scope {
  listeners: Map<string, Listener>;
  shown: { title: string; options: Record<string, unknown> }[];
  tabs: { url: string; focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> }[];
  opened: string[];
}

let scope: Scope;

function fire(type: string, event: object): Promise<unknown> {
  let work: Promise<unknown> = Promise.resolve();
  scope.listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => (work = p), ...event } as never);
  return work;
}

beforeEach(async () => {
  vi.resetModules();
  scope = { listeners: new Map(), shown: [], tabs: [], opened: [] };
  vi.stubGlobal('self', {
    location: { origin: 'https://agent.example.ru' },
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => (scope.shown.push({ title, options }), Promise.resolve()),
      pushManager: { subscribe: vi.fn(() => Promise.resolve({ toJSON: () => ({ endpoint: 'https://push.example/renewed', keys: { p256dh: 'p', auth: 'a' } }) })) },
    },
    clients: {
      matchAll: () => Promise.resolve(scope.tabs),
      openWindow: (url: string) => (scope.opened.push(url), Promise.resolve()),
      claim: () => Promise.resolve(),
    },
    skipWaiting: () => Promise.resolve(),
    addEventListener: (type: string, listener: Listener) => scope.listeners.set(type, listener),
  });
  // The handler is a plain script, not a module: it is loaded for its listeners.
  const entry = './sw.ts';
  await import(/* @vite-ignore */ entry);
});
afterEach(() => vi.unstubAllGlobals());

const payload = { id: '6f1c2c1e-1111-4111-8111-111111111111', kind: 'approval_waiting', title: 'Ждёт вашего решения', body: 'Утренняя сводка · Отправить письмо', link: '/approvals?question=q1' };

describe('the handler of notifications', () => {
  it('shows a push under its own id, with its link', async () => {
    await fire('push', { data: { json: () => payload } });
    expect(scope.shown).toEqual([{ title: 'Ждёт вашего решения', options: expect.objectContaining({ body: 'Утренняя сводка · Отправить письмо', tag: payload.id, data: { link: '/approvals?question=q1' }, lang: 'ru' }) }]);
  });

  it('never stays silent: an unreadable push shows a plain notification', async () => {
    await fire('push', { data: { json: () => JSON.parse('not json') as unknown } });
    await fire('push', { data: null });
    expect(scope.shown.map((s) => s.title)).toEqual(['Бизнес-агент', 'Бизнес-агент']);
  });

  it('opens the address in an open tab of the app, or in a new one', async () => {
    const tab = { url: 'https://agent.example.ru/agents/sales', focus: vi.fn(() => Promise.resolve()), navigate: vi.fn(() => Promise.resolve()) };
    scope.tabs.push(tab);
    await fire('notificationclick', { notification: { close: vi.fn(), data: { link: '/approvals?question=q1' } } });
    expect(tab.focus).toHaveBeenCalled();
    expect(tab.navigate).toHaveBeenCalledWith('https://agent.example.ru/approvals?question=q1');
    scope.tabs.length = 0;
    await fire('notificationclick', { notification: { close: vi.fn(), data: { link: '/projects/p1' } } });
    expect(scope.opened).toEqual(['https://agent.example.ru/projects/p1']);
  });

  it('never takes a link to another site', async () => {
    await fire('notificationclick', { notification: { close: vi.fn(), data: { link: 'https://evil.example/steal' } } });
    expect(scope.opened).toEqual(['https://agent.example.ru/']);
  });

  it('hands a renewed subscription to the server', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(url.endsWith('/key') ? JSON.stringify({ publicKey: 'BAAA' }) : '{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    await fire('pushsubscriptionchange', {});
    expect(fetchMock).toHaveBeenCalledWith('/app/api/me/push-subscriptions', expect.objectContaining({ method: 'POST', body: JSON.stringify({ endpoint: 'https://push.example/renewed', keys: { p256dh: 'p', auth: 'a' } }) }));
  });
});
