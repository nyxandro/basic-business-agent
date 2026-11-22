// Samples of good documents (docs/specs/[20.11.2026]-feedback-and-value.md, scenario 3; owner 21.11, F4): a document the
// agent made in the person's conversation, marked «Хороший образец», goes into the knowledge base at once as a document
// of the kind «образец» — read into fragments like every document, its file kept — in the base of a department of the
// person (or of the organisation, for the one who keeps it), without a keeper's confirmation. Agents find samples first
// when they make a document of the same kind; the keeper of the base removes a bad one.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { exampleSaveSchema, GENUI_TOOL, type ExampleSaveResponse, type ExampleStateResponse } from '@bba/contracts';
import type { Hono } from 'hono';
import type { Memory } from '@mastra/memory';
import type { AccessContext } from '../auth/access.ts';
import { inThreadFolder, threadFoldersOf } from '../chat/thread-folder.ts';
import type { Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { conversationMessages } from '../history/store.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { logEvent } from '../server/log.ts';
import type { FileStorage } from '../storage/engine.ts';
import { existingInside } from '../workspace/layout.ts';
import type { KnowledgeIndexer } from './indexer.ts';
import { uploadDocument, type Base } from './store.ts';

export interface ExampleDeps {
  db: Db;
  memory: Memory;
  storage: Pick<FileStorage, 'hold'>;
  workspaceRoot: string;
  indexer: Pick<KnowledgeIndexer, 'wake'>;
}

const ORG_NAME = 'Вся организация';

// The kind of a document by the words of its name: what the person confirms or corrects.
const KINDS: [RegExp, string][] = [
  [/(^|[^а-яё])кп([^а-яё]|$)|коммерческ/i, 'Коммерческое предложение'],
  [/договор|контракт/i, 'Договор'],
  [/(^|[^а-яё])сч[её]т/i, 'Счёт'],
  [/письм/i, 'Письмо'],
  [/(^|[^а-яё])акт([^а-яё]|$)/i, 'Акт'],
  [/протокол/i, 'Протокол'],
  [/смет/i, 'Смета'],
  [/прайс/i, 'Прайс-лист'],
  [/отч[её]т/i, 'Отчёт'],
  [/презентац/i, 'Презентация'],
];
const BY_EXTENSION: Record<string, string> = { '.xlsx': 'Таблица', '.xls': 'Таблица', '.ods': 'Таблица', '.pptx': 'Презентация', '.ppt': 'Презентация', '.odp': 'Презентация' };

export function guessDocType(name: string): string {
  return KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? BY_EXTENSION[extname(name).toLowerCase()] ?? 'Документ';
}

// The bases a sample may go to: each department of the person, and the organisation's for the one who keeps it.
async function basesFor(db: Db, who: AccessContext): Promise<ExampleStateResponse['bases']> {
  const { rows } = await db.query<{ id: string; name: string }>(
    'SELECT d.id::text, d.name FROM app.department_members m JOIN app.departments d ON d.id = m.department_id WHERE m.user_id = $1 ORDER BY d.name',
    [who.userId],
  );
  const org = who.isSuperadmin || who.permissions.has('documents.org.manage');
  return [...rows.map((d) => ({ scope: 'department' as const, departmentId: d.id, name: d.name })), ...(org ? [{ scope: 'org' as const, name: ORG_NAME }] : [])];
}

// The file is one the agent showed in this conversation of the person as made in its answer: an attachment of the person
// is never a sample.
async function madeName(db: Db, userId: string, threadId: string, path: string): Promise<string> {
  const { messages } = await conversationMessages(db, userId, threadId);
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.content.startsWith('{')) continue;
    const parts = (JSON.parse(m.content) as { parts?: { type?: string; toolInvocation?: { toolName?: string; result?: { shown?: boolean; path?: string; name?: string; made?: boolean } } }[] }).parts ?? [];
    for (const p of parts) {
      const r = p.type === 'tool-invocation' && p.toolInvocation?.toolName === GENUI_TOOL.file ? p.toolInvocation.result : undefined;
      if (r?.shown && r.path === path && r.made === true && r.name) return r.name;
    }
  }
  throw appError('APP_EXAMPLE_NOT_MADE', `${path} of ${threadId} was not made by the agent`);
}

