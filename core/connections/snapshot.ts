// The snapshot of an MCP server's actions (docs/specs/[20.11.2026]-mcp-connections.md, section 4 and step 3): the
// admin checks the server with their own access, and agents get only the actions the admin turned on, in the
// description the admin saw. Definitions are kept as plain data (Mastra `listToolDefinitionsWithErrors`), so
// tools are rebuilt from them without asking the server on every turn (`toolFromDefinition`, step 6).
import { createHash, randomUUID } from 'node:crypto';
import { MCPClient, type MCPDiscoveryErrorDetails, type SerializableMCPToolDefinition } from '@mastra/mcp';
import type { McpAction, McpActionPatch, McpAuthKind } from '@bba/contracts';
import { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { origin } from './log-safe.ts';
import { modelNames } from './tool-names.ts';

// Section 18: the client's own 3 s to connect is too short for a server far away.
export const CONNECT_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 30_000;
// A rough count for «Включённые действия добавляют к каждому запросу агента около N токенов»: the JSON of a tool
// with Russian and English text gives about 3 characters a token [assumption, not measured on our models].
const CHARS_PER_TOKEN = 3;
const HTTP_SERVER_ERROR = 500;
const UNEXPECTED_CONTENT = 'CLIENT_HTTP_UNEXPECTED_CONTENT';

// An action as the snapshot keeps it: the admin's marks and the server's definition they were made on.
export interface StoredAction {
  name: string;
  modelName: string;
  title: string | null;
  enabled: boolean;
  readOnly: boolean;
  check: boolean;
  isNew: boolean;
  isChanged: boolean;
  // Of what the model sees of the action: a change marks it for the admin.
  fingerprint: string;
  definition: SerializableMCPToolDefinition;
}

export interface ServerAccess {
  url: URL;
  headers: Record<string, string>;
}

// JSON with sorted keys: the same definition gives the same fingerprint whatever order the server writes keys in.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprintOf(definition: SerializableMCPToolDefinition): string {
  const seen = { title: definition.title, description: definition.description, inputSchema: definition.inputSchema, outputSchema: definition.outputSchema, annotations: definition.annotations };
  return createHash('sha256').update(canonical(seen)).digest('hex');
}

const serverTitleOf = (definition: SerializableMCPToolDefinition) => definition.title ?? definition.annotations?.title ?? definition.name;

export function toActionView(action: StoredAction): McpAction {
  const description = action.definition.description ?? '';
  const seenByModel = JSON.stringify({ name: action.modelName, description, parameters: action.definition.inputSchema });
  return {
    name: action.name,
    modelName: action.modelName,
    title: action.title,
    serverTitle: serverTitleOf(action.definition),
    description,
    enabled: action.enabled,
    readOnly: action.readOnly,
    readOnlyHint: action.definition.annotations?.readOnlyHint === true,
    check: action.check,
    isNew: action.isNew,
    isChanged: action.isChanged,
    tokens: Math.ceil(seenByModel.length / CHARS_PER_TOKEN),
  };
}

// A new snapshot over the previous one: the admin's marks stay on the actions still there; an action that appears
// is off and, after the first snapshot, marked new; one whose description or parameters changed is marked.
export function mergeSnapshot(slug: string, previous: readonly StoredAction[], definitions: readonly SerializableMCPToolDefinition[], first: boolean): StoredAction[] {
  const before = new Map(previous.map((action) => [action.name, action]));
  const names = modelNames(
    slug,
    definitions.map((d) => d.name),
  );
  return definitions.map((definition) => {
    const fingerprint = fingerprintOf(definition);
    const modelName = names.get(definition.name)!;
    const kept = before.get(definition.name);
    if (kept) return { ...kept, modelName, fingerprint, definition, isChanged: kept.isChanged || kept.fingerprint !== fingerprint };
    return { name: definition.name, modelName, title: null, enabled: false, readOnly: false, check: false, isNew: !first, isChanged: false, fingerprint, definition };
  });
}

const invalid = (message: string, userMessage: string) => appError('APP_VALIDATION_FAILED', message, { userMessage });

