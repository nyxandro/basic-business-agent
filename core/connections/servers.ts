// MCP servers the admin adds without a developer (docs/specs/[20.11.2026]-mcp-connections.md, sections 8
// and 17): what a server row may hold, how its secrets are sealed and what the admin panel sees of it.
// A server starts as a draft; employees see it only after the admin checked it and turned it on.
import { randomBytes, randomUUID } from 'node:crypto';
import type { McpAction, McpField, McpProgram, McpServerInput, McpServerStatus, McpServerView } from '@bba/contracts';
import { mcpServerInputSchema } from '@bba/contracts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { decryptFailed } from './credentials.ts';

// {{field}} in a template: the key of a field the admin described.
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;
// An exact version: npx «name@1.2.3» (scoped too), uvx «name==1.2.3». Ranges, tags and «latest» would
// let every start fetch other code (the owner's decision 21.11: programs only in the sandbox, pinned).
const NPX_EXACT = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const UVX_EXACT = /^[A-Za-z0-9][A-Za-z0-9._-]*==\d+(\.\d+){1,3}$/;
const SLUG_ATTEMPTS = 5;
const UNIQUE_VIOLATION = '23505';

export interface ServerSecrets {
  client: { clientId: string; clientSecret?: string } | null;
  shared: Record<string, string> | null;
}

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
  snapshot: McpAction[];
  snapshot_at: Date | null;
  status: McpServerStatus;
  status_error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

const invalid = (message: string, userMessage: string) => appError('APP_VALIDATION_FAILED', message, { userMessage });

function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

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

function checkAddress(url: string): void {
  // Placeholders stand for values of employees: the rest must already be an address.
  let parsed: URL;
  try {
    parsed = new URL(url.replace(PLACEHOLDER, 'x'));
  } catch (cause) {
    throw appError('APP_VALIDATION_FAILED', 'server url does not parse', { cause, userMessage: 'Адрес сервера записан неверно. Скопируйте его из инструкции системы целиком, начиная с https://.' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw invalid(`server url protocol ${parsed.protocol}`, 'Адрес сервера должен начинаться с https:// (или http:// для сервера во внутренней сети).');
  }
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
    checkAddress(input.url);
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

  if (input.auth === 'shared_key') {
    const values = input.sharedValues ?? {};
    for (const field of input.fields) {
      if (!values[field.key]) throw invalid(`shared value ${field.key} missing`, `Заполните «${field.label}» — без него общий ключ не заработает.`);
    }
  } else if (input.sharedValues) {
    throw invalid(`shared values with auth ${input.auth}`, 'Значения общего ключа нужны только для «Общего ключа организации».');
  }
  if (input.client && input.auth !== 'oauth') throw invalid(`client with auth ${input.auth}`, 'Client ID нужен только для входа через сайт системы.');
  return input;
}

function sealSecrets(box: SecretBox, input: McpServerInput): { ciphertext: Buffer; iv: Buffer; keyVersion: number } | null {
  const secrets: ServerSecrets = { client: input.client ?? null, shared: input.auth === 'shared_key' ? (input.sharedValues ?? null) : null };
  if (!secrets.client && !secrets.shared) return null;
  return box.seal(JSON.stringify(secrets));
}

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
    actions: row.snapshot,
    snapshotAt: row.snapshot_at?.toISOString() ?? null,
    agents,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const newSlug = () => `m${randomBytes(3).toString('hex')}`;

// Adds a server as a draft: nobody sees it until the admin checks it and turns it on.
export async function createServer(db: Db, box: SecretBox, raw: McpServerInput, createdBy: string): Promise<McpServerView> {
  const input = validateServerInput(raw);
  const sealed = sealSecrets(box, input);
  const id = randomUUID();
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { rows } = await db.query<ServerRow>(
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
      const row = rows[0]!;
      return toView(row, [], openSecrets(box, row));
    } catch (error) {
      // Six hex digits give 16 million slugs: a clash is rare, a new one settles it.
      const clash = (error as { code?: string; constraint?: string }).code === UNIQUE_VIOLATION && (error as { constraint?: string }).constraint === 'mcp_servers_slug_key';
      if (!clash || attempt >= SLUG_ATTEMPTS) throw error;
    }
  }
}

export async function loadServerSecrets(db: Db, box: SecretBox, id: string): Promise<ServerSecrets> {
  const { rows } = await db.query<ServerRow>('SELECT title, secret_ciphertext, secret_iv, secret_key_version FROM app.mcp_servers WHERE id = $1', [id]);
  if (!rows[0]) throw new AppError({ code: 'APP_NOT_FOUND', message: `mcp server ${id} not found`, userMessage: 'Такого подключения нет. Обновите страницу.', status: 404 });
  return openSecrets(box, rows[0]);
}
