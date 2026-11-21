// Notifications in the interface (docs/specs/[20.11.2026]-notifications.md, step 8): the bell at the right of every
// header on a computer, the panel with «Ждут решения» and «Уведомления», the hint inside the page, the states of this
// browser in «Настройки → Уведомления», turning on, and signing out that drops the browser's subscription.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const AGENTS = [{ id: 'sales', name: 'Продажи', description: '', starters: [], mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } }];
const READY = { id: 'n1', kind: 'task_result', title: 'Готово: Утренняя сводка', body: 'Результат — в разговоре задачи.', link: '/agents/sales?thread=bg%3At1%3Au1', createdAt: '2026-11-21T06:05:00.000Z', read: false };
const SHARED = { id: 'n2', kind: 'project_shared', title: 'Вам открыли проект «Тендер»', body: 'Проект ведёт Пётр.', link: '/projects/p1', createdAt: '2026-11-20T10:00:00.000Z', read: true };

function server(counts: object = { pendingApprovals: 0, unread: 1, latest: READY }) {
  return mockServer({
    'GET /app/api/me': { body: ME },
    'GET /app/api/agents': { body: { agents: AGENTS } },
    'GET /app/api/threads': { body: { threads: [], next: null } },
    'GET /app/api/projects': { body: { projects: [] } },
    'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: null, resetsOn: '2026-12-01' }, daily: null } },
    'GET /app/api/me/notifications': { body: counts },
    'GET /app/api/me/notifications/list': { body: { items: [READY, SHARED] } },
    'POST /app/api/me/notifications/read': { body: { ok: true } },
    'GET /app/api/approvals': { body: { pending: [], failed: [] } },
    'GET /app/api/me/connections': { body: { connections: [] } },
    'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' } } } },
    'GET /app/api/threads/t1/project': { body: { projectId: null } },
  });
}

// A browser that can show notifications: a service worker, a push manager and the permission as given.
function stubBrowser(input: { permission: NotificationPermission; subscription?: { endpoint: string } | null; grant?: NotificationPermission }) {
  const unsubscribe = vi.fn(() => Promise.resolve(true));
  const existing = input.subscription ? { ...input.subscription, unsubscribe, options: { applicationServerKey: null }, toJSON: () => ({ endpoint: input.subscription!.endpoint, keys: { p256dh: 'p', auth: 'a' } }) } : null;
  const created = { endpoint: 'https://push.example/new', unsubscribe, options: { applicationServerKey: null }, toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }) };
  const pushManager = { getSubscription: vi.fn(() => Promise.resolve(existing)), subscribe: vi.fn(() => Promise.resolve(created)) };
  const registration = { pushManager };
  vi.stubGlobal('Notification', Object.assign(function Notification() {}, { permission: input.permission, requestPermission: vi.fn(() => Promise.resolve(input.grant ?? input.permission)) }));
  vi.stubGlobal('PushManager', function PushManager() {});
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { register: vi.fn(() => Promise.resolve(registration)), ready: Promise.resolve(registration), getRegistration: vi.fn(() => Promise.resolve(registration)), addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  return { pushManager, unsubscribe };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
});