async function fileBytes(deps: ExampleDeps, userId: string, threadId: string, path: string): Promise<Buffer> {
  const found = await threadFoldersOf(deps, userId, threadId);
  const bytes = await inThreadFolder(deps.storage, found, 'read', (folder) => {
    const real = existingInside(folder, path);
    return real && statSync(real).isFile() ? readFileSync(real) : null;
  });
  if (!bytes) throw appError('APP_NOT_FOUND', `${path} of ${threadId} is gone`, { userMessage: 'Файла уже нет в папке разговора — сохранить его образцом нельзя.' });
  return bytes;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function exampleState(deps: ExampleDeps, who: AccessContext, threadId: string, path: string): Promise<ExampleStateResponse> {
  const name = await madeName(deps.db, who.userId, threadId, path);
  const bytes = await fileBytes(deps, who.userId, threadId, path);
  const { rows } = await deps.db.query<{ document_id: string | null }>('SELECT document_id FROM app.example_marks WHERE user_id = $1 AND thread_id = $2 AND path = $3 AND sha256 = $4', [who.userId, threadId, path, sha256(bytes)]);
  const state = !rows[0] ? 'none' : rows[0].document_id ? 'saved' : 'removed';
  return { state, bases: await basesFor(deps.db, who), docType: guessDocType(name) };
}

export async function saveExample(deps: ExampleDeps, who: AccessContext, input: { threadId: string; path: string; docType: string; base: { scope: 'org' } | { scope: 'department'; departmentId: string } }): Promise<ExampleSaveResponse> {
  const { db } = deps;
  const name = await madeName(db, who.userId, input.threadId, input.path);
  const bases = await basesFor(db, who);
  if (bases.length === 0) throw appError('APP_EXAMPLE_NO_BASE', `${who.userId} has no department and keeps no base`);
  const allowed = bases.find((b) => b.scope === input.base.scope && (b.scope === 'org' || (input.base.scope === 'department' && b.departmentId === input.base.departmentId)));
  if (!allowed) throw appError('APP_ADMIN_FORBIDDEN', `${who.userId} may not put a sample into ${JSON.stringify(input.base)}`, { userMessage: 'В эту базу знаний вы образец сохранить не можете — выберите базу своего отдела.' });
  const bytes = await fileBytes(deps, who.userId, input.threadId, input.path);
  const sha = sha256(bytes);
  const base: Base = input.base.scope === 'org' ? { scope: 'org', departmentId: null } : { scope: 'department', departmentId: input.base.departmentId };
  let documentId: string;
  try {
    documentId = await uploadDocument(db, who.userId, base, 'example', name, new Uint8Array(bytes), input.docType);
  } catch (error) {
    // The same file is in that base already — as a sample or a document.
    if (isAppError(error) && error.code === 'APP_KNOWLEDGE_DUPLICATE') throw appError('APP_EXAMPLE_SAVED', `${input.path} is in the base already`, { cause: error });
    throw error;
  }
  await db.query(
    `INSERT INTO app.example_marks (user_id, thread_id, path, sha256, document_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, thread_id, path, sha256) DO UPDATE SET document_id = EXCLUDED.document_id, created_at = now()`,
    [who.userId, input.threadId, input.path, sha, documentId],
  );
  deps.indexer.wake();
  logEvent('info', 'example_saved', { documentId, scope: base.scope, docType: input.docType });
  return { documentId };
}

export function registerExampleRoutes(app: Hono<AppEnv>, deps: ExampleDeps): void {
  app.get('/app/api/me/examples', async (c) => {
    const threadId = c.req.query('threadId');
    const path = c.req.query('path');
    if (!threadId || !path) throw appError('APP_VALIDATION_FAILED', 'threadId and path are required');
    return c.json(await exampleState(deps, access(c), threadId, path));
  });
  app.post('/app/api/me/examples', async (c) => c.json(await saveExample(deps, access(c), await parseJson(c, exampleSaveSchema)), 201));
}
