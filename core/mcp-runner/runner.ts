// mcp-runner: program servers of MCP (`npx …`, `uvx …`) as servers by address for the app
// (docs/specs/[20.11.2026]-mcp-connections.md, F1, step 9). Each program runs in bubblewrap inside this container,
// which is outside the networks of the database and the gateway. To the app a program is a server at
// /servers/<id>/mcp: the bridge talks to the program over stdio (Mastra MCPClient) and serves its actions over HTTP
// (Mastra MCPServer). One process per server and program; it stops after 30 minutes without requests; three falls in
// ten minutes and the server answers «falls» until the admin checks it again.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { MCPClient, MCPServer } from '@mastra/mcp';
import type { AnyTool } from '../plugins/public/index.ts';
import { PackageFailed } from './install.ts';
import { programKey, verifiedSpec, type ProgramSpec } from './protocol.ts';
import { sandboxed, type Launch } from './sandbox.ts';

const CALL_TIMEOUT_MS = 60_000;
export const CRASH_WINDOW_MS = 10 * 60 * 1000;
export const CRASHES_TO_STOP = 3;
const ROUTE = /^\/servers\/([0-9a-f-]{36})\/(mcp|prepare)$/;
// What a lost program looks like to the client library: its process ended under a call.
const LOST = /connection closed|not connected|terminated|MCP_CLIENT_TOOL_CALL_OUTCOME_UNKNOWN/i;
// Mastra: the program answered the call with an error of its own — its words may sound like LOST, it has not fallen.
const ANSWERED = 'MCP_CLIENT_TOOL_EXECUTION_FAILED';
const answeredItself = (error: unknown) => {
  for (let current = error; current instanceof Error; current = current.cause) if ((current as { id?: unknown }).id === ANSWERED) return true;
  return false;
};

export interface RunnerDeps {
  secret: string;
  packagesDir: string;
  bwrap: string;
  idleMs: number;
  install(spec: ProgramSpec, root: string, cache: string): Promise<Launch>;
  now?(): number;
  log(event: string, fields: Record<string, unknown>): void;
}

interface Program {
  key: string;
  serverId: string;
  client: MCPClient;
  server: MCPServer;
  timer: NodeJS.Timeout;
  crashes: number[];
}

// An answer of the runner itself (not of a program): the app reads its code.
function reply(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code, message } }));
}

// The client library gives a plain answer of the program as it is ({ content, isError }); the MCP server of the bridge
// would wrap any object into JSON text once more, so the text of the answer goes on as a string. An answer with
// structured content comes as that content already and is served with it.
const PLAIN_KEYS = new Set(['content', 'isError', '_meta']);

function passOn(output: unknown): unknown {
  const raw = output as { content?: unknown } | null;
  const plain = raw && typeof raw === 'object' && Array.isArray(raw.content) && Object.keys(raw).every((key) => PLAIN_KEYS.has(key));
  if (!plain) return output;
  return (raw.content as { type?: string; text?: string }[]).map((part) => (part.type === 'text' ? (part.text ?? '') : JSON.stringify(part))).join('\n');
}

const errorText = (error: unknown) => [error instanceof Error ? error.message : String(error), (error as { id?: unknown }).id].join(' ');

