// Browser stand: the real server on a fresh test database (dropped on exit) with a stand-in model
// that answers by keywords (stand-model.ts). Needs the development stand (pnpm dev:db).
//   pnpm stand      — server on :3000
//   pnpm dev:web    — interface on http://localhost:8080
// Sign in: olga@example.com (employee, department «Продажи») or igor@example.com (superadmin),
// password from TEST_PASSWORD.
import { serve } from '@hono/node-server';
import { createTestApp, TEST_PASSWORD } from '../../core/server/test-app.ts';
import { standModel } from './stand-model.ts';

const PORT = 3000;

const t = await createTestApp({ modelFallback: standModel, assistantSubagent: true });
const olga = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
const dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [dep, olga]);
await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales'), ($1, 'assistant')`, [dep]);

// A background task that has already asked Ольга a question («Ждёт подтверждения»).
await t.background.createTask({ id: 'morning', title: 'Утренняя сводка', agentId: 'sales', ownerUserId: olga, cron: '0 9 * * *', prompt: 'Напиши письмо клиенту со сводкой по сделкам' });
await t.background.runTask('morning', 'manual');

const server = serve({ fetch: t.app.fetch, port: PORT }, () => {
  console.log(`stand: server on :${PORT}; sign in as olga@example.com or igor@example.com, password ${TEST_PASSWORD}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await t.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
