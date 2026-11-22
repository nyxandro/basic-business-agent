// Requests of multi-step approvals (docs/specs/[20.11.2026]-multi-step-approvals.md, sections 5 and 8). After the
// employee's «Да» an action under a rule is not run: a request is made — its full parameters encrypted, the stages and
// their approvers as resolved now — and the run of the agent gets «отправлено на согласование №N» at once. The request
// lives outside the run: a new message does not cancel it. Each stage is decided once, by any of its approvers; the last
// agreement hands the request to the execution (execute.ts). Every stage waits 72 hours.
import { createHash } from 'node:crypto';
import type { ActionDescription, ChainDto, ChainStatus } from '@bba/contracts';
import type { SecretBox } from '../crypto/secret-box.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { writeJournal } from '../journal/journal.ts';
import { notices } from '../notifications/kinds.ts';
import { notify } from '../notifications/notify.ts';
import { logEvent } from '../server/log.ts';
import { resolveStages } from './approvers.ts';
import { rulesFor } from './rules.ts';

export const STAGE_HOURS = 72;
export const RETRY_HOURS = 72;

export interface ChainRequest {
  userId: string;
  agentId: string;
  threadId: string;
  projectId: string | null;
  runKind: 'chat' | 'background';
  taskId: string | null;
  target: string;
  args: unknown;
  action: ActionDescription;
  toolCallId: string;
}

export interface ChainSent {
  status: 'sent_for_approval' | 'already_waiting';
  id: string;
  stages: string[];
  note: string;
}

export interface ChainRow {
  id: string;
  user_id: string;
  agent_id: string;
  thread_id: string;
  project_id: string | null;
  run_kind: 'chat' | 'background';
  task_id: string | null;
  target: string;
  args_ciphertext: Buffer;
  args_iv: Buffer;
  args_key_version: number;
  summary: string;
  labels: ActionDescription;
  comment: string;
  stages: string[][];
  stage_names: string[];
  stage: number;
  status: ChainStatus;
  call_started_at: Date | null;
  result: unknown;
  error_code: string | null;
  created_at: Date;
  stage_expires_at: Date;
  retry_until: Date | null;
}

// The constant line the model follows after a request is sent (as the note of memory and widgets).
export const SENT_NOTE = 'Действие не выполнено, пока его не согласуют. Скажи сотруднику номер заявки и кто согласует; итог придёт в этот разговор, и ты сможешь продолжить работу.';

const argsHash = (target: string, args: unknown) => createHash('sha256').update(`${target}\n${JSON.stringify(args ?? null)}`).digest('hex');
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000);

export const chainNumber = (id: string) => `№${id}`;

export function openArgs(box: SecretBox, row: Pick<ChainRow, 'args_ciphertext' | 'args_iv' | 'args_key_version'>): unknown {
  return JSON.parse(box.open({ ciphertext: row.args_ciphertext, iv: row.args_iv, keyVersion: row.args_key_version })) as unknown;
}

