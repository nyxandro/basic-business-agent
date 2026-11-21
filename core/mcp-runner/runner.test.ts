// mcp-runner (docs/specs/[20.11.2026]-mcp-connections.md, F1, step 9): a program server in bubblewrap, served to the
// app as a server by address. A real sandbox; the sample program stands in for a package from npm.
import { mkdtempSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPClient } from '@mastra/mcp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PackageFailed } from './install.ts';
import { runnerPath, signedHeaders, type ProgramSpec } from './protocol.ts';
import { createRunner } from './runner.ts';

const SECRET = 'r'.repeat(40);
const FIXTURE = fileURLToPath(new URL('./fixtures/echo-server', import.meta.url));
const SERVER_ID = '0b8f5d6e-1c2a-4f3b-9d4e-5a6b7c8d9e0f';
const spec = (over: Partial<ProgramSpec> = {}): ProgramSpec => ({ runner: 'npx', package: 'bba-echo-mcp@1.0.0', args: ['--base', 'http://1c.local'], env: { CRM_TOKEN: 'shared-7731' }, ...over });

let packages: string;
let http: Server;
let base: string;
let runner: ReturnType<typeof createRunner>;
const clients: MCPClient[] = [];

function start(idleMs: number) {
  runner = createRunner({
    secret: SECRET,
    packagesDir: packages,
    bwrap: '/usr/bin/bwrap',
    idleMs,
    // The sample program instead of `npm install`: the rest — the sandbox, the bridge — is real.
    install: async (program, root) => {
      if (program.package.startsWith('missing')) throw new PackageFailed('not_found', 'npm error 404');
      await cp(FIXTURE, join(root, 'pkg'), { recursive: true });
      return { command: process.execPath, args: [join(root, 'pkg', 'server.mjs'), ...program.args], root, extraPaths: [dirname(dirname(process.execPath))] };
    },
    log: () => undefined,
  });
}

// The app's side: a client that signs each request, as the manager of connections does.
function clientOf(program: ProgramSpec, secret = SECRET): MCPClient {
  const client = new MCPClient({
    id: `test-${clients.length}`,
    registerProcessHooks: false,
    servers: {
      s: {
        url: new URL(`${base}${runnerPath(SERVER_ID, 'mcp')}`),
        fetch: (url: string | URL, init?: RequestInit) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...signedHeaders(secret, SERVER_ID, program) } }),
      },
    },
  });
  clients.push(client);
  return client;
}

const prepare = (program: ProgramSpec) => fetch(`${base}${runnerPath(SERVER_ID, 'prepare')}`, { method: 'POST', headers: signedHeaders(SECRET, SERVER_ID, program) });
const textOf = (answer: unknown) => (answer as { content: { text: string }[] }).content[0]!.text;

beforeAll(async () => {
  packages = mkdtempSync(join(tmpdir(), 'bba-mcp-packages-'));
  http = createServer((req, res) => void runner.handle(req, res));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.disconnect()));
  await runner.close();
});
afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await rm(packages, { recursive: true, force: true });
});