// The admin's marks over the snapshot. Saving them is looking at the list: «new» and «changed» are cleared.
export function applyActionMarks(actions: readonly StoredAction[], marks: readonly McpActionPatch[]): StoredAction[] {
  const byName = new Map(marks.map((mark) => [mark.name, mark]));
  if (byName.size !== marks.length) throw invalid('an action is marked twice', 'Одно действие отмечено дважды. Обновите страницу и сохраните ещё раз.');
  const known = new Set(actions.map((a) => a.name));
  const unknown = marks.find((mark) => !known.has(mark.name));
  if (unknown) throw invalid(`action ${unknown.name} is not in the snapshot`, 'Сервер больше не даёт одно из действий. Обновите список действий и сохраните ещё раз.');
  const checks = marks.filter((mark) => mark.check);
  if (checks.length > 1) throw invalid('more than one check action', 'Проверять ключ можно одним действием — оставьте отметку у одного.');
  if (checks[0] && !checks[0].readOnly) throw invalid('a check action that writes', 'Проверять ключ можно только действием «только чтение»: проверка идёт без «Да».');
  return actions.map((action) => {
    const mark = byName.get(action.name);
    const marked = mark ? { enabled: mark.enabled, readOnly: mark.readOnly, check: mark.check, title: mark.title ? mark.title : null } : {};
    return { ...action, ...marked, isNew: false, isChanged: false };
  });
}

const REFUSED: Record<McpAuthKind, (title: string) => string> = {
  none: (title) => `${title} не пускает без входа. Выберите другой способ входа.`,
  oauth: (title) => `${title} не приняла ваш вход. Нажмите «Проверить своим доступом» и войдите заново.`,
  personal_key: (title) => `${title} не приняла ключ. Проверьте его.`,
  shared_key: (title) => `${title} не приняла ключ. Проверьте его.`,
};

function readFailure(server: { title: string; auth: McpAuthKind }, url: URL, detail: MCPDiscoveryErrorDetails): AppError {
  const facts = { httpStatus: detail.httpStatus ?? null, code: detail.code ?? null };
  if (detail.httpStatus === 401 || detail.httpStatus === 403) {
    return new AppError({
      code: 'APP_CONNECTOR_AUTH_FAILED',
      message: `mcp snapshot: ${origin(url)} refused the access (HTTP ${detail.httpStatus})`,
      userMessage: REFUSED[server.auth](server.title),
      status: 401,
      details: facts,
    });
  }
  // A page or JSON of another kind answered: not MCP. Refused, unknown host, silence, 5xx of a proxy: no answer.
  const notMcp = detail.httpStatus !== undefined ? detail.httpStatus < HTTP_SERVER_ERROR : detail.code === UNEXPECTED_CONTENT;
  return notMcp
    ? appError('APP_MCP_NOT_MCP', `mcp snapshot: ${origin(url)} is not an MCP server`, { details: facts })
    : appError('APP_MCP_UNREACHABLE', `mcp snapshot: ${origin(url)} does not answer`, { details: facts });
}

// The server's actions with the given access. Nothing of the failure's text is kept: the client library writes
// the address with its path into it.
export async function readDefinitions(server: { slug: string; title: string; auth: McpAuthKind }, access: ServerAccess): Promise<SerializableMCPToolDefinition[]> {
  const client = new MCPClient({
    id: `mcp-snapshot-${randomUUID()}`,
    registerProcessHooks: false,
    servers: { [server.slug]: { url: access.url, requestInit: { headers: access.headers }, connectTimeout: CONNECT_TIMEOUT_MS, timeout: LIST_TIMEOUT_MS } },
  });
  try {
    const { definitions, errorDetails } = await client.listToolDefinitionsWithErrors({ perServerTimeoutMs: LIST_TIMEOUT_MS });
    const failure = errorDetails[server.slug];
    if (failure) throw readFailure(server, access.url, failure);
    return Object.values(definitions[server.slug] ?? {});
  } finally {
    await client.disconnect();
  }
}
