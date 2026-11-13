// pnpm tasks <command> — background tasks for the developer, until the owner decides F2
// (who creates tasks: a config file, the admin panel or the employee in the chat). Every option
// writes the same table; the running server picks changes up within a minute.
//   create <id> <agent id> <owner e-mail> "<cron>" "<title>" "<prompt>"
//   list | pause <id> | resume <id> | delete <id>
import { fileURLToPath } from 'node:url';
import { Cron } from 'croner';
import { loadInstallation } from '../config/load.ts';
import { createPool } from '../db/pool.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TASK_ID = /^[a-z0-9][a-z0-9-]{1,60}$/;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL ?? fail('APP_CONFIG_INVALID: .env: DATABASE_URL: is not set');
const [command, ...args] = process.argv.slice(2);
const db = createPool(databaseUrl);

try {
  switch (command) {
    case 'create': {
      const [id, agentId, email, cron, title, prompt] = args;
      if (!id || !agentId || !email || !cron || !title || !prompt) fail('Usage: tasks create <id> <agent id> <owner e-mail> "<cron>" "<title>" "<prompt>"');
      if (!TASK_ID.test(id)) fail('APP_VALIDATION_FAILED: id: use 2–61 lowercase letters, digits and dashes');
      const installation = await loadInstallation(ROOT, process.env);
      if (!installation.agents.some((a) => a.passport.id === agentId)) fail(`APP_VALIDATION_FAILED: agent "${agentId}" is not in agents/`);
      new Cron(cron, { timezone: installation.app.timezone, paused: true });
      const { rows } = await db.query<{ id: string }>('SELECT "id" FROM app."user" WHERE lower("email") = lower($1)', [email]);
      if (!rows[0]) fail(`APP_NOT_FOUND: no employee with e-mail ${email}`);
      await db.query(`INSERT INTO app.background_tasks (id, title, agent_id, owner_user_id, cron, prompt, status, thread_id) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`, [
        id,
        title,
        agentId,
        rows[0].id,
        cron,
        prompt,
        `bg:${id}`,
      ]);
      console.log(`Task ${id} created; the server schedules it within a minute.`);
      break;
    }
    case 'list': {
      const { rows } = await db.query<{ id: string; title: string; agent_id: string; cron: string; status: string; email: string | null; last_run_at: Date | null }>(
        `SELECT t.id, t.title, t.agent_id, t.cron, t.status, u."email" AS email, t.last_run_at FROM app.background_tasks t LEFT JOIN app."user" u ON u."id" = t.owner_user_id ORDER BY t.id`,
      );
      for (const r of rows) console.log(`${r.id}\t${r.status}\t${r.cron}\t${r.agent_id}\t${r.email ?? '(no owner)'}\t${r.last_run_at?.toISOString() ?? 'never'}\t${r.title}`);
      break;
    }
    case 'pause':
    case 'resume': {
      const [id] = args;
      const { rowCount } = await db.query("UPDATE app.background_tasks SET status = $2, paused_reason = NULL, updated_at = now() WHERE id = $1", [id, command === 'pause' ? 'paused' : 'active']);
      if (!rowCount) fail(`APP_NOT_FOUND: no task ${id}`);
      console.log(`Task ${id} ${command === 'pause' ? 'paused' : 'resumed'}.`);
      break;
    }
    case 'delete': {
      const [id] = args;
      const { rowCount } = await db.query('DELETE FROM app.background_tasks WHERE id = $1', [id]);
      if (!rowCount) fail(`APP_NOT_FOUND: no task ${id}`);
      console.log(`Task ${id} deleted; its schedule goes away within a minute.`);
      break;
    }
    default:
      fail('Usage: tasks create|list|pause|resume|delete …');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.end();
}
