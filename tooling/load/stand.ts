// The stand of load tests (review 24.11, issue #35): the real server — sandbox, the test LiteLLM, Postgres — on a fresh
// test database, with the stand-in model of tests/e2e/stand-model.ts made slow like a real one and many employees
// already signed in. `pnpm load` (drive.ts) reads .data/load/stand.json. Ctrl+C stops it and drops the database.
//   pnpm load:stand [--people 60] [--model-ms 2000] [--long-text 0]
// --model-ms  how long the model thinks before each answer of the agent (a real one: seconds);
// --long-text a final answer of about this many characters in pieces of 6, as a real model writes (0 — the stand's own).
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import type { FakeRequest, FakeTurn } from '../../core/models/fake-openai.ts';
import { createTestApp, TEST_PASSWORD } from '../../core/server/test-app.ts';
import { createStandModel, standNaming, standWeb } from '../../tests/e2e/stand-model.ts';
import { LOAD_DIR, STAND_FILE, type LoadStand } from './files.ts';

const PORT = 3000;
// The pieces a real model sends a long answer in: hundreds of events the server passes on, each costing it time.
const LONG_TEXT_PIECE = 6;
const FILLER = ' Условия поставки зависят от объёма, сроков и адреса объекта; уточним их в договоре и спецификации.';

const { values } = parseArgs({ options: { people: { type: 'string', default: '60' }, 'model-ms': { type: 'string', default: '2000' }, 'long-text': { type: 'string', default: '0' } } });
const people = Number(values.people);
const modelMs = Number(values['model-ms']);
const longText = Number(values['long-text']);
if (![people, modelMs, longText].every((n) => Number.isInteger(n) && n >= 0) || people < 1) throw new Error('--people, --model-ms and --long-text are whole numbers, --people at least 1');

const longer = (turn: FakeTurn): FakeTurn =>
  longText > 0 && 'text' in turn && !('toolCalls' in turn) && turn.text !== '-'
    ? { ...turn, text: (turn.text + FILLER.repeat(Math.ceil(longText / FILLER.length))).slice(0, longText), chunkSize: LONG_TEXT_PIECE }
    : turn;
const slow = (turn: FakeTurn): FakeTurn => ('text' in turn || 'toolCalls' in turn ? { ...turn, delayMs: (turn.delayMs ?? 0) + modelMs } : turn);
const model = createStandModel();

const t = await createTestApp({
  modelFallback: (req: FakeRequest) => slow(longer(model(req))),
  // The name of a conversation stays short: only the wait of the model.
  namingFallback: (req: FakeRequest) => slow(standNaming(req)),
  sandbox: true,
  web: standWeb,
  quietHours: false,
});
const department = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales'), ($1, 'assistant')`, [department]);
const signedIn: LoadStand['people'] = [];
for (let i = 0; i < people; i++) {
  const email = `load${i}@example.com`;
  await t.createUser({ email, name: `Сотрудник ${i}`, departmentIds: [department] });
  // Each person from an address of their own, as in an office of its own machines: the limit of sign-ins counts addresses.
  const ip = `10.77.${Math.floor(i / 250)}.${(i % 250) + 1}`;
  signedIn.push({ email, ip, cookie: await t.signIn(email, TEST_PASSWORD, ip) });
}
const { connectionString } = (t.db as unknown as { options: { connectionString: string } }).options;
const stand: LoadStand = { pid: process.pid, database: new URL(connectionString).pathname.slice(1), modelMs, longText, people: signedIn };
const server = serve({ fetch: t.app.fetch, port: PORT }, () => {
  mkdirSync(LOAD_DIR, { recursive: true });
  writeFileSync(STAND_FILE, JSON.stringify(stand));
  console.log(`load stand: :${PORT}, ${people} people, model ${modelMs} ms, long text ${longText}; pnpm load burst <n> | flow <perMinute> <seconds>`);
});
const stop = async () => {
  server.close();
  await t.close();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
