// The first look at an address the admin typed (docs/specs/[20.11.2026]-mcp-connections.md, step 2): is there an
// MCP server, and how does it let people in. Real HTTP servers on this machine, no network beyond it.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import type { McpProbeInput } from '@bba/contracts';
import { isAppError } from '../errors/app-error.ts';
import { probeServer } from './probe.ts';
import { closedPortUrl, startTestMcpServer, startTestWebPage } from './test/servers.ts';

const stops: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(stops.map((stop) => stop()));
});

const target = (url: string, over: Partial<McpProbeInput> = {}): McpProbeInput => ({ url, fields: [], values: {}, ...over });
const AUTHORIZATION_SERVER = 'https://auth.example.com';

async function mcpServer(options?: Parameters<typeof startTestMcpServer>[0]) {
  const server = await startTestMcpServer(options);
  stops.push(() => server.close());
  return server;
}

async function rawServer(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const http: Server = createServer(handler);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  stops.push(() => new Promise((resolve) => http.close(() => resolve())));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
}

interface Failure {
  code: string;
  userMessage: string;
  logged: string;
}

// What a failure shows the admin, and everything of it that may reach the server log (message and causes).
async function failure(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    const logged: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) logged.push(current.message, current.stack ?? '');
    return { code: error.code, userMessage: error.userMessage, logged: logged.join('\n') };
  }
  throw new Error('expected a rejection');
}

describe('an address the admin typed', () => {
  it('is a server without sign-in when the handshake goes through', async () => {
    const server = await mcpServer();
    await expect(probeServer(target(server.url))).resolves.toEqual({ auth: 'none' });
  });

  it('wants a sign-in on the system’s site when the 401 challenge points to the sign-in addresses', async () => {
    const server = await mcpServer({ signIn: { where: 'challenge', authorizationServer: AUTHORIZATION_SERVER } });
    await expect(probeServer(target(server.url))).resolves.toEqual({ auth: 'oauth' });
  });

  it('wants a sign-in on the system’s site when only the well-known address tells where to sign in', async () => {
    const server = await mcpServer({ signIn: { where: 'well-known', authorizationServer: AUTHORIZATION_SERVER } });
    await expect(probeServer(target(server.url))).resolves.toEqual({ auth: 'oauth' });
  });

  it('takes a key when it refuses without saying where to sign in', async () => {
    const server = await mcpServer({ signIn: { where: 'nowhere', authorizationServer: AUTHORIZATION_SERVER } });
    await expect(probeServer(target(server.url))).resolves.toEqual({ auth: 'key' });
  });

  it('takes a key when it answers 403 without a key', async () => {
    const url = await rawServer((_req, res) => res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"forbidden"}'));
    await expect(probeServer(target(url))).resolves.toEqual({ auth: 'key' });
  });

  it('is not an MCP server when a web page answers', async () => {
    const page = await startTestWebPage();
    stops.push(() => page.close());
    const result = await failure(probeServer(target(page.url)));
    expect(result.code).toBe('APP_MCP_NOT_MCP');
    expect(result.userMessage).toContain('/mcp');
  });

  it('is not an MCP server when the path is wrong (404) or the answer is JSON of another kind', async () => {
    const server = await mcpServer();
    expect((await failure(probeServer(target(server.url.replace(/\/mcp$/, '/api'))))).code).toBe('APP_MCP_NOT_MCP');
    const json = await rawServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}'));
    expect((await failure(probeServer(target(json)))).code).toBe('APP_MCP_NOT_MCP');
  });

  it('does not answer when nothing listens, when a proxy says the server is down, or when it keeps silent', async () => {
    expect((await failure(probeServer(target(await closedPortUrl())))).code).toBe('APP_MCP_UNREACHABLE');
    const down = await rawServer((_req, res) => res.writeHead(502).end('bad gateway'));
    expect((await failure(probeServer(target(down)))).code).toBe('APP_MCP_UNREACHABLE');
    const silent = await rawServer(() => {});
    const started = Date.now();
    expect((await failure(probeServer(target(silent), 300))).code).toBe('APP_MCP_UNREACHABLE');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('refuses http to an address on the internet: keys would travel in the open', async () => {
    const result = await failure(probeServer(target('http://8.8.8.8/mcp')));
    expect(result.code).toBe('APP_VALIDATION_FAILED');
    expect(result.userMessage).toContain('https://');
  });

  it('allows http inside the office network and on this machine, by name too', async () => {
    const server = await mcpServer();
    await expect(probeServer(target(server.url.replace('127.0.0.1', 'localhost')))).resolves.toEqual({ auth: 'none' });
  });

  it('refuses what is not a web address', async () => {
    expect((await failure(probeServer(target('ftp://crm.example.com/mcp')))).code).toBe('APP_VALIDATION_FAILED');
    expect((await failure(probeServer(target('crm.example.com/mcp')))).code).toBe('APP_VALIDATION_FAILED');
  });
});

describe('an address with a {{field}} of the employee in it', () => {
  const field = { key: 'token', label: 'Ключ API', hint: '', secret: true };

  it('is checked only after the admin entered a value for it', async () => {
    const server = await mcpServer();
    const result = await failure(probeServer(target(`${server.url}?key={{token}}`, { fields: [field] })));
    expect(result.code).toBe('APP_VALIDATION_FAILED');
    expect(result.userMessage).toContain('Ключ API');
    expect(server.requested).toEqual([]);
  });

  it('gets the value encoded, once: a slash or {{ in it stays a part of the value', async () => {
    const server = await mcpServer();
    await expect(probeServer(target(`${server.url}?key={{token}}`, { fields: [field], values: { token: 'a/b {{token}}' } }))).resolves.toEqual({ auth: 'none' });
    expect(server.requested[0]).toBe('/mcp?key=a%2Fb%20%7B%7Btoken%7D%7D');
  });

  it('keeps the value out of everything that may reach the server log', async () => {
    const closed = await closedPortUrl();
    const result = await failure(probeServer(target(closed.replace(/\/mcp$/, '/{{token}}/mcp'), { fields: [field], values: { token: 'secret-key-5521' } })));
    expect(result.code).toBe('APP_MCP_UNREACHABLE');
    expect(result.logged).not.toContain('secret-key-5521');
    const page = await startTestWebPage();
    stops.push(() => page.close());
    const notMcp = await failure(probeServer(target(`${page.url}?key={{token}}`, { fields: [field], values: { token: 'secret-key-5521' } })));
    expect(notMcp.logged).not.toContain('secret-key-5521');
    // The client library names the target of a redirect in its error text, the path with the key included.
    const away = await rawServer((req, res) => res.writeHead(307, { location: `http://127.0.0.1:9${req.url ?? ''}` }).end());
    const redirected = await failure(probeServer(target(away.replace(/\/mcp$/, '/{{token}}/mcp'), { fields: [field], values: { token: 'secret-key-5521' } })));
    expect(redirected.code).toBe('APP_MCP_NOT_MCP');
    expect(redirected.logged).not.toContain('secret-key-5521');
  });
});
