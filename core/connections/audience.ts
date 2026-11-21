// Who could use a connection: the active employees with at least one of its agents — through their departments, or
// all agents for a superadministrator (core/auth/access.ts). «Подключили N из M» counts M this way
// (docs/specs/[20.11.2026]-mcp-connections.md, step 8): not every employee of the installation.
import type { Db } from '../db/pool.ts';

export async function countEmployeesWithAgents(db: Db, agentIds: readonly string[]): Promise<number> {
  if (agentIds.length === 0) return 0;
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app."user" u LEFT JOIN app.user_profiles p ON p.user_id = u."id"
      WHERE p.blocked_at IS NULL AND p.deletion_started_at IS NULL
        AND (EXISTS (SELECT 1 FROM app.user_roles ur JOIN app.roles r ON r.id = ur.role_id WHERE ur.user_id = u."id" AND r.builtin = 'superadmin')
          OR EXISTS (SELECT 1 FROM app.department_members dm JOIN app.department_agents da ON da.department_id = dm.department_id
                      WHERE dm.user_id = u."id" AND da.agent_id = ANY($1::text[])))`,
    [[...agentIds]],
  );
  return rows[0]!.n;
}
