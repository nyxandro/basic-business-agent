// Roles created in the admin panel; the two built-in ones are immutable (spec, section 8.2).
import type { AdminRole, Permission } from '@bba/contracts';
import { writeAudit } from '../audit/audit.ts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';

// The shape is read by the web interface («Роли»).
export type Role = AdminRole;

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION;
}

export async function listRoles(db: Db): Promise<Role[]> {
  const { rows } = await db.query<{ id: string; name: string; permissions: Permission[]; builtin: Role['builtin']; user_count: number }>(
    `SELECT r.id, r.name, r.permissions, r.builtin, (SELECT count(*)::int FROM app.user_roles ur WHERE ur.role_id = r.id) AS user_count
       FROM app.roles r ORDER BY r.builtin IS NULL, r.name`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, permissions: r.permissions, builtin: r.builtin, userCount: r.user_count }));
}

async function builtinOf(db: Db, id: string): Promise<Role['builtin']> {
  const { rows } = await db.query<{ builtin: Role['builtin'] }>('SELECT builtin FROM app.roles WHERE id = $1', [id]);
  if (!rows[0]) throw appError('APP_NOT_FOUND', `role ${id} not found`);
  return rows[0].builtin;
}

export async function createRole(db: Db, actorUserId: string, input: { name: string; permissions: Permission[] }): Promise<string> {
  try {
    const { rows } = await db.query<{ id: string }>('INSERT INTO app.roles (name, permissions) VALUES ($1, $2) RETURNING id', [
      input.name,
      JSON.stringify(input.permissions),
    ]);
    await writeAudit(db, { actorUserId, action: 'role.create', target: rows[0]!.id, details: input });
    return rows[0]!.id;
  } catch (error) {
    if (isUniqueViolation(error)) throw appError('APP_ADMIN_NAME_TAKEN', `role name "${input.name}" is taken`, { cause: error });
    throw error;
  }
}

export async function updateRole(db: Db, actorUserId: string, id: string, input: { name: string; permissions: Permission[] }): Promise<void> {
  if ((await builtinOf(db, id)) !== null) throw appError('APP_ADMIN_BUILTIN_ROLE', `role ${id} is built-in`);
  try {
    await db.query('UPDATE app.roles SET name = $2, permissions = $3, updated_at = now() WHERE id = $1', [id, input.name, JSON.stringify(input.permissions)]);
  } catch (error) {
    if (isUniqueViolation(error)) throw appError('APP_ADMIN_NAME_TAKEN', `role name "${input.name}" is taken`, { cause: error });
    throw error;
  }
  await writeAudit(db, { actorUserId, action: 'role.update', target: id, details: input });
}

export async function deleteRole(db: Db, actorUserId: string, id: string): Promise<void> {
  if ((await builtinOf(db, id)) !== null) throw appError('APP_ADMIN_BUILTIN_ROLE', `role ${id} is built-in`);
  await db.query('DELETE FROM app.roles WHERE id = $1', [id]);
  await writeAudit(db, { actorUserId, action: 'role.delete', target: id });
}

export async function builtinRoleId(db: Db, builtin: 'superadmin' | 'employee'): Promise<string> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM app.roles WHERE builtin = $1', [builtin]);
  if (!rows[0]) throw new Error(`built-in role ${builtin} is missing: migrations were not applied`);
  return rows[0].id;
}

// What a set of roles would grant: used to stop admins from handing out rights they lack.
export async function grantsOf(db: Db, roleIds: string[]): Promise<{ permissions: Permission[]; superadmin: boolean }> {
  const { rows } = await db.query<{ permissions: Permission[]; builtin: Role['builtin'] }>(
    'SELECT permissions, builtin FROM app.roles WHERE id = ANY($1::uuid[])',
    [roleIds],
  );
  return {
    permissions: [...new Set(rows.flatMap((r) => r.permissions))],
    superadmin: rows.some((r) => r.builtin === 'superadmin'),
  };
}
