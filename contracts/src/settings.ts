// Screens of the employee: «Ждёт подтверждения» and «Настройки» (spec, section 7).
import type { ActionDescription } from './chat.ts';

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
  // A question of a conversation (decision of the owner 21.11, F4): it is answered there, on its card «Да»; the list
  // shows it with a link to the conversation.
  conversation: { threadId: string; agentId: string; title: string } | null;
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

// A question by its id — where an old notification leads: still waiting, or what became of it and when.
export type ApprovalStatusDto = 'pending' | 'approved' | 'declined' | 'expired' | 'failed';
export interface ApprovalStateResponse {
  id: string;
  status: ApprovalStatusDto;
  action: string;
  decidedAt: string | null;
}
