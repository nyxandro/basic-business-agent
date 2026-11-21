// Program servers of MCP in the app (docs/specs/[20.11.2026]-mcp-connections.md, F1, step 9): the admin adds a program
// with the shared key, checks it through mcp-runner and turns it on; the agent of an employee uses it like a server
// by address. mcp-runner runs in this process with a real sandbox; the sample program stands in for a package.
import { mkdtempSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerInput, McpServerView } from '@bba/contracts';
import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PackageFailed } from '../mcp-runner/install.ts';
import { createRunner } from '../mcp-runner/runner.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';

const BASE = '/app/api/admin/mcp-servers';
const SECRET = 'p'.repeat(40);
const FIXTURE = fileURLToPath(new URL('../mcp-runner/fixtures/echo-server', import.meta.url));
let packages: string;
let http: Server;
let runner: ReturnType<typeof createRunner>;
let t: TestApp;
let admin: string;
let olga: { id: string; cookie: string };

beforeAll(async () => {
  packages = mkdtempSync(join(tmpdir(), 'bba-mcp-programs-'));
  runner = createRunner({
    secret: SECRET,
    packagesDir: packages,
    bwrap: '/usr/bin/bwrap',
    idleMs: 60_000,
    install: async (program, root) => {
      if (program.package.startsWith('missing')) throw new PackageFailed('not_found', 'npm error 404');
      await cp(FIXTURE, join(root, 'pkg'), { recursive: true });
      return { command: process.execPath, args: [join(root, 'pkg', 'server.mjs'), ...program.args], root, extraPaths: [dirname(dirname(process.execPath))] };
    },
    log: () => undefined,
  });
  http = createServer((req, res) => void runner.handle(req, res));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t = await createTestApp({ mcpRunner: { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, secret: SECRET } });
  await t.createUser({ email: 'igor@example.com', roleIds: [await t.roleId('superadmin')] });
  admin = await t.signIn('igor@example.com');
  const sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Отдел продаж') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  olga = { id: await t.createUser({ email: 'olga@example.com', departmentIds: [sales] }), cookie: await t.signIn('olga@example.com') };
});
afterAll(async () => {
  await t.close();
  await runner.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await rm(packages, { recursive: true, force: true });
});

const program = (over: Partial<McpServerInput> = {}): McpServerInput => ({
  title: '1С',
  transport: 'program',
  url: null,
  program: { runner: 'npx', package: 'bba-echo-mcp@1.0.0', args: ['--base', 'http://1c.local'] },
  auth: 'shared_key',
  fields: [{ key: 'token', label: 'Ключ 1С', hint: '', secret: true }],
  headers: {},
  env: { ONEC_TOKEN: 'Bearer {{token}}' },
  sharedValues: { token: 'shared-7731' },
  client: null,
  ...over,
});

async function call<T>(method: string, path: string, cookie: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await t.call(method, path, { cookie, ...(body === undefined ? {} : { body }) });
  return { status: res.status, json: (await res.json()) as T };
}

function ctx() {
  const requestContext = new RequestContext();
  requestContext.set(REQUEST_KEYS.userId, olga.id);
  requestContext.set(REQUEST_KEYS.agentId, 'sales');
  return { requestContext } as never;
}
const textOf = (answer: unknown) => (answer as { content: { text: string }[] }).content[0]!.text;

describe('a program server', () => {
  it('is checked through mcp-runner, and the agent gets the shared key only in the program’s environment', async () => {
    const created = (await call<{ server: McpServerView }>('POST', BASE, admin, program())).json.server;
    const checked = await call<{ server: McpServerView }>('POST', `${BASE}/${created.id}/check`, admin, { values: {} });
    expect(checked.json.server.actions.map((a) => a.name)).toEqual(['echo', 'whoami', 'fall']);
    const enabled = await call<{ server: McpServerView }>('PATCH', `${BASE}/${created.id}`, admin, {
      actions: [
        { name: 'echo', enabled: true, readOnly: true, title: null, check: false },
        { name: 'whoami', enabled: true, readOnly: true, title: null, check: false },
        { name: 'fall', enabled: true, readOnly: false, title: null, check: false },
      ],
      agents: ['sales'],
      status: 'enabled',
    });
    expect(enabled.json.server.status).toBe('enabled');
    await call('POST', `/app/api/me/connections/mcp/${created.id}/use`, olga.cookie, { on: true });

    const tools = await t.connections.toolsFor(olga.id, { agentId: 'sales', connectorIds: [] });
    const slug = created.slug;
    expect(textOf(await tools[`${slug}_echo`]!.execute!({ text: 'остатки' }, ctx()))).toBe('остатки');
    const seen = JSON.parse(textOf(await tools[`${slug}_whoami`]!.execute!({}, ctx()))) as { args: string[]; env: Record<string, string>; app: boolean };
    expect(seen.env).toMatchObject({ ONEC_TOKEN: 'Bearer shared-7731' });
    expect(Object.keys(seen.env).sort()).toEqual(['HOME', 'ONEC_TOKEN', 'PATH', 'PWD']);
    expect(seen.args).toEqual(['--base', 'http://1c.local']);
    expect(seen.app).toBe(false);

    // Three falls in ten minutes: mcp-runner stops it, the admin sees «Программа-сервер падает».
    for (let fall = 0; fall < 3; fall += 1) await expect(tools[`${slug}_fall`]!.execute!({}, ctx())).rejects.toBeTruthy();
    await expect(tools[`${slug}_echo`]!.execute!({ text: 'ещё' }, ctx())).rejects.toMatchObject({ code: 'APP_CONNECTOR_UNAVAILABLE' });
    expect((await call<{ server: McpServerView }>('GET', `${BASE}/${created.id}`, admin)).json.server).toMatchObject({ status: 'program_crashed', statusErrorCode: 'APP_MCP_PROGRAM_CRASHED' });

    // The admin checks it again: the program starts anew and works.
    expect((await call<{ server: McpServerView }>('POST', `${BASE}/${created.id}/check`, admin, { values: {} })).json.server.status).toBe('enabled');
    const fresh = await t.connections.toolsFor(olga.id, { agentId: 'sales', connectorIds: [] });
    expect(textOf(await fresh[`${slug}_echo`]!.execute!({ text: 'снова' }, ctx()))).toBe('снова');
  });

  it('tells the admin a package that cannot be installed', async () => {
    const created = (await call<{ server: McpServerView }>('POST', BASE, admin, program({ program: { runner: 'npx', package: 'missing-mcp@9.9.9', args: [] } }))).json.server;
    const failed = await call<{ error: { code: string; message: string } }>('POST', `${BASE}/${created.id}/check`, admin, { values: {} });
    expect(failed.json.error.code).toBe('APP_MCP_PACKAGE_FAILED');
    expect(failed.json.error.message).toContain('missing-mcp@9.9.9: такого пакета или такой версии нет');
  });
});

describe('an installation without mcp-runner', () => {
  it('says program servers are not on, instead of failing somewhere', async () => {
    const plain = await createTestApp();
    try {
      await plain.createUser({ email: 'igor@example.com', roleIds: [await plain.roleId('superadmin')] });
      const cookie = await plain.signIn('igor@example.com');
      const created = (await (await plain.call('POST', BASE, { cookie, body: program() })).json()) as { server: McpServerView };
      const failed = (await (await plain.call('POST', `${BASE}/${created.server.id}/check`, { cookie, body: { values: {} } })).json()) as { error: { code: string } };
      expect(failed.error.code).toBe('APP_MCP_RUNNER_NOT_CONFIGURED');
    } finally {
      await plain.close();
    }
  });
});
