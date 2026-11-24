// Samples of good documents (docs/specs/[20.11.2026]-feedback-and-value.md, scenario 3; owner 21.11, F4; owner 24.11, F6): a
// document the agent made in the person's conversation, marked with the heart, goes into the knowledge base at once as a
// document of the kind «образец» — its kind guessed from its name, read into fragments like every document, its file kept —
// in the base of a department of the person (or of the organisation, for the one who keeps it), without a keeper's
// confirmation. Agents find samples first when they make a document of the same kind; the one who marked a sample takes
// it out with the heart, the keeper of the base removes any. All of it only while «Интерфейс» allows the heart.
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { exampleFileSchema, exampleSaveSchema, GENUI_TOOL, type ExampleBase, type ExampleMarksResponse, type ExampleSaveResponse } from '@bba/contracts';
import type { Hono } from 'hono';
import type { Memory } from '@mastra/memory';
import type { AccessContext } from '../auth/access.ts';
import { inThreadFolder, threadFoldersOf } from '../chat/thread-folder.ts';
import type { Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { conversationMessages } from '../history/store.ts';
import { access, parseJson, type AppEnv } from '../http/http.ts';
import { interfaceAdminState } from '../interface-settings/store.ts';
import { logEvent } from '../log/log.ts';
import type { FileStorage } from '../storage/engine.ts';
import { readFileInside } from '../workspace/layout.ts';
import type { KnowledgeIndexer } from './indexer.ts';
import { deleteDocument, KB_FILE_MAX_BYTES, uploadDocument, type Base } from './store.ts';

export interface ExampleDeps {
  db: Db;
  memory: Memory;
  storage: Pick<FileStorage, 'hold'>;
  workspaceRoot: string;
  indexer: Pick<KnowledgeIndexer, 'wake'>;
}

const ORG_NAME = 'Вся организация';

// The kind of a document by the words of its name: the heart gives a sample this kind (F6, no window to correct it).
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
async function basesFor(db: Db, who: AccessContext): Promise<ExampleBase[]> {
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
  // Read from the checked descriptor: the agent may swap the file for a link out of the folder or a pipe at any moment.
  const read = await inThreadFolder(deps.storage, found, 'read', (folder) => readFileInside(folder, path, KB_FILE_MAX_BYTES));
  if (read && !read.bytes) throw appError('APP_UPLOAD_TOO_LARGE', `${path} of ${read.size} bytes for a sample`, { userMessage: 'Файл больше 20 МБ — базой знаний он не читается.' });
  const bytes = read?.bytes;
  if (!bytes) throw appError('APP_NOT_FOUND', `${path} of ${threadId} is gone`, { userMessage: 'Файла уже нет в папке разговора — добавить его в референсы нельзя.' });
  return bytes;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// The heart is offered and works only while «Добавление документов в референсы» is on (F6); the samples in the bases
// stay whatever it is.
async function assertSamplesOn(db: Db): Promise<void> {
  if (!(await interfaceAdminState(db)).documentSamples) throw appError('APP_EXAMPLES_OFF', 'document samples are turned off in «Интерфейс»');
}

// The samples in a base now that the person made of the file at this place of the conversation. The heart is filled by
// the place, not by the bytes: opening a chat reads no files (with S3 that would bring the person's conversations down).
async function savedDocuments(db: Db, userId: string, threadId: string, path: string): Promise<string[]> {
  const { rows } = await db.query<{ document_id: string }>('SELECT document_id::text FROM app.example_marks WHERE user_id = $1 AND thread_id = $2 AND path = $3 AND document_id IS NOT NULL', [userId, threadId, path]);
  return rows.map((r) => r.document_id);
}

export async function exampleMarks(deps: ExampleDeps, who: AccessContext, threadId: string): Promise<ExampleMarksResponse> {
  await assertSamplesOn(deps.db);
  const { rows } = await deps.db.query<{ path: string }>('SELECT DISTINCT path FROM app.example_marks WHERE user_id = $1 AND thread_id = $2 AND document_id IS NOT NULL ORDER BY path', [who.userId, threadId]);
  return { bases: await basesFor(deps.db, who), saved: rows.map((r) => r.path) };
}

export async function saveExample(deps: ExampleDeps, who: AccessContext, input: { threadId: string; path: string; base: { scope: 'org' } | { scope: 'department'; departmentId: string } }): Promise<ExampleSaveResponse> {
  const { db } = deps;
  await assertSamplesOn(db);
  const name = await madeName(db, who.userId, input.threadId, input.path);
  const bases = await basesFor(db, who);
  if (bases.length === 0) throw appError('APP_EXAMPLE_NO_BASE', `${who.userId} has no department and keeps no base`);
  const allowed = bases.find((b) => b.scope === input.base.scope && (b.scope === 'org' || (input.base.scope === 'department' && b.departmentId === input.base.departmentId)));
  if (!allowed) throw appError('APP_ADMIN_FORBIDDEN', `${who.userId} may not put a sample into ${JSON.stringify(input.base)}`, { userMessage: 'В эту базу знаний вы документ добавить не можете — выберите базу своего отдела.' });
  if ((await savedDocuments(db, who.userId, input.threadId, input.path)).length > 0) throw appError('APP_EXAMPLE_SAVED', `${input.path} of ${input.threadId} is a sample already`);
  const bytes = await fileBytes(deps, who.userId, input.threadId, input.path);
  const sha = sha256(bytes);
  const base: Base = input.base.scope === 'org' ? { scope: 'org', departmentId: null } : { scope: 'department', departmentId: input.base.departmentId };
  const docType = guessDocType(name);
  let documentId: string;
  try {
    documentId = await uploadDocument(db, who.userId, base, 'example', name, new Uint8Array(bytes), docType);
  } catch (error) {
    // The same file is in that base already — as a sample or a document.
    if (isAppError(error) && error.code === 'APP_KNOWLEDGE_DUPLICATE') throw appError('APP_EXAMPLE_SAVED', `${input.path} is in the base already`, { cause: error });
    throw error;
  }
  // A mark the keeper's removal emptied is taken again; a live one is never overwritten: the other heart of this file (the
  // block's and the viewer's) may have put it into another base meanwhile — then this copy leaves the base at once, and
  // no sample stays there that no heart can take out.
  const marked = await db.query(
    `INSERT INTO app.example_marks (user_id, thread_id, path, sha256, document_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, thread_id, path, sha256) DO UPDATE SET document_id = EXCLUDED.document_id, created_at = now()
       WHERE app.example_marks.document_id IS NULL`,
    [who.userId, input.threadId, input.path, sha, documentId],
  );
  if (marked.rowCount !== 1) {
    await deleteDocument(db, who.userId, documentId);
    throw appError('APP_EXAMPLE_SAVED', `${input.path} of ${input.threadId} was marked by another press meanwhile`);
  }
  deps.indexer.wake();
  logEvent('info', 'example_saved', { documentId, scope: base.scope, docType });
  return { documentId };
}

// The filled heart pressed: the samples the person made of this place leave their bases (the audit has it as a removal
// of a document by the person), and the place is marked no more.
export async function removeExample(deps: ExampleDeps, who: AccessContext, input: { threadId: string; path: string }): Promise<void> {
  const { db } = deps;
  await assertSamplesOn(db);
  const documents = await savedDocuments(db, who.userId, input.threadId, input.path);
  if (documents.length === 0) throw appError('APP_EXAMPLE_NOT_SAVED', `${input.path} of ${input.threadId} is no sample of ${who.userId}`);
  for (const documentId of documents) await deleteDocument(db, who.userId, documentId);
  // The marks of the documents just removed are empty now (ON DELETE SET NULL); a mark a press made meanwhile stays.
  await db.query('DELETE FROM app.example_marks WHERE user_id = $1 AND thread_id = $2 AND path = $3 AND document_id IS NULL', [who.userId, input.threadId, input.path]);
  logEvent('info', 'example_removed', { documents: documents.length });
}

export function registerExampleRoutes(app: Hono<AppEnv>, deps: ExampleDeps): void {
  app.get('/app/api/me/examples', async (c) => {
    const threadId = c.req.query('threadId');
    if (!threadId) throw appError('APP_VALIDATION_FAILED', 'threadId is required');
    return c.json(await exampleMarks(deps, access(c), threadId));
  });
  app.post('/app/api/me/examples', async (c) => c.json(await saveExample(deps, access(c), await parseJson(c, exampleSaveSchema)), 201));
  app.delete('/app/api/me/examples', async (c) => {
    const parsed = exampleFileSchema.safeParse({ threadId: c.req.query('threadId'), path: c.req.query('path') });
    if (!parsed.success) throw appError('APP_VALIDATION_FAILED', `bad sample file: ${parsed.error.message}`);
    await removeExample(deps, access(c), parsed.data);
    return c.json({ ok: true });
  });
}
