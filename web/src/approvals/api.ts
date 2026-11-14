import type { ApprovalsResponse, NotificationsResponse } from '@bba/contracts';
import { api } from '../api/client.ts';

export const fetchApprovals = () => api<ApprovalsResponse>('GET', '/app/api/approvals');
export const decideApproval = (id: string, approved: boolean) => api<{ ok: true }>('POST', `/app/api/approvals/${encodeURIComponent(id)}/decision`, { approved });
export const fetchNotifications = () => api<NotificationsResponse>('GET', '/app/api/me/notifications');
