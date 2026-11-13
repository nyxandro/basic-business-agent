// Admin section «Пользователи»: invites, password resets, roles of a person, blocking.
import { inviteCreateSchema, passwordResetCreateSchema, userRolesSchema } from '@bba/contracts';
import type { Hono } from 'hono';
import { loadAccess, type AccessContext } from '../../auth/access.ts';
import { grantsOf } from '../../auth/roles.ts';
import { createInvite, createPasswordReset, listUsers, revokeInvite, setUserBlocked, setUserRoles } from '../../auth/users.ts';
import type { Db } from '../../db/pool.ts';
import { appError } from '../../errors/catalog.ts';
import { assertCanGrant, requirePermission } from '../../server/guards.ts';
import { access, parseJson, type AppEnv } from '../../server/http.ts';

// Managing someone (reset link, roles, block) needs at least the rights that person has:
// otherwise an admin could take over a stronger account through a reset link.
async function assertCanManage(db: Db, actor: AccessContext, targetUserId: string): Promise<void> {
  const target = await loadAccess(db, targetUserId);
  if (!target) throw appError('APP_NOT_FOUND', `user ${targetUserId} not found`);
  assertCanGrant(actor, [...target.permissions], target.isSuperadmin);
}

export function registerPeopleRoutes(app: Hono<AppEnv>, deps: { db: Db; publicUrl: string }): void {
  const { db, publicUrl } = deps;
  const guard = requirePermission('users');
  const link = (kind: 'invite' | 'reset', token: string) => new URL(`/${kind}/${token}`, publicUrl).toString();

  app.get('/app/api/admin/users', guard, async (c) => c.json({ users: await listUsers(db) }));

  app.post('/app/api/admin/invites', guard, async (c) => {
    const input = await parseJson(c, inviteCreateSchema);
    const grants = await grantsOf(db, input.roleIds);
    assertCanGrant(access(c), grants.permissions, grants.superadmin);
    const issued = await createInvite(db, access(c).userId, input);
    return c.json({ id: issued.id, link: link('invite', issued.token), expiresAt: issued.expiresAt.toISOString() }, 201);
  });

  app.post('/app/api/admin/invites/:id/revoke', guard, async (c) => {
    await revokeInvite(db, access(c).userId, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/app/api/admin/password-resets', guard, async (c) => {
    const { userId } = await parseJson(c, passwordResetCreateSchema);
    await assertCanManage(db, access(c), userId);
    const issued = await createPasswordReset(db, access(c).userId, userId);
    return c.json({ id: issued.id, link: link('reset', issued.token), expiresAt: issued.expiresAt.toISOString() }, 201);
  });

  app.put('/app/api/admin/users/:id/roles', guard, async (c) => {
    const { roleIds } = await parseJson(c, userRolesSchema);
    const userId = c.req.param('id');
    await assertCanManage(db, access(c), userId);
    const grants = await grantsOf(db, roleIds);
    assertCanGrant(access(c), grants.permissions, grants.superadmin);
    await setUserRoles(db, access(c).userId, userId, roleIds);
    return c.json({ ok: true });
  });

  for (const [action, blocked] of [['block', true], ['unblock', false]] as const) {
    app.post(`/app/api/admin/users/:id/${action}`, guard, async (c) => {
      const userId = c.req.param('id');
      if (blocked && userId === access(c).userId) throw appError('APP_VALIDATION_FAILED', 'an admin cannot block themselves');
      await assertCanManage(db, access(c), userId);
      await setUserBlocked(db, access(c).userId, userId, blocked);
      return c.json({ ok: true });
    });
  }
}
