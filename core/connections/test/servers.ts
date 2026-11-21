// Test servers for connections: an MCP server that records whose access reached it, and an OAuth
// authorisation server with PKCE and single-use, rotating refresh tokens (like Bitrix24 or amoCRM).
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { z } from 'zod';

export interface TestMcpServer {
  url: string;
  seen: IncomingHttpHeaders[];
  // The path and query of every request to the server, as it arrived.
  requested: string[];
  // Requests whose Authorization header is not accepted get 401.
  acceptedTokens: Set<string> | null;
  close(): Promise<void>;
}

// How a protected test server tells where to sign in (MCP authorization, RFC 9728): in the 401 challenge (the
// metadata then lies at an address only the challenge names), only at the well-known address of the resource, or
// nowhere (a server that takes a key).
export interface TestMcpServerOptions {
  signIn?: { where: 'challenge' | 'well-known' | 'nowhere'; authorizationServer: string };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function startTestMcpServer(options: TestMcpServerOptions = {}): Promise<TestMcpServer> {
  const seen: IncomingHttpHeaders[] = [];
  const state: TestMcpServer = { url: '', seen, requested: [], acceptedTokens: options.signIn ? new Set() : null, close: () => Promise.resolve() };
  let base = '';
  const mcp = new MCPServer({
    id: 'crm',
    name: 'Тестовая CRM',
    version: '1.0.0',
    tools: {
      deals_search: createTool({ id: 'deals_search', description: 'Найти сделки', inputSchema: z.object({}), execute: () => Promise.resolve({ deals: 12 }) }),
      deal_create: createTool({ id: 'deal_create', description: 'Создать сделку', inputSchema: z.object({ title: z.string() }), execute: (i) => Promise.resolve({ created: i.title }) }),
    },
  });
  const signIn = options.signIn;
  const metadataPath = signIn?.where === 'challenge' ? '/oauth/resource-metadata' : '/.well-known/oauth-protected-resource/mcp';
  const http = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (signIn && signIn.where !== 'nowhere' && req.method === 'GET' && path === metadataPath) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [signIn.authorizationServer] }));
      return;
    }
    seen.push(req.headers);
    state.requested.push(req.url ?? '');
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (state.acceptedTokens && !state.acceptedTokens.has(token)) {
      const challenge = signIn?.where === 'challenge' ? { 'www-authenticate': `Bearer resource_metadata="${base}${metadataPath}"` } : {};
      res.writeHead(401, { 'content-type': 'application/json', ...challenge }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    void mcp.startHTTP({ url: new URL(req.url ?? '/', 'http://127.0.0.1'), httpPath: '/mcp', req, res });
  });
  base = await listen(http);
  state.url = `${base}/mcp`;
  state.close = () => new Promise((resolve) => http.close(() => resolve()));
  return state;
}

export interface TestOAuthServer {
  base: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  accessTokens: Set<string>;
  refreshUses: string[];
  accessTtlSeconds: number;
  close(): Promise<void>;
}

export async function startTestOAuthServer(): Promise<TestOAuthServer> {
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const liveRefresh = new Set<string>();
  const s: TestOAuthServer = {
    base: '',
    authorizeUrl: '',
    tokenUrl: '',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    accessTokens: new Set(),
    refreshUses: [],
    accessTtlSeconds: 3600,
    close: () => Promise.resolve(),
  };
  const issue = () => {
    const access = `at-${randomBytes(8).toString('hex')}`;
    const refresh = `rt-${randomBytes(8).toString('hex')}`;
    s.accessTokens.add(access);
    liveRefresh.add(refresh);
    return { access_token: access, refresh_token: refresh, expires_in: s.accessTtlSeconds, token_type: 'Bearer' };
  };
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const code = `code-${randomBytes(6).toString('hex')}`;
      codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirectUri: url.searchParams.get('redirect_uri') ?? '' });
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const reply = (status: number, json: object) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      if (p.get('client_id') !== s.clientId || p.get('client_secret') !== s.clientSecret) return reply(401, { error: 'invalid_client' });
      if (p.get('grant_type') === 'authorization_code') {
        const entry = codes.get(p.get('code') ?? '');
        const challenge = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
        if (!entry || entry.challenge !== challenge || entry.redirectUri !== p.get('redirect_uri')) return reply(400, { error: 'invalid_grant' });
        codes.delete(p.get('code')!);
        return reply(200, issue());
      }
      if (p.get('grant_type') === 'refresh_token') {
        const rt = p.get('refresh_token') ?? '';
        s.refreshUses.push(rt);
        if (!liveRefresh.delete(rt)) return reply(400, { error: 'invalid_grant' }); // single use
        return reply(200, issue());
      }
      return reply(400, { error: 'unsupported_grant_type' });
    });
  });
  s.base = await listen(http);
  s.authorizeUrl = `${s.base}/authorize`;
  s.tokenUrl = `${s.base}/token`;
  s.close = () => new Promise((resolve) => http.close(() => resolve()));
  return s;
}

// A web page where an MCP server was expected: a sign-in page, a site, a proxy's error page.
export async function startTestWebPage(): Promise<{ url: string; close(): Promise<void> }> {
  const http = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Вход</title>'));
  const base = await listen(http);
  return { url: `${base}/mcp`, close: () => new Promise((resolve) => http.close(() => resolve())) };
}

// An address where nothing listens: a port taken and freed again.
export async function closedPortUrl(): Promise<string> {
  const http = createServer();
  const base = await listen(http);
  await new Promise<void>((resolve) => http.close(() => resolve()));
  return `${base}/mcp`;
}
