// Departments: a person may be in several; a department opens agents to its members.
import { writeAudit } from '../audit/audit.ts';
import type { Db } from '../db/pool.ts';
import { inTransaction } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';

export interface Department {
  id: string;
  name: string;
  userIds: string[];
  agentIds: string[];
}

const UNIQUE_VIOLATION = '23505';

export async function listDepartments(db: Db): Promise<Department[]> {
  const { rows } = await db.query<{ id: string; name: string; user_ids: string[] | null; agent_ids: string[] | null }>(
    `SELECT d.id, d.name,
            (SELECT array_agg(user_id ORDER BY user_id) FROM app.department_members WHERE department_id = d.id) AS user_ids,
            (SELECT array_agg(agent_id ORDER BY agent_id) FROM app.department_agents WHERE department_id = d.id) AS agent_ids
       FROM app.departments d ORDER BY d.name`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, userIds: r.user_ids ?? [], agentIds: r.agent_ids ?? [] }));
}

async function assertExists(db: Db, id: string): Promise<void> {
  const { rowCount } = await db.query('SELECT 1 FROM app.departments WHERE id = $1', [id]);
  if (!rowCount) throw appError('APP_NOT_FOUND', `department ${id} not found`);
}

async function withUniqueName<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw appError('APP_ADMIN_NAME_TAKEN', `department "${name}" exists`, { cause: error });
    throw error;
  }
}

export async function createDepartment(db: Db, actorUserId: string, name: string): Promise<string> {
  const id = await withUniqueName(name, async () => {
    const { rows } = await db.query<{ id: string }>('INSERT INTO app.departments (name) VALUES ($1) RETURNING id', [name]);
    return rows[0]!.id;
  });
  await writeAudit(db, { actorUserId, action: 'department.create', target: id, details: { name } });
  return id;
}

export async function renameDepartment(db: Db, actorUserId: string, id: string, name: string): Promise<void> {
  await assertExists(db, id);
  await withUniqueName(name, () => db.query('UPDATE app.departments SET name = $2 WHERE id = $1', [id, name]));
  await writeAudit(db, { actorUserId, action: 'department.rename', target: id, details: { name } });
}

export async function deleteDepartment(db: Db, actorUserId: string, id: string): Promise<void> {
  await assertExists(db, id);
  await db.query('DELETE FROM app.departments WHERE id = $1', [id]);
  await writeAudit(db, { actorUserId, action: 'department.delete', target: id });
}

export async function setDepartmentMembers(db: Db, actorUserId: string, id: string, userIds: string[]): Promise<void> {
  await assertExists(db, id);
  await inTransaction(db, async (c) => {
    const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM app."user" WHERE "id" = ANY($1::text[])', [userIds]);
    if (rows[0]?.n !== new Set(userIds).size) throw appError('APP_VALIDATION_FAILED', 'unknown user id', { details: { field: 'userIds' } });
    await c.query('DELETE FROM app.department_members WHERE department_id = $1', [id]);
    await c.query('INSERT INTO app.department_members (department_id, user_id) SELECT $1, unnest($2::text[])', [id, userIds]);
    await writeAudit(c, { actorUserId, action: 'department.members', target: id, details: { userIds } });
  });
}

// Agent ids are checked against the loaded agents by the caller (the route knows the registry).
export async function setDepartmentAgents(db: Db, actorUserId: string, id: string, agentIds: string[]): Promise<void> {
  await assertExists(db, id);
  await inTransaction(db, async (c) => {
    await c.query('DELETE FROM app.department_agents WHERE department_id = $1', [id]);
    await c.query('INSERT INTO app.department_agents (department_id, agent_id) SELECT $1, unnest($2::text[])', [id, agentIds]);
    await writeAudit(c, { actorUserId, action: 'department.agents', target: id, details: { agentIds } });
  });
}
