// Browser stand: the real server on a fresh test database (dropped on exit) with a stand-in model
// that answers by keywords (stand-model.ts). Needs the development stand (pnpm dev:db).
//   pnpm stand      — server on :3000
//   pnpm dev:web    — interface on http://localhost:8080
// Sign in: olga@example.com (employee, «Продажи»: both agents), petr@example.com (employee,
// «Бухгалтерия»: «Помощник» only) or igor@example.com (superadmin); password from TEST_PASSWORD.
// «Нейросеть» has a subscription model and a pool of three ChatGPT accounts in a fake OpenAI; a new
// account is connected through its page «Открыть сайт OpenAI» (enter the code and any e-mail).
import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { createTask } from '../../core/background/tasks.ts';
import { createProject } from '../../core/projects/projects.ts';
import { createSkill } from '../../core/skills-admin/store.ts';
import { startFakeChatGpt } from '../../core/models/fake-chatgpt.ts';
import { createTestApp, TEST_PASSWORD } from '../../core/server/test-app.ts';
import { createStandModel, standNaming } from './stand-model.ts';

const PORT = 3000;

const openai = await startFakeChatGpt();
const t = await createTestApp({ modelFallback: createStandModel(), namingFallback: standNaming, assistantSubagent: true, chatgpt: { authBase: openai.url }, sandbox: true });
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

// A background task for the department «Продажи» that has already asked Ольга a question
// («Ждёт подтверждения»).
const igor = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'igor@example.com'`)).rows[0]!.id;
const morning = await createTask({ db: t.db, registry: t.registry, background: t.background, timezone: 'Europe/Moscow' }, igor, {
  title: 'Утренняя сводка',
  agentId: 'sales',
  access: { scope: 'departments', departmentIds: [dep], userIds: [] },
  schedule: { kind: 'weekdays', time: '09:00' },
  prompt: 'Напиши письмо клиенту со сводкой по сделкам',
});
await t.background.fire(morning.id);
await t.background.idle();

// A skill of the company for the whole organisation, as the admin uploads it in «Скиллы»; the
// system skills of documents are there without any upload (spec, section 8.18).
await createSkill(t.skillsDeps, igor, new Uint8Array(readFileSync(new URL('../../skills/note-taking.skill', import.meta.url))), { scope: 'org', departmentIds: [], userIds: [] });
// Ольга's project with its instructions.
const tender = await createProject({ db: t.db, memory: t.memory, workspaceRoot: t.workspaceRoot }, olga, { name: 'Тендер', access: { mode: 'private', departmentIds: [], userIds: [] } });
await t.db.query('UPDATE app.projects SET instructions = $1 WHERE id = $2', ['Заказчик — ООО «Пример». Отвечай кратко.', tender.id]);

// The pool of the subscription: one account works, one cools down after a 429, one is new.
const subscription = await t.models.create(igor, { connection: 'chatgpt', kind: 'chat', label: 'GPT по подписке', providerModel: 'chatgpt/gpt-5.4', vision: true });
const pool: string[] = [];
for (const email of ['sales.gpt@example.com', 'office.gpt@example.com', 'reserve.gpt@example.com']) {
  const login = await t.accounts.startLogin(igor, null);
  openai.approve(login.userCode, { email });
  const done = await t.accounts.pollLogin(igor, login.id);
  if (done.status !== 'connected') throw new Error(`stand: ${email} did not connect`);
  pool.push(done.account.id);
}
const [working, cooling] = pool.map((id) => `${subscription.id}:${id}`);
await t.db.query(
  `INSERT INTO app.usage_events (at, user_id, model, deployment, is_subscription, input_tokens, output_tokens, litellm_call_id)
   VALUES (now() - interval '5 minutes', $1, $2, $3, true, 150000, 60000, 'stand-1'), (now() - interval '20 minutes', $1, $2, $4, true, 300000, 90000, 'stand-2')`,
  [olga, subscription.id, working, cooling],
);
await t.db.query(
  `INSERT INTO app.account_events (at, account_id, deployment, status, code, cooldown_until, litellm_call_id)
   VALUES (now() - interval '1 minute', $1, $2, 429, 'RateLimitError', now() + interval '1 hour', 'stand-429')`,
  [pool[1], cooling],
);

const server = serve({ fetch: t.app.fetch, port: PORT }, () => {
  console.log(`stand: server on :${PORT}; sign in as olga@, petr@ or igor@example.com, password ${TEST_PASSWORD}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await t.close();
  await openai.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
