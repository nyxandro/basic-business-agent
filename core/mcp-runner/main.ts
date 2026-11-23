// The entry of the mcp-runner container (deploy/compose.yaml; docs/specs/[20.11.2026]-mcp-connections.md, F1, step 9):
// serves the program servers of MCP to the app on its own network. Its only setting is the secret it shares with the
// app; without it nothing starts.
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { logEvent } from '../log/log.ts';
import { installProgram } from './install.ts';
import { createRunner } from './runner.ts';

// In the volume shared with the app (deploy/compose.yaml): there is no network between them.
const SOCKET = '/run/mcp-runner/runner.sock';
const PACKAGES_DIR = '/packages';
const IDLE_MS = 30 * 60 * 1000;
const BWRAP = '/usr/bin/bwrap';
const MIN_SECRET_LENGTH = 32;

const secret = process.env.MCP_RUNNER_SECRET;
if (!secret || secret.length < MIN_SECRET_LENGTH) {
  logEvent('error', 'mcp_runner_config_invalid', { code: 'APP_CONFIG_INVALID', field: 'MCP_RUNNER_SECRET', message: `must be at least ${MIN_SECRET_LENGTH} characters` });
  process.exit(1);
}
if (!existsSync(BWRAP)) {
  logEvent('error', 'mcp_runner_config_invalid', { code: 'APP_SANDBOX_UNAVAILABLE', message: `${BWRAP} is not installed` });
  process.exit(1);
}

const runner = createRunner({ secret, packagesDir: PACKAGES_DIR, bwrap: BWRAP, idleMs: IDLE_MS, install: installProgram, log: (event, fields) => logEvent('warn', event, fields) });
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', running: runner.running() }));
    return;
  }
  runner.handle(req, res).catch((error: unknown) => {
    logEvent('error', 'mcp_runner_failed', { error });
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'APP_INTERNAL', message: 'mcp-runner failed' } }));
  });
});
// A socket left by a stopped container would refuse the new one.
rmSync(SOCKET, { force: true });
server.listen(SOCKET, () => logEvent('info', 'mcp_runner_started', { socket: SOCKET }));
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close();
    void runner.close().then(() => process.exit(0));
  });
}
