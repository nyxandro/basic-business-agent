// Default-deny session check for /app/api and rights checks for admin sections.
import type { AdminSection, Permission } from '@bba/contracts';
import type { MiddlewareHandler } from 'hono';
import { loadAccess, type AccessContext } from '../auth/access.ts';
import type { Auth } from '../auth/auth.ts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import type { AppEnv } from './http.ts';

// The only addresses under /app/api that work without a session.
// The client document of the installation is read by the systems MCP servers sign in with (static, no data). The address
// of a webhook task is reached by another system: its secret is the access (docs/specs/[20.11.2026]-event-tasks.md).
const PUBLIC_PREFIXES = ['/app/api/auth/', '/app/api/health', '/app/api/invites/', '/app/api/password-resets/', '/app/api/internal/', '/app/api/connections/oauth/client.json', '/app/api/hooks/'];

export function isPublicPath(path: string): boolean {
  return PUBLIC_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p));
}

export function requireSession(db: Db, auth: Auth): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isPublicPath(c.req.path)) return next();
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw appError('APP_AUTH_SESSION_EXPIRED', 'no valid session');
    const ctx = await loadAccess(db, session.user.id);
    if (!ctx) throw appError('APP_AUTH_SESSION_EXPIRED', 'session user no longer exists');
    if (ctx.blocked) {
      await db.query('DELETE FROM app."session" WHERE "userId" = $1', [ctx.userId]);
      throw appError('APP_AUTH_BANNED', 'user is blocked');
    }
    c.set('access', ctx);
    return next();
  };
}

export function requirePermission(section: AdminSection): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get('access').permissions.has(section)) throw appError('APP_ADMIN_FORBIDDEN', `missing permission ${section}`);
    return next();
  };
}

// Reading a list that a neighbouring section needs: whoever invites people picks roles and
// departments, whoever builds departments picks people and agents. Changes keep their own right.
export function requireAnyPermission(...sections: AdminSection[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const permissions = c.get('access').permissions;
    if (!sections.some((s) => permissions.has(s))) throw appError('APP_ADMIN_FORBIDDEN', `missing any of permissions ${sections.join(', ')}`);
    return next();
  };
}

// Nobody grants rights they do not have: closes "give myself more rights" through roles or invites.
export function assertCanGrant(ctx: AccessContext, permissions: readonly Permission[], grantsSuperadmin: boolean): void {
  if (grantsSuperadmin && !ctx.isSuperadmin) throw appError('APP_ADMIN_FORBIDDEN', 'only a superadmin can grant or remove the superadmin role');
  const missing = permissions.filter((p) => !ctx.permissions.has(p));
  if (missing.length > 0) throw appError('APP_ADMIN_FORBIDDEN', `cannot grant permissions the actor lacks: ${missing.join(', ')}`);
}
