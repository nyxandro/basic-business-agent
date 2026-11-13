// pnpm admin:create <email> "<name>"   — invite link for a superadmin (first start of an installation)
// pnpm admin:reset-password <email>   — password reset link for an existing person
// Links instead of passwords on the command line: nothing secret stays in the shell history.
import { builtinRoleId } from '../auth/roles.ts';
import { createInvite, createPasswordReset } from '../auth/users.ts';
import { createPool } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`APP_CONFIG_INVALID: .env: ${name}: is not set`);
    process.exit(1);
  }
  return value;
}

const [command, email, name] = process.argv.slice(2);
const usage = 'Usage: admin.ts create <email> "<name>" | admin.ts reset-password <email>';
if (!command || !email || (command === 'create' && !name)) {
  console.error(usage);
  process.exit(1);
}

const publicUrl = requireEnv('APP_PUBLIC_URL');
const db = createPool(requireEnv('DATABASE_URL'));
try {
  if (command === 'create') {
    const issued = await createInvite(db, null, { email, name: name!, roleIds: [await builtinRoleId(db, 'superadmin')], departmentIds: [] });
    console.log(`Superadmin invite (valid until ${issued.expiresAt.toISOString()}):\n${new URL(`/invite/${issued.token}`, publicUrl).toString()}`);
  } else if (command === 'reset-password') {
    const { rows } = await db.query<{ id: string }>('SELECT "id" FROM app."user" WHERE lower("email") = lower($1)', [email]);
    if (!rows[0]) throw new Error(`APP_NOT_FOUND: no user with e-mail ${email}`);
    const issued = await createPasswordReset(db, null, rows[0].id);
    console.log(`Password reset link (valid until ${issued.expiresAt.toISOString()}):\n${new URL(`/reset/${issued.token}`, publicUrl).toString()}`);
  } else {
    console.error(usage);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(isAppError(error) ? error.message : error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.end();
}