describe('a program server', () => {
  it('serves its actions as they are, with only the admin’s environment and none of the container’s files', async () => {
    start(60_000);
    const client = clientOf(spec());
    const { definitions, errorDetails } = await client.listToolDefinitionsWithErrors();
    expect(errorDetails).toEqual({});
    expect(Object.keys(definitions.s ?? {})).toEqual(['echo', 'whoami', 'fall', 'complain']);
    expect(definitions.s!.whoami!.annotations).toEqual({ readOnlyHint: true });

    const tools = await client.listTools();
    expect(textOf(await tools.s_echo!.execute!({ text: 'привет' }, {} as never))).toBe('привет');
    const seen = JSON.parse(textOf(await tools.s_whoami!.execute!({}, {} as never))) as { args: string[]; env: Record<string, string>; app: boolean; workspace: boolean };
    expect(seen.args).toEqual(['--base', 'http://1c.local']);
    expect(Object.keys(seen.env).sort()).toEqual(['CRM_TOKEN', 'HOME', 'PATH', 'PWD']);
    expect(seen.env.CRM_TOKEN).toBe('shared-7731');
    expect([seen.app, seen.workspace]).toEqual([false, false]);
    expect(runner.running()).toBe(1);
  });

  it('answers only requests the app signed, and not an old one', async () => {
    start(60_000);
    const unsigned = await fetch(`${base}${runnerPath(SERVER_ID, 'prepare')}`, { method: 'POST' });
    expect(unsigned.status).toBe(500);
    expect(await unsigned.json()).toMatchObject({ error: { code: 'APP_MCP_RUNNER_REFUSED' } });
    const foreign = await fetch(`${base}${runnerPath(SERVER_ID, 'prepare')}`, { method: 'POST', headers: signedHeaders('x'.repeat(40), SERVER_ID, spec()) });
    expect(foreign.status).toBe(500);
    const old = await fetch(`${base}${runnerPath(SERVER_ID, 'prepare')}`, { method: 'POST', headers: signedHeaders(SECRET, SERVER_ID, spec(), Date.now() - 10 * 60 * 1000) });
    expect(old.status).toBe(500);
    expect(runner.running()).toBe(0);
  });

  it('stops after the idle time and starts again at the next request', async () => {
    start(300);
    expect((await prepare(spec())).status).toBe(200);
    expect(runner.running()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(runner.running()).toBe(0);
    const tools = await clientOf(spec()).listTools();
    expect(textOf(await tools.s_echo!.execute!({ text: 'снова' }, {} as never))).toBe('снова');
  });

  it('that falls three times in ten minutes answers «falls» until the admin checks it again', async () => {
    start(60_000);
    const tools = await clientOf(spec()).listTools();
    for (let fall = 0; fall < 3; fall += 1) await expect(tools.s_fall!.execute!({}, {} as never)).rejects.toBeTruthy();
    const answer = await fetch(`${base}${runnerPath(SERVER_ID, 'mcp')}`, { method: 'POST', headers: { ...signedHeaders(SECRET, SERVER_ID, spec()), 'content-type': 'application/json' }, body: '{}' });
    expect(answer.status).toBe(503);
    expect(await answer.json()).toMatchObject({ error: { code: 'APP_MCP_PROGRAM_CRASHED' } });
    expect((await prepare(spec())).status).toBe(200);
    expect(runner.running()).toBe(1);
  });

  it('does not count an error the program answered itself as a fall, whatever its words', async () => {
    start(60_000);
    const tools = await clientOf(spec()).listTools();
    for (let time = 0; time < 3; time += 1) await expect(tools.s_complain!.execute!({}, {} as never)).rejects.toBeTruthy();
    expect(textOf(await tools.s_echo!.execute!({ text: 'работает' }, {} as never))).toBe('работает');
  });

  it('installs a package once when two servers with it are checked at the same time', async () => {
    let installs = 0;
    runner = createRunner({
      secret: SECRET,
      packagesDir: packages,
      bwrap: '/usr/bin/bwrap',
      idleMs: 60_000,
      install: async (program, root) => {
        installs += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await cp(FIXTURE, join(root, 'pkg'), { recursive: true });
        return { command: process.execPath, args: [join(root, 'pkg', 'server.mjs'), ...program.args], root, extraPaths: [dirname(dirname(process.execPath))] };
      },
      log: () => undefined,
    });
    const other = '1b8f5d6e-1c2a-4f3b-9d4e-5a6b7c8d9e0f';
    const prepareOf = (serverId: string) => fetch(`${base}${runnerPath(serverId, 'prepare')}`, { method: 'POST', headers: signedHeaders(SECRET, serverId, spec({ package: 'bba-echo-mcp@1.0.1' })) });
    const answers = await Promise.all([prepareOf(SERVER_ID), prepareOf(other)]);
    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect(installs).toBe(1);
  });

  it('tells a package that cannot be installed', async () => {
    start(60_000);
    const answer = await prepare(spec({ package: 'missing-mcp@9.9.9' }));
    expect(answer.status).toBe(422);
    expect(await answer.json()).toMatchObject({ error: { code: 'APP_MCP_PACKAGE_FAILED', message: 'not_found' } });
  });
});
