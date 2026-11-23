// Admin sections «Роли» and «Отделы».
import { departmentAgentsSchema, departmentBodySchema, departmentMembersSchema, roleBodySchema } from '@bba/contracts';
import type { Hono } from 'hono';
import {
  createDepartment,
  deleteDepartment,
  listDepartments,
  renameDepartment,
  setDepartmentAgents,
  setDepartmentMembers,
} from '../../auth/departments.ts';
import { createRole, deleteRole, listRoles, updateRole } from '../../auth/roles.ts';
import type { Db } from '../../db/pool.ts';
import { appError } from '../../errors/catalog.ts';
import { assertCanGrant, requireAnyPermission, requirePermission } from '../../auth/guards.ts';
import { access, parseJson, type AppEnv } from '../../http/http.ts';

export function registerRoleRoutes(app: Hono<AppEnv>, deps: { db: Db; knownAgentIds: () => ReadonlySet<string> }): void {
  const { db } = deps;
  const roles = requirePermission('roles');
  const departments = requirePermission('departments');

  app.get('/app/api/admin/roles', requireAnyPermission('roles', 'users'), async (c) => c.json({ roles: await listRoles(db) }));
  app.post('/app/api/admin/roles', roles, async (c) => {
    const input = await parseJson(c, roleBodySchema);
    assertCanGrant(access(c), input.permissions, false);
    return c.json({ id: await createRole(db, access(c).userId, input) }, 201);
  });
  app.put('/app/api/admin/roles/:id', roles, async (c) => {
    const input = await parseJson(c, roleBodySchema);
    assertCanGrant(access(c), input.permissions, false);
    await updateRole(db, access(c).userId, c.req.param('id'), input);
    return c.json({ ok: true });
  });
  app.delete('/app/api/admin/roles/:id', roles, async (c) => {
    await deleteRole(db, access(c).userId, c.req.param('id'));
    return c.json({ ok: true });
  });

  // Also for those who give skills and background tasks to departments and people.
  app.get('/app/api/admin/departments', requireAnyPermission('departments', 'users', 'skills', 'agents'), async (c) => c.json({ departments: await listDepartments(db) }));
  app.post('/app/api/admin/departments', departments, async (c) => {
    const { name } = await parseJson(c, departmentBodySchema);
    return c.json({ id: await createDepartment(db, access(c).userId, name) }, 201);
  });
  app.put('/app/api/admin/departments/:id', departments, async (c) => {
    const { name } = await parseJson(c, departmentBodySchema);
    await renameDepartment(db, access(c).userId, c.req.param('id'), name);
    return c.json({ ok: true });
  });
  app.delete('/app/api/admin/departments/:id', departments, async (c) => {
    await deleteDepartment(db, access(c).userId, c.req.param('id'));
    return c.json({ ok: true });
  });
  app.put('/app/api/admin/departments/:id/members', departments, async (c) => {
    const { userIds } = await parseJson(c, departmentMembersSchema);
    await setDepartmentMembers(db, access(c).userId, c.req.param('id'), userIds);
    return c.json({ ok: true });
  });
  app.put('/app/api/admin/departments/:id/agents', departments, async (c) => {
    const { agentIds } = await parseJson(c, departmentAgentsSchema);
    const known = deps.knownAgentIds();
    const unknown = agentIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw appError('APP_VALIDATION_FAILED', `unknown agents: ${unknown.join(', ')}`, { details: { field: 'agentIds' } });
    await setDepartmentAgents(db, access(c).userId, c.req.param('id'), agentIds);
    return c.json({ ok: true });
  });
}
