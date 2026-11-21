// `fetch` over a Unix socket: the app reaches mcp-runner through a socket in a volume they share, not over a network
// (docs/specs/[20.11.2026]-mcp-connections.md, F1). A program in mcp-runner then has no network path to the app at
// all — neither to its sign-in nor to its internal addresses. Node's own fetch cannot use a socket, so this one is
// node:http with `socketPath`; the address of a request names only the path, its host is not used.
import { request, type IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';

function headersOf(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  return headers;
}

export function unixFetch(socketPath: string) {
  return (input: string | URL, init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const url = new URL(String(input));
      const body = init?.body;
      if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
        reject(new Error('unixFetch sends only text or bytes'));
        return;
      }
      const sent = request(
        { socketPath, path: `${url.pathname}${url.search}`, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.signal ? { signal: init.signal } : {}) },
        (res) => {
          const status = res.statusCode ?? 502;
          const empty = status === 204 || status === 304 || init?.method === 'HEAD';
          resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? '', headers: headersOf(res.headers) }));
        },
      );
      // The shape of fetch's own network failure, so callers tell «the runner does not answer» the same way.
      sent.on('error', (error) => reject(error.name === 'AbortError' ? error : new TypeError('fetch failed', { cause: error })));
      sent.end(body ?? undefined);
    });
}
