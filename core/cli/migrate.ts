// pnpm db:migrate — apply pending migrations to DATABASE_URL (the server also does it on start).
import { isAppError } from '../errors/app-error.ts';
import { migrate } from '../db/migrate.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('APP_CONFIG_INVALID: .env: DATABASE_URL: is not set');
  process.exit(1);
}

try {
  const applied = await migrate(databaseUrl);
  console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
} catch (error) {
  console.error(isAppError(error) ? error.message : error);
  process.exit(1);
}
