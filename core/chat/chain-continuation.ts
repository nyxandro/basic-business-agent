// How a request ends in the employee's conversation (docs/specs/[20.11.2026]-multi-step-approvals.md, scenario 4):
// a line of its outcome, and after a done request the agent goes on there (owner 21.11, F3) — a new turn on the
// employee's limit, told the outcome: «если работа от этого зависела — продолжи». Both wait for a turn going on in that
// conversation to end; with the limit spent there is only the line.
import { randomUUID } from 'node:crypto';
import type { Memory } from '@mastra/memory';
import { RequestContext } from '@mastra/core/request-context';
import type { Activity } from '../notifications/activity.ts';
import { settleSnapshot, takeSnapshot } from '../projects/trash.ts';
import { projectArea, userArea } from '../storage/areas.ts';
import type { FileStorage } from '../storage/engine.ts';
import { abilitiesValue, readAbilities } from '../abilities/abilities.ts';
import { holdThreadForServer, releaseThreadForServer } from './run.ts';
import { CHAIN_OUTCOME_PREFIX } from './service-turns.ts';
import type { Db } from '../db/pool.ts';
import { resolveAgent, type EditorDeps } from '../editor/prompts.ts';
import type { ModelGateway } from '../models/gateway.ts';
import { chooseModels } from '../models/resolve.ts';
import { runProjectOfWaitingAnswer } from '../projects/access.ts';
import { REQUEST_KEYS } from '../run-context/request-keys.ts';
import { logEvent } from '../log/log.ts';
import type { SkillsRuntime } from '../skills-admin/runtime.ts';
import { chainNumber, statusText, type ChainRow } from '../approvals/chains.ts';

const WAIT_STEP_MS = 2000;
// A conversation busy longer than this keeps its line only: the continuation is not worth starting late.
const WAIT_MAX_MS = 30 * 60 * 1000;

export interface ChainContinuation {
  after(row: ChainRow, result: unknown, code: string | null): Promise<void>;
  // Resolves when the lines and turns started so far are done (tests, shutdown).
  idle(): Promise<void>;
}

export interface ChainContinuationDeps {
  db: Db;
  memory: Memory;
  editor: EditorDeps;
  timezone: string;
  gateway: Pick<ModelGateway, 'assertWithinBudget'>;
  skills: Pick<SkillsRuntime, 'skillsFor'>;
  // As every run (spec, sections 8.20 and 8.23): the folder held, the project's files remembered, the ring of work.
  storage: Pick<FileStorage, 'hold'>;
  workspaceRoot: string;
  activity: Pick<Activity, 'start'>;
}

async function lineOf(db: Db, row: ChainRow, code: string | null): Promise<string> {
  const { rows } = await db.query<{ name: string | null; decision: string; reason: string | null }>(
    `SELECT u."name", d.decision, d.reason FROM app.approval_chain_decisions d LEFT JOIN app."user" u ON u."id" = d.user_id WHERE d.chain_id = $1 ORDER BY d.at`,
    [row.id],
  );
  const agreed = rows.filter((r) => r.decision !== 'declined').map((r) => r.name).filter(Boolean);
  const declined = rows.find((r) => r.decision === 'declined');
  const head = `Согласование ${chainNumber(String(row.id))} · ${row.summary}: ${statusText(row.status)}`;
  if (row.status === 'declined' && declined) return `${head} — ${declined.name ?? 'согласующий'}: «${declined.reason ?? ''}».`;
  if (row.status === 'done') return `${head}${agreed.length ? ` (согласовали: ${agreed.join(', ')})` : ''}.`;
  if (row.status === 'failed') return `${head}. Код: ${code ?? 'APP_TOOL_FAILED'}. Повторить выполнение можно в «Ждёт подтверждения» → «Мои заявки» в течение 72 часов.`;
  if (row.status === 'unknown_outcome') return `${head}. Проверьте в системе, прошло ли действие; повтора не будет.`;
  return `${head}.`;
}

