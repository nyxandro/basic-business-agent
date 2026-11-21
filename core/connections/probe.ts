// The first look at an address the admin typed (docs/specs/[20.11.2026]-mcp-connections.md, scenario 1, step 2):
// is there an MCP server, and how does it let people in — without sign-in, through the system's site (OAuth,
// found by the 401 challenge or the well-known address of RFC 9728), or with a key (it refuses and names no
// sign-in). The handshake is the one agents make later: the MCP client tries the 2026-07-28 revision and falls
// back to the 2025 ones, so an address the probe accepts is one the agents reach.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  Client,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type FetchLike,
} from '@modelcontextprotocol/client';
import { mcpProbeInputSchema, type McpProbeAuth, type McpProbeInput, type McpProbeResult } from '@bba/contracts';
import type { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { isPublicAddress } from '../net/public-address.ts';
import { isNetworkFailure, origin, safeCause } from './log-safe.ts';
import { fillTemplate } from './templates.ts';

// The client's own 3 s is too short for a server far away (section 18): the agents' calls wait 10 s too.
export const PROBE_TIMEOUT_MS = 10_000;
const CLIENT_INFO = { name: 'basic-business-agent', version: '1.0.0' };
const HTTP_SERVER_ERROR = 500;

type Verdict = 'needs_access' | 'unreachable' | 'not_mcp';

const invalid = (message: string, userMessage: string) => appError('APP_VALIDATION_FAILED', message, { userMessage });

const unreachable = (url: URL, error: unknown): AppError => appError('APP_MCP_UNREACHABLE', `mcp probe: ${origin(url)} does not answer`, { cause: safeCause(error) });
const notMcp = (url: URL, error: unknown): AppError => appError('APP_MCP_NOT_MCP', `mcp probe: ${origin(url)} is not an MCP server`, { cause: safeCause(error) });

function fillAddress(input: McpProbeInput): URL {
  const filled = fillTemplate(input.url, (key) => {
    const value = input.values[key];
    if (value) return encodeURIComponent(value);
    const label = input.fields.find((field) => field.key === key)?.label ?? key;
    throw invalid(`mcp probe: no value for {{${key}}}`, `Введите «${label}», чтобы проверить адрес: без этого значения сервер не ответит.`);
  });
  let url: URL;
  try {
    url = new URL(filled);
  } catch {
    throw invalid('mcp probe: the address does not parse', 'Адрес сервера записан неверно. Скопируйте его из инструкции системы целиком, начиная с https://.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid(`mcp probe: scheme ${url.protocol}`, 'Адрес сервера должен начинаться с https:// (или http:// для сервера во внутренней сети).');
  }
  return url;
}

// http only inside the office network or on this machine (the 1C server): over the internet the keys of employees
// would travel in the open. The admin types the address, so inner addresses are allowed (section 15).
export async function assertPlainHttpAllowed(url: URL): Promise<void> {
  if (url.protocol !== 'http:') return;
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
    } catch (error) {
      throw unreachable(url, error);
    }
  }
  if (addresses.some(isPublicAddress)) {
    throw invalid(`mcp probe: plain http to the public ${origin(url)}`, 'Адрес должен начинаться с https://. Без шифрования ключи сотрудников уйдут открытым текстом.');
  }
}

function verdictOf(error: unknown): Verdict | null {
  if (error instanceof SdkHttpError) {
    if (error.status === 401 || error.status === 403) return 'needs_access';
    // A proxy before the server answers 502/503 when the server behind it is down.
    return error.status >= HTTP_SERVER_ERROR ? 'unreachable' : 'not_mcp';
  }
  if (error instanceof SdkError) {
    if (error.code === SdkErrorCode.RequestTimeout || error.code === SdkErrorCode.ConnectionClosed) return 'unreachable';
    // The handshake failed: on the network (refused, no such host) the server is not there; otherwise something
    // answered, but not by MCP (a web page, JSON of another kind).
    if (error.code === SdkErrorCode.EraNegotiationFailed) return error.cause instanceof TypeError ? 'unreachable' : 'not_mcp';
  }
  if (error instanceof TypeError) return 'unreachable';
  return null;
}

// A server that refuses tells where to sign in in its 401 challenge or at its well-known address; without that
// it takes a key in a header or in the address.
async function signInOf(url: URL, challenge: URL | undefined, timeoutMs: number): Promise<McpProbeAuth> {
  const timed: FetchLike = (target, init) => fetch(target, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  try {
    const metadata = await discoverOAuthProtectedResourceMetadata(url, challenge ? { resourceMetadataUrl: challenge } : {}, timed);
    return metadata.authorization_servers && metadata.authorization_servers.length > 0 ? 'oauth' : 'key';
  } catch (error) {
    if (isNetworkFailure(error)) throw unreachable(url, error);
    // No metadata (404, 401), a page in its place or JSON of another shape: the server names no sign-in.
    return 'key';
  }
}

// The MCP handshake without any access. A refusal brings the server's 401 challenge, which may name where its
// sign-in metadata lies (RFC 9728) — the MCP client library reads it from the 401 of its transport.
async function handshake(url: URL, timeoutMs: number): Promise<{ failure: unknown; challenge: URL | undefined } | null> {
  let challenge: URL | undefined;
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: async (target, init) => {
      const response = await fetch(target, init);
      if (response.status === 401) challenge = extractWWWAuthenticateParams(response).resourceMetadataUrl ?? challenge;
      return response;
    },
  });
  const client = new Client(CLIENT_INFO, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    return null;
  } catch (failure) {
    return { failure, challenge };
  } finally {
    await client.close();
  }
}

function handshakeFailure(url: URL, failure: unknown): AppError {
  const verdict = verdictOf(failure);
  if (verdict === 'unreachable') return unreachable(url, failure);
  if (verdict === 'not_mcp') return notMcp(url, failure);
  return appError('APP_INTERNAL', `mcp handshake with ${origin(url)} failed unexpectedly`, { cause: safeCause(failure) });
}

export async function probeServer(raw: McpProbeInput, timeoutMs = PROBE_TIMEOUT_MS): Promise<McpProbeResult> {
  const parsed = mcpProbeInputSchema.safeParse(raw);
  if (!parsed.success) throw appError('APP_VALIDATION_FAILED', 'mcp probe input does not match the schema', { cause: parsed.error });
  const url = fillAddress(parsed.data);
  await assertPlainHttpAllowed(url);
  const refused = await handshake(url, timeoutMs);
  if (!refused) return { auth: 'none' };
  if (verdictOf(refused.failure) === 'needs_access') return { auth: await signInOf(url, refused.challenge, timeoutMs) };
  throw handshakeFailure(url, refused.failure);
}

// Where the sign-in metadata of a server lies, by its 401 challenge — for a sign-in started outside a transport
// (step 4). Undefined when the challenge names none: the well-known address is then looked up.
export async function signInChallenge(url: URL, timeoutMs = PROBE_TIMEOUT_MS): Promise<URL | undefined> {
  const refused = await handshake(url, timeoutMs);
  if (!refused) return undefined;
  if (verdictOf(refused.failure) === 'needs_access') return refused.challenge;
  throw handshakeFailure(url, refused.failure);
}
