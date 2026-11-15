import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS_DIR } from './migrate.ts';
import { createTestDatabase, type TestDatabase } from './test-database.ts';

const EXPECTED_TABLES = [
  'user', 'session', 'account', 'verification',
  'roles', 'user_roles', 'departments', 'department_members', 'department_agents',
  'org_profile', 'user_profiles', 'invites', 'password_resets', 'limit_settings', 'user_limits',
  'model_keys', 'connector_credentials', 'usage_events', 'background_tasks', 'approval_requests',
  'action_journal', 'agent_overrides', 'admin_audit', 'masking_settings', 'masking_map', 'schema_migrations', 'oauth_states',
  'projects', 'thread_projects', 'models', 'model_provider_keys', 'model_settings', 'skills', 'skill_scope', 'task_scope', 'background_task_runs',
  'chatgpt_accounts', 'chatgpt_logins', 'account_events', 'interface_settings',
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
    expect(await migrate(db.url)).toEqual(['0001_initial.sql', '0002_builtin_roles.sql', '0003_agent_overrides_drafts.sql', '0004_oauth_states.sql', '0005_background_runs.sql', '0006_projects.sql', '0007_models.sql', '0008_skills.sql', '0009_task_scope.sql', '0010_org_name_starters.sql', '0011_chatgpt_accounts.sql', '0012_interface_settings.sql']);
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

  // 0009: a stage 1 task belonged to its owner; its owner becomes its one employee.
  it('moves the tasks of stage 1 to their owners, and stops a task without one', async () => {
    const stage = await createTestDatabase();
    const before = mkdtempSync(join(tmpdir(), 'bba-migrations-'));
    try {
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0009')) copyFileSync(join(MIGRATIONS_DIR, f), join(before, f));
      await migrate(stage.url, before);
      await query(stage.url, `INSERT INTO app."user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('u1', 'Ольга', 'olga@example.com', true, now(), now())`);
      await query(
        stage.url,
        `INSERT INTO app.background_tasks (id, title, agent_id, owner_user_id, cron, prompt, status, thread_id) VALUES
           ('morning', 'Сводка', 'sales', 'u1', '0 9 * * *', 'x', 'active', 'bg:morning'),
           ('orphan', 'Ничья', 'sales', NULL, '0 9 * * *', 'x', 'active', 'bg:orphan')`,
      );
      expect(await migrate(stage.url)).toContain('0009_task_scope.sql');
      expect(await query(stage.url, 'SELECT id, scope, created_by, status, paused_reason FROM app.background_tasks ORDER BY id')).toEqual([
        { id: 'morning', scope: 'users', created_by: 'u1', status: 'active', paused_reason: null },
        { id: 'orphan', scope: 'users', created_by: null, status: 'paused', paused_reason: 'scope_empty' },
      ]);
      expect(await query(stage.url, 'SELECT task_id, user_id, department_id FROM app.task_scope')).toEqual([{ task_id: 'morning', user_id: 'u1', department_id: null }]);
    } finally {
      rmSync(before, { recursive: true, force: true });
      await stage.drop();
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
