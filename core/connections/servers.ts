// MCP servers the admin adds without a developer (docs/specs/[20.11.2026]-mcp-connections.md, sections 8
// and 17): what a server row may hold, how its secrets are sealed and what the admin panel sees of it.
// A server starts as a draft; employees see it only after the admin checked it and turned it on.
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { McpCheckInput, McpField, McpProgram, McpServerInput, McpServerPatch, McpServerStatus, McpServerView } from '@bba/contracts';
import { mcpServerInputSchema } from '@bba/contracts';
import type { SecretBox } from '../crypto/secret-box.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { decryptFailed } from './credentials.ts';
import { assertPlainHttpAllowed } from './probe.ts';
import { applyActionMarks, mergeSnapshot, readDefinitions, toActionView, type ServerAccess, type StoredAction } from './snapshot.ts';
import { fillTemplate, PLACEHOLDER, placeholders } from './templates.ts';

// An exact version: npx «name@1.2.3» (scoped too), uvx «name==1.2.3». Ranges, tags and «latest» would
// let every start fetch other code (the owner's decision 21.11: programs only in the sandbox, pinned).
const NPX_EXACT = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const UVX_EXACT = /^[A-Za-z0-9][A-Za-z0-9._-]*==\d+(\.\d+){1,3}$/;
const SLUG_ATTEMPTS = 5;
const UNIQUE_VIOLATION = '23505';
// What stands for an employee's value while the address of a template is checked.
const FIELD_MARK = 'bba-field';

// The personal access of employees to a server is kept as to any connected system: one record per person.
export const mcpConnectorId = (serverId: string) => `mcp:${serverId}`;

export interface ServerSecrets {
  client: { clientId: string; clientSecret?: string } | null;
  shared: Record<string, string> | null;
}

type Queryable = Db | pg.PoolClient;

