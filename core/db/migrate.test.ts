import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './migrate.ts';
import { createTestDatabase, type TestDatabase } from './test-database.ts';

const EXPECTED_TABLES = [
  'user', 'session', 'account', 'verification',
  'roles', 'user_roles', 'departments', 'department_members', 'department_agents',
  'org_profile', 'user_profiles', 'invites', 'password_resets', 'limit_settings', 'user_limits',
  'model_keys', 'connector_credentials', 'usage_events', 'background_tasks', 'approval_requests',
  'action_journal', 'agent_overrides', 'admin_audit', 'masking_settings', 'masking_map', 'schema_migrations',
];

async function query<T extends pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

describe('migrate', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('creates every table of the installation and is idempotent', async () => {
    expect(await migrate(db.url)).toEqual(['0001_initial.sql', '0002_builtin_roles.sql', '0003_agent_overrides_drafts.sql']);
    const rows = await query<{ table_name: string }>(db.url, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'app'");
    expect(rows.map((r) => r.table_name).sort()).toEqual([...EXPECTED_TABLES].sort());
    const schemas = await query<{ schema_name: string }>(db.url, "SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('mastra', 'litellm')");
    expect(schemas).toHaveLength(2);
    expect(await migrate(db.url)).toEqual([]);
  });

  it('matches the schema Better Auth expects: nothing to create or add', async () => {
    const pool = new pg.Pool({ connectionString: db.url, options: '-c search_path=app' });
    try {
      const plan = await getMigrations({ database: pool, emailAndPassword: { enabled: true } });
      expect(plan.toBeCreated.map((t) => t.table)).toEqual([]);
      expect(plan.toBeAdded.map((t) => `${t.table}: ${Object.keys(t.fields).join(',')}`)).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('keeps journals append-only', async () => {
    await query(db.url, "INSERT INTO app.action_journal (run_kind, event, result) VALUES ('chat', 'tool_call', 'ok')");
    await expect(query(db.url, "UPDATE app.action_journal SET result = 'error'")).rejects.toThrow(/APP_DB_APPEND_ONLY/);
    await expect(query(db.url, 'DELETE FROM app.action_journal')).rejects.toThrow(/APP_DB_APPEND_ONLY/);
    await expect(query(db.url, 'DELETE FROM app.admin_audit')).resolves.toEqual([]);
    await query(db.url, "INSERT INTO app.admin_audit (action) VALUES ('role.update')");
    await expect(query(db.url, 'DELETE FROM app.admin_audit')).rejects.toThrow(/APP_DB_APPEND_ONLY/);
  });
});

describe('migrate with a failing migration', () => {
  let db: TestDatabase;
  let dir: string;
  beforeAll(async () => {
    db = await createTestDatabase();
    dir = mkdtempSync(join(tmpdir(), 'bba-migrations-'));
    writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE app.first (id int);');
    writeFileSync(join(dir, '0002_broken.sql'), 'CREATE TABLE app.second (id int);\nSELECT * FROM app.no_such_table;');
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  });

  it('rolls the failing file back entirely and reports it', async () => {
    await expect(migrate(db.url, dir)).rejects.toMatchObject({ code: 'APP_DB_MIGRATION_FAILED', details: { file: '0002_broken.sql' } });
    const tables = await query<{ table_name: string }>(db.url, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'app' AND table_name IN ('first', 'second')");
    expect(tables.map((t) => t.table_name)).toEqual(['first']);
    const applied = await query<{ id: string }>(db.url, 'SELECT id FROM app.schema_migrations');
    expect(applied.map((r) => r.id)).toEqual(['0001_ok.sql']);
  });

  it('refuses a migration file with a wrong name', async () => {
    writeFileSync(join(dir, 'oops.sql'), 'SELECT 1;');
    await expect(migrate(db.url, dir)).rejects.toMatchObject({ code: 'APP_DB_MIGRATION_INVALID' });
  });
});
