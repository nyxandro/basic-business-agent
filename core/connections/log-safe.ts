// What of an MCP failure may reach the server log (docs/specs/[20.11.2026]-mcp-connections.md, section 13): the
// scheme and the host of an address, and the kinds, codes and statuses of errors — never their texts, which the
// client libraries fill with the address and its path, and a key may sit in the path (МойСклад).

export const origin = (url: URL) => `${url.protocol}//${url.host}`;

export function safeCause(error: unknown): Error {
  const links: string[] = [];
  for (let current = error; current instanceof Error && links.length < 4; current = current.cause) {
    const { code, data } = current as { code?: unknown; data?: { status?: unknown } };
    links.push([current.name, typeof code === 'string' ? code : null, typeof data?.status === 'number' ? `status ${data.status}` : null].filter(Boolean).join(' '));
  }
  return new Error(links.length > 0 ? links.join(' <- ') : `non-error ${typeof error}`);
}

// A failure of the network or of patience: the system is not reachable now, the access itself may be fine.
export const isNetworkFailure = (error: unknown) => error instanceof TypeError || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
