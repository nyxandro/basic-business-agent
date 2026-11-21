// Notifications in the browser and the list under the bell (docs/specs/[20.11.2026]-notifications.md).
import { z } from 'zod';

export const NOTIFICATION_KINDS = [
  'approval_waiting',
  'approval_expiring',
  'connection_broken',
  'task_result',
  'task_failed',
  'project_shared',
  'limit_near',
  'limit_exhausted',
  'answer_ready',
  'answer_failed',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// Kinds about a question «Да»: the question itself is counted in «Ждут решения», so they never add to the bell's count.
export const APPROVAL_NOTIFICATION_KINDS: readonly NotificationKind[] = ['approval_waiting', 'approval_expiring'];

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  // An address inside the app.
  link: string;
  createdAt: string;
  read: boolean;
}

export interface NotificationList {
  items: NotificationItem[];
}

// The state of a conversation in the lists (decision of the owner 22.11), by precedence: an agent works there now; a
// question «Да» waits for the person; its answer broke while nobody watched; its answer is ready while nobody watched.
// The last two go when the conversation is opened.
export const THREAD_STATES = ['running', 'waiting', 'failed', 'done'] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

// The bell: questions waiting for the person's decision, unread notifications besides questions, and the newest unread
// one — the page shows it as a hint when it is new (the person is in the app, so no push came); and the states of the
// person's conversations that have one.
export interface NotificationsResponse {
  pendingApprovals: number;
  unread: number;
  latest: NotificationItem | null;
  threads: Record<string, ThreadState>;
}

// A visible tab says «I am here» this often; a hidden one says «hidden» at once (the server pushes then).
export const PRESENCE_PING_MS = 30_000;

export const presenceInputSchema = z.strictObject({
  // A random id of the tab, made when the page loads.
  tab: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  visible: z.boolean(),
  // The conversation on the screen of this tab; null — another screen. An answer that ends with its conversation on no
  // visible screen is told «Ответ готов» (owner, 22.11: left for another chat while the agent answered).
  threadId: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/).nullable(),
});
export type PresenceInput = z.infer<typeof presenceInputSchema>;

export interface PushKeyResponse {
  publicKey: string;
}

// What the browser's PushSubscription.toJSON() gives.
export const pushSubscriptionInputSchema = z.object({
  endpoint: z.url({ protocol: /^https?$/ }).max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;

export const pushUnsubscribeSchema = z.strictObject({ endpoint: z.string().max(2048) });

// Whether this browser gets notifications: the server knows its subscription by the address.
export interface PushStatusResponse {
  subscribed: boolean;
}

// What the browser's handler gets in a push (kept small: a push holds up to ~4 KB).
export interface PushPayload {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string;
}
