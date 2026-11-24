// Who may use an agent (owner's decision 24.11, spec section 8.15): the whole organisation, a department of the person
// (app.department_agents — the same link as «Агенты отдела») or the person by name, set on the agent's page; a
// superadministrator has every agent. Every query asking «may this person use the agent» takes its condition from here:
// a copy of the rule elsewhere would show a person the tasks or connections of an agent they no longer have.
import type { AgentAccess } from '@bba/contracts';
import { writeAudit } from '../audit/audit.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';

// `user` and `agent` are SQL expressions of the code — a parameter (`$2`) or a column (`u."id"`, `t.agent_id`) — never data.
export function mayUseAgentSql(user: string, agent: string): string {
  return `(EXISTS (SELECT 1 FROM app.user_roles ur JOIN app.roles r ON r.id = ur.role_id WHERE ur.user_id = ${user} AND r.builtin = 'superadmin')
        OR EXISTS (SELECT 1 FROM app.agent_org_access ao WHERE ao.agent_id = ${agent})
        OR EXISTS (SELECT 1 FROM app.department_members dm JOIN app.department_agents da ON da.department_id = dm.department_id
                    WHERE dm.user_id = ${user} AND da.agent_id = ${agent})
        OR EXISTS (SELECT 1 FROM app.agent_people ap WHERE ap.user_id = ${user} AND ap.agent_id = ${agent}))`;
}

// The agents the lists open to the person (`user` as above); a superadministrator's every agent is the caller's to add.
export function agentsOfPersonSql(user: string): string {
  return `SELECT ao.agent_id FROM app.agent_org_access ao
          UNION SELECT da.agent_id FROM app.department_members dm JOIN app.department_agents da ON da.department_id = dm.department_id WHERE dm.user_id = ${user}
          UNION SELECT ap.agent_id FROM app.agent_people ap WHERE ap.user_id = ${user}`;
}

const NOBODY: AgentAccess = { org: false, departmentIds: [], userIds: [] };

// The access of every agent that has any; an agent missing from the map is open to nobody but a superadministrator.
export async function listAgentAccess(db: Db): Promise<Map<string, AgentAccess>> {
  const { rows } = await db.query<{ agent_id: string; kind: 'org' | 'department' | 'person'; target: string | null }>(
    `SELECT agent_id, 'org' AS kind, NULL AS target FROM app.agent_org_access
     UNION ALL SELECT agent_id, 'department', department_id::text FROM app.department_agents
     UNION ALL SELECT agent_id, 'person', user_id FROM app.agent_people
     ORDER BY 1, 2, 3`,
  );
  const out = new Map<string, AgentAccess>();
  for (const r of rows) {
    const access = out.get(r.agent_id) ?? { ...NOBODY, departmentIds: [], userIds: [] };
    if (r.kind === 'org') access.org = true;
    else if (r.kind === 'department') access.departmentIds.push(r.target!);
    else access.userIds.push(r.target!);
    out.set(r.agent_id, access);
  }
  return out;
}

export async function agentAccessOf(db: Db, agentId: string): Promise<AgentAccess> {
  return (await listAgentAccess(db)).get(agentId) ?? NOBODY;
}

// «Вся организация» makes the lists needless: they are cleared, as the page shows them.
export async function setAgentAccess(db: Db, agentId: string, raw: AgentAccess, actorUserId: string): Promise<AgentAccess> {
  const access: AgentAccess = raw.org ? { org: true, departmentIds: [], userIds: [] } : { org: false, departmentIds: [...new Set(raw.departmentIds)], userIds: [...new Set(raw.userIds)] };
  await inTransaction(db, async (c) => {
    const departments = await c.query('SELECT 1 FROM app.departments WHERE id = ANY($1::uuid[])', [access.departmentIds]);
    const people = await c.query('SELECT 1 FROM app."user" WHERE "id" = ANY($1)', [access.userIds]);
    if (departments.rowCount !== access.departmentIds.length || people.rowCount !== access.userIds.length) {
      throw appError('APP_VALIDATION_FAILED', `unknown departments or employees in the access of agent ${agentId}`, { userMessage: 'Некоторых отделов или сотрудников уже нет. Обновите страницу.' });
    }
    await c.query('DELETE FROM app.agent_org_access WHERE agent_id = $1', [agentId]);
    await c.query('DELETE FROM app.department_agents WHERE agent_id = $1', [agentId]);
    await c.query('DELETE FROM app.agent_people WHERE agent_id = $1', [agentId]);
    if (access.org) await c.query('INSERT INTO app.agent_org_access (agent_id) VALUES ($1)', [agentId]);
    await c.query('INSERT INTO app.department_agents (department_id, agent_id) SELECT unnest($1::uuid[]), $2', [access.departmentIds, agentId]);
    await c.query('INSERT INTO app.agent_people (agent_id, user_id) SELECT $1, unnest($2::text[])', [agentId, access.userIds]);
    await writeAudit(c, { actorUserId, action: 'agent.access', target: agentId, details: access });
  });
  return access;
}
