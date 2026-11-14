// Screens of the employee: «Ждёт подтверждения» and «Настройки» (spec, section 7).
import type { ActionDescription } from './chat.ts';

export interface MemoryResponse {
  text: string;
  // Nothing remembered yet: empty or only the blank template.
  empty: boolean;
}

export interface MyUsage {
  month: { spentRub: number; limitRub: number | null; resetsOn: string };
  // Only when subscription models exist and a daily cap applies (spec, F5).
  daily: { usedTokens: number; capTokens: number } | null;
}

export type ConnectionAuth = 'oauth' | 'static' | 'identity';
export type ConnectionState = 'not_connected' | 'connected' | 'unverified' | 'auth_error';

export interface MyConnection {
  id: string;
  title: string;
  auth: ConnectionAuth;
  fields: { name: string; label: string; secret: boolean }[];
  status: ConnectionState;
  checkedAt: string | null;
}

export interface PendingApproval {
  id: string;
  agent: string;
  task: string | null;
  tool: string;
  // As the action was described when the question was asked.
  action: ActionDescription;
  args: unknown;
  createdAt: string;
  expiresAt: string;
}

export interface FailedRun {
  at: string;
  agent: string;
  task: string | null;
  event: string;
  tool: string | null;
  code: string | null;
}

export interface ApprovalsResponse {
  pending: PendingApproval[];
  failed: FailedRun[];
}

export interface NotificationsResponse {
  pendingApprovals: number;
  unreadResults: number;
}
