import type { ApprovalsResponse, ChainDto, ChainPreviewResponse, ChainsResponse, NotificationsResponse } from '@bba/contracts';
import { api } from '../api/client.ts';

export const fetchApprovals = () => api<ApprovalsResponse>('GET', '/app/api/approvals');
export const decideApproval = (id: string, approved: boolean) => api<{ ok: true }>('POST', `/app/api/approvals/${encodeURIComponent(id)}/decision`, { approved });
export const fetchNotifications = () => api<NotificationsResponse>('GET', '/app/api/me/notifications');

// Multi-step approvals (docs/specs/[20.11.2026]-multi-step-approvals.md).
const C = '/app/api/approval-chains';
export const previewChain = (tool: string) => api<ChainPreviewResponse>('POST', `${C}/preview`, { tool });
export const sendChainReason = (toolCallId: string, comment: string) => api<{ ok: true }>('POST', `${C}/reason`, { toolCallId, comment });
export const fetchChains = () => api<ChainsResponse>('GET', C);
export const decideChain = (id: string, approve: boolean, reason?: string) => api<ChainDto>('POST', `${C}/${encodeURIComponent(id)}/decision`, { approve, ...(reason ? { reason } : {}) });
export const withdrawChain = (id: string) => api<ChainDto>('POST', `${C}/${encodeURIComponent(id)}/withdraw`, {});
export const retryChain = (id: string) => api<ChainDto>('POST', `${C}/${encodeURIComponent(id)}/retry`, {});
