// MCP servers the admin adds (docs/specs/[20.11.2026]-mcp-connections.md, step 1): what a server row may
// hold and how its secrets are kept, on a real database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpServerInput } from '@bba/contracts';
import { createSecretBox } from '../crypto/secret-box.ts';
import { migrate } from '../db/migrate.ts';
import { createPool, type Db } from '../db/pool.ts';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import { isAppError } from '../errors/app-error.ts';
import { TEST_ENCRYPTION_KEYS } from '../server/test-app.ts';
import { createServer, loadServerSecrets } from './servers.ts';

let database: TestDatabase;
let db: Db;
const box = createSecretBox(TEST_ENCRYPTION_KEYS);

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url);
  db = createPool(database.url);
  await db.query(`INSERT INTO app."user" ("id", "name", "email", "emailVerified") VALUES ('igor', 'Игорь Власов', 'igor@example.com', true)`);
});
afterAll(async () => {
  await db.end();
  await database.drop();
});

const httpServer = (over: Partial<McpServerInput>): McpServerInput => ({
  title: 'МойСклад',
  transport: 'http',
  url: 'https://mcp.example.com/{{token}}/mcp',
  program: null,
  auth: 'personal_key',
  fields: [{ key: 'token', label: 'Ключ API', hint: 'Настройки → Интеграции', secret: true }],
  headers: {},
  env: {},
  sharedValues: null,
  client: null,
  ...over,
});

async function rejection(promise: Promise<unknown>): Promise<{ code: string; userMessage: string }> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return { code: error.code, userMessage: error.userMessage };
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('a server the admin adds', () => {
  it('starts as a draft with a short Latin slug for the names of its actions', async () => {
    const server = await createServer(db, box, httpServer({}), 'igor');
    expect(server.status).toBe('draft');
    expect(server.slug).toMatch(/^m[0-9a-f]{6}$/);
    expect(server.actions).toEqual([]);
  });

  it('rejects a template that names a field nobody fills in', async () => {
    const failure = await rejection(createServer(db, box, httpServer({ headers: { Authorization: 'Bearer {{api_key}}' } }), 'igor'));
    expect(failure.code).toBe('APP_VALIDATION_FAILED');
    expect(failure.userMessage).toContain('{{api_key}}');
  });

  it('rejects a personal key without fields', async () => {
    const failure = await rejection(createServer(db, box, httpServer({ url: 'https://mcp.example.com/mcp', fields: [] }), 'igor'));
    expect(failure.code).toBe('APP_VALIDATION_FAILED');
  });

  it('keeps the shared key and the client secret only sealed', async () => {
    const server = await createServer(
      db,
      box,
      httpServer({
        url: 'https://crm.example.com/mcp',
        auth: 'shared_key',
        headers: { Authorization: 'Bearer {{token}}' },
        sharedValues: { token: 'shared-secret-7731' },
      }),
      'igor',
    );
    const oauth = await createServer(
      db,
      box,
      httpServer({ url: 'https://portal.example.com/mcp', auth: 'oauth', fields: [], client: { clientId: 'app-42', clientSecret: 'client-secret-9915' } }),
      'igor',
    );
    const { rows } = await db.query<{ dump: string }>(`SELECT row_to_json(s)::text AS dump FROM app.mcp_servers s WHERE id = ANY($1)`, [[server.id, oauth.id]]);
    for (const row of rows) {
      expect(row.dump).not.toContain('shared-secret-7731');
      expect(row.dump).not.toContain('client-secret-9915');
    }
    expect((await loadServerSecrets(db, box, server.id)).shared).toEqual({ token: 'shared-secret-7731' });
    expect((await loadServerSecrets(db, box, oauth.id)).client).toEqual({ clientId: 'app-42', clientSecret: 'client-secret-9915' });
    expect(server.sharedConfigured).toBe(true);
    expect(JSON.stringify(server)).not.toContain('shared-secret-7731');
  });

  it('asks for every shared field before saving', async () => {
    const failure = await rejection(
      createServer(db, box, httpServer({ url: 'https://crm.example.com/mcp', auth: 'shared_key', headers: { Authorization: 'Bearer {{token}}' }, sharedValues: {} }), 'igor'),
    );
    expect(failure.code).toBe('APP_VALIDATION_FAILED');
  });
});

describe('a server that is a program (the admin’s decision 21.11: only in the sandbox)', () => {
  const program = (pkg: string, over: Partial<McpServerInput> = {}): McpServerInput => ({
    ...httpServer({}),
    title: '1С',
    transport: 'program',
    url: null,
    program: { runner: 'npx', package: pkg, args: ['--base', 'http://1c.local/base'] },
    auth: 'none',
    fields: [],
    ...over,
  });

  it('takes a package only with an exact version', async () => {
    await expect(createServer(db, box, program('1c-mcp-server@2.3.1'), 'igor')).resolves.toMatchObject({ transport: 'program', status: 'draft' });
    for (const pkg of ['1c-mcp-server', '1c-mcp-server@latest', '1c-mcp-server@^2.3.1', '1c-mcp-server@2']) {
      const failure = await rejection(createServer(db, box, program(pkg), 'igor'));
      expect(failure.code).toBe('APP_VALIDATION_FAILED');
      expect(failure.userMessage).toContain('точную версию');
    }
  });

  it('has no sign-in of each employee: a process per person would not fit the server', async () => {
    const failure = await rejection(createServer(db, box, program('1c-mcp-server@2.3.1', { auth: 'personal_key', fields: [{ key: 'token', label: 'Ключ', hint: '', secret: true }], env: { TOKEN: '{{token}}' } }), 'igor'));
    expect(failure.code).toBe('APP_VALIDATION_FAILED');
  });
});
