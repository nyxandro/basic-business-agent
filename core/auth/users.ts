// People of the installation: invites, password resets, roles, blocking (spec, scenario 5).
// Links are copied by the admin and sent by hand; there are no e-mails (spec, section 15).
import { SHARED } from '../projects/access.ts';
import type { InviteCreate } from '@bba/contracts';
import type pg from 'pg';
import { writeAudit } from '../audit/audit.ts';
import type { Db } from '../db/pool.ts';
import { inTransaction } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import type { Auth } from './auth.ts';
import { generateToken, hashToken } from './tokens.ts';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1000;
// Serialises changes that could leave the installation without an active superadmin.
const SUPERADMIN_LOCK_KEY = 74_010_002;

export interface IssuedLink {
  id: string;
  token: string;
  expiresAt: Date;
}

export interface UserListItem {
  id: string;
  email: string;
  name: string;
  position: string;
  blocked: boolean;
  roleIds: string[];
  departmentIds: string[];
  createdAt: Date;
  // Their projects and how many of them are open to colleagues: they go to the administrator who
  // removes the employee (spec, section 8.20).
  projects: { total: number; shared: number };
}

async function emailTaken(db: Pick<pg.Pool, 'query'>, email: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM app."user" WHERE lower("email") = lower($1)', [email]);
  return (rowCount ?? 0) > 0;
}

async function assertRolesExist(db: Pick<pg.Pool, 'query'>, roleIds: string[]): Promise<void> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.roles WHERE id = ANY($1::uuid[])', [roleIds]);
  if (rows[0]?.n !== new Set(roleIds).size) throw appError('APP_VALIDATION_FAILED', 'unknown role id', { details: { field: 'roleIds' } });
}

async function assertDepartmentsExist(db: Pick<pg.Pool, 'query'>, ids: string[]): Promise<void> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.departments WHERE id = ANY($1::uuid[])', [ids]);
  if (rows[0]?.n !== new Set(ids).size) throw appError('APP_VALIDATION_FAILED', 'unknown department id', { details: { field: 'departmentIds' } });
}

export async function createInvite(db: Db, actorUserId: string | null, input: InviteCreate): Promise<IssuedLink> {
  if (await emailTaken(db, input.email)) throw appError('APP_INVITE_EMAIL_EXISTS', `user ${input.email} already exists`);
  await assertRolesExist(db, input.roleIds);
  await assertDepartmentsExist(db, input.departmentIds);
  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  return inTransaction(db, async (c) => {
    // A new invite replaces older unused ones for the same address.
    await c.query('UPDATE app.invites SET revoked_at = now() WHERE lower(email) = lower($1) AND used_at IS NULL AND revoked_at IS NULL', [input.email]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.invites (email, name, role_ids, department_ids, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.email, input.name, input.roleIds, input.departmentIds, hashToken(token), actorUserId, expiresAt],
    );
    const id = rows[0]!.id;
    await writeAudit(c, { actorUserId, action: 'invite.create', target: input.email, details: { inviteId: id, roleIds: input.roleIds } });
    return { id, token, expiresAt };
  });
}

export async function revokeInvite(db: Db, actorUserId: string, inviteId: string): Promise<void> {
  const { rowCount } = await db.query('UPDATE app.invites SET revoked_at = now() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL', [inviteId]);
  if (!rowCount) throw appError('APP_NOT_FOUND', `invite ${inviteId} is not pending`);
  await writeAudit(db, { actorUserId, action: 'invite.revoke', target: inviteId });
}

interface InviteRow {
  id: string;
  email: string;
  name: string;
  role_ids: string[];
  department_ids: string[];
}

const VALID_INVITE = 'token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()';

export async function findInvite(db: Db, token: string): Promise<{ email: string; name: string }> {
  const { rows } = await db.query<InviteRow>(`SELECT email, name FROM app.invites WHERE ${VALID_INVITE}`, [hashToken(token)]);
  if (!rows[0]) throw appError('APP_INVITE_INVALID', 'invite token is unknown, used, revoked or expired');
  return { email: rows[0].email, name: rows[0].name };
}

