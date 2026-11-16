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
  'projects', 'thread_projects', 'project_shares', 'project_places', 'project_trash', 'models', 'model_provider_keys', 'model_settings', 'skills', 'skill_scope', 'task_scope', 'background_task_runs',
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
    expect(await migrate(db.url)).toEqual(['0001_initial.sql', '0002_builtin_roles.sql', '0003_agent_overrides_drafts.sql', '0004_oauth_states.sql', '0005_background_runs.sql', '0006_projects.sql', '0007_models.sql', '0008_skills.sql', '0009_task_scope.sql', '0010_org_name_starters.sql', '0011_chatgpt_accounts.sql', '0012_interface_settings.sql', '0013_drop_read_documents.sql', '0014_model_output_limit.sql', '0015_project_order.sql', '0016_project_access.sql', '0017_approval_project.sql', '0018_project_trash.sql', '0019_trash_overlap.sql']);
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

  // 0013: «Чтение документов» gives way to the system skills of documents (spec, section 8.18).
  it('removes the uploaded «Чтение документов» with a record in the audit, and no other skill', async () => {
    const stage = await createTestDatabase();
    const before = mkdtempSync(join(tmpdir(), 'bba-migrations-'));
    try {
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0013')) copyFileSync(join(MIGRATIONS_DIR, f), join(before, f));
      await migrate(stage.url, before);
      for (const name of ['read-documents', 'note-taking']) {
        await query(stage.url, `INSERT INTO app.skills (name, title, description, archive, sha256, size_bytes, files, has_scripts, scope) VALUES ('${name}', 't', 'd', '\\x00', '${'a'.repeat(64)}', 1, '[]', false, 'org')`);
      }
      expect(await migrate(stage.url)).toEqual(['0013_drop_read_documents.sql', '0014_model_output_limit.sql', '0015_project_order.sql', '0016_project_access.sql', '0017_approval_project.sql', '0018_project_trash.sql', '0019_trash_overlap.sql']);
      expect(await query(stage.url, 'SELECT name FROM app.skills')).toEqual([{ name: 'note-taking' }]);
      expect(await query(stage.url, `SELECT actor_user_id, action, target FROM app.admin_audit`)).toEqual([{ actor_user_id: null, action: 'skill.delete', target: 'read-documents' }]);
    } finally {
      rmSync(before, { recursive: true, force: true });
      await stage.drop();
    }
  });

  // 0014: the limit of an answer (spec, section 8.19) goes onto a catalog that already has models.
  it('adds the limit of an answer to models on keys and subscriptions without refusing them; they wait for the server', async () => {
    const stage = await createTestDatabase();
    const before = mkdtempSync(join(tmpdir(), 'bba-migrations-'));
    try {
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0014')) copyFileSync(join(MIGRATIONS_DIR, f), join(before, f));
      await migrate(stage.url, before);
      await query(
        stage.url,
        `INSERT INTO app.models (id, kind, label, connection, provider_model, vision, price_input, price_output, price_cache_read, price_cache_write, price_reasoning, price_image)
         VALUES ('m-onkey', 'chat', 'Qwen', 'api_key', 'groq/qwen/qwen3.8-27b', true, 1, 1, 1, 1, 1, 0)`,
      );
      await query(stage.url, `INSERT INTO app.models (id, kind, label, connection, provider_model, vision) VALUES ('m-sub', 'chat', 'GPT', 'chatgpt', 'chatgpt/gpt-5.4', true)`);
      expect(await migrate(stage.url)).toEqual(['0014_model_output_limit.sql', '0015_project_order.sql', '0016_project_access.sql', '0017_approval_project.sql', '0018_project_trash.sql', '0019_trash_overlap.sql']);
      expect(await query(stage.url, 'SELECT id, max_output_tokens FROM app.models ORDER BY id')).toEqual([
        { id: 'm-onkey', max_output_tokens: null },
        { id: 'm-sub', max_output_tokens: null },
      ]);
    } finally {
      rmSync(before, { recursive: true, force: true });
      await stage.drop();
    }
  });

  // 0015: the order of the side panel (spec, section 8.12) goes onto projects that already exist.
  it('gives existing projects the order they had, by name, per person, none of them pinned', async () => {
    const stage = await createTestDatabase();
    const before = mkdtempSync(join(tmpdir(), 'bba-migrations-'));
    try {
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0015')) copyFileSync(join(MIGRATIONS_DIR, f), join(before, f));
      await migrate(stage.url, before);
      await query(stage.url, `INSERT INTO app."user" ("id", "name", "email", "emailVerified") VALUES ('u1', 'Ольга', 'olga@example.com', true), ('u2', 'Пётр', 'petr@example.com', true)`);
      await query(
        stage.url,
        `INSERT INTO app.projects (id, user_id, name) VALUES
           ('00000000-0000-4000-8000-000000000001', 'u1', 'бета'), ('00000000-0000-4000-8000-000000000002', 'u1', 'Альфа'),
           ('00000000-0000-4000-8000-000000000003', 'u1', 'Гамма'), ('00000000-0000-4000-8000-000000000004', 'u2', 'Отчёты')`,
      );
      // Only 0015: the next migrations move these columns elsewhere.
      copyFileSync(join(MIGRATIONS_DIR, '0015_project_order.sql'), join(before, '0015_project_order.sql'));
      expect(await migrate(stage.url, before)).toEqual(['0015_project_order.sql']);
      expect(await query(stage.url, 'SELECT user_id, name, position, pinned FROM app.projects ORDER BY user_id, position')).toEqual([
        { user_id: 'u1', name: 'Альфа', position: 1, pinned: false },
        { user_id: 'u1', name: 'бета', position: 2, pinned: false },
        { user_id: 'u1', name: 'Гамма', position: 3, pinned: false },
        { user_id: 'u2', name: 'Отчёты', position: 1, pinned: false },
      ]);
      // A project without a place is a mistake of the server, not something to guess.
      await expect(query(stage.url, `INSERT INTO app.projects (id, user_id, name) VALUES ('00000000-0000-4000-8000-000000000005', 'u1', 'Дельта')`)).rejects.toThrow(/position/);
    } finally {
      rmSync(before, { recursive: true, force: true });
      await stage.drop();
    }
  });

  // 0016: shared projects (spec, section 8.20) go onto projects with their places in the panel.
  it('keeps existing projects private, moves their places into the panel table and keeps links', async () => {
    const stage = await createTestDatabase();
    const before = mkdtempSync(join(tmpdir(), 'bba-migrations-'));
    try {
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0016')) copyFileSync(join(MIGRATIONS_DIR, f), join(before, f));
      await migrate(stage.url, before);
      await query(stage.url, `INSERT INTO app."user" ("id", "name", "email", "emailVerified") VALUES ('u1', 'Ольга', 'olga@example.com', true)`);
      await query(
        stage.url,
        `INSERT INTO app.projects (id, user_id, name, position, pinned) VALUES
           ('00000000-0000-4000-8000-000000000001', 'u1', 'Альфа', 2, false), ('00000000-0000-4000-8000-000000000002', 'u1', 'Бета', 1, true)`,
      );
      await query(stage.url, `INSERT INTO app.thread_projects (thread_id, user_id, project_id) VALUES ('t1', 'u1', '00000000-0000-4000-8000-000000000001')`);
      expect(await migrate(stage.url)).toEqual(['0016_project_access.sql', '0017_approval_project.sql', '0018_project_trash.sql', '0019_trash_overlap.sql']);
      expect(await query(stage.url, 'SELECT name, access, archived_at FROM app.projects ORDER BY name')).toEqual([
        { name: 'Альфа', access: 'private', archived_at: null },
        { name: 'Бета', access: 'private', archived_at: null },
      ]);
      expect(await query(stage.url, 'SELECT user_id, project_id, position, pinned, seen_at IS NOT NULL AS seen FROM app.project_places ORDER BY position')).toEqual([
        { user_id: 'u1', project_id: '00000000-0000-4000-8000-000000000002', position: 1, pinned: true, seen: true },
        { user_id: 'u1', project_id: '00000000-0000-4000-8000-000000000001', position: 2, pinned: false, seen: true },
      ]);
      // Removing a project leaves the link of a conversation empty: the server names it before that.
      await query(stage.url, `DELETE FROM app.projects WHERE id = '00000000-0000-4000-8000-000000000001'`);
      expect(await query(stage.url, 'SELECT thread_id, project_id, lost_project_name FROM app.thread_projects')).toEqual([{ thread_id: 't1', project_id: null, lost_project_name: null }]);
      // A project without its access is a mistake of the server, not something to guess.
      await expect(query(stage.url, `INSERT INTO app.projects (id, user_id, name) VALUES ('00000000-0000-4000-8000-000000000003', 'u1', 'Гамма')`)).rejects.toThrow(/access/);
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
