// pnpm dev:people — the people of the browser stand (tests/e2e/stand.ts) in the development
// installation, with the same password, so the same logins work on both:
//   igor@example.com — superadmin; olga@example.com — «Продажи»; petr@example.com — «Бухгалтерия».
// Everyone already there gets that password too. Each department gets the agents of agents/.
// Development only: it refuses an installation whose address is not this machine.
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAuth } from '../core/auth/auth.ts';
import { builtinRoleId } from '../core/auth/roles.ts';
import { acceptInvite, acceptPasswordReset, createInvite, createPasswordReset } from '../core/auth/users.ts';
import { createAuthPool, createPool, type Db } from '../core/db/pool.ts';
import { TEST_PASSWORD } from '../core/server/test-app.ts';

const PEOPLE = [
  { email: 'igor@example.com', name: 'Игорь', role: 'superadmin', department: null },
  { email: 'olga@example.com', name: 'Ольга', role: 'employee', department: 'Продажи' },
  { email: 'petr@example.com', name: 'Пётр', role: 'employee', department: 'Бухгалтерия' },
] as const;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`APP_CONFIG_INVALID: .env: ${name}: is not set`);
  return value;
}

async function departmentId(db: Db, name: string): Promise<string> {
  await db.query('INSERT INTO app.departments (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
  const { rows } = await db.query<{ id: string }>('SELECT id FROM app.departments WHERE name = $1', [name]);
  return rows[0]!.id;
}

const publicUrl = requireEnv('APP_PUBLIC_URL');
if (!LOCAL_HOSTS.has(new URL(publicUrl).hostname)) {
  console.error(`dev:people sets a known password: only for an installation on this machine, not ${publicUrl}`);
  process.exit(1);
}
const databaseUrl = requireEnv('DATABASE_URL');
const db = createPool(databaseUrl);
const authPool = createAuthPool(databaseUrl);
const auth = createAuth({ db, authPool, secret: requireEnv('BETTER_AUTH_SECRET'), publicUrl });
const agentsDir = fileURLToPath(new URL('../agents', import.meta.url));
const agentIds = readdirSync(agentsDir).filter((d) => statSync(`${agentsDir}/${d}`).isDirectory());

try {
  for (const person of PEOPLE) {
    const { rows } = await db.query<{ id: string }>('SELECT "id" FROM app."user" WHERE lower("email") = $1', [person.email]);
    if (!rows[0]) {
      const issued = await createInvite(db, null, { email: person.email, name: person.name, roleIds: [await builtinRoleId(db, person.role)], departmentIds: [] });
      await acceptInvite(db, auth, issued.token, TEST_PASSWORD);
    }
    if (person.department) {
      const dep = await departmentId(db, person.department);
      await db.query('INSERT INTO app.department_members (department_id, user_id) SELECT $1, "id" FROM app."user" WHERE lower("email") = $2 ON CONFLICT DO NOTHING', [dep, person.email]);
      for (const agentId of agentIds) await db.query('INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [dep, agentId]);
    }
  }
  // Everyone signs in with the same password, the people of earlier tries too.
  const { rows: everyone } = await db.query<{ id: string; email: string }>('SELECT "id", "email" FROM app."user" ORDER BY "email"');
  for (const user of everyone) {
    const issued = await createPasswordReset(db, null, user.id);
    await acceptPasswordReset(db, auth, issued.token, TEST_PASSWORD);
  }
  console.log(`dev:people: ${everyone.map((u) => u.email).join(', ')} — password ${TEST_PASSWORD}`);
} finally {
  await db.end();
  await authPool.end();
}
