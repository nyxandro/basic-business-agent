// Admin section «Пользователи»: invites, password resets, roles of a person, blocking.
import { inviteCreateSchema, passwordResetCreateSchema, userLimitsSchema, userProfileSchema, userRolesSchema, type AdminPeopleResponse } from '@bba/contracts';
import { writeAudit } from '../../audit/audit.ts';
import type { ModelGateway } from '../../models/gateway.ts';
import { deleteEmployee, type DeletionDeps } from '../deletion.ts';
import type { Hono } from 'hono';
import { loadAccess, type AccessContext } from '../../auth/access.ts';
import { grantsOf } from '../../auth/roles.ts';
import { createInvite, createPasswordReset, listUsers, revokeInvite, setUserBlocked, setUserRoles } from '../../auth/users.ts';
import type { Db } from '../../db/pool.ts';
import { appError } from '../../errors/catalog.ts';
import { assertCanGrant, requireAnyPermission, requirePermission } from '../../server/guards.ts';
import { access, parseJson, type AppEnv } from '../../server/http.ts';

// Managing someone (reset link, roles, block) needs at least the rights that person has:
// otherwise an admin could take over a stronger account through a reset link.
async function assertCanManage(db: Db, actor: AccessContext, targetUserId: string): Promise<void> {
  const target = await loadAccess(db, targetUserId);
  if (!target) throw appError('APP_NOT_FOUND', `user ${targetUserId} not found`);
  assertCanGrant(actor, [...target.permissions], target.isSuperadmin);
}

export function registerPeopleRoutes(
  app: Hono<AppEnv>,
  deps: { db: Db; publicUrl: string; deletion: DeletionDeps; gateway: Pick<ModelGateway, 'syncUserBudget'> },
): void {
  const { db, publicUrl } = deps;
  const guard = requirePermission('users');
  const link = (kind: 'invite' | 'reset', token: string) => new URL(`/${kind}/${token}`, publicUrl).toString();

  app.get('/app/api/admin/users', requireAnyPermission('users', 'departments', 'limits'), async (c) => c.json({ users: await listUsers(db) }));
  // Names only, to pick whom a skill or a background task is for: no e-mails, roles or blocking.
  app.get('/app/api/admin/people', requireAnyPermission('users', 'departments', 'limits', 'skills', 'agents'), async (c) => {
    const { rows } = await db.query<{ id: string; name: string }>('SELECT "id", "name" FROM app."user" ORDER BY "name", "id"');
    const body: AdminPeopleResponse = { people: rows };
    return c.json(body);
  });

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

  app.get('/app/api/admin/invites', guard, async (c) => {
    const { rows } = await db.query<{ id: string; email: string; name: string; created_at: Date; expires_at: Date }>(
      'SELECT id, email, name, created_at, expires_at FROM app.invites WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC',
    );
    return c.json({ invites: rows.map((r) => ({ id: r.id, email: r.email, name: r.name, createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString() })) });
  });

  app.put('/app/api/admin/users/:id/profile', guard, async (c) => {
    const input = await parseJson(c, userProfileSchema);
    const userId = c.req.param('id');
    await assertCanManage(db, access(c), userId);
    await db.query('UPDATE app."user" SET "name" = $2, "updatedAt" = now() WHERE "id" = $1', [userId, input.name]);
    await db.query('INSERT INTO app.user_profiles (user_id, position) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET position = EXCLUDED.position', [userId, input.position]);
    await writeAudit(db, { actorUserId: access(c).userId, action: 'user.profile', target: userId, details: input });
    return c.json({ ok: true });
  });

  app.put('/app/api/admin/users/:id/limits', requirePermission('limits'), async (c) => {
    const input = await parseJson(c, userLimitsSchema);
    const userId = c.req.param('id');
    await db.query(
      `INSERT INTO app.user_limits (user_id, monthly_rub, daily_subscription_tokens, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE SET monthly_rub = EXCLUDED.monthly_rub, daily_subscription_tokens = EXCLUDED.daily_subscription_tokens,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [userId, input.monthlyRub, input.dailySubscriptionTokens, access(c).userId],
    );
    await deps.gateway.syncUserBudget(userId);
    await writeAudit(db, { actorUserId: access(c).userId, action: 'user.limits', target: userId, details: input });
    return c.json({ ok: true });
  });

  app.delete('/app/api/admin/users/:id', guard, async (c) => {
    const userId = c.req.param('id');
    await assertCanManage(db, access(c), userId);
    await deleteEmployee(deps.deletion, access(c).userId, userId);
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
