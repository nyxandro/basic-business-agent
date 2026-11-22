// The execution of an agreed request (docs/specs/[20.11.2026]-multi-step-approvals.md, scenario 4, section 8). The
// server calls the very action the employee asked for, with the parameters of the request, on the employee's behalf —
// their access, the agent as it is now — and never twice:
// - the request is taken by one row change that also writes «вызов начат» (`call_started_at`);
// - a request found at the start with «вызов начат» and no result is «итог неизвестен», not run again;
// - one found agreed but not started runs then.
// The agent goes on in the employee's conversation after a done request (continue.ts, owner 21.11, F3).
import type { RequestContext } from '@mastra/core/request-context';
import { RequestContext as Context } from '@mastra/core/request-context';
import { abilitiesValue, readAbilities } from '../abilities/abilities.ts';
import { loadAccess } from '../auth/access.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { resolveAgent, type EditorDeps } from '../editor/prompts.ts';
import { isAppError } from '../errors/app-error.ts';
import { notices } from '../notifications/kinds.ts';
import { notify } from '../notifications/notify.ts';
import { runProjectOfWaitingAnswer } from '../projects/access.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { logEvent } from '../server/log.ts';
import type { SkillsRuntime } from '../skills-admin/runtime.ts';
import { projectArea, userArea } from '../storage/areas.ts';
import type { FileStorage } from '../storage/engine.ts';
import { expireChains, openArgs, RETRY_HOURS, type ChainRow } from './chains.ts';
import type { ChainContinuation } from './continue.ts';

export const SWEEP_MS = 10 * 1000;
// A call that does not end in this time is not waited for: its outcome is unknown (a plugin's tool has no timeout).
export const CALL_MAX_MS = 5 * 60 * 1000;
// What of the action's answer is kept with the request (and told to the agent going on).
const RESULT_MAX = 20_000;

export interface ChainExecutor {
  // Takes agreed requests now (a decision, «Повторить выполнение»).
  wake(): void;
  // Requests a stopped server left: started ones are «итог неизвестен», agreed ones run.
  recover(): Promise<void>;
  // Resolves when nothing agreed waits and nothing runs (tests, shutdown).
  idle(): Promise<void>;
  start(): void;
  stop(): void;
}

export interface ChainExecutorDeps {
  db: Db;
  box: SecretBox;
  editor: EditorDeps;
  skills: Pick<SkillsRuntime, 'skillsFor'>;
  storage: Pick<FileStorage, 'hold'>;
  continuation: ChainContinuation;
}

const keep = (output: unknown): unknown => {
  let text: string;
  try {
    text = JSON.stringify(output ?? null);
  } catch {
    return { unreadable: true };
  }
  return text.length <= RESULT_MAX ? (JSON.parse(text) as unknown) : { cut: true, text: text.slice(0, RESULT_MAX) };
};

class CallTimeout extends Error {}
const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CallTimeout(`the call took over ${ms} ms`)), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