describe('the bell', () => {
  it('stands at the right of the chat header on a computer, counts unread news, and opens the list under itself', async () => {
    const s = server();
    renderApp('/agents/sales?thread=t1');
    const bell = await screen.findByRole('button', { name: 'Уведомления: 1 новое уведомление' });
    expect(bell).toHaveTextContent('1');
    const user = userEvent.setup();
    await user.click(bell);
    const panel = await screen.findByRole('dialog', { name: 'Уведомления' });
    expect(within(panel).getByRole('radio', { name: 'Уведомления · 1' })).toHaveAttribute('aria-checked', 'true');
    expect(await within(panel).findByText('Готово: Утренняя сводка')).toBeInTheDocument();
    expect(within(panel).getByText('Вам открыли проект «Тендер»')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Новое')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Отметить все прочитанными' }));
    await waitFor(() => expect(s.calls.find((c) => c.path === '/app/api/me/notifications/read')?.body).toEqual({ all: true }));
    expect(within(panel).queryByLabelText('Новое')).not.toBeInTheDocument();
  });

  it('opens a notification where it leads and marks it read', async () => {
    const s = server();
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Уведомления:/ }));
    await user.click(await screen.findByRole('button', { name: /Вам открыли проект «Тендер»/ }));
    await waitFor(() => expect(s.calls.find((c) => c.path === '/app/api/me/notifications/read')?.body).toEqual({ id: 'n2' }));
    expect(screen.queryByRole('dialog', { name: 'Уведомления' })).not.toBeInTheDocument();
    await waitFor(() => expect(s.calls.some((c) => c.path === '/app/api/projects/p1')).toBe(true));
  });

  it('is in the header of every screen on a computer and stays there with nothing new', async () => {
    server({ pendingApprovals: 0, unread: 0, latest: null });
    renderApp('/settings/memory');
    const header = (await screen.findByRole('button', { name: 'Уведомления: Нет новых уведомлений' })).closest('header')!;
    expect(within(header).getByText('Моя память')).toBeInTheDocument();
  });

  it('opens on «Ждут решения» while a question waits and counts it with the news', async () => {
    server({ pendingApprovals: 2, unread: 1, latest: READY });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Уведомления: 2 вопроса ждут решения, 1 новое уведомление' }));
    const panel = await screen.findByRole('dialog', { name: 'Уведомления' });
    expect(within(panel).getByRole('radio', { name: 'Ждут решения · 2' })).toHaveAttribute('aria-checked', 'true');
    expect(await within(panel).findByText('Ничего не ждёт вашего решения')).toBeInTheDocument();
  });

  it('gives no hint when reading the newest makes an older notification the newest', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const s = server({ pendingApprovals: 0, unread: 2, latest: { ...SHARED, id: 'n3', read: false, createdAt: '2026-11-21T07:00:00.000Z' } });
      renderApp('/agents/sales?thread=t1');
      await screen.findByRole('button', { name: /^Уведомления:/ });
      s.set('GET /app/api/me/notifications', { body: { pendingApprovals: 0, unread: 1, latest: READY } });
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Уведомления: 1 новое уведомление' })).toBeInTheDocument());
      expect(screen.queryByText(/Готово: Утренняя сводка ·/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a notification that came while the person is in the app as a hint inside the page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const s = server({ pendingApprovals: 0, unread: 0, latest: null });
      renderApp('/agents/sales?thread=t1');
      await screen.findByRole('button', { name: /^Уведомления:/ });
      expect(screen.queryByText(/Готово: Утренняя сводка/)).not.toBeInTheDocument();
      s.set('GET /app/api/me/notifications', { body: { pendingApprovals: 0, unread: 1, latest: READY } });
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(await screen.findByText('Готово: Утренняя сводка · Результат — в разговоре задачи.')).toBeInTheDocument();
      expect(s.pings.length).toBeGreaterThanOrEqual(2);
      expect(s.pings[0]!.body).toMatchObject({ visible: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('notifications of this browser', () => {
  it('names why a browser cannot: plain http, an iPhone outside the home screen, no support, refused in the browser', async () => {
    server();
    const first = renderApp('/settings/notifications');
    expect(await screen.findByText(/работают, только когда приложение открыто по https/)).toBeInTheDocument();
    first.unmount();

    stubBrowser({ permission: 'default' });
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1');
    const iphone = renderApp('/settings/notifications');
    expect(await screen.findByText(/добавить приложение на экран «Домой»/)).toBeInTheDocument();
    iphone.unmount();
    ua.mockRestore();

    stubBrowser({ permission: 'denied' });
    const denied = renderApp('/settings/notifications');
    expect(await screen.findByText(/запрещены в настройках браузера/)).toBeInTheDocument();
    denied.unmount();

    // No service worker in this browser.
    Reflect.deleteProperty(navigator, 'serviceWorker');
    renderApp('/settings/notifications');
    expect(await screen.findByText(/Этот браузер не умеет уведомления/)).toBeInTheDocument();
  });

  it('turns on: asks the browser, hands the subscription to the server and sends a trial push', async () => {
    const s = server();
    s.set('GET /app/api/push/key', { body: { publicKey: 'BAAA' } });
    s.set('POST /app/api/me/push-subscriptions', { body: { ok: true } });
    s.set('POST /app/api/me/push-test', { body: { sent: 1 } });
    s.set('POST /app/api/me/push-subscriptions/status', { body: { subscribed: true } });
    const browser = stubBrowser({ permission: 'default', grant: 'granted' });
    renderApp('/settings/notifications');
    expect(await screen.findByText('Выключены в этом браузере')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Включить' }));
    expect(await screen.findByText('Включены в этом браузере')).toBeInTheDocument();
    expect(browser.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(s.calls.find((c) => c.path === '/app/api/me/push-subscriptions' && c.method === 'POST')?.body).toEqual({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } });
    await waitFor(() => expect(s.calls.some((c) => c.path === '/app/api/me/push-test')).toBe(true));
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeInTheDocument();
  });

  // A shared computer whose last person did not press «Выйти»: their subscription is dropped in this browser.
  it('drops a subscription another person left in this browser, and reads as off', async () => {
    const s = server();
    s.set('POST /app/api/me/push-subscriptions/status', { body: { subscribed: false } });
    const browser = stubBrowser({ permission: 'granted', subscription: { endpoint: 'https://push.example/old' } });
    renderApp('/settings/notifications');
    expect(await screen.findByText('Выключены в этом браузере')).toBeInTheDocument();
    expect(browser.unsubscribe).toHaveBeenCalled();
  });

  it('signing out drops the subscription of this browser before the sign-out', async () => {
    const s = server();
    s.set('DELETE /app/api/me/push-subscriptions', { body: { ok: true } });
    s.set('POST /app/api/auth/sign-out', { body: { ok: true } });
    const browser = stubBrowser({ permission: 'granted', subscription: { endpoint: 'https://push.example/mine' } });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Настройки' }));
    await user.click(screen.getByRole('menuitem', { name: /Выйти/ }));
    await waitFor(() => expect(s.calls.some((c) => c.path === '/app/api/auth/sign-out')).toBe(true));
    expect(browser.unsubscribe).toHaveBeenCalled();
    const drop = s.calls.findIndex((c) => c.method === 'DELETE' && c.path === '/app/api/me/push-subscriptions');
    expect(s.calls[drop]?.body).toEqual({ endpoint: 'https://push.example/mine' });
    expect(drop).toBeLessThan(s.calls.findIndex((c) => c.path === '/app/api/auth/sign-out'));
  });
});