export async function acceptInvite(db: Db, auth: Auth, token: string, password: string): Promise<{ email: string }> {
  // Claim the invite atomically so the same link cannot create two accounts.
  const { rows } = await db.query<InviteRow>(
    `UPDATE app.invites SET used_at = now() WHERE ${VALID_INVITE} RETURNING id, email, name, role_ids, department_ids`,
    [hashToken(token)],
  );
  const invite = rows[0];
  if (!invite) throw appError('APP_INVITE_INVALID', 'invite token is unknown, used, revoked or expired');
  try {
    if (await emailTaken(db, invite.email)) throw appError('APP_INVITE_EMAIL_EXISTS', `user ${invite.email} already exists`);
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: invite.email, name: invite.name, emailVerified: true }, { method: 'admin' });
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: await ctx.password.hash(password) });
    await inTransaction(db, async (c) => {
      await c.query('INSERT INTO app.user_profiles (user_id) VALUES ($1)', [user.id]);
      await c.query('INSERT INTO app.user_roles (user_id, role_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING', [user.id, invite.role_ids]);
      await c.query(
        'INSERT INTO app.department_members (department_id, user_id) SELECT d, $1 FROM unnest($2::uuid[]) AS d WHERE EXISTS (SELECT 1 FROM app.departments WHERE id = d)',
        [user.id, invite.department_ids],
      );
      await writeAudit(c, { actorUserId: user.id, action: 'invite.accept', target: invite.email, details: { inviteId: invite.id } });
    });
    return { email: invite.email };
  } catch (error) {
    // Recovery path: give the link back so the person can retry after the cause is fixed.
    await db.query('UPDATE app.invites SET used_at = NULL WHERE id = $1', [invite.id]);
    throw error;
  }
}