export function createChainExecutor(deps: ChainExecutorDeps): ChainExecutor {
  const { db } = deps;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  async function contextOf(row: ChainRow): Promise<RequestContext> {
    const abilities = await readAbilities(db, row.agent_id);
    const [project, skillPaths] = await Promise.all([runProjectOfWaitingAnswer(db, row.project_id), deps.skills.skillsFor(row.user_id, { documents: abilities.commands })]);
    const rc = new Context();
    rc.set(REQUEST_KEYS.userId, row.user_id);
    rc.set(REQUEST_KEYS.threadId, row.thread_id);
    rc.set(REQUEST_KEYS.agentId, row.agent_id);
    rc.set(REQUEST_KEYS.runKind, row.run_kind);
    if (row.task_id) rc.set(REQUEST_KEYS.taskId, row.task_id);
    if (project.projectId && project.projectOwnerId) {
      rc.set(REQUEST_KEYS.projectId, project.projectId);
      rc.set(REQUEST_KEYS.projectOwnerId, project.projectOwnerId);
    }
    rc.set(REQUEST_KEYS.skillPaths, JSON.stringify(skillPaths));
    rc.set(REQUEST_KEYS.abilities, abilitiesValue(abilities));
    rc.set(REQUEST_KEYS.chainExecution, String(row.id));
    return rc;
  }

  async function finish(row: ChainRow, status: 'done' | 'failed' | 'unknown_outcome', result: unknown, code: string | null): Promise<void> {
    // Only over «выполняется»: a request the start of the server marked meanwhile is not overwritten.
    const { rowCount } = await db.query(
      `UPDATE app.approval_chains SET status = $2, result = $3, error_code = $4, finished_at = now(), retry_until = CASE WHEN $2 = 'failed' THEN now() + interval '${RETRY_HOURS} hours' ELSE NULL END
        WHERE id = $1 AND status = 'executing'`,
      [row.id, status, result === undefined ? null : JSON.stringify(result), code],
    );
    if (!rowCount) return;
    logEvent(status === 'done' ? 'info' : 'warn', 'approval_chain_executed', { chainId: row.id, status, code });
    await notify(db, notices.chainResult({ userId: row.user_id, chainId: String(row.id), action: row.summary, outcome: status, agentId: row.agent_id, threadId: row.thread_id }));
    await deps.continuation.after({ ...row, status }, status === 'done' ? result : null, code);
  }

  async function runOne(id: string): Promise<void> {
    const { rows } = await db.query<ChainRow>(`SELECT * FROM app.approval_chains WHERE id = $1 AND status = 'executing' AND call_started_at IS NULL`, [id]);
    const row = rows[0];
    if (!row) return;
    // The employee must still be who may run it: active, with the agent open.
    const access = await loadAccess(db, row.user_id);
    if (!access || access.blocked || (!access.isSuperadmin && !access.agentIds.has(row.agent_id))) {
      await db.query(`UPDATE app.approval_chains SET call_started_at = now() WHERE id = $1 AND call_started_at IS NULL`, [row.id]);
      await finish(row, 'failed', undefined, access?.blocked ? 'APP_AUTH_BANNED' : 'APP_AGENT_ACCESS_DENIED');
      return;
    }
    let tool: { execute?: (input: unknown, ctx: unknown) => Promise<unknown> } | undefined;
    let rc: RequestContext;
    try {
      rc = await contextOf(row);
      const agent = await resolveAgent(deps.editor, row.agent_id, 'published');
      const tools = (await agent.listTools({ requestContext: rc })) as Record<string, { execute?: (input: unknown, ctx: unknown) => Promise<unknown> }>;
      tool = tools[row.target];
    } catch (error) {
      // Not callable at all (the agent is gone, its settings are broken): a failure of this request, not of the queue.
      await db.query(`UPDATE app.approval_chains SET call_started_at = now() WHERE id = $1 AND call_started_at IS NULL`, [row.id]);
      await finish(row, 'failed', undefined, isAppError(error) ? error.code : 'APP_CHAIN_TOOL_GONE');
      return;
    }
    const claimed = await db.query(`UPDATE app.approval_chains SET call_started_at = now() WHERE id = $1 AND status = 'executing' AND call_started_at IS NULL`, [row.id]);
    if (!claimed.rowCount) return;
    if (!tool?.execute) {
      await finish(row, 'failed', undefined, 'APP_CHAIN_TOOL_GONE');
      return;
    }
    const projectId = rc.get<string, string | undefined>(REQUEST_KEYS.projectId);
    const ownerId = rc.get<string, string | undefined>(REQUEST_KEYS.projectOwnerId);
    const release = await deps.storage.hold(projectId && ownerId ? projectArea(projectId, ownerId) : userArea(row.user_id), 'write');
    let output: unknown;
    try {
      output = await withTimeout(tool.execute(openArgs(deps.box, row), { requestContext: rc, agent: { agentId: row.agent_id, toolCallId: `chain-${row.id}`, messages: [] } }), CALL_MAX_MS);
    } catch (error) {
      await release();
      // A call that did not end in time may have reached the system: no «Повторить» (the book, chapter 5).
      if (error instanceof CallTimeout) await finish(row, 'unknown_outcome', undefined, 'APP_CHAIN_UNKNOWN_OUTCOME');
      else await finish(row, 'failed', undefined, isAppError(error) ? error.code : 'APP_TOOL_FAILED');
      return;
    }
    await release();
    // Mastra answers parameters that do not fit the action (its schema changed meanwhile) with an object of the error,
    // and our tools answer their failures the same way: not done.
    const refused = output && typeof output === 'object' && 'error' in output && (output).error;
    if (refused) {
      const code = (output as { code?: unknown }).code;
      await finish(row, 'failed', undefined, typeof code === 'string' && code.startsWith('APP_') ? code : 'APP_TOOL_FAILED');
      return;
    }
    // Done is done: what follows (keeping the answer, the line, the notice) never turns it into «Повторить».
    await finish(row, 'done', keep(output), null);
  }

  // Every agreed request once per sweep, each on its own: one that cannot run never holds the others back.
  async function sweepOnce(): Promise<void> {
    for (const row of await expireChains(db)) await deps.continuation.after(row, null, null);
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM app.approval_chains WHERE status = 'executing' AND call_started_at IS NULL ORDER BY id`);
    for (const { id } of rows) await runOne(String(id)).catch((error: unknown) => logEvent('error', 'approval_chain_execute_failed', { chainId: id, error }));
  }

  const executor: ChainExecutor = {
    wake() {
      void executor.idle().catch((error: unknown) => logEvent('error', 'approval_chain_sweep_failed', { error }));
    },
    async recover() {
      const { rows } = await db.query<ChainRow>(`UPDATE app.approval_chains SET status = 'unknown_outcome', error_code = 'APP_CHAIN_UNKNOWN_OUTCOME', finished_at = now() WHERE status = 'executing' AND call_started_at IS NOT NULL RETURNING *`);
      for (const row of rows) {
        logEvent('warn', 'approval_chain_unknown', { chainId: row.id });
        await notify(db, notices.chainResult({ userId: row.user_id, chainId: String(row.id), action: row.summary, outcome: 'unknown_outcome', agentId: row.agent_id, threadId: row.thread_id }));
        await deps.continuation.after(row, null, 'APP_CHAIN_UNKNOWN_OUTCOME');
      }
      executor.wake();
    },
    idle() {
      // One sweep at a time; a call while one runs waits for it.
      running ??= sweepOnce().finally(() => (running = null));
      return running.then(() => deps.continuation.idle());
    },
    start() {
      timer = setInterval(() => executor.wake(), SWEEP_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return executor;
}
