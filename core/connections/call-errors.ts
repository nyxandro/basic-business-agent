// What a failed call of an action on a connected system means (docs/specs/[20.11.2026]-mcp-connections.md, step 7,
// section 9): by the HTTP status and the codes of the MCP client, never by words in an error's text — a «403» in the
// name of a deal must not break a connection (a regular expression over the text did that before step 7).
import { AppError, isAppError } from '../errors/app-error.ts';

const CHAIN_DEPTH = 6;
// Mastra: the connection broke after the server got a call that is not safe to repeat, so it did not call again.
const OUTCOME_UNKNOWN = 'MCP_CLIENT_TOOL_CALL_OUTCOME_UNKNOWN';
// Mastra: the server answered the call with an error of its own (`isError`): it is a result, the model reads it.
const ANSWERED_WITH_ERROR = 'MCP_CLIENT_TOOL_EXECUTION_FAILED';

export type CallFailure =
  // Our own error raised inside the call (a token that could not be refreshed), maybe wrapped by the client.
  | { kind: 'own'; error: AppError }
  | { kind: 'answered' }
  | { kind: 'unknown_outcome' }
  // 401: the access is not taken any more.
  | { kind: 'refused' }
  // 403: no right to this one thing.
  | { kind: 'forbidden' }
  | { kind: 'unavailable'; httpStatus: number | undefined };

function chainOf(error: unknown): Error[] {
  const out: Error[] = [];
  for (let current = error; current instanceof Error && out.length < CHAIN_DEPTH; current = current.cause) out.push(current);
  return out;
}

// The HTTP status the client library put on the error (SdkHttpError keeps it as `status` and `data.status`).
function httpStatusOf(chain: Error[]): number | undefined {
  for (const error of chain) {
    const { status, statusCode, data } = error as { status?: unknown; statusCode?: unknown; data?: { status?: unknown } };
    if (typeof status === 'number') return status;
    if (typeof statusCode === 'number') return statusCode;
    if (typeof data?.status === 'number') return data.status;
  }
  return undefined;
}

export function classifyCall(error: unknown): CallFailure {
  const chain = chainOf(error);
  // Our errors first: an AppError has an HTTP status of its own, it is not the system's answer.
  const own = chain.find(isAppError);
  if (own) return { kind: 'own', error: own };
  const ids = new Set(chain.map((e) => (e as { id?: unknown }).id));
  if (ids.has(OUTCOME_UNKNOWN)) return { kind: 'unknown_outcome' };
  if (ids.has(ANSWERED_WITH_ERROR)) return { kind: 'answered' };
  const httpStatus = httpStatusOf(chain);
  if (httpStatus === 401) return { kind: 'refused' };
  if (httpStatus === 403) return { kind: 'forbidden' };
  return { kind: 'unavailable', httpStatus };
}
