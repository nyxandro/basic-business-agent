import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TEST_PASSWORD, type TestApp } from './test-app.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

async function json(res: Response): Promise<{ error?: { code: string; message: string } } & Record<string, unknown>> {
  return (await res.json()) as { error?: { code: string; message: string } } & Record<string, unknown>;
}

function tokenOf(link: unknown): string {
  return String(link).split('/').pop()!;
}

describe('closed server', () => {
  it('answers 404 to Mastra built-in routes and to anything outside our routes', async () => {
    expect((await t.call('GET', '/api/agents')).status).toBe(404);
    expect((await t.call('POST', '/api/agents/assistant/generate', { body: {} })).status).toBe(404);
    const res = await t.call('GET', '/whatever');
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe('APP_NOT_FOUND');
  });

  it('requires a session for /app/api except the public addresses', async () => {
    const res = await t.call('GET', '/app/api/me');
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: { code: 'APP_AUTH_SESSION_EXPIRED', message: 'Сессия истекла. Войдите заново — разговоры сохранены.' } });
    expect((await t.call('GET', '/app/api/health')).status).toBe(200);
  });

  it('does not let anyone sign up on their own', async () => {
    const res = await t.call('POST', '/app/api/auth/sign-up/email', { body: { email: 'x@example.com', password: TEST_PASSWORD, name: 'X' } });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('invites', () => {
  it('lets an admin invite a person once; the link works one time only', async () => {
    await t.createUser({ email: 'igor@example.com', roleIds: [await t.roleId('superadmin')] });
    const admin = await t.signIn('igor@example.com');
    const created = await t.call('POST', '/app/api/admin/invites', {
      cookie: admin,
      body: { email: 'olga@example.com', name: 'Ольга', roleIds: [await t.roleId('employee')], departmentIds: [] },
    });
    expect(created.status).toBe(201);
    const { link } = await json(created);
    expect(String(link)).toMatch(/^http:\/\/localhost:8080\/invite\//);
    const token = tokenOf(link);
    expect(await json(await t.call('GET', `/app/api/invites/${token}`))).toEqual({ email: 'olga@example.com', name: 'Ольга' });

    const short = await t.call('POST', `/app/api/invites/${token}/accept`, { body: { password: 'short' } });
    expect((await json(short)).error?.code).toBe('APP_PASSWORD_TOO_SHORT');

    expect((await t.call('POST', `/app/api/invites/${token}/accept`, { body: { password: TEST_PASSWORD } })).status).toBe(200);
    const again = await t.call('POST', `/app/api/invites/${token}/accept`, { body: { password: TEST_PASSWORD } });
    expect((await json(again)).error?.code).toBe('APP_INVITE_INVALID');

    const olga = await t.signIn('olga@example.com');
    const me = await json(await t.call('GET', '/app/api/me', { cookie: olga }));
    expect(me).toMatchObject({ user: { email: 'olga@example.com', name: 'Ольга' }, isSuperadmin: false, permissions: [] });
  });

  it('refuses to invite an address that already has an account', async () => {
    const admin = await t.signIn('igor@example.com');
    const res = await t.call('POST', '/app/api/admin/invites', {
      cookie: admin,
      body: { email: 'OLGA@example.com', name: 'Ольга', roleIds: [await t.roleId('employee')], departmentIds: [] },
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe('APP_INVITE_EMAIL_EXISTS');
  });
});

describe('sign-in errors', () => {
  it('answers a wrong password in our format, and then limits the attempts', async () => {
    const ip = '10.200.0.1';
    const wrong = await t.call('POST', '/app/api/auth/sign-in/email', { body: { email: 'olga@example.com', password: 'wrong-password' }, ip });
    expect(wrong.status).toBe(401);
    expect((await json(wrong)).error?.code).toBe('APP_AUTH_INVALID_CREDENTIALS');
    let last: Response = wrong;
    for (let i = 0; i < 6; i++) last = await t.call('POST', '/app/api/auth/sign-in/email', { body: { email: 'olga@example.com', password: 'wrong-password' }, ip });
    expect(last.status).toBe(429);
    expect((await json(last)).error?.code).toBe('APP_AUTH_RATE_LIMITED');
  });
});

describe('password reset', () => {
  it('sets a new password and closes every open session of that person', async () => {
    const userId = await t.createUser({ email: 'petr@example.com' });
    const oldSession = await t.signIn('petr@example.com');
    expect((await t.call('GET', '/app/api/me', { cookie: oldSession })).status).toBe(200);

    const admin = await t.signIn('igor@example.com');
    const issued = await json(await t.call('POST', '/app/api/admin/password-resets', { cookie: admin, body: { userId } }));
    expect(String(issued.link)).toMatch(/\/reset\//);
    const token = tokenOf(issued.link);
    expect((await t.call('POST', `/app/api/password-resets/${token}/accept`, { body: { password: 'new-password-123' } })).status).toBe(200);

    expect((await t.call('GET', '/app/api/me', { cookie: oldSession })).status).toBe(401);
    await expect(t.signIn('petr@example.com')).rejects.toThrow();
    expect(await t.signIn('petr@example.com', 'new-password-123')).toBeTruthy();
    const reuse = await t.call('POST', `/app/api/password-resets/${token}/accept`, { body: { password: 'another-password-1' } });
    expect((await json(reuse)).error?.code).toBe('APP_PASSWORD_RESET_INVALID');
  });
});

describe('rights', () => {
  it('closes an admin section to a role without the right', async () => {
    const olga = await t.signIn('olga@example.com');
    const res = await t.call('GET', '/app/api/admin/users', { cookie: olga });
    expect(res.status).toBe(403);
    expect((await json(res)).error?.code).toBe('APP_ADMIN_FORBIDDEN');
  });

  it('opens exactly the sections of a custom role and forbids granting more than one has', async () => {
    const admin = await t.signIn('igor@example.com');
    const created = await json(await t.call('POST', '/app/api/admin/roles', { cookie: admin, body: { name: 'Кадры', permissions: ['users'] } }));
    const hrRole = String(created.id);
    await t.createUser({ email: 'hr@example.com', roleIds: [hrRole] });
    const hr = await t.signIn('hr@example.com');
    expect((await t.call('GET', '/app/api/admin/users', { cookie: hr })).status).toBe(200);
    // Roles can be read to pick them in an invite, but not changed without the «Роли» right.
    expect((await t.call('GET', '/app/api/admin/roles', { cookie: hr })).status).toBe(200);
    expect((await t.call('PUT', `/app/api/admin/roles/${hrRole}`, { cookie: hr, body: { name: 'Кадры', permissions: ['users', 'roles'] } })).status).toBe(403);

    const toSuperadmin = await t.call('POST', '/app/api/admin/invites', {
      cookie: hr,
      body: { email: 'friend@example.com', name: 'Друг', roleIds: [await t.roleId('superadmin')], departmentIds: [] },
    });
    expect((await json(toSuperadmin)).error?.code).toBe('APP_ADMIN_FORBIDDEN');

    const igorId = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'igor@example.com'`)).rows[0]!.id;
    const resetSuperadmin = await t.call('POST', '/app/api/admin/password-resets', { cookie: hr, body: { userId: igorId } });
    expect((await json(resetSuperadmin)).error?.code).toBe('APP_ADMIN_FORBIDDEN');
  });

  it('keeps at least one active superadmin', async () => {
    const admin = await t.signIn('igor@example.com');
    const igorId = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'igor@example.com'`)).rows[0]!.id;
    const demote = await t.call('PUT', `/app/api/admin/users/${igorId}/roles`, { cookie: admin, body: { roleIds: [await t.roleId('employee')] } });
    expect(demote.status).toBe(409);
    expect((await json(demote)).error?.code).toBe('APP_ADMIN_LAST_SUPERADMIN');

    await t.createUser({ email: 'second@example.com', roleIds: [await t.roleId('superadmin')] });
    const second = await t.signIn('second@example.com');
    const block = await t.call('POST', `/app/api/admin/users/${igorId}/block`, { cookie: second });
    expect(block.status).toBe(200);
    const secondId = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'second@example.com'`)).rows[0]!.id;
    const demoteSecond = await t.call('PUT', `/app/api/admin/users/${secondId}/roles`, { cookie: second, body: { roleIds: [await t.roleId('employee')] } });
    expect((await json(demoteSecond)).error?.code).toBe('APP_ADMIN_LAST_SUPERADMIN');
    await t.call('POST', `/app/api/admin/users/${igorId}/unblock`, { cookie: second });
  });

  it('blocks a person: open sessions stop working and sign-in is refused', async () => {
    const victimId = await t.createUser({ email: 'blocked@example.com' });
    const session = await t.signIn('blocked@example.com');
    const admin = await t.signIn('igor@example.com');
    expect((await t.call('POST', `/app/api/admin/users/${victimId}/block`, { cookie: admin })).status).toBe(200);
    expect((await t.call('GET', '/app/api/me', { cookie: session })).status).toBe(401);
    const res = await t.call('POST', '/app/api/auth/sign-in/email', { body: { email: 'blocked@example.com', password: TEST_PASSWORD } });
    expect(res.status).toBe(403);
    expect((await json(res)).error?.code).toBe('APP_AUTH_BANNED');
  });

  it('opens agents through departments and refuses unknown agents', async () => {
    const admin = await t.signIn('igor@example.com');
    const dep = String((await json(await t.call('POST', '/app/api/admin/departments', { cookie: admin, body: { name: 'Продажи' } }))).id);
    const olgaId = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'olga@example.com'`)).rows[0]!.id;
    expect((await t.call('PUT', `/app/api/admin/departments/${dep}/members`, { cookie: admin, body: { userIds: [olgaId] } })).status).toBe(200);
    expect((await t.call('PUT', `/app/api/admin/departments/${dep}/agents`, { cookie: admin, body: { agentIds: ['sales'] } })).status).toBe(200);
    const bad = await t.call('PUT', `/app/api/admin/departments/${dep}/agents`, { cookie: admin, body: { agentIds: ['ghost'] } });
    expect((await json(bad)).error?.code).toBe('APP_VALIDATION_FAILED');
    const olga = await t.signIn('olga@example.com');
    expect((await json(await t.call('GET', '/app/api/me', { cookie: olga }))).departmentIds).toEqual([dep]);
  });
});