export function createRunner(deps: RunnerDeps) {
  const programs = new Map<string, Program>();
  // Servers that fell three times in ten minutes: they wait for the admin's check (prepare).
  const fallen = new Set<string>();
  const starting = new Map<string, Promise<Program>>();
  // A package shared by two servers is installed once: the second waits for the first.
  const installing = new Map<string, Promise<Launch>>();
  const now = () => (deps.now ? deps.now() : Date.now());

  async function stop(program: Program): Promise<void> {
    clearTimeout(program.timer);
    programs.delete(program.key);
    await program.client.disconnect();
  }

  function touch(program: Program): void {
    clearTimeout(program.timer);
    program.timer = setTimeout(() => void stop(program), deps.idleMs);
    program.timer.unref();
  }

  // Counts the falls of the program under its calls; the third in ten minutes stops it.
  function guard(program: () => Program | undefined, serverId: string, tool: AnyTool): AnyTool {
    const execute = tool.execute!.bind(tool) as (input: unknown, ctx: unknown) => Promise<unknown>;
    return createTool({
      ...tool,
      execute: async (input: unknown, ctx: unknown) => {
        try {
          return passOn(await execute(input, ctx));
        } catch (error) {
          const current = program();
          if (current && !answeredItself(error) && LOST.test(errorText(error))) {
            current.crashes = [...current.crashes.filter((at) => now() - at < CRASH_WINDOW_MS), now()];
            deps.log('mcp_program_fell', { serverId, falls: current.crashes.length });
            if (current.crashes.length >= CRASHES_TO_STOP) {
              fallen.add(serverId);
              await stop(current);
            }
          }
          throw error;
        }
      },
    } as Parameters<typeof createTool>[0]) as AnyTool;
  }

  async function start(serverId: string, spec: ProgramSpec, key: string): Promise<Program> {
    // One folder per package: the same package of two servers is installed once.
    const root = join(deps.packagesDir, createHash('sha256').update(`${spec.runner}\n${spec.package}`).digest('hex').slice(0, 24));
    const pending = installing.get(root) ?? deps.install({ ...spec, args: [] }, root, join(deps.packagesDir, '.npm-cache')).finally(() => installing.delete(root));
    installing.set(root, pending);
    const installed = await pending;
    const launch = { ...installed, args: [...installed.args, ...spec.args] };
    const command = sandboxed(launch, spec.env, deps.bwrap);
    const client = new MCPClient({
      id: `program-${key}`,
      registerProcessHooks: false,
      servers: { program: { command: command.command, args: command.args, env: {}, inheritDefaultEnv: false, timeout: CALL_TIMEOUT_MS, enableServerLogs: false } },
    });
    let tools: Record<string, AnyTool>;
    try {
      tools = ((await client.listToolsets()).program ?? {}) as Record<string, AnyTool>;
    } catch (error) {
      await client.disconnect();
      throw Object.assign(new Error('the program does not answer by MCP'), { cause: error, code: 'APP_MCP_NOT_MCP' });
    }
    // The tools count the falls of the program they belong to, which exists once the server is built.
    const holder: { program?: Program } = {};
    const guarded = Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, guard(() => holder.program, serverId, tool)]));
    const server = new MCPServer({ id: `program-${key}`, name: spec.package, version: '1.0.0', tools: guarded });
    const program: Program = { key, serverId, client, server, timer: setTimeout(() => undefined, 0), crashes: [] };
    holder.program = program;
    programs.set(key, program);
    touch(program);
    return program;
  }

  // A program of a server: running, or started (once, whatever the number of requests that wait for it).
  async function programFor(serverId: string, spec: ProgramSpec): Promise<Program> {
    const key = programKey(serverId, spec);
    const running = programs.get(key);
    if (running) return running;
    // Another program of this server (a new package, arguments or key) gives way.
    for (const other of programs.values()) if (other.serverId === serverId) await stop(other);
    const pending = starting.get(key) ?? start(serverId, spec, key).finally(() => starting.delete(key));
    starting.set(key, pending);
    return pending;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mcp-runner');
    const route = ROUTE.exec(url.pathname);
    if (!route) return reply(res, 404, 'APP_NOT_FOUND', 'no such address');
    const [, serverId, what] = route as unknown as [string, string, 'mcp' | 'prepare'];
    let spec: ProgramSpec;
    try {
      spec = verifiedSpec(deps.secret, serverId, (name) => {
        const value = req.headers[name];
        return typeof value === 'string' ? value : undefined;
      }, now());
    } catch (error) {
      deps.log('mcp_runner_refused', { serverId, reason: errorText(error) });
      return reply(res, 500, 'APP_MCP_RUNNER_REFUSED', 'the request is not signed by the app');
    }
    if (what === 'prepare') fallen.delete(serverId);
    if (fallen.has(serverId)) return reply(res, 503, 'APP_MCP_PROGRAM_CRASHED', 'the program fell three times in ten minutes');
    let program: Program;
    try {
      program = await programFor(serverId, spec);
    } catch (error) {
      if (error instanceof PackageFailed) {
        deps.log('mcp_package_failed', { serverId, package: spec.package, reason: error.reason, tail: error.tail });
        return reply(res, 422, 'APP_MCP_PACKAGE_FAILED', error.reason);
      }
      deps.log('mcp_program_failed', { serverId, package: spec.package, error: errorText(error) });
      return reply(res, 422, 'APP_MCP_NOT_MCP', 'the program does not answer by MCP');
    }
    touch(program);
    if (what === 'prepare') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }
    await program.server.startHTTP({ url, httpPath: url.pathname, req, res });
  }

  return {
    handle,
    // How many programs run now: the health line of the container and the tests.
    running: () => programs.size,
    async close() {
      for (const program of [...programs.values()]) await stop(program);
    },
  };
}