export async function chainRow(db: Db, id: string): Promise<ChainRow | null> {
  if (!/^\d+$/.test(id)) return null;
  const { rows } = await db.query<ChainRow>('SELECT * FROM app.approval_chains WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function tellApprovers(db: Db, row: Pick<ChainRow, 'id' | 'user_id' | 'labels' | 'stage' | 'stages'>): Promise<void> {
  const { rows } = await db.query<{ name: string }>('SELECT "name" FROM app."user" WHERE "id" = $1', [row.user_id]);
  for (const userId of row.stages[row.stage - 1] ?? []) {
    if (userId === row.user_id) continue;
    await notify(db, notices.chainWaiting({ userId, chainId: row.id, action: row.labels.title, requester: rows[0]?.name ?? '' , stage: row.stage, stages: row.stages.length }));
  }
}

// The first stage the employee does not pass by themselves (F4), from `from` (1-based); past the last — 0.
function nextStage(stages: string[][], selfStages: Set<number>, from: number): number {
  for (let n = from; n <= stages.length; n++) if (!selfStages.has(n)) return n;
  return 0;
}

export interface ChainService {
  // A call of an action under a rule: the request, or the one already waiting for the same call.
  send(request: ChainRequest): Promise<ChainSent>;
  rulesApply(target: string): Promise<boolean>;
}

// A request agreed at once (every stage the employee's own) is taken by the execution's sweep (execute.ts, every 10 s).
export function createChainService(deps: { db: Db; box: SecretBox }): ChainService {
  const { db, box } = deps;
  return {
    async rulesApply(target) {
      return (await rulesFor(db, target)).length > 0;
    },

    async send(request) {
      const rules = await rulesFor(db, request.target);
      if (rules.length === 0) throw new Error(`no approval rule on ${request.target}: the policy asked for a request without one`);
      const reason = await db.query<{ comment: string }>('DELETE FROM app.approval_chain_reasons WHERE user_id = $1 AND tool_call_id = $2 RETURNING comment', [request.userId, request.toolCallId]);
      const comment = reason.rows[0]?.comment;
      const hash = argsHash(request.target, request.args);
      const waiting = await db.query<{ id: string; stage_names: string[] }>(`SELECT id, stage_names FROM app.approval_chains WHERE user_id = $1 AND target = $2 AND args_hash = $3 AND status IN ('pending', 'executing')`, [request.userId, request.target, hash]);
      if (waiting.rows[0]) return { status: 'already_waiting', id: String(waiting.rows[0].id), stages: waiting.rows[0].stage_names, note: `Это действие с такими же параметрами уже на согласовании (${chainNumber(String(waiting.rows[0].id))}): новая заявка не нужна.` };
      if (!comment) throw appError('APP_CHAIN_REASON_REQUIRED', `no reason for the request of call ${request.toolCallId}`);
      const resolved = await resolveStages(db, request.userId, rules.flatMap((r) => r.stages));
      const selfStages = new Set(resolved.flatMap((s, i) => (s.self ? [i + 1] : [])));
      const stages = resolved.map((s) => s.approvers);
      const first = nextStage(stages, selfStages, 1);
      const sealed = box.seal(JSON.stringify(request.args ?? null));
      const id = await inTransaction(db, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO app.approval_chains (user_id, agent_id, thread_id, project_id, run_kind, task_id, target, args_ciphertext, args_iv, args_key_version, args_hash,
                                            summary, labels, comment, stages, stage_names, stage, status, stage_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
          [request.userId, request.agentId, request.threadId, request.projectId, request.runKind, request.taskId, request.target, sealed.ciphertext, sealed.iv, sealed.keyVersion, hash,
           request.action.title, JSON.stringify(request.action), comment, JSON.stringify(stages), JSON.stringify(resolved.map((s) => s.name)), first || stages.length, first ? 'pending' : 'executing', hoursFromNow(STAGE_HOURS)],
        );
        const chainId = String(rows[0]!.id);
        for (const n of selfStages) await c.query(`INSERT INTO app.approval_chain_decisions (chain_id, stage, user_id, decision) VALUES ($1, $2, $3, 'self')`, [chainId, n, request.userId]);
        return chainId;
      });
      await writeJournal(db, { userId: request.userId, agentId: request.agentId, runKind: request.runKind, taskId: request.taskId, event: 'approval_chain_created', tool: request.target, args: request.args, result: 'sent', approvedBy: request.userId });
      logEvent('info', 'approval_chain_created', { chainId: id, target: request.target, stages: stages.length });
      if (first) await tellApprovers(db, { id, user_id: request.userId, labels: request.action, stage: first, stages });
      return { status: 'sent_for_approval', id, stages: resolved.map((s) => s.name), note: SENT_NOTE };
    },
  };
}

// A decision of an approver on the stage now: «Согласовать» goes to the next stage or to the execution; «Отклонить» —
// with a reason — ends the request. The same request decided twice gets «уже решена».
// Resolves `true` when the decision was the last agreement: the request is now for the execution (execute.ts).
export async function decideChain(db: Db, chainId: string, userId: string, approve: boolean, reason: string | undefined): Promise<boolean> {
  if (!approve && !reason?.trim()) throw appError('APP_VALIDATION_FAILED', 'a decline without a reason', { userMessage: 'Напишите причину — её увидит сотрудник.' });
  const outcome = await inTransaction(db, async (c) => {
    const { rows } = await c.query<ChainRow>('SELECT * FROM app.approval_chains WHERE id = $1 FOR UPDATE', [chainId]);
    const row = rows[0];
    if (!row || !(row.stages[row.stage - 1] ?? []).includes(userId) && row.status === 'pending') throw appError('APP_NOT_FOUND', `chain ${chainId} is not waiting for ${userId}`, { userMessage: 'Такой заявки нет.' });
    if (row.status !== 'pending') throw appError('APP_APPROVAL_DECIDED', `chain ${chainId} is ${row.status}`, { userMessage: `Заявка уже решена: ${statusText(row.status)}.` });
    await c.query('INSERT INTO app.approval_chain_decisions (chain_id, stage, user_id, decision, reason) VALUES ($1, $2, $3, $4, $5)', [chainId, row.stage, userId, approve ? 'approved' : 'declined', reason?.trim() || null]);
    if (!approve) {
      await c.query(`UPDATE app.approval_chains SET status = 'declined', finished_at = now() WHERE id = $1`, [chainId]);
      return { row, next: null as number | null, declined: true };
    }
    const selfDone = await c.query<{ stage: number }>(`SELECT stage FROM app.approval_chain_decisions WHERE chain_id = $1 AND decision = 'self'`, [chainId]);
    const next = nextStage(row.stages, new Set(selfDone.rows.map((r) => r.stage)), row.stage + 1);
    if (next) await c.query(`UPDATE app.approval_chains SET stage = $2, stage_expires_at = $3 WHERE id = $1`, [chainId, next, hoursFromNow(STAGE_HOURS)]);
    else await c.query(`UPDATE app.approval_chains SET status = 'executing' WHERE id = $1`, [chainId]);
    return { row, next, declined: false };
  });
  const { row } = outcome;
  await writeJournal(db, { userId: row.user_id, agentId: row.agent_id, runKind: row.run_kind, taskId: row.task_id, event: 'approval_stage', tool: row.target, approvedBy: userId, result: approve ? 'approved' : 'declined' });
  logEvent('info', 'approval_stage_decided', { chainId, stage: row.stage, approve });
  if (outcome.declined) {
    await notify(db, notices.chainResult({ userId: row.user_id, chainId, action: row.summary, outcome: 'declined', agentId: row.agent_id, threadId: row.thread_id }));
    return false;
  }
  if (outcome.next) {
    await tellApprovers(db, { ...row, stage: outcome.next });
    return false;
  }
  return true;
}

