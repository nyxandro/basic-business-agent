// Who a fire of a background task reaches (spec, section 8.6):
// - «Вся организация» — every active employee with access to the agent;
// - «Отделы» — the employees of the chosen departments, «Сотрудники» — the chosen people; of
//   them, a blocked employee or one without access to the agent is skipped with the reason.
// Access to an agent: a superadmin has every agent, others — the agents of their departments.
import type { Db } from '../db/pool.ts';

export type SkipReason = 'blocked' | 'no_access';

export interface Member {
  userId: string;
  skip: SkipReason | null;
}

interface Row {
  user_id: string;
  blocked: boolean;
  has_access: boolean;
}

export async function membersOf(db: Db, taskId: string, scope: 'org' | 'departments' | 'users', agentId: string): Promise<Member[]> {
  const people =
    scope === 'org'
      ? `SELECT u."id" AS user_id FROM app."user" u WHERE $1::text IS NOT NULL`
      : scope === 'departments'
        ? `SELECT DISTINCT dm.user_id FROM app.task_scope ts JOIN app.department_members dm ON dm.department_id = ts.department_id WHERE ts.task_id = $1`
        : `SELECT ts.user_id FROM app.task_scope ts WHERE ts.task_id = $1 AND ts.user_id IS NOT NULL`;
  const { rows } = await db.query<Row>(
    `SELECT p.user_id,
            COALESCE(pr.blocked_at IS NOT NULL OR pr.deletion_started_at IS NOT NULL, false) AS blocked,
            EXISTS (SELECT 1 FROM app.user_roles ur JOIN app.roles r ON r.id = ur.role_id WHERE ur.user_id = p.user_id AND r.builtin = 'superadmin')
              OR EXISTS (SELECT 1 FROM app.department_members dm JOIN app.department_agents da ON da.department_id = dm.department_id
                          WHERE dm.user_id = p.user_id AND da.agent_id = $2) AS has_access
       FROM (${people}) p
       LEFT JOIN app.user_profiles pr ON pr.user_id = p.user_id
      ORDER BY p.user_id`,
    [taskId, agentId],
  );
  const members = rows.map((r) => ({ userId: r.user_id, skip: r.blocked ? ('blocked' as const) : r.has_access ? null : ('no_access' as const) }));
  // The whole organisation means those who may use the agent, not everyone else skipped.
  return scope === 'org' ? members.filter((m) => m.skip === null) : members;
}