export async function createPasswordReset(db: Db, actorUserId: string | null, userId: string): Promise<IssuedLink> {
  const { rowCount } = await db.query('SELECT 1 FROM app."user" WHERE "id" = $1', [userId]);
  if (!rowCount) throw appError('APP_NOT_FOUND', `user ${userId} not found`);
  const token = generateToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
  return inTransaction(db, async (c) => {
    await c.query('UPDATE app.password_resets SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [userId]);
    const { rows } = await c.query<{ id: string }>(
      'INSERT INTO app.password_resets (user_id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, hashToken(token), actorUserId, expiresAt],
    );
    await writeAudit(c, { actorUserId, action: 'password_reset.create', target: userId });
    return { id: rows[0]!.id, token, expiresAt };
  });
}

const VALID_RESET = 'r.token_hash = $1 AND r.used_at IS NULL AND r.revoked_at IS NULL AND r.expires_at > now()';

export async function findPasswordReset(db: Db, token: string): Promise<{ email: string }> {
  const { rows } = await db.query<{ email: string }>(
    `SELECT u."email" FROM app.password_resets r JOIN app."user" u ON u."id" = r.user_id WHERE ${VALID_RESET}`,
    [hashToken(token)],
  );
  if (!rows[0]) throw appError('APP_PASSWORD_RESET_INVALID', 'reset token is unknown, used, revoked or expired');
  return rows[0];
}

export async function acceptPasswordReset(db: Db, auth: Auth, token: string, password: string): Promise<{ email: string }> {
  const { rows } = await db.query<{ id: string; user_id: string }>(
    `UPDATE app.password_resets r SET used_at = now() WHERE ${VALID_RESET} RETURNING r.id, r.user_id`,
    [hashToken(token)],
  );
  const reset = rows[0];
  if (!reset) throw appError('APP_PASSWORD_RESET_INVALID', 'reset token is unknown, used, revoked or expired');
  try {
    const ctx = await auth.$context;
    await ctx.internalAdapter.updatePassword(reset.user_id, await ctx.password.hash(password));
    // A new password closes every open session of that person.
    await ctx.internalAdapter.deleteUserSessions(reset.user_id);
  } catch (error) {
    await db.query('UPDATE app.password_resets SET used_at = NULL WHERE id = $1', [reset.id]);
    throw error;
  }
  const { rows: users } = await db.query<{ email: string }>('SELECT "email" FROM app."user" WHERE "id" = $1', [reset.user_id]);
  await writeAudit(db, { actorUserId: reset.user_id, action: 'password_reset.accept', target: reset.user_id });
  return { email: users[0]!.email };
}

// Throws if the change would leave no active superadmin. Call inside a transaction holding SUPERADMIN_LOCK_KEY.
async function assertKeepsActiveSuperadmin(c: pg.PoolClient, change: { userId: string; losesSuperadmin: boolean }): Promise<void> {
  if (!change.losesSuperadmin) return;
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(DISTINCT ur.user_id)::int AS n
       FROM app.user_roles ur JOIN app.roles r ON r.id = ur.role_id AND r.builtin = 'superadmin'
       LEFT JOIN app.user_profiles p ON p.user_id = ur.user_id
      WHERE ur.user_id <> $1 AND p.blocked_at IS NULL AND p.deletion_started_at IS NULL`,
    [change.userId],
  );
  if ((rows[0]?.n ?? 0) === 0) throw appError('APP_ADMIN_LAST_SUPERADMIN', `change would leave no active superadmin (user ${change.userId})`);
}

async function isSuperadmin(c: Pick<pg.Pool, 'query'>, userId: string): Promise<boolean> {
  const { rowCount } = await c.query(
    "SELECT 1 FROM app.user_roles ur JOIN app.roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.builtin = 'superadmin'",
    [userId],
  );
  return (rowCount ?? 0) > 0;
}

async function assertUserExists(c: Pick<pg.Pool, 'query'>, userId: string): Promise<void> {
  const { rowCount } = await c.query('SELECT 1 FROM app."user" WHERE "id" = $1', [userId]);
  if (!rowCount) throw appError('APP_NOT_FOUND', `user ${userId} not found`);
}

export async function setUserRoles(db: Db, actorUserId: string, userId: string, roleIds: string[]): Promise<void> {
  await assertRolesExist(db, roleIds);
  await inTransaction(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [SUPERADMIN_LOCK_KEY]);
    await assertUserExists(c, userId);
    const { rows } = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM app.roles WHERE id = ANY($1::uuid[]) AND builtin = 'superadmin'", [roleIds]);
    const keepsSuperadmin = (rows[0]?.n ?? 0) > 0;
    await assertKeepsActiveSuperadmin(c, { userId, losesSuperadmin: (await isSuperadmin(c, userId)) && !keepsSuperadmin });
    await c.query('DELETE FROM app.user_roles WHERE user_id = $1', [userId]);
    await c.query('INSERT INTO app.user_roles (user_id, role_id) SELECT $1, unnest($2::uuid[])', [userId, roleIds]);
    await writeAudit(c, { actorUserId, action: 'user.roles', target: userId, details: { roleIds } });
  });
}

export async function setUserBlocked(db: Db, actorUserId: string, userId: string, blocked: boolean): Promise<void> {
  await inTransaction(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [SUPERADMIN_LOCK_KEY]);
    await assertUserExists(c, userId);
    if (blocked) await assertKeepsActiveSuperadmin(c, { userId, losesSuperadmin: await isSuperadmin(c, userId) });
    await c.query(
      `INSERT INTO app.user_profiles (user_id, blocked_at) VALUES ($1, CASE WHEN $2 THEN now() END)
       ON CONFLICT (user_id) DO UPDATE SET blocked_at = CASE WHEN $2 THEN now() END`,
      [userId, blocked],
    );
    if (blocked) await c.query('DELETE FROM app."session" WHERE "userId" = $1', [userId]);
    await writeAudit(c, { actorUserId, action: blocked ? 'user.block' : 'user.unblock', target: userId });
  });
}

export async function listUsers(db: Db): Promise<UserListItem[]> {
  const { rows } = await db.query<{
    id: string; email: string; name: string; position: string | null; blocked: boolean; role_ids: string[] | null; department_ids: string[] | null; projects: number; shared_projects: number; created_at: Date;
  }>(
    `SELECT u."id" AS id, u."email" AS email, u."name" AS name, p.position,
            COALESCE(p.blocked_at IS NOT NULL OR p.deletion_started_at IS NOT NULL, false) AS blocked,
            (SELECT array_agg(role_id::text) FROM app.user_roles WHERE user_id = u."id") AS role_ids,
            (SELECT array_agg(department_id::text) FROM app.department_members WHERE user_id = u."id") AS department_ids,
            (SELECT count(*)::int FROM app.projects p WHERE p.user_id = u."id") AS projects,
            (SELECT count(*)::int FROM app.projects p WHERE p.user_id = u."id" AND ${SHARED}) AS shared_projects,
            u."createdAt" AS created_at
       FROM app."user" u LEFT JOIN app.user_profiles p ON p.user_id = u."id"
      ORDER BY u."name"`,
  );
  return rows.map((r) => ({
    id: r.id, email: r.email, name: r.name, position: r.position ?? '', blocked: r.blocked,
    roleIds: r.role_ids ?? [], departmentIds: r.department_ids ?? [], createdAt: r.created_at, projects: { total: r.projects, shared: r.shared_projects },
  }));
}
