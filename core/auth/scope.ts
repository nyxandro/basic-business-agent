// Who a background task reaches (spec, section 8.6): «Вся организация», «Отделы» or «Сотрудники». The lists live in
// app.task_scope with one department or one employee per row.
import type { TaskAccess } from '@bba/contracts';
import type pg from 'pg';
import { appError } from '../errors/catalog.ts';

export type ScopeAccess = TaskAccess;
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

// Replaces the lists of a checked scope (the scope column itself belongs to app.background_tasks).
export async function writeScopeTargets(db: Queryable, taskId: string, access: ScopeAccess): Promise<void> {
  await db.query('DELETE FROM app.task_scope WHERE task_id = $1', [taskId]);
  for (const department of access.departmentIds) await db.query('INSERT INTO app.task_scope (task_id, department_id) VALUES ($1, $2)', [taskId, department]);
  for (const user of access.userIds) await db.query('INSERT INTO app.task_scope (task_id, user_id) VALUES ($1, $2)', [taskId, user]);
}
