// Append-only record of changes made in the admin panel (spec, section 17.4: admin_audit).
import type pg from 'pg';

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export async function writeAudit(
  db: Queryable,
  entry: { actorUserId: string | null; action: string; target: string | null; details?: Record<string, unknown> },
): Promise<void> {
  await db.query('INSERT INTO app.admin_audit (actor_user_id, action, target, details) VALUES ($1, $2, $3, $4)', [
    entry.actorUserId,
    entry.action,
    entry.target,
    JSON.stringify(entry.details ?? {}),
  ]);
}
