// Who is asking and what they may do: roles, rights, departments and the agents open to them (core/auth/agent-access.ts).
import { ADMIN_SECTIONS, PERMISSIONS, type Permission } from '@bba/contracts';
import type { Db } from '../db/pool.ts';
import { agentsOfPersonSql } from './agent-access.ts';

export interface AccessContext {
  userId: string;
  email: string;
  name: string;
  roleIds: string[];
  isSuperadmin: boolean;
  permissions: ReadonlySet<Permission>;
  departmentIds: string[];
  agentIds: ReadonlySet<string>;
  blocked: boolean;
}

interface Row {
  id: string;
  email: string;
  name: string;
  blocked: boolean;
  role_ids: string[] | null;
  builtins: (string | null)[] | null;
  permissions: Permission[] | null;
  department_ids: string[] | null;
  agent_ids: string[] | null;
}

const KNOWN_PERMISSIONS = new Set<string>(PERMISSIONS);

export async function loadAccess(db: Db, userId: string): Promise<AccessContext | null> {
  const { rows } = await db.query<Row>(
    `SELECT u."id", u."email", u."name",
            COALESCE(p.blocked_at IS NOT NULL OR p.deletion_started_at IS NOT NULL, false) AS blocked,
            (SELECT array_agg(r.id::text) FROM app.user_roles ur JOIN app.roles r ON r.id = ur.role_id WHERE ur.user_id = u."id") AS role_ids,
            (SELECT array_agg(r.builtin) FROM app.user_roles ur JOIN app.roles r ON r.id = ur.role_id WHERE ur.user_id = u."id") AS builtins,
            (SELECT array_agg(DISTINCT perm) FROM app.user_roles ur JOIN app.roles r ON r.id = ur.role_id,
                    jsonb_array_elements_text(r.permissions) AS perm WHERE ur.user_id = u."id") AS permissions,
            (SELECT array_agg(dm.department_id::text) FROM app.department_members dm WHERE dm.user_id = u."id") AS department_ids,
            (SELECT array_agg(DISTINCT a.agent_id) FROM (${agentsOfPersonSql('u."id"')}) a) AS agent_ids
       FROM app."user" u LEFT JOIN app.user_profiles p ON p.user_id = u."id"
      WHERE u."id" = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  const isSuperadmin = (row.builtins ?? []).includes('superadmin');
  const permissions = new Set<Permission>(
    isSuperadmin ? PERMISSIONS : (row.permissions ?? []).filter((p): p is Permission => KNOWN_PERMISSIONS.has(p)),
  );
  return {
    userId: row.id,
    email: row.email,
    name: row.name,
    roleIds: row.role_ids ?? [],
    isSuperadmin,
    permissions,
    departmentIds: row.department_ids ?? [],
    agentIds: new Set(row.agent_ids ?? []),
    blocked: row.blocked,
  };
}

export function hasAnyAdminSection(access: AccessContext): boolean {
  return ADMIN_SECTIONS.some((s) => access.permissions.has(s));
}
