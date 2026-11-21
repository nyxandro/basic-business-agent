// Who a project is open to (spec, section 8.20): «Только я», «Выбранным» — departments and people
// together — or «Всей организации». Only the creator sets it; the list is replaced as a whole.
import { PROJECT_ACCESS_MAX_TARGETS, type ProjectAccessDto, type ProjectAccessInput, type ProjectAccessMode } from '@bba/contracts';
import type pg from 'pg';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { notices } from '../notifications/kinds.ts';
import { notifyAll } from '../notifications/notify.ts';

type Queryable = Pick<pg.PoolClient, 'query'>;

export interface CheckedAccess {
  mode: ProjectAccessMode;
  departmentIds: string[];
  userIds: string[];
}

const GONE = 'Некоторых отделов или сотрудников уже нет. Обновите список и сохраните снова.';
// Signed-in people who may get a project: not blocked and not being removed.
const ACTIVE_PERSON = `NOT EXISTS (SELECT 1 FROM app.user_profiles pr WHERE pr.user_id = u."id" AND (pr.blocked_at IS NOT NULL OR pr.deletion_started_at IS NOT NULL))`;

// The departments and people of «Выбранным» must exist; people added now must be active — one already
// in the list (`kept`) stays even when blocked since, until the creator removes them. The creator is
// not in their own list. Another mode carries no lists: a list there is a mistake of the client.
export async function checkAccess(db: Queryable, ownerId: string, input: ProjectAccessInput, kept: readonly string[] = []): Promise<CheckedAccess> {
  const departmentIds = [...new Set(input.departmentIds)];
  const userIds = [...new Set(input.userIds)];
  if (input.mode !== 'list') {
    if (departmentIds.length > 0 || userIds.length > 0) throw appError('APP_VALIDATION_FAILED', `access ${input.mode} with a list of targets`);
    return { mode: input.mode, departmentIds: [], userIds: [] };
  }
  if (departmentIds.length + userIds.length === 0) throw appError('APP_VALIDATION_FAILED', 'access list without targets', { userMessage: 'Выберите хотя бы один отдел или сотрудника.' });
  if (departmentIds.length + userIds.length > PROJECT_ACCESS_MAX_TARGETS) {
    throw appError('APP_VALIDATION_FAILED', `access list of ${departmentIds.length + userIds.length} targets`, { userMessage: `Можно выбрать не больше ${PROJECT_ACCESS_MAX_TARGETS} отделов и сотрудников.` });
  }
  if (userIds.includes(ownerId)) throw appError('APP_VALIDATION_FAILED', 'the creator is in their own access list', { userMessage: 'Создатель видит проект и так — уберите себя из списка.' });
  const { rowCount: departments } = await db.query('SELECT 1 FROM app.departments WHERE id = ANY($1::uuid[])', [departmentIds]);
  const { rowCount: people } = await db.query(`SELECT 1 FROM app."user" u WHERE u."id" = ANY($1) AND (${ACTIVE_PERSON} OR u."id" = ANY($2))`, [userIds, [...kept]]);
  if (departments !== departmentIds.length || people !== userIds.length) throw appError('APP_VALIDATION_FAILED', 'unknown or inactive targets in an access list', { userMessage: GONE });
  return { mode: 'list', departmentIds, userIds };
}

export async function writeAccess(db: Queryable, projectId: string, access: CheckedAccess): Promise<void> {
  await db.query('UPDATE app.projects SET access = $2, updated_at = now() WHERE id = $1', [projectId, access.mode]);
  await db.query('DELETE FROM app.project_shares WHERE project_id = $1', [projectId]);
  if (access.departmentIds.length > 0) await db.query('INSERT INTO app.project_shares (project_id, department_id) SELECT $1, unnest($2::uuid[])', [projectId, access.departmentIds]);
  if (access.userIds.length > 0) await db.query('INSERT INTO app.project_shares (project_id, user_id) SELECT $1, unnest($2::text[])', [projectId, access.userIds]);
}

// The list as the creator sees it, with names: departments with their active people, people with
// a mark of blocking (they stay in the list until the creator removes them).
export async function describeAccess(db: Queryable, projectId: string, mode: ProjectAccessMode): Promise<ProjectAccessDto> {
  const { rows: departments } = await db.query<{ id: string; name: string; members: number }>(
    `SELECT d.id, d.name, (SELECT count(*)::int FROM app.department_members m JOIN app."user" u ON u."id" = m.user_id WHERE m.department_id = d.id AND ${ACTIVE_PERSON}) AS members
       FROM app.project_shares s JOIN app.departments d ON d.id = s.department_id
      WHERE s.project_id = $1 ORDER BY lower(d.name)`,
    [projectId],
  );
  const { rows: people } = await db.query<{ id: string; name: string; email: string; blocked: boolean }>(
    `SELECT u."id" AS id, u."name" AS name, u."email" AS email, NOT ${ACTIVE_PERSON} AS blocked
       FROM app.project_shares s JOIN app."user" u ON u."id" = s.user_id
      WHERE s.project_id = $1 ORDER BY lower(u."name"), u."id"`,
    [projectId],
  );
  // A list whose departments and people are all gone opens the project to nobody.
  const shownMode = mode === 'list' && departments.length + people.length === 0 ? 'private' : mode;
  return { mode: shownMode, departments, people };
}

// The active people a list of «Выбранным» opens the project to — named, or in a named department — besides its creator.
export async function peopleOfList(db: Queryable, projectId: string, ownerId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT u."id" AS id FROM app.project_shares s JOIN app."user" u ON u."id" = s.user_id WHERE s.project_id = $1 AND ${ACTIVE_PERSON}
     UNION
     SELECT u."id" FROM app.project_shares s JOIN app.department_members m ON m.department_id = s.department_id JOIN app."user" u ON u."id" = m.user_id
      WHERE s.project_id = $1 AND ${ACTIVE_PERSON}`,
    [projectId],
  );
  return new Set(rows.map((r) => r.id).filter((id) => id !== ownerId));
}

// «Вам открыли проект» to the people a change of the list opened it to — at that moment, by name or by department;
// opening to the whole organisation tells nobody (decision of the agent, docs/specs/[20.11.2026]-notifications.md).
export async function notifyProjectShared(db: Db, input: { projectId: string; ownerId: string; people: readonly string[] }): Promise<void> {
  if (input.people.length === 0) return;
  const { rows } = await db.query<{ name: string; owner: string }>(
    'SELECT p.name, u."name" AS owner FROM app.projects p JOIN app."user" u ON u."id" = p.user_id WHERE p.id = $1',
    [input.projectId],
  );
  const project = rows[0];
  if (!project) return;
  const sharedAt = new Date();
  await notifyAll(db, input.people.map((userId) => notices.projectShared({ userId, projectId: input.projectId, projectName: project.name, ownerName: project.owner, sharedAt })));
}
