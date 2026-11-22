// Multi-step approvals (docs/specs/[20.11.2026]-multi-step-approvals.md): rules on actions of agents, requests that run
// once every stage of approvers agreed, the heads of departments who approve at a stage «руководитель отдела».
import { z } from 'zod';
import type { ActionDescription } from './chat.ts';

export const RULE_STAGES_MAX = 5;
export const STAGE_APPROVERS_MAX = 10;
export const CHAIN_REASON_MIN = 5;
export const CHAIN_REASON_MAX = 2000;

// An approver of a stage: the heads of the employee's departments, or a named person; any of a stage decides.
export const ruleApproverSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('head') }), z.strictObject({ kind: z.literal('user'), userId: z.string().min(1) })]);
export type RuleApprover = z.infer<typeof ruleApproverSchema>;

export const approvalRuleInputSchema = z.strictObject({
  // The action as agents call it (its name in the agent's tools).
  target: z.string().min(1).max(200),
  stages: z.array(z.array(ruleApproverSchema).min(1).max(STAGE_APPROVERS_MAX)).min(1).max(RULE_STAGES_MAX),
  enabled: z.boolean(),
});
export type ApprovalRuleInput = z.infer<typeof approvalRuleInputSchema>;

export interface ApprovalRuleDto extends ApprovalRuleInput {
  id: string;
  // The name of the action for people; null — no agent has this action now.
  title: string | null;
}

export interface ApprovalRulesResponse {
  rules: ApprovalRuleDto[];
  // The actions a rule may be set on: those that change data, of every agent, the mailbox and the connected systems.
  actions: { target: string; title: string; system: string | null }[];
}

export const departmentHeadsSchema = z.strictObject({ userIds: z.array(z.string().min(1)).max(STAGE_APPROVERS_MAX) });

// «Зачем — увидят согласующие», sent by the card of «Да» before the answer.
export const chainReasonSchema = z.strictObject({ toolCallId: z.string().min(1).max(200), comment: z.string().trim().min(CHAIN_REASON_MIN).max(CHAIN_REASON_MAX) });

// What the card of «Да» shows for a call under a rule: the stages by their names.
export interface ChainPreviewResponse {
  stages: string[] | null;
}

export const CHAIN_STATUSES = ['pending', 'executing', 'done', 'failed', 'declined', 'expired', 'withdrawn', 'unknown_outcome'] as const;
export type ChainStatus = (typeof CHAIN_STATUSES)[number];

export interface ChainDecisionDto {
  stage: number;
  name: string | null;
  decision: 'approved' | 'declined' | 'self';
  reason: string | null;
  at: string;
}

export interface ChainDto {
  id: string;
  status: ChainStatus;
  // The stage now (1-based) and the names of every stage.
  stage: number;
  stages: string[];
  action: ActionDescription & { tool: string };
  // The parameters as the action gets them: the approver is a colleague, masking is for the model.
  args: unknown;
  comment: string;
  requester: string;
  agent: string;
  createdAt: string;
  stageExpiresAt: string;
  decisions: ChainDecisionDto[];
  errorCode: string | null;
  // What the viewer may do now.
  canDecide: boolean;
  canWithdraw: boolean;
  canRetry: boolean;
}

export interface ChainsResponse {
  // Requests waiting for the viewer's decision, and the viewer's own requests.
  forMe: ChainDto[];
  mine: ChainDto[];
}

export const chainDecisionSchema = z.strictObject({ approve: z.boolean(), reason: z.string().trim().max(CHAIN_REASON_MAX).optional() });