interface ServerRow {
  id: string;
  slug: string;
  title: string;
  transport: 'http' | 'program';
  url: string | null;
  program: McpProgram | null;
  auth: McpServerInput['auth'];
  fields: McpField[];
  header_templates: Record<string, string>;
  env_templates: Record<string, string>;
  secret_ciphertext: Buffer | null;
  secret_iv: Buffer | null;
  secret_key_version: number | null;
  snapshot: StoredAction[];
  snapshot_at: Date | null;
  status: McpServerStatus;
  status_error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

const invalid = (message: string, userMessage: string) => appError('APP_VALIDATION_FAILED', message, { userMessage });

function checkTemplates(input: McpServerInput): void {
  const known = new Set(input.fields.map((f) => f.key));
  const templates = [input.url ?? '', ...Object.values(input.headers), ...Object.values(input.env)];
  const used = new Set(templates.flatMap(placeholders));
  for (const key of used) {
    if (!known.has(key)) {
      throw invalid(`template names unknown field ${key}`, `В шаблоне есть {{${key}}}, но такого поля нет. Добавьте поле «${key}» или исправьте шаблон.`);
    }
  }
  for (const field of input.fields) {
    if (!used.has(field.key)) {
      throw invalid(`field ${field.key} is not used`, `Поле «${field.label}» нигде не используется. Подставьте {{${field.key}}} в адрес, заголовок или переменную окружения — или удалите поле.`);
    }
  }
}

// Placeholders stand for values of employees: the rest must already be an address.
function parseTemplateAddress(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url.replace(PLACEHOLDER, FIELD_MARK));
  } catch (cause) {
    throw appError('APP_VALIDATION_FAILED', 'server url does not parse', { cause, userMessage: 'Адрес сервера записан неверно. Скопируйте его из инструкции системы целиком, начиная с https://.' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw invalid(`server url protocol ${parsed.protocol}`, 'Адрес сервера должен начинаться с https:// (или http:// для сервера во внутренней сети).');
  }
  return parsed;
}

// http only to an inner address (section 9). A host made of an employee's value is checked when it is filled.
async function checkPlainHttp(input: McpServerInput): Promise<void> {
  if (input.transport !== 'http' || !input.url) return;
  const url = parseTemplateAddress(input.url);
  if (url.hostname.includes(FIELD_MARK)) return;
  await assertPlainHttpAllowed(url);
}

function checkProgram(program: McpProgram): void {
  const exact = program.runner === 'npx' ? NPX_EXACT : UVX_EXACT;
  if (!exact.test(program.package)) {
    throw invalid(
      `program package ${program.package} has no exact version`,
      program.runner === 'npx'
        ? 'Укажите точную версию пакета, например 1c-mcp-server@2.3.1 — иначе при каждом запуске может скачаться другой код.'
        : 'Укажите точную версию пакета, например mcp-server-1c==2.3.1 — иначе при каждом запуске может скачаться другой код.',
    );
  }
}

function requireSharedValues(fields: readonly McpField[], values: Record<string, string> | null | undefined): Record<string, string> {
  const given = values ?? {};
  for (const field of fields) {
    if (!given[field.key]) throw invalid(`shared value ${field.key} missing`, `Заполните «${field.label}» — без него общий ключ не заработает.`);
  }
  return Object.fromEntries(fields.map((f) => [f.key, given[f.key]!]));
}

// Every rule a server row keeps, before anything is written (the database repeats the structural ones).
export function validateServerInput(raw: McpServerInput): McpServerInput {
  const parsed = mcpServerInputSchema.safeParse(raw);
  if (!parsed.success) throw appError('APP_VALIDATION_FAILED', 'mcp server input does not match the schema', { cause: parsed.error });
  const input = parsed.data;
  const keys = input.fields.map((f) => f.key);
  if (new Set(keys).size !== keys.length) throw invalid('duplicate field keys', 'У двух полей одинаковый ключ — сделайте ключи разными.');

  if (input.transport === 'http') {
    if (!input.url || input.program) throw invalid('http server needs url and no program', 'Укажите адрес сервера.');
    if (Object.keys(input.env).length > 0) throw invalid('env for a server by address', 'Переменные окружения бывают только у программы.');
    parseTemplateAddress(input.url);
  } else {
    if (!input.program || input.url) throw invalid('program server needs a program and no url', 'Укажите команду и пакет программы.');
    if (Object.keys(input.headers).length > 0) throw invalid('headers for a program', 'Заголовки бывают только у сервера по адресу.');
    if (input.auth !== 'none' && input.auth !== 'shared_key') {
      throw invalid(
        `program with ${input.auth}`,
        'Программа-сервер работает одним процессом на всю организацию, поэтому у неё бывает только «Без входа» или «Общий ключ организации».',
      );
    }
    checkProgram(input.program);
  }

  if (input.auth === 'personal_key' || input.auth === 'shared_key') {
    if (input.fields.length === 0) throw invalid(`${input.auth} without fields`, 'Добавьте хотя бы одно поле ключа — например, «Ключ API».');
  } else if (input.fields.length > 0) {
    throw invalid(`fields with auth ${input.auth}`, 'Поля ключа нужны только для личного или общего ключа.');
  }
  checkTemplates(input);

  if (input.auth === 'shared_key') requireSharedValues(input.fields, input.sharedValues);
  else if (input.sharedValues) throw invalid(`shared values with auth ${input.auth}`, 'Значения общего ключа нужны только для «Общего ключа организации».');
  if (input.client && input.auth !== 'oauth') throw invalid(`client with auth ${input.auth}`, 'Client ID нужен только для входа через сайт системы.');
  return input;
}

function sealSecrets(box: SecretBox, secrets: ServerSecrets): { ciphertext: Buffer; iv: Buffer; keyVersion: number } | null {
  if (!secrets.client && !secrets.shared) return null;
  return box.seal(JSON.stringify(secrets));
}

const secretsOf = (input: McpServerInput): ServerSecrets => ({ client: input.client ?? null, shared: input.auth === 'shared_key' ? (input.sharedValues ?? null) : null });

function openSecrets(box: SecretBox, row: Pick<ServerRow, 'title' | 'secret_ciphertext' | 'secret_iv' | 'secret_key_version'>): ServerSecrets {
  if (!row.secret_ciphertext || !row.secret_iv || row.secret_key_version === null) return { client: null, shared: null };
  try {
    return JSON.parse(box.open({ ciphertext: row.secret_ciphertext, iv: row.secret_iv, keyVersion: row.secret_key_version })) as ServerSecrets;
  } catch (error) {
    throw decryptFailed(row.title, error);
  }
}

function toView(row: ServerRow, agents: string[], secrets: ServerSecrets): McpServerView {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    transport: row.transport,
    url: row.url,
    program: row.program,
    auth: row.auth,
    fields: row.fields,
    headers: row.header_templates,
    env: row.env_templates,
    clientId: secrets.client?.clientId ?? null,
    clientSecretSet: Boolean(secrets.client?.clientSecret),
    sharedConfigured: secrets.shared !== null,
    status: row.status,
    statusErrorCode: row.status_error_code,
    actions: row.snapshot.map(toActionView),
    snapshotAt: row.snapshot_at?.toISOString() ?? null,
    agents,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const notFound = (id: string) => new AppError({ code: 'APP_NOT_FOUND', message: `mcp server ${id} not found`, userMessage: 'Такого подключения нет. Обновите страницу.', status: 404 });

async function loadRow(db: Queryable, id: string, lock: boolean): Promise<ServerRow> {
  const { rows } = await db.query<ServerRow>(`SELECT * FROM app.mcp_servers WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw notFound(id);
  return rows[0];
}

async function agentsOf(db: Queryable, id: string): Promise<string[]> {
  const { rows } = await db.query<{ agent_id: string }>('SELECT agent_id FROM app.mcp_server_agents WHERE server_id = $1 ORDER BY agent_id', [id]);
  return rows.map((r) => r.agent_id);
}

async function viewOf(db: Queryable, box: SecretBox, row: ServerRow): Promise<McpServerView> {
  return toView(row, await agentsOf(db, row.id), openSecrets(box, row));
}

async function setAgents(db: Queryable, id: string, agents: readonly string[]): Promise<void> {
  await db.query('DELETE FROM app.mcp_server_agents WHERE server_id = $1', [id]);
  if (agents.length > 0) await db.query('INSERT INTO app.mcp_server_agents (server_id, agent_id) SELECT $1, unnest($2::text[])', [id, [...new Set(agents)]]);
}

function checkAgents(agents: readonly string[], known: ReadonlySet<string>): void {
  const unknown = agents.find((agent) => !known.has(agent));
  if (unknown) throw invalid(`unknown agent ${unknown}`, 'Одного из выбранных агентов больше нет. Обновите страницу и выберите заново.');
}

const newSlug = () => `m${randomBytes(3).toString('hex')}`;

// Adds a server as a draft: nobody sees it until the admin checks it and turns it on. By default every agent may
// use it (the owner's decision F2, 21.11); the admin narrows the list.
export async function createServer(db: Db, box: SecretBox, raw: McpServerInput, createdBy: string, agents: readonly string[]): Promise<McpServerView> {
  const input = validateServerInput(raw);
  await checkPlainHttp(input);
  const sealed = sealSecrets(box, secretsOf(input));
  const id = randomUUID();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await inTransaction(db, async (client) => {
        const { rows } = await client.query<ServerRow>(
          `INSERT INTO app.mcp_servers (id, slug, title, transport, url, program, auth, fields, header_templates, env_templates,
             secret_ciphertext, secret_iv, secret_key_version, snapshot, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, '[]'::jsonb, 'draft', $14)
           RETURNING *`,
          [
            id,
            newSlug(),
            input.title,
            input.transport,
            input.url,
            input.program ? JSON.stringify(input.program) : null,
            input.auth,
            JSON.stringify(input.fields),
            JSON.stringify(input.headers),
            JSON.stringify(input.env),
            sealed?.ciphertext ?? null,
            sealed?.iv ?? null,
            sealed?.keyVersion ?? null,
            createdBy,
          ],
        );
        await setAgents(client, id, agents);
        return viewOf(client, box, rows[0]!);
      });
    } catch (error) {
      // Six hex digits give 16 million slugs: a clash is rare, a new one settles it.
      const clash = (error as { code?: string; constraint?: string }).code === UNIQUE_VIOLATION && (error as { constraint?: string }).constraint === 'mcp_servers_slug_key';
      if (!clash || attempt >= SLUG_ATTEMPTS) throw error;
    }
  }
}

export async function loadServerSecrets(db: Db, box: SecretBox, id: string): Promise<ServerSecrets> {
  return openSecrets(box, await loadRow(db, id, false));
}

export async function getServer(db: Db, box: SecretBox, id: string): Promise<McpServerView> {
  return viewOf(db, box, await loadRow(db, id, false));
}

export async function listServers(db: Db, box: SecretBox): Promise<McpServerView[]> {
  const { rows } = await db.query<ServerRow>('SELECT * FROM app.mcp_servers ORDER BY created_at, id');
  return Promise.all(rows.map((row) => viewOf(db, box, row)));
}

// The address and the headers with the values of fields: in the address encoded, once (section 10).
export function accessOf(row: Pick<ServerRow, 'url' | 'header_templates' | 'fields'>, valueOf: (field: McpField) => string): ServerAccess {
  const value = (key: string) => {
    const field = row.fields.find((f) => f.key === key);
    if (!field) throw appError('APP_INTERNAL', `template names field ${key} the server does not have`);
    return valueOf(field);
  };
  return {
    url: new URL(fillTemplate(row.url!, (key) => encodeURIComponent(value(key)))),
    headers: Object.fromEntries(Object.entries(row.header_templates).map(([name, template]) => [name, fillTemplate(template, value)])),
  };
}

// «Проверить своим доступом» and «Обновить список действий»: the actions with the admin's access become the
// snapshot; the admin's marks stay on the actions still there.
export async function checkServer(db: Db, box: SecretBox, id: string, input: McpCheckInput): Promise<McpServerView> {
  const row = await loadRow(db, id, false);
  if (row.transport === 'program') throw invalid('program servers are checked through mcp-runner (step 9)', 'Проверка программ-серверов ещё не готова.');
  if (row.auth === 'oauth') throw invalid('oauth servers are checked after the admin signs in (step 4)', 'Проверка входа через сайт системы ещё не готова.');
  const shared = row.auth === 'shared_key' ? openSecrets(box, row).shared : null;
  const access = accessOf(row, (field) => {
    const value = row.auth === 'shared_key' ? shared?.[field.key] : input.values[field.key];
    if (!value) throw invalid(`check without ${field.key}`, `Введите «${field.label}», чтобы проверить сервер.`);
    return value;
  });
  await assertPlainHttpAllowed(access.url);
  const definitions = await readDefinitions(row, access);
  return inTransaction(db, async (client) => {
    const current = await loadRow(client, id, true);
    const snapshot = mergeSnapshot(current.slug, current.snapshot, definitions, current.snapshot_at === null);
    const { rows } = await client.query<ServerRow>('UPDATE app.mcp_servers SET snapshot = $2, snapshot_at = now(), updated_at = now() WHERE id = $1 RETURNING *', [id, JSON.stringify(snapshot)]);
    return viewOf(client, box, rows[0]!);
  });
}

// A new definition of a draft: the secrets not sent again stay (the browser never gets them back).
function redefine(input: McpServerInput, row: ServerRow, stored: ServerSecrets): McpServerInput {
  const sharedValues = input.auth === 'shared_key' && input.sharedValues === null && row.auth === 'shared_key' ? stored.shared : input.sharedValues;
  const keepSecret = input.client && !input.client.clientSecret && stored.client?.clientSecret && stored.client.clientId === input.client.clientId;
  const client = keepSecret ? { clientId: input.client!.clientId, clientSecret: stored.client!.clientSecret } : input.client;
  return validateServerInput({ ...input, sharedValues, client });
}

function checkEnable(row: ServerRow, agents: readonly string[]): void {
  if (row.status === 'shared_auth_error') throw invalid('enable with a refused shared key', 'Сначала обновите общий ключ: система его не принимает.');
  if (row.snapshot_at === null) throw invalid('enable before a check', 'Сначала проверьте сервер своим доступом — так появится список действий.');
  if (!row.snapshot.some((action) => action.enabled)) throw invalid('enable without actions', 'Включите хотя бы одно действие — иначе агентам нечем пользоваться.');
  if (agents.length === 0) throw invalid('enable without agents', 'Выберите хотя бы одного агента, которому доступен сервер.');
}

// «Изменить» (scenario 5). Everything in one transaction over the locked row: two admins do not undo each other.
export async function updateServer(db: Db, box: SecretBox, id: string, patch: McpServerPatch, knownAgents: ReadonlySet<string>): Promise<McpServerView> {
  // The address is looked up before the row is locked: a name lookup may take seconds.
  if (patch.definition) await checkPlainHttp(patch.definition);
  return inTransaction(db, async (client) => {
    let row = await loadRow(client, id, true);
    let secrets = openSecrets(box, row);

    if (patch.definition) {
      if (row.status !== 'draft') {
        throw invalid('definition of a server in use', 'Адрес, способ входа и поля меняются, пока сервер — черновик. Чтобы сменить их у включённого сервера, удалите его и добавьте заново.');
      }
      const input = redefine(patch.definition, row, secrets);
      secrets = secretsOf(input);
      const { rows } = await client.query<ServerRow>(
        `UPDATE app.mcp_servers SET title = $2, transport = $3, url = $4, program = $5, auth = $6, fields = $7, header_templates = $8, env_templates = $9,
           snapshot = '[]'::jsonb, snapshot_at = NULL
         WHERE id = $1 RETURNING *`,
        [id, input.title, input.transport, input.url, input.program ? JSON.stringify(input.program) : null, input.auth, JSON.stringify(input.fields), JSON.stringify(input.headers), JSON.stringify(input.env)],
      );
      row = rows[0]!;
      // A sign-in the admin made for the check belongs to the old address.
      await client.query('DELETE FROM app.connector_credentials WHERE connector_id = $1', [mcpConnectorId(id)]);
    }

    if (patch.title !== undefined) row = { ...row, title: patch.title };
    if (patch.fields) {
      const before = row.fields.map((f) => f.key).sort();
      const after = patch.fields.map((f) => f.key).sort();
      if (before.join('\n') !== after.join('\n')) throw invalid('field keys changed', 'Ключи полей не меняются — меняются подписи и подсказки. Чтобы сменить поля, удалите сервер и добавьте заново.');
      row = { ...row, fields: patch.fields };
    }
    if (patch.sharedValues) {
      if (row.auth !== 'shared_key') throw invalid('shared values for another auth', 'Общий ключ бывает только у «Общего ключа организации».');
      secrets = { ...secrets, shared: requireSharedValues(row.fields, patch.sharedValues) };
      // A new key is the way back from «Общий ключ не принят» (section 17).
      if (row.status === 'shared_auth_error') row = { ...row, status: 'enabled', status_error_code: null };
    }
    if (patch.actions) row = { ...row, snapshot: applyActionMarks(row.snapshot, patch.actions) };
    if (patch.agents) {
      checkAgents(patch.agents, knownAgents);
      await setAgents(client, id, patch.agents);
    }
    if (patch.status === 'enabled' && row.status !== 'enabled') {
      checkEnable(row, await agentsOf(client, id));
      row = { ...row, status: 'enabled', status_error_code: null };
    }
    if (patch.status === 'disabled') {
      if (row.status === 'draft') throw invalid('disable a draft', 'Черновик и так не виден сотрудникам.');
      row = { ...row, status: 'disabled' };
    }

    const sealed = sealSecrets(box, secrets);
    const { rows } = await client.query<ServerRow>(
      `UPDATE app.mcp_servers SET title = $2, fields = $3, snapshot = $4, status = $5, status_error_code = $6,
         secret_ciphertext = $7, secret_iv = $8, secret_key_version = $9, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, row.title, JSON.stringify(row.fields), JSON.stringify(row.snapshot), row.status, row.status_error_code, sealed?.ciphertext ?? null, sealed?.iv ?? null, sealed?.keyVersion ?? null],
    );
    return viewOf(client, box, rows[0]!);
  });
}

// «Удалить» (scenario 5): the sign-ins and keys of employees go with the server.
export async function deleteServer(db: Db, id: string): Promise<{ title: string }> {
  return inTransaction(db, async (client) => {
    const row = await loadRow(client, id, true);
    await client.query('DELETE FROM app.connector_credentials WHERE connector_id = $1', [mcpConnectorId(id)]);
    await client.query('DELETE FROM app.oauth_states WHERE connector_id = $1', [mcpConnectorId(id)]);
    await client.query('DELETE FROM app.mcp_servers WHERE id = $1', [id]);
    return { title: row.title };
  });
}