export function createChainContinuation(deps: ChainContinuationDeps): ChainContinuation {
  const { db, memory } = deps;
  const pending = new Set<Promise<void>>();

  async function waitForThread(threadId: string): Promise<boolean> {
    const until = Date.now() + WAIT_MAX_MS;
    while (!holdThreadForServer(threadId)) {
      if (Date.now() > until) return false;
      await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
    }
    return true;
  }

  async function goOn(row: ChainRow, result: unknown): Promise<void> {
    try {
      await deps.gateway.assertWithinBudget(row.user_id);
    } catch (error) {
      logEvent('info', 'approval_chain_continuation_skipped', { chainId: row.id, error });
      return;
    }
    const abilities = await readAbilities(db, row.agent_id);
    const [project, models, skillPaths] = await Promise.all([runProjectOfWaitingAnswer(db, row.project_id), chooseModels(db, deps.timezone, row.user_id, row.agent_id), deps.skills.skillsFor(row.agent_id, { documents: abilities.commands })]);
    const rc = new RequestContext();
    rc.set(REQUEST_KEYS.userId, row.user_id);
    rc.set(REQUEST_KEYS.threadId, row.thread_id);
    rc.set(REQUEST_KEYS.agentId, row.agent_id);
    rc.set(REQUEST_KEYS.runKind, row.run_kind);
    rc.set(REQUEST_KEYS.runStartedAt, String(Date.now()));
    if (row.task_id) rc.set(REQUEST_KEYS.taskId, row.task_id);
    rc.set(REQUEST_KEYS.modelId, models.primary);
    if (models.fallback) rc.set(REQUEST_KEYS.fallbackModelId, models.fallback);
    if (project.projectId && project.projectOwnerId) {
      rc.set(REQUEST_KEYS.projectId, project.projectId);
      rc.set(REQUEST_KEYS.projectOwnerId, project.projectOwnerId);
    }
    rc.set(REQUEST_KEYS.skillPaths, JSON.stringify(skillPaths));
    rc.set(REQUEST_KEYS.abilities, abilitiesValue(abilities));
    const agent = await resolveAgent(deps.editor, row.agent_id, 'published');
    const release = await deps.storage.hold(project.projectId && project.projectOwnerId ? projectArea(project.projectId, project.projectOwnerId) : userArea(row.user_id), 'write');
    const idle = deps.activity.start(row.user_id, row.thread_id);
    const snapshot = project.projectId && project.projectOwnerId ? takeSnapshot(deps.workspaceRoot, { projectId: project.projectId, ownerId: project.projectOwnerId, userId: row.user_id, threadId: row.thread_id }) : null;
    if (snapshot) rc.set(REQUEST_KEYS.projectSnapshot, snapshot.id);
    try {
      await turn(agent, rc, row, result);
    } finally {
      if (snapshot) await settleSnapshot(db, deps.workspaceRoot, snapshot).catch((error: unknown) => logEvent('error', 'project_trash_settle_failed', { code: 'APP_INTERNAL', projectId: snapshot.projectId, error }));
      idle();
      await release();
    }
  }

  async function turn(agent: Awaited<ReturnType<typeof resolveAgent>>, rc: RequestContext, row: ChainRow, result: unknown): Promise<void> {
    const told = `${CHAIN_OUTCOME_PREFIX}${chainNumber(String(row.id))}] Действие «${row.summary}» согласовано и выполнено. Ответ системы: ${JSON.stringify(result).slice(0, 4000)}. Если работа в этом разговоре от этого действия зависела — продолжи её; иначе коротко сообщи итог.`;
    const stream = await agent.stream(told, { memory: { thread: row.thread_id, resource: row.user_id }, requestContext: rc });
    for await (const part of stream.fullStream) if (part.type === 'error') throw (part.payload as { error: unknown }).error;
  }

  async function run(row: ChainRow, result: unknown, code: string | null): Promise<void> {
    const thread = await memory.getThreadById({ threadId: row.thread_id });
    // The conversation was removed: the outcome stays in the notification and «Мои заявки».
    if (!thread || thread.resourceId !== row.user_id) return;
    const chat = !row.thread_id.startsWith('bg:') && !row.thread_id.startsWith('ev:');
    const held = chat ? await waitForThread(row.thread_id) : true;
    try {
      await memory.saveMessages({
        messages: [{ id: randomUUID(), threadId: row.thread_id, resourceId: row.user_id, role: 'assistant', createdAt: new Date(), content: { format: 2, parts: [{ type: 'text', text: await lineOf(db, row, code) }] } }],
      });
      // A conversation busy for half an hour keeps the line only: the agent does not barge into a turn going on.
      if (row.status === 'done' && held) await goOn(row, result);
      if (!held) logEvent('warn', 'approval_chain_continuation_skipped', { chainId: row.id, reason: 'thread_busy' });
    } finally {
      if (chat && held) releaseThreadForServer(row.thread_id);
    }
  }

  return {
    after(row, result, code) {
      const work = run(row, result, code).catch((error: unknown) => logEvent('error', 'approval_chain_continuation_failed', { chainId: row.id, error }));
      pending.add(work);
      void work.finally(() => pending.delete(work));
      return Promise.resolve();
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
