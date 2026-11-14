// Who gets something the admin set up — a skill or a background task (spec, sections 8.6, 8.15):
// «Вся организация», «Отделы» or «Сотрудники». The scope's lists live in a table of the thing
// (skill_scope, task_scope) with one department or one employee per row.
import type { SkillAccess } from '@bba/contracts';
import type pg from 'pg';
import { appError } from '../errors/catalog.ts';

export type ScopeAccess = SkillAccess;
type Queryable = Pick<pg.PoolClient, 'query'>;

// Departments or employees of the scope must exist; "the whole organisation" takes no list.
export async function checkScope(db: Queryable, access: ScopeAccess): Promise<ScopeAccess> {
  if (access.scope === 'org') return { scope: 'org', departmentIds: [], userIds: [] };
  const ids = access.scope === 'departments' ? [...new Set(access.departmentIds)] : [...new Set(access.userIds)];
  if (ids.length === 0) {
    throw appError('APP_VALIDATION_FAILED', `scope ${access.scope} without targets`, { userMessage: access.scope === 'departments' ? 'Выберите хотя бы один отдел.' : 'Выберите хотя бы одного сотрудника.' });
  }
  const { rowCount } = await db.query(access.scope === 'departments' ? 'SELECT 1 FROM app.departments WHERE id = ANY($1::uuid[])' : 'SELECT 1 FROM app."user" WHERE "id" = ANY($1)', [ids]);
  if (rowCount !== ids.length) throw appError('APP_VALIDATION_FAILED', `unknown ${access.scope} in a scope`, { userMessage: 'Некоторых отделов или сотрудников уже нет. Обновите страницу.' });
  return access.scope === 'departments' ? { scope: 'departments', departmentIds: ids, userIds: [] } : { scope: 'users', departmentIds: [], userIds: ids };
}

const TABLES = {
  skill: { table: 'app.skill_scope', key: 'skill_name' },
  task: { table: 'app.task_scope', key: 'task_id' },
} as const;

// Replaces the lists of a checked scope (the scope column itself belongs to the owner's table).
export async function writeScopeTargets(db: Queryable, of: keyof typeof TABLES, id: string, access: ScopeAccess): Promise<void> {
  const { table, key } = TABLES[of];
  await db.query(`DELETE FROM ${table} WHERE ${key} = $1`, [id]);
  for (const department of access.departmentIds) await db.query(`INSERT INTO ${table} (${key}, department_id) VALUES ($1, $2)`, [id, department]);
  for (const user of access.userIds) await db.query(`INSERT INTO ${table} (${key}, user_id) VALUES ($1, $2)`, [id, user]);
}
