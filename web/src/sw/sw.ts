// The browser's handler of notifications, served at /sw.js (docs/specs/[20.11.2026]-notifications.md, steps 6 and 18).
// It shows every push it gets — never stays silent: Chrome then shows its own «сайт обновлён в фоне» and Safari drops
// the subscription after three silent pushes; whether a push goes at all is the server's to decide. A click opens the
// address of the notification in a tab of the app (an open one if there is). When the browser renews its subscription,
// the handler hands the new one to the server.
// Kept without imports: Vite serves it as it is while developing, and the build makes it one plain file.

interface PushPayload {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string;
}

interface WindowClientLike {
  url: string;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
}

interface WorkerScope {
  location: { origin: string };
  registration: {
    showNotification(title: string, options: { body: string; tag: string; icon: string; badge: string; data: { link: string }; lang: string }): Promise<void>;
    pushManager: { subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<{ toJSON(): unknown }> };
  };
  clients: { matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>; openWindow(url: string): Promise<unknown>; claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: string, listener: (event: never) => void): void;
}

interface ExtendableEventLike {
  waitUntil(work: Promise<unknown>): void;
}

const scope = self as unknown as WorkerScope;
const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-96.png';
// A push the handler cannot read still shows something: a silent push costs the subscription.
const FALLBACK: PushPayload = { id: 'bba-fallback', kind: 'unknown', title: 'Бизнес-агент', body: 'Новое уведомление. Откройте приложение.', link: '/' };

function readPayload(data: { json(): unknown } | null): PushPayload {
  try {
    const value = data?.json() as Partial<PushPayload> | undefined;
    if (value && typeof value.title === 'string' && typeof value.id === 'string') {
      return { id: value.id, kind: String(value.kind ?? 'unknown'), title: value.title, body: String(value.body ?? ''), link: typeof value.link === 'string' ? value.link : '/' };
    }
  } catch {
    // An unreadable push falls back below.
  }
  return FALLBACK;
}

// Only an address of this very app: a link is never taken to another site.
function inApp(link: string): string {
  const url = new URL(link, scope.location.origin);
  return url.origin === scope.location.origin ? url.href : scope.location.origin + '/';
}

function base64Url(value: string): Uint8Array {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

// A new handler takes over at once, so a fix to it reaches open tabs without closing them.
scope.addEventListener('install', (event: ExtendableEventLike) => event.waitUntil(scope.skipWaiting()));
scope.addEventListener('activate', (event: ExtendableEventLike) => event.waitUntil(scope.clients.claim()));

scope.addEventListener('push', (event: ExtendableEventLike & { data: { json(): unknown } | null }) => {
  const payload = readPayload(event.data);
  // The tag is the notification's id: the same notification delivered twice shows once.
  event.waitUntil(scope.registration.showNotification(payload.title, { body: payload.body, tag: payload.id, icon: ICON, badge: BADGE, data: { link: payload.link }, lang: 'ru' }));
});

scope.addEventListener('notificationclick', (event: ExtendableEventLike & { notification: { close(): void; data?: { link?: string } } }) => {
  event.notification.close();
  const target = inApp(event.notification.data?.link ?? '/');
  event.waitUntil(
    (async () => {
      const open = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const tab = open.find((c) => new URL(c.url).origin === scope.location.origin);
      if (tab) {
        await tab.focus();
        await tab.navigate(target);
        return;
      }
      await scope.clients.openWindow(target);
    })(),
  );
});

// The browser renewed the subscription (Safari, Firefox): the server learns the new address, or the person would get
// nothing until they turn notifications on again.
scope.addEventListener('pushsubscriptionchange', (event: ExtendableEventLike) => {
  event.waitUntil(
    (async () => {
      const keyRes = await fetch('/app/api/push/key', { credentials: 'same-origin' });
      if (!keyRes.ok) return;
      const { publicKey } = (await keyRes.json()) as { publicKey: string };
      const subscription = await scope.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64Url(publicKey) });
      await fetch('/app/api/me/push-subscriptions', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription.toJSON()) });
    })(),
  );
});
