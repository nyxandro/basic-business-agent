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

export const taskCreateSchema = z.object({
  title: z.string(),
  agentId: z.string().min(1),
  access: taskAccessSchema,
  schedule: taskScheduleSchema,
  prompt: z.string(),
});
export type TaskCreate = z.infer<typeof taskCreateSchema>;
// A task of stage 1 with a cron that is no preset keeps it until a preset is chosen.
export const taskUpdateSchema = taskCreateSchema.partial();
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
  access: TaskAccess;
  // null — a cron of stage 1 that is no preset, shown as `cron`.
  schedule: TaskSchedule | null;
  cron: string;
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

export interface TaskRunsResponse {
  fireAt: string | null;
  runs: TaskRunDto[];
}
