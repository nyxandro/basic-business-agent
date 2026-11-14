// Browser stand: the real server on a fresh test database (dropped on exit) with a stand-in model
// that answers by keywords (stand-model.ts). Needs the development stand (pnpm dev:db).
//   pnpm stand      — server on :3000
//   pnpm dev:web    — interface on http://localhost:8080
// Sign in: olga@example.com (employee, «Продажи»: both agents), petr@example.com (employee,
// «Бухгалтерия»: «Помощник» only) or igor@example.com (superadmin); password from TEST_PASSWORD.
import { serve } from '@hono/node-server';
import { createTask } from '../../core/background/tasks.ts';
import { createTestApp, TEST_PASSWORD } from '../../core/server/test-app.ts';
import { standModel } from './stand-model.ts';

const PORT = 3000;

const t = await createTestApp({ modelFallback: standModel, assistantSubagent: true });
const olga = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
const dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [dep, olga]);
await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales'), ($1, 'assistant')`, [dep]);
// Пётр from another department sees only that department's agent.
const petr = await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
const accounting = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Бухгалтерия') RETURNING id`)).rows[0]!.id;
await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [accounting, petr]);
await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'assistant')`, [accounting]);

// A background task that has already asked Ольга a question («Ждёт подтверждения»).
const igor = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'igor@example.com'`)).rows[0]!.id;
const morning = await createTask({ db: t.db, registry: t.registry, background: t.background, timezone: 'Europe/Moscow' }, igor, {
  title: 'Утренняя сводка',
  agentId: 'sales',
  access: { scope: 'users', departmentIds: [], userIds: [olga] },
  schedule: { kind: 'weekdays', time: '09:00' },
  prompt: 'Напиши письмо клиенту со сводкой по сделкам',
});
await t.background.fire(morning.id);
await t.background.idle();

const server = serve({ fetch: t.app.fetch, port: PORT }, () => {
  console.log(`stand: server on :${PORT}; sign in as olga@, petr@ or igor@example.com, password ${TEST_PASSWORD}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await t.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
