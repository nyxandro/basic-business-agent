// Who could use a connection: the active employees with at least one of its agents (core/auth/agent-access.ts). «Подключили N из M» counts M this way
// (docs/specs/[20.11.2026]-mcp-connections.md, step 8): not every employee of the installation.
import { mayUseAgentSql } from '../auth/agent-access.ts';
import type { Db } from '../db/pool.ts';

export async function countEmployeesWithAgents(db: Db, agentIds: readonly string[]): Promise<number> {
  if (agentIds.length === 0) return 0;
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app."user" u LEFT JOIN app.user_profiles p ON p.user_id = u."id"
      WHERE p.blocked_at IS NULL AND p.deletion_started_at IS NULL
        AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS a(agent_id) WHERE ${mayUseAgentSql('u."id"', 'a.agent_id')})`,
    [[...agentIds]],
  );
  return rows[0]!.n;
}
