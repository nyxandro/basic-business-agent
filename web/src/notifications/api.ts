// The server's side of notifications (docs/specs/[20.11.2026]-notifications.md, section 17).
import type { ApprovalStateResponse, NotificationList, NotificationsResponse, PresenceInput, PushKeyResponse, PushStatusResponse } from '@bba/contracts';
import { api } from '../api/client.ts';

export const fetchCounts = () => api<NotificationsResponse>('GET', '/app/api/me/notifications');
export const sendPresence = (input: PresenceInput) => api<NotificationsResponse>('POST', '/app/api/me/presence', input);
// «Hidden» as the tab goes away — closed, the phone locked: `keepalive` lets the browser finish it after the page is gone,
// so the server pushes at once instead of believing the person is here for another minute.
export function sendHidden(tab: string): void {
  fetch('/app/api/me/presence', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tab, visible: false, threadId: null } satisfies PresenceInput),
  }).catch((error: unknown) => console.warn('presence not sent', error));
}
export const fetchList = () => api<NotificationList>('GET', '/app/api/me/notifications/list');
export const markRead = (id: string) => api<{ ok: true }>('POST', '/app/api/me/notifications/read', { id });
export const markAllRead = () => api<{ ok: true }>('POST', '/app/api/me/notifications/read', { all: true });
export const fetchPushKey = () => api<PushKeyResponse>('GET', '/app/api/push/key');
export const saveSubscription = (subscription: PushSubscriptionJSON) => api<{ ok: true }>('POST', '/app/api/me/push-subscriptions', subscription);
export const dropSubscription = (endpoint: string) => api<{ ok: true }>('DELETE', '/app/api/me/push-subscriptions', { endpoint });
export const subscriptionStatus = (endpoint: string) => api<PushStatusResponse>('POST', '/app/api/me/push-subscriptions/status', { endpoint });
export const sendTestPush = () => api<{ sent: number }>('POST', '/app/api/me/push-test');
export const fetchApprovalState = (id: string) => api<ApprovalStateResponse>('GET', `/app/api/approvals/${encodeURIComponent(id)}`);
