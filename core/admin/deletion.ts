// Removal of an employee in steps (spec, scenario 5, section 9: APP_ADMIN_DELETE_PARTIAL).
// The first step blocks the person; every later step is idempotent, so "Удалить" can be pressed
// again after a failure and continues where it stopped. Background tasks lose their owner and
// pause («Задачи без владельца»); the action journal keeps its rows.
import type { Memory } from '@mastra/memory';
import { writeAudit } from '../audit/audit.ts';
import type { Db } from '../db/pool.ts';
import { inTransaction } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import type { ModelGateway } from '../models/gateway.ts';
import { transferProjects } from '../projects/transfer.ts';
import { deleteUserWorkspace } from '../workspace/layout.ts';
import { userArea } from '../storage/areas.ts';
import type { FileStorage } from '../storage/engine.ts';
import { logEvent } from '../server/log.ts';

const SUPERADMIN_LOCK_KEY = 74_010_002;

export interface DeletionDeps {
  db: Db;
  memory: Memory;
  gateway: Pick<ModelGateway, 'forgetUser'>;
  workspaceRoot: string;
  // Where the files are kept (spec, section 8.23): the person's files go from the bucket too.
  storage: Pick<FileStorage, 'drop' | 'exclusive'>;
}

async function startDeletion(db: Db, actorUserId: string, userId: string): Promise<void> {
  await inTransaction(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [SUPERADMIN_LOCK_KEY]);
    const { rowCount } = await c.query('SELECT 1 FROM app."user" WHERE "id" = $1', [userId]);
    if (!rowCount) throw appError('APP_NOT_FOUND', `user ${userId} not found`);
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(DISTINCT ur.user_id)::int AS n FROM app.user_roles ur JOIN app.roles r ON r.id = ur.role_id AND r.builtin = 'superadmin'
         LEFT JOIN app.user_profiles p ON p.user_id = ur.user_id
        WHERE ur.user_id <> $1 AND p.blocked_at IS NULL AND p.deletion_started_at IS NULL`,
      [userId],
    );
    const { rowCount: isSuperadmin } = await c.query(
      "SELECT 1 FROM app.user_roles ur JOIN app.roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.builtin = 'superadmin'",
      [userId],
    );
    if (isSuperadmin && (rows[0]?.n ?? 0) === 0) throw appError('APP_ADMIN_LAST_SUPERADMIN', `user ${userId} is the last superadmin`);
    await c.query(
      `INSERT INTO app.user_profiles (user_id, deletion_started_at) VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET deletion_started_at = coalesce(app.user_profiles.deletion_started_at, now())`,
      [userId],
    );
    await c.query('DELETE FROM app."session" WHERE "userId" = $1', [userId]);
  });
  await writeAudit(db, { actorUserId, action: 'user.delete.start', target: userId });
}

export async function deleteEmployee(deps: DeletionDeps, actorUserId: string, userId: string): Promise<void> {
  if (actorUserId === userId) throw appError('APP_VALIDATION_FAILED', 'an admin cannot delete themselves', { userMessage: 'Нельзя удалить самого себя.' });
  await startDeletion(deps.db, actorUserId, userId);
  const steps: [string, () => Promise<unknown>][] = [
    ['model key', () => deps.gateway.forgetUser(userId)],
    ['connections', () => deps.db.query('DELETE FROM app.connector_credentials WHERE user_id = $1', [userId])],
    [
      'conversations',
      async () => {
        const { threads } = await deps.memory.listThreads({ filter: { resourceId: userId }, perPage: false });
        for (const thread of threads) {
          await deps.memory.deleteThread(thread.id);
          await deps.db.query('DELETE FROM app.masking_map WHERE thread_id = $1', [thread.id]);
        }
      },
    ],
    ['memory', () => deps.memory.updateWorkingMemory({ threadId: `memory-view:${userId}`, resourceId: userId, workingMemory: '' })],
    // Their projects go to the administrator who removes them (spec, section 8.20), before their folder goes.
    ['projects', () => transferProjects(deps.db, deps.storage, deps.workspaceRoot, userId, actorUserId)],
    [
      'workspace',
      async () => {
        await deps.storage.drop(userArea(userId));
        deleteUserWorkspace(deps.workspaceRoot, userId);
      },
    ],
    ['account', () => deps.db.query('DELETE FROM app."user" WHERE "id" = $1', [userId])],
  ];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (error) {
      logEvent('error', 'user_delete_step_failed', { userId, step: name, error });
      throw appError('APP_ADMIN_DELETE_PARTIAL', `deletion of ${userId} stopped at step "${name}"`, { cause: error, details: { step: name } });
    }
  }
  await writeAudit(deps.db, { actorUserId, action: 'user.delete.finish', target: userId });
}
