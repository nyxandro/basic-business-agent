// Test servers for connections: an MCP server that records whose access reached it, and an OAuth
// authorisation server with PKCE and single-use, rotating refresh tokens (like Bitrix24 or amoCRM).
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
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
  // Requests with these tokens get 403: the person may not do this.
  forbiddenTokens: Set<string>;
  // Calls of these actions lose the connection after the server got them: the outcome is unknown to the client.
  dropCalls: Set<string>;
  close(): Promise<void>;
}

// How a protected test server tells where to sign in (MCP authorization, RFC 9728): in the 401 challenge (the
// metadata then lies at an address only the challenge names), only at the well-known address of the resource, or
// nowhere (a server that takes a key).
export interface TestMcpServerOptions {
  signIn?: { where: 'challenge' | 'well-known' | 'nowhere'; authorizationServer: string };
  port?: number;
}

// A port of its own (0) in tests; a fixed one on the browser stand, whose scenarios type the address.
async function listen(server: Server, port = 0): Promise<string> {
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function startTestMcpServer(options: TestMcpServerOptions = {}): Promise<TestMcpServer> {
  const seen: IncomingHttpHeaders[] = [];
  const state: TestMcpServer = { url: '', seen, requested: [], acceptedTokens: options.signIn ? new Set() : null, forbiddenTokens: new Set(), dropCalls: new Set(), close: () => Promise.resolve() };
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
    if (state.forbiddenTokens.has(token)) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    const serve = () => void mcp.startHTTP({ url: new URL(req.url ?? '/', 'http://127.0.0.1'), httpPath: '/mcp', req, res });
    if (state.dropCalls.size === 0 || req.method !== 'POST') return serve();
    // Read the call, then cut the connection as if the server crashed while doing it.
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const message = JSON.parse(body) as { method?: string; params?: { name?: string } };
      if (message.method === 'tools/call' && state.dropCalls.has(message.params?.name ?? '')) {
        req.socket.destroy();
        return;
      }
      (req as IncomingMessage & { body?: unknown }).body = message;
      serve();
    });
  });
  base = await listen(http, options.port);
  state.url = `${base}/mcp`;
  state.close = () => new Promise((resolve) => http.close(() => resolve()));
  return state;
}

export interface TestOAuthServer {
  base: string;
  // The issuer of its metadata (RFC 8414); the authorization answer names it in `iss` (RFC 9207).
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  accessTokens: Set<string>;
  refreshUses: string[];
  // Clients registered on the fly (RFC 7591), in order.
  registrations: string[];
  // Token requests by grant type, to count exchanges and refreshes.
  tokenRequests: string[];
  accessTtlSeconds: number;
  // A wrong `iss` in the authorization answer: a mix-up the client must refuse.
  issInAnswer: string | null;
  // The token address answers a refresh with this status (the system is down), not refusing the token.
  refreshDown: number | null;
  close(): Promise<void>;
}

export interface TestOAuthServerOptions {
  // Clients may register themselves (RFC 7591); without it only the client set up in advance works.
  dynamicRegistration?: boolean;
  port?: number;
}

// An authorization server with PKCE and single-use, rotating refresh tokens (like Bitrix24 or amoCRM), its metadata
// at the well-known address and, when asked, registration on the fly — what an MCP server with a sign-in points to.
export async function startTestOAuthServer(options: TestOAuthServerOptions = {}): Promise<TestOAuthServer> {
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  const liveRefresh = new Map<string, string>();
  const clients = new Map<string, string | null>();
  const s: TestOAuthServer = {
    base: '',
    issuer: '',
    authorizeUrl: '',
    tokenUrl: '',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    accessTokens: new Set(),
    refreshUses: [],
    registrations: [],
    tokenRequests: [],
    accessTtlSeconds: 3600,
    issInAnswer: null,
    refreshDown: null,
    close: () => Promise.resolve(),
  };
  clients.set(s.clientId, s.clientSecret);
  const issue = (clientId: string) => {
    const access = `at-${randomBytes(8).toString('hex')}`;
    const refresh = `rt-${randomBytes(8).toString('hex')}`;
    s.accessTokens.add(access);
    liveRefresh.set(refresh, clientId);
    return { access_token: access, refresh_token: refresh, expires_in: s.accessTtlSeconds, token_type: 'Bearer' };
  };
  // client_secret_basic or client_secret_post; a client registered without a secret is public (PKCE only).
  const clientOf = (req: IncomingMessage, p: URLSearchParams): string | null => {
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    const [id, secret] = basic ? Buffer.from(basic[1]!, 'base64').toString().split(':').map(decodeURIComponent) : [p.get('client_id'), p.get('client_secret')];
    if (!id || !clients.has(id)) return null;
    const expected = clients.get(id);
    return expected === null || expected === secret ? id : null;
  };
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const reply = (status: number, json: object) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return reply(200, {
        issuer: s.issuer,
        authorization_endpoint: s.authorizeUrl,
        token_endpoint: s.tokenUrl,
        ...(options.dynamicRegistration ? { registration_endpoint: `${s.base}/register` } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const clientId = url.searchParams.get('client_id') ?? '';
      if (!clients.has(clientId)) return reply(400, { error: 'invalid_client' });
      const code = `code-${randomBytes(6).toString('hex')}`;
      codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirectUri: url.searchParams.get('redirect_uri') ?? '', clientId });
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      back.searchParams.set('iss', s.issInAnswer ?? s.issuer);
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (url.pathname === '/register' && options.dynamicRegistration) {
        const metadata = JSON.parse(body) as { token_endpoint_auth_method?: string };
        const clientId = `dcr-${s.registrations.length + 1}`;
        const secret = metadata.token_endpoint_auth_method === 'none' ? null : `dcr-secret-${randomBytes(6).toString('hex')}`;
        clients.set(clientId, secret);
        s.registrations.push(clientId);
        return reply(201, { ...metadata, client_id: clientId, ...(secret ? { client_secret: secret } : {}), client_id_issued_at: Math.floor(Date.now() / 1000) });
      }
      const p = new URLSearchParams(body);
      s.tokenRequests.push(p.get('grant_type') ?? '');
      const clientId = clientOf(req, p);
      if (!clientId) return reply(401, { error: 'invalid_client' });
      if (p.get('grant_type') === 'authorization_code') {
        const entry = codes.get(p.get('code') ?? '');
        const challenge = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
        if (!entry || entry.challenge !== challenge || entry.redirectUri !== p.get('redirect_uri') || entry.clientId !== clientId) return reply(400, { error: 'invalid_grant' });
        codes.delete(p.get('code')!);
        return reply(200, issue(clientId));
      }
      if (p.get('grant_type') === 'refresh_token') {
        // 503 — the system says «not now» in OAuth words; 502 — a proxy before it answers with a page.
        if (s.refreshDown === 502) return res.writeHead(502, { 'content-type': 'text/html' }).end('<h1>Bad Gateway</h1>');
        if (s.refreshDown) return reply(s.refreshDown, { error: 'temporarily_unavailable' });
        const rt = p.get('refresh_token') ?? '';
        s.refreshUses.push(rt);
        // Single use, and only by the client it was issued to.
        if (liveRefresh.get(rt) !== clientId) return reply(400, { error: 'invalid_grant' });
        liveRefresh.delete(rt);
        return reply(200, issue(clientId));
      }
      return reply(400, { error: 'unsupported_grant_type' });
    });
  });
  s.base = await listen(http, options.port);
  s.issuer = s.base;
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
