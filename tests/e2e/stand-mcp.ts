// MCP servers of the browser stand (docs/specs/[20.11.2026]-mcp-connections.md, step 10): a system that takes a key in
// its address, a system with a sign-in on its site, and mcp-runner for a program (the sample program stands in for a
// package from npm; the sandbox is real). The scenarios type the addresses, so the ports are fixed.
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestMcpServer, startTestOAuthServer } from '../../core/connections/test/servers.ts';
import { createRunner } from '../../core/mcp-runner/runner.ts';

export const STAND_MCP = {
  // «МойСклад» of the stand: the key goes in the address.
  keyed: 'http://127.0.0.1:39201/mcp?key={{token}}',
  // «Битрикс24» of the stand: a sign-in on its site (39203), which registers the app on the fly.
  portal: 'http://127.0.0.1:39202/mcp',
  program: 'bba-echo-mcp@1.0.0',
} as const;

const SECRET = 'stand-mcp-runner-secret-0123456789abcdef';
const FIXTURE = fileURLToPath(new URL('../../core/mcp-runner/fixtures/echo-server', import.meta.url));

export async function startStandMcp(): Promise<{ runner: { socketPath: string; secret: string }; close(): Promise<void> }> {
  const keyed = await startTestMcpServer({ port: 39201 });
  const signIn = await startTestOAuthServer({ dynamicRegistration: true, port: 39203 });
  const portal = await startTestMcpServer({ port: 39202, signIn: { where: 'challenge', authorizationServer: signIn.issuer } });
  portal.acceptedTokens = signIn.accessTokens;
  const packages = await mkdtemp(join(tmpdir(), 'bba-stand-packages-'));
  const runner = createRunner({
    secret: SECRET,
    packagesDir: packages,
    bwrap: '/usr/bin/bwrap',
    idleMs: 30 * 60 * 1000,
    install: async (program, root) => {
      await cp(FIXTURE, join(root, 'pkg'), { recursive: true });
      return { command: process.execPath, args: [join(root, 'pkg', 'server.mjs'), ...program.args], root, extraPaths: [dirname(dirname(process.execPath))] };
    },
    log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
  });
  // The app reaches mcp-runner through a socket, as in an installation (deploy/compose.yaml).
  const socketPath = join(packages, 'runner.sock');
  const http = createServer((req, res) => void runner.handle(req, res));
  await new Promise<void>((resolve) => http.listen(socketPath, resolve));
  return {
    runner: { socketPath, secret: SECRET },
    async close() {
      await runner.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await Promise.all([keyed.close(), portal.close(), signIn.close()]);
      await rm(packages, { recursive: true, force: true });
    },
  };
}
