// The queue of background runs (spec, section 8.6): one row of app.background_task_runs per fire
// and employee. At most MAX_CONCURRENT_RUNS run at once; a row is taken with FOR UPDATE SKIP LOCKED,
// so two takers never get the same one. After a restart only rows without a result go on; a row
// whose fire is more than a day old is skipped instead.
import type { Db } from '../db/pool.ts';
import { logEvent } from '../server/log.ts';
import type { Member } from './scope.ts';

export const MAX_CONCURRENT_RUNS = 3;
export const LATE_AFTER = '1 day';

export interface QueuedRun {
  id: string;
  taskId: string;
  userId: string;
  fireAt: Date;
}

export type FinishedOutcome = 'done' | 'awaiting-approval' | 'failed';

interface RunRow {
  id: string;
  task_id: string;
  user_id: string;
  fire_at: Date;
}

// Rows of one fire: queued for those who may run, skipped with the reason for the rest. The same
// fire counted twice (a double trigger, a catch-up) adds nothing.
export async function enqueueFire(db: Db, taskId: string, fireAt: Date, members: (Member & { awaiting: boolean })[]): Promise<{ queued: number; skipped: number }> {
  let queued = 0;
  let skipped = 0;
  for (const m of members) {
    const reason = m.skip ?? (m.awaiting ? 'awaiting_approval' : null);
    const { rowCount } = await db.query(
      `INSERT INTO app.background_task_runs (task_id, fire_at, user_id, outcome, reason_code, finished_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'skipped' THEN now() END) ON CONFLICT (task_id, fire_at, user_id) DO NOTHING`,
      [taskId, fireAt, m.userId, reason ? 'skipped' : 'queued', reason],
    );
    if (rowCount) {
      if (reason) skipped++;
      else queued++;
    }
  }
  return { queued, skipped };
}

async function claimNext(db: Db): Promise<QueuedRun | null> {
  const { rows } = await db.query<RunRow>(
    `UPDATE app.background_task_runs SET outcome = 'running', started_at = now()
      WHERE id = (SELECT id FROM app.background_task_runs WHERE outcome = 'queued' ORDER BY fire_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, task_id, user_id, fire_at`,
  );
  const r = rows[0];
  return r ? { id: r.id, taskId: r.task_id, userId: r.user_id, fireAt: r.fire_at } : null;
}

export async function finishRun(db: Db, runId: string, outcome: FinishedOutcome, reasonCode: string | null): Promise<void> {
  await db.query('UPDATE app.background_task_runs SET outcome = $2, reason_code = $3, finished_at = now(), unread = $4 WHERE id = $1', [runId, outcome, reasonCode, outcome !== 'failed']);
}

// Rows a stopped server left: running ones run again, ones a day late are skipped.
export async function recoverRuns(db: Db): Promise<{ requeued: number; late: number }> {
  const late = await db.query(
    `UPDATE app.background_task_runs SET outcome = 'skipped', reason_code = 'too_late', finished_at = now()
      WHERE outcome IN ('queued', 'running') AND fire_at < now() - interval '${LATE_AFTER}'`,
  );
  const requeued = await db.query("UPDATE app.background_task_runs SET outcome = 'queued', started_at = NULL WHERE outcome = 'running'");
  return { requeued: requeued.rowCount ?? 0, late: late.rowCount ?? 0 };
}

export interface RunQueue {
  // Starts queued runs up to the limit; returns at once, the runs go on.
  drain(): void;
  // Resolves when nothing is queued or running in this process (tests, shutdown).
  idle(): Promise<void>;
}

export function createRunQueue(db: Db, run: (row: QueuedRun) => Promise<void>, maxConcurrent = MAX_CONCURRENT_RUNS): RunQueue {
  let active = 0;
  const inFlight = new Set<Promise<void>>();

  async function takeOne(): Promise<boolean> {
    // The slot is taken before the row, so parallel calls never exceed the limit.
    active++;
    let row: QueuedRun | null;
    try {
      row = await claimNext(db);
    } catch (error) {
      active--;
      throw error;
    }
    if (!row) {
      active--;
      return false;
    }
    const work = run(row)
      .catch((error: unknown) => logEvent('error', 'background_run_crashed', { runId: row.id, taskId: row.taskId, error }))
      .finally(() => {
        active--;
        inFlight.delete(work);
        queue.drain();
      });
    inFlight.add(work);
    return true;
  }

  const queue: RunQueue = {
    drain() {
      void (async () => {
        while (active < maxConcurrent && (await takeOne()));
      })().catch((error: unknown) => logEvent('error', 'background_queue_failed', { error }));
    },
    async idle() {
      for (;;) {
        await Promise.all([...inFlight]);
        const { rowCount } = await db.query("SELECT 1 FROM app.background_task_runs WHERE outcome IN ('queued', 'running') LIMIT 1");
        if (inFlight.size === 0 && !rowCount) return;
        queue.drain();
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
  return queue;
}
