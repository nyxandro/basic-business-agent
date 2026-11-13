// Applies SQL migrations from core/db/migrations in file-name order.
// Each migration runs in its own transaction: a failing file leaves the database exactly
// as it was before that file, and the start of the application stops with a code.
// An advisory lock keeps two starting processes from migrating at the same time.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { AppError } from '../errors/app-error.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

const MIGRATION_LOCK_KEY = 74_010_001;
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

function listMigrations(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const invalid = files.find((f) => !MIGRATION_FILE.test(f));
  if (invalid) {
    throw new AppError({
      code: 'APP_DB_MIGRATION_INVALID',
      message: `migration file name "${invalid}" does not match NNNN_name.sql`,
      userMessage: 'Приложение собрано с ошибкой: файл обновления базы назван неверно.',
      nextStep: 'Сообщите разработчику код ошибки.',
      details: { file: invalid },
    });
  }
  return files;
}

export async function migrate(databaseUrl: string, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = listMigrations(dir);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Session-level lock: released when the connection closes, whatever happens below.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query('CREATE SCHEMA IF NOT EXISTS app');
    await client.query(
      'CREATE TABLE IF NOT EXISTS app.schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query<{ id: string }>('SELECT id FROM app.schema_migrations')).rows.map((r) => r.id));
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO app.schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new AppError({
          code: 'APP_DB_MIGRATION_FAILED',
          message: `migration ${file} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
          userMessage: 'Не удалось обновить базу данных. Обновление отменено целиком, данные не изменены.',
          nextStep: 'Верните предыдущую версию приложения и сообщите разработчику код ошибки.',
          cause: error,
          details: { file },
        });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.end();
  }
}
