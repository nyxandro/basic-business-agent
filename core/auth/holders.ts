// The people who hold a right now — the superadmins and the roles with it — not blocked and not being removed: whom
// a notification about the work of that right goes to (tasks in trouble, a new complaint).
import type { Permission } from '@bba/contracts';
import type { Db } from '../db/pool.ts';

export async function holdersOf(db: Db, permission: Permission): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT DISTINCT ur.user_id FROM app.user_roles ur JOIN app.roles r ON r.id = ur.role_id LEFT JOIN app.user_profiles p ON p.user_id = ur.user_id
      WHERE (r.builtin = 'superadmin' OR r.permissions ? $1) AND p.blocked_at IS NULL AND p.deletion_started_at IS NULL`,
    [permission],
  );
  return rows.map((r) => r.user_id);
}
