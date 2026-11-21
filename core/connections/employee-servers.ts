// What an employee does with the MCP servers the admin allowed for their agents (docs/specs/[20.11.2026]-mcp-connections.md,
// scenario 2; the owner's decision F2, 21.11): turns on one without a sign-in or with the shared key («Использовать»),
// saves their own key, disconnects. A sign-in on the system's site is in mcp-auth.ts.
import type { CredentialStatus } from './credentials.ts';
import { deleteCredential, saveCredential, setCredentialStatus } from './credentials.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { authFailed } from './errors.ts';
import type { McpTools } from './mcp-tools.ts';
import { mcpConnectorId, serverForEmployee } from './servers.ts';

export interface EmployeeServerDeps {
  db: Db;
  box: SecretBox;
  mcp: McpTools;
}

// The agents of the employee: a superadmin has them all.
export type EmployeeAgents = ReadonlySet<string> | 'all';

const invalid = (message: string, userMessage: string) => appError('APP_VALIDATION_FAILED', message, { userMessage });

async function turnOn(db: Db, serverId: string, userId: string): Promise<void> {
  await db.query('INSERT INTO app.mcp_server_users (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [serverId, userId]);
}

// «Использовать» for a server without a sign-in or with the shared key of the organization.
export async function useServer(deps: EmployeeServerDeps, input: { userId: string; agents: EmployeeAgents; serverId: string; on: boolean }): Promise<void> {
  const server = await serverForEmployee(deps.db, deps.box, input.serverId, input.agents);
  if (server.auth !== 'none' && server.auth !== 'shared_key') throw invalid(`${server.title} needs the employee's own access`, `${server.title} работает с вашим доступом — нажмите «Подключить».`);
  if (input.on) await turnOn(deps.db, server.id, input.userId);
  else await deps.db.query('DELETE FROM app.mcp_server_users WHERE server_id = $1 AND user_id = $2', [server.id, input.userId]);
}

// «Подключить» with a personal key: the fields the admin described, all of them. With a check action the key is
// checked at once; without — «Сохранено, проверится при первом действии».
export async function savePersonalKey(deps: EmployeeServerDeps, input: { userId: string; agents: EmployeeAgents; serverId: string; fields: Record<string, string> }): Promise<CredentialStatus> {
  const server = await serverForEmployee(deps.db, deps.box, input.serverId, input.agents);
  if (server.auth !== 'personal_key') throw invalid(`${server.title} takes no personal key`, `${server.title} не принимает личный ключ.`);
  const extra = Object.keys(input.fields).find((key) => !server.fields.some((field) => field.key === key));
  if (extra) throw invalid(`field ${extra} is not of the server`, 'Форма устарела. Обновите страницу и введите ключ ещё раз.');
  for (const field of server.fields) {
    if (!input.fields[field.key]) throw invalid(`field ${field.key} missing`, `Заполните «${field.label}».`);
  }
  const connectorId = mcpConnectorId(server.id);
  deps.mcp.forget(server.id, input.userId);
  await saveCredential(deps.db, deps.box, { userId: input.userId, connectorId, credential: { kind: 'static', fields: input.fields }, status: 'unverified' });
  await turnOn(deps.db, server.id, input.userId);
  if (!server.checkAction) return 'unverified';
  try {
    await deps.mcp.verify(input.userId, server);
  } catch (error) {
    deps.mcp.forget(server.id, input.userId);
    await setCredentialStatus(deps.db, input.userId, connectorId, 'auth_error', 'APP_CONNECTOR_AUTH_FAILED');
    throw authFailed(server.title, connectorId, error);
  }
  await setCredentialStatus(deps.db, input.userId, connectorId, 'connected', null);
  return 'connected';
}

// «Отключить»: the employee's key or sign-in is deleted, and the server is off for them. Works on a server already
// gone from their agents too — it is their own data.
export async function disconnectServer(deps: EmployeeServerDeps, input: { userId: string; serverId: string }): Promise<void> {
  deps.mcp.forget(input.serverId, input.userId);
  await deleteCredential(deps.db, input.userId, mcpConnectorId(input.serverId));
  await deps.db.query('DELETE FROM app.mcp_server_users WHERE server_id = $1 AND user_id = $2', [input.serverId, input.userId]);
}
