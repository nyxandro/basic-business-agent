import { z } from 'zod';
import { skillAccessSchema, type SkillAccess } from './skills.ts';

// «Режимы работы» (spec, scenario 4, section 8.6): background tasks the admin sets for the
// organisation, departments or employees; each fire runs on behalf of every employee in scope.
export const taskAccessSchema = skillAccessSchema;
export type TaskAccess = SkillAccess;

// The time is hh:mm in the installation's time zone; a week day is 1 (Monday) … 7 (Sunday).
export const taskScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time: z.string() }),
  z.object({ kind: z.literal('weekdays'), time: z.string() }),
  z.object({ kind: z.literal('weekly'), time: z.string(), weekday: z.number().int().min(1).max(7) }),
  z.object({ kind: z.literal('monthly'), time: z.string(), monthDay: z.number().int().min(1).max(28) }),
]);
export type TaskSchedule = z.infer<typeof taskScheduleSchema>;

// How a task starts (docs/specs/[20.11.2026]-event-tasks.md): by its schedule, on a letter in an employee's mailbox, or
// on a message another system sends to the task's address. The kind of a task does not change once it is made.
export const TASK_TRIGGERS = ['schedule', 'mail', 'webhook'] as const;
export type TaskTrigger = (typeof TASK_TRIGGERS)[number];

// The filter of a mail task: the sender — addresses or domains, any of them; the subject — words, any of them (case and
// «ё» do not matter). Both must fit; an empty list fits every letter.
export const MAIL_FILTER_ITEMS_MAX = 50;
export const mailFilterSchema = z.strictObject({
  from: z.array(z.string().max(254)).max(MAIL_FILTER_ITEMS_MAX),
  subject: z.array(z.string().max(200)).max(MAIL_FILTER_ITEMS_MAX),
});
export type MailFilter = z.infer<typeof mailFilterSchema>;

const taskBase = { title: z.string(), agentId: z.string().min(1), prompt: z.string() };
// A webhook task works on behalf of its executor (owner 21.11, F1), so it has no scope of its own.
export const taskCreateSchema = z.discriminatedUnion('trigger', [
  z.object({ ...taskBase, trigger: z.literal('schedule'), access: taskAccessSchema, schedule: taskScheduleSchema }),
  z.object({ ...taskBase, trigger: z.literal('mail'), access: taskAccessSchema, mailFilter: mailFilterSchema }),
  z.object({ ...taskBase, trigger: z.literal('webhook'), executorId: z.string().min(1) }),
]);
export type TaskCreate = z.infer<typeof taskCreateSchema>;
// A task of stage 1 with a cron that is no preset keeps it until a preset is chosen. Fields of another kind are refused.
export const taskUpdateSchema = z.object({ ...taskBase, access: taskAccessSchema, schedule: taskScheduleSchema, mailFilter: mailFilterSchema, executorId: z.string().min(1) }).partial();
export type TaskUpdate = z.infer<typeof taskUpdateSchema>;
export const taskStatusSchema = z.object({ status: z.enum(['active', 'paused']) });

export const RUN_OUTCOMES = ['queued', 'running', 'done', 'awaiting-approval', 'failed', 'skipped'] as const;
export type RunOutcomeName = (typeof RUN_OUTCOMES)[number];

// One fire of a task: how many people it reached and how it went for them.
export interface TaskFireSummary {
  fireAt: string;
  total: number;
  counts: Record<RunOutcomeName, number>;
}

export interface AdminTask {
  id: string;
  title: string;
  agentId: string;
  trigger: TaskTrigger;
  access: TaskAccess;
  // A schedule task: null — a cron of stage 1 that is no preset, shown as `cron`. Null for an event task.
  schedule: TaskSchedule | null;
  cron: string | null;
  mailFilter: MailFilter | null;
  // A webhook task: who it works for, and the address another system sends to (always visible; «Сменить адрес»).
  executor: { id: string; name: string } | null;
  hookUrl: string | null;
  // An event task: events of the last 24 hours that started a run, and those skipped (a flood, a pause, the executor).
  events: { fired: number; skipped: number } | null;
  prompt: string;
  status: 'active' | 'paused';
  // agent_missing — «Агента больше нет»; scope_empty — «Некому выполнять».
  pausedReason: string | null;
  createdBy: string | null;
  lastFire: TaskFireSummary | null;
}

export interface TaskRunDto {
  userId: string;
  name: string;
  outcome: RunOutcomeName;
  // Why a run was skipped or failed: no_access, blocked, awaiting_approval, too_late, an APP_* code.
  reasonCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

// An event of a task and what became of it (docs/specs/[20.11.2026]-event-tasks.md, section 8).
export const TASK_EVENT_OUTCOMES = ['queued', 'skipped_flood', 'skipped_paused', 'skipped_executor', 'done', 'awaiting-approval', 'failed'] as const;
export type TaskEventOutcome = (typeof TASK_EVENT_OUTCOMES)[number];

export interface TaskEventDto {
  id: string;
  receivedAt: string;
  // A message of another system: its first characters. A letter: nothing — the mail is the employee's.
  summary: string | null;
  // A letter: whose mailbox it came to.
  user: string | null;
  outcome: TaskEventOutcome;
  reasonCode: string | null;
}

export interface TaskEventsResponse {
  events: TaskEventDto[];
  // Messages the address refused in the last 24 hours.
  rejected: { tooLarge: number; badFormat: number };
}

// How many of the people of a mail task have a mailbox connected: «Сработает у N из M».
export const mailReachSchema = z.object({ agentId: z.string().min(1), access: taskAccessSchema });
export interface MailReachResponse {
  withMail: number;
  total: number;
}

export interface TaskRunsResponse {
  fireAt: string | null;
  runs: TaskRunDto[];
}

// «Режимы работы» → «Подтверждения» (docs/specs/[20.11.2026]-notifications.md, F4): how long a question «Да» waits, in
// hours — of a conversation and of a background task. A question keeps the term it was asked with.
export const APPROVAL_TTL_HOURS_MIN = 1;
export const APPROVAL_TTL_HOURS_MAX = 720;
const ttlHours = z.number().int().min(APPROVAL_TTL_HOURS_MIN).max(APPROVAL_TTL_HOURS_MAX);
export const approvalSettingsSchema = z.strictObject({ chatTtlHours: ttlHours, backgroundTtlHours: ttlHours });
export type ApprovalSettingsDto = z.infer<typeof approvalSettingsSchema>;
