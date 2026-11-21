// Notifications of an installation put together (docs/specs/[20.11.2026]-notifications.md): the VAPID keys, presence,
// the sender of pushes and the delivery loop. Called once at the start of the server (and of a test app).
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { createDelivery, type Delivery } from './delivery.ts';
import { createPresence, type Presence } from './presence.ts';
import { createPushSender, ensureVapidKeys, httpsTransport, vapidSubject, type PushSender, type PushTransport } from './push.ts';

export interface Notifications {
  presence: Presence;
  sender: PushSender;
  delivery: Delivery;
  publicKey: string;
  testOrigin: string | null;
}

export async function createNotifications(deps: {
  db: Db;
  box: SecretBox;
  timezone: string;
  // Tests: the fake push service (core/notifications/fake-push.ts) and a clock.
  push?: { transport: PushTransport; testOrigin: string };
  // The browser stand of e2e runs at any hour: no quiet night there.
  quietHours?: false;
  now?: () => Date;
  clock?: () => number;
}): Promise<Notifications> {
  const keys = await ensureVapidKeys(deps.db, deps.box);
  const presence = createPresence(deps.clock);
  const testOrigin = deps.push?.testOrigin ?? null;
  const sender = createPushSender({ keys, subject: () => vapidSubject(deps.db), transport: deps.push?.transport ?? httpsTransport, testOrigin });
  const delivery = createDelivery({ db: deps.db, presence, timezone: deps.timezone, sender, quietHours: deps.quietHours !== false, ...(deps.now ? { now: deps.now } : {}) });
  return { presence, sender, delivery, publicKey: keys.publicKey, testOrigin };
}