export async function withdrawChain(db: Db, chainId: string, userId: string): Promise<void> {
  const { rows } = await db.query<ChainRow>(`UPDATE app.approval_chains SET status = 'withdrawn', finished_at = now() WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING *`, [chainId, userId]);
  const row = rows[0];
  if (!row) throw appError('APP_APPROVAL_DECIDED', `chain ${chainId} cannot be withdrawn by ${userId}`, { userMessage: 'Заявку уже нельзя отозвать: она решена или не ваша.' });
  for (const approver of row.stages[row.stage - 1] ?? []) await notify(db, notices.chainWithdrawn({ userId: approver, chainId, action: row.summary }));
}

// Stages past their 72 hours: the request ends, the employee is told.
export async function expireChains(db: Db): Promise<number> {
  const { rows } = await db.query<ChainRow>(`UPDATE app.approval_chains SET status = 'expired', finished_at = now() WHERE status = 'pending' AND stage_expires_at < now() RETURNING *`);
  for (const row of rows) await notify(db, notices.chainResult({ userId: row.user_id, chainId: row.id, action: row.summary, outcome: 'expired', agentId: row.agent_id, threadId: row.thread_id }));
  return rows.length;
}

export function statusText(status: ChainStatus): string {
  const texts: Record<ChainStatus, string> = {
    pending: 'на согласовании',
    executing: 'согласовано, выполняется',
    done: 'согласовано и выполнено',
    failed: 'согласовано, но не выполнено',
    declined: 'отклонено',
    expired: 'истекло',
    withdrawn: 'отозвано',
    unknown_outcome: 'неизвестно, выполнено ли действие',
  };
  return texts[status];
}

// A request as the screen shows it to `viewer`: the requester and its approvers see it; nobody else.
export async function chainDto(db: Db, box: SecretBox, row: ChainRow, viewer: string, agentName: (id: string) => string): Promise<ChainDto> {
  const { rows: people } = await db.query<{ id: string; name: string }>('SELECT "id", "name" FROM app."user" WHERE "id" = ANY($1)', [[row.user_id, ...row.stages.flat()]]);
  const nameOf = (id: string | null) => (id ? (people.find((p) => p.id === id)?.name ?? null) : null);
  const decisions = await db.query<{ stage: number; user_id: string | null; decision: 'approved' | 'declined' | 'self'; reason: string | null; at: Date }>('SELECT stage, user_id, decision, reason, at FROM app.approval_chain_decisions WHERE chain_id = $1 ORDER BY at', [row.id]);
  const approverNow = row.status === 'pending' && (row.stages[row.stage - 1] ?? []).includes(viewer);
  return {
    id: String(row.id),
    status: row.status,
    stage: row.stage,
    stages: row.stage_names,
    action: { ...row.labels, tool: row.target },
    args: openArgs(box, row),
    comment: row.comment,
    requester: nameOf(row.user_id) ?? '',
    agent: agentName(row.agent_id),
    createdAt: row.created_at.toISOString(),
    stageExpiresAt: row.stage_expires_at.toISOString(),
    decisions: decisions.rows.map((d) => ({ stage: d.stage, name: nameOf(d.user_id), decision: d.decision, reason: d.reason, at: d.at.toISOString() })),
    errorCode: row.error_code,
    canDecide: approverNow && row.user_id !== viewer,
    canWithdraw: row.user_id === viewer && row.status === 'pending',
    canRetry: row.user_id === viewer && row.status === 'failed' && row.retry_until !== null && row.retry_until.getTime() > Date.now(),
  };
}

export async function canSee(db: Db, row: ChainRow, viewer: string): Promise<boolean> {
  if (row.user_id === viewer || row.stages.flat().includes(viewer)) return true;
  const { rowCount } = await db.query('SELECT 1 FROM app.approval_chain_decisions WHERE chain_id = $1 AND user_id = $2', [row.id, viewer]);
  return (rowCount ?? 0) > 0;
}
