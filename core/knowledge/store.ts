// Documents of the knowledge base (docs/specs/[20.11.2026]-knowledge-base.md, sections 5, 8, 9): who keeps which base,
// who reads it, the versions of a document. The organisation's base is kept with «Документы организации», a
// department's — with «Документы отдела» by members of that department; a person reads the organisation's base and
// the bases of their departments — in a shared project too, by the person's own access (owner 21.11, F3).
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { KbDocumentDto, KbScope } from '@bba/contracts';
import type pg from 'pg';
import type { AccessContext } from '../auth/access.ts';
import { writeAudit } from '../audit/audit.ts';
import { docFormatOf } from '../doctext/extract.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';

export const KB_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const KB_TITLE_MAX = 200;

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export interface Base {
  scope: KbScope;
  departmentId: string | null;
}

// The departments a person reads the bases of.
export async function readableDepartments(db: Queryable, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>('SELECT department_id::text AS id FROM app.department_members WHERE user_id = $1', [userId]);
  return rows.map((r) => r.id);
}

// May the person keep this base: the organisation's — «Документы организации»; a department's — «Документы отдела» and
// a member of it. A superadmin keeps every base.
export async function assertKeeper(db: Db, access: AccessContext, base: Base): Promise<void> {
  if (access.isSuperadmin) return;
  if (base.scope === 'org' && access.permissions.has('documents.org.manage')) return;
  if (base.scope === 'department' && base.departmentId && access.permissions.has('documents.department.manage') && (await readableDepartments(db, access.userId)).includes(base.departmentId)) return;
  throw appError('APP_ADMIN_FORBIDDEN', `no right to keep the knowledge base ${base.scope}:${base.departmentId ?? ''}`, { userMessage: 'Вести эту базу знаний может сотрудник с правом «Документы организации» или «Документы отдела» этого отдела.' });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function baseOf(db: Db, documentId: string): Promise<Base> {
  if (!UUID.test(documentId)) throw appError('APP_NOT_FOUND', `knowledge document ${documentId} not found`, { userMessage: 'Документ не найден. Обновите страницу.' });
  const { rows } = await db.query<{ scope: KbScope; department_id: string | null }>('SELECT scope, department_id::text FROM app.kb_documents WHERE id = $1', [documentId]);
  if (!rows[0]) throw appError('APP_NOT_FOUND', `knowledge document ${documentId} not found`, { userMessage: 'Документ не найден. Обновите страницу.' });
  return { scope: rows[0].scope, departmentId: rows[0].department_id };
}

export async function documentBaseForKeeper(db: Db, access: AccessContext, documentId: string): Promise<Base> {
  const base = await baseOf(db, documentId);
  await assertKeeper(db, access, base);
  return base;
}

function assertFile(name: string, bytes: Uint8Array): string {
  if (bytes.byteLength > KB_FILE_MAX_BYTES) throw appError('APP_UPLOAD_TOO_LARGE', `knowledge file of ${bytes.byteLength} bytes`, { userMessage: 'Файл больше 20 МБ. Разделите его на части.' });
  const ext = extname(name).toLowerCase();
  if (!docFormatOf(ext)) throw appError('APP_KNOWLEDGE_FORMAT', `knowledge file of type ${ext}`);
  return createHash('sha256').update(bytes).digest('hex');
}

const titleOf = (name: string) => [...name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim()].slice(0, KB_TITLE_MAX).join('') || name;

export async function uploadDocument(db: Db, actorUserId: string, base: Base, kind: 'document' | 'example', name: string, bytes: Uint8Array): Promise<string> {
  const sha = assertFile(name, bytes);
  const same = await db.query<{ title: string }>(
    `SELECT d.title FROM app.kb_documents d JOIN app.kb_versions v ON v.document_id = d.id AND v.version = coalesce(d.current_version, v.version)
      WHERE v.sha256 = $1 AND d.scope = $2 AND d.department_id IS NOT DISTINCT FROM $3::uuid LIMIT 1`,
    [sha, base.scope, base.departmentId],
  );
  if (same.rows[0]) throw appError('APP_KNOWLEDGE_DUPLICATE', `knowledge file already in the base as ${same.rows[0].title}`, { userMessage: `Этот файл уже есть в базе: «${same.rows[0].title}».` });
  const id = await inTransaction(db, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.kb_documents (scope, department_id, kind, title, uploaded_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [base.scope, base.departmentId, kind, titleOf(name), actorUserId],
    );
    const documentId = rows[0]!.id;
    await c.query(`INSERT INTO app.kb_versions (document_id, version, file_name, content, size, sha256, status) VALUES ($1, 1, $2, $3, $4, $5, 'pending')`, [documentId, name, Buffer.from(bytes), bytes.byteLength, sha]);
    await writeAudit(c, { actorUserId, action: 'knowledge.upload', target: documentId, details: { name, scope: base.scope, departmentId: base.departmentId, kind } });
    return documentId;
  });
  return id;
}

// A new version of a document: searched once read; until then — the version before (scenario 4).
export async function replaceDocument(db: Db, actorUserId: string, documentId: string, name: string, bytes: Uint8Array): Promise<void> {
  const sha = assertFile(name, bytes);
  await inTransaction(db, async (c) => {
    // The document is locked: two replacements at once get numbers one after another.
    await c.query('SELECT 1 FROM app.kb_documents WHERE id = $1 FOR UPDATE', [documentId]);
    const { rows } = await c.query<{ next: number }>('SELECT coalesce(max(version), 0) + 1 AS next FROM app.kb_versions WHERE document_id = $1', [documentId]);
    await c.query(`INSERT INTO app.kb_versions (document_id, version, file_name, content, size, sha256, status) VALUES ($1, $2, $3, $4, $5, $6, 'pending')`, [documentId, rows[0]!.next, name, Buffer.from(bytes), bytes.byteLength, sha]);
    await c.query('UPDATE app.kb_documents SET updated_at = now() WHERE id = $1', [documentId]);
    await writeAudit(c, { actorUserId, action: 'knowledge.replace', target: documentId, details: { name, version: rows[0]!.next } });
  });
}

export async function updateDocument(db: Db, actorUserId: string, documentId: string, change: { title?: string; editionDate?: string | null }): Promise<void> {
  const title = change.title === undefined ? null : [...change.title.trim()].slice(0, KB_TITLE_MAX).join('');
  if (title === '') throw appError('APP_VALIDATION_FAILED', 'an empty knowledge document title', { userMessage: 'Название документа не может быть пустым.' });
  await db.query(
    `UPDATE app.kb_documents SET title = coalesce($2, title), edition_date = CASE WHEN $3 THEN $4::date ELSE edition_date END, updated_at = now() WHERE id = $1`,
    [documentId, title, change.editionDate !== undefined, change.editionDate ?? null],
  );
  await writeAudit(db, { actorUserId, action: 'knowledge.update', target: documentId, details: { ...change } });
}

// The words of a version's fragments leave the dictionary of typos with them.
export async function forgetWords(c: Queryable, documentId: string, version: number): Promise<void> {
  const words = `SELECT w, count(DISTINCT c.id)::int AS n FROM app.kb_chunks c CROSS JOIN LATERAL regexp_split_to_table(c.norm_text, '[^[:alnum:]]+') AS w
                  WHERE c.document_id = $1 AND c.version = $2 AND length(w) >= 4 GROUP BY w`;
  await c.query(`WITH gone AS (${words}) DELETE FROM app.kb_words k USING gone g WHERE k.word = g.w AND k.count <= g.n`, [documentId, version]);
  await c.query(`WITH gone AS (${words}) UPDATE app.kb_words k SET count = k.count - g.n FROM gone g WHERE k.word = g.w`, [documentId, version]);
}

export async function rememberWords(c: Queryable, documentId: string, version: number): Promise<void> {
  await c.query(
    `INSERT INTO app.kb_words (word, count)
     SELECT w, count(DISTINCT c.id)::int FROM app.kb_chunks c CROSS JOIN LATERAL regexp_split_to_table(c.norm_text, '[^[:alnum:]]+') AS w
      WHERE c.document_id = $1 AND c.version = $2 AND length(w) >= 4 GROUP BY w
     ON CONFLICT (word) DO UPDATE SET count = app.kb_words.count + EXCLUDED.count`,
    [documentId, version],
  );
}

export async function deleteDocument(db: Db, actorUserId: string, documentId: string): Promise<void> {
  await inTransaction(db, async (c) => {
    const { rows } = await c.query<{ version: number }>('SELECT DISTINCT version FROM app.kb_chunks WHERE document_id = $1', [documentId]);
    for (const { version } of rows) await forgetWords(c, documentId, version);
    await c.query('DELETE FROM app.kb_documents WHERE id = $1', [documentId]);
    await writeAudit(c, { actorUserId, action: 'knowledge.delete', target: documentId });
  });
}

// «Повторить»: the latest version is read again.
export async function retryDocument(db: Db, documentId: string): Promise<void> {
  await db.query(`UPDATE app.kb_versions SET status = 'pending', error_code = NULL, warning = NULL WHERE document_id = $1 AND version = (SELECT max(version) FROM app.kb_versions WHERE document_id = $1) AND status = 'rejected'`, [documentId]);
}

export async function listDocuments(db: Db, base: Base): Promise<KbDocumentDto[]> {
  const { rows } = await db.query<{ id: string; title: string; kind: 'document' | 'example'; edition_date: string | null; current_version: number | null; updated_at: Date; latest: number; status: 'pending' | 'ready' | 'rejected'; warning: string | null; error_code: string | null; chunks: number | null; file_name: string; size: number }>(
    `SELECT d.id, d.title, d.kind, to_char(d.edition_date, 'YYYY-MM-DD') AS edition_date, d.current_version, d.updated_at,
            v.version AS latest, v.status, v.warning, v.error_code, cv.chunks, v.file_name, v.size
       FROM app.kb_documents d
       JOIN LATERAL (SELECT * FROM app.kb_versions WHERE document_id = d.id ORDER BY version DESC LIMIT 1) v ON true
       LEFT JOIN app.kb_versions cv ON cv.document_id = d.id AND cv.version = d.current_version
      WHERE d.scope = $1 AND d.department_id IS NOT DISTINCT FROM $2::uuid
      ORDER BY d.kind, d.title`,
    [base.scope, base.departmentId],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    editionDate: r.edition_date,
    currentVersion: r.current_version,
    latestVersion: r.latest,
    status: r.status,
    warning: r.warning,
    errorCode: r.error_code,
    chunks: r.chunks,
    fileName: r.file_name,
    size: r.size,
    updatedAt: r.updated_at.toISOString(),
  }));
}

// The file of a version for the person: a keeper of its base, or a reader of it (the viewer, «Скачать»).
export async function documentFile(db: Db, userId: string, documentId: string, version: number | null): Promise<{ name: string; content: Buffer }> {
  if (!UUID.test(documentId)) throw appError('APP_NOT_FOUND', `knowledge document ${documentId} not found`, { userMessage: 'Документ не найден или недоступен.' });
  const departments = await readableDepartments(db, userId);
  const { rows } = await db.query<{ file_name: string; content: Buffer }>(
    `SELECT v.file_name, v.content FROM app.kb_documents d JOIN app.kb_versions v ON v.document_id = d.id AND v.version = coalesce($2::int, d.current_version)
      WHERE d.id = $1 AND (d.scope = 'org' OR d.department_id::text = ANY($3))`,
    [documentId, version, departments],
  );
  if (!rows[0]) throw appError('APP_NOT_FOUND', `knowledge document ${documentId} not readable by ${userId}`, { userMessage: 'Документ не найден или недоступен.' });
  return { name: rows[0].file_name, content: rows[0].content };
}

// The titles of the documents a person reads, for the layer of the prompt.
export async function readableTitles(db: Db, userId: string, limit: number): Promise<{ titles: string[]; total: number }> {
  const departments = await readableDepartments(db, userId);
  const { rows } = await db.query<{ title: string; total: number }>(
    `SELECT title, count(*) OVER ()::int AS total FROM app.kb_documents WHERE current_version IS NOT NULL AND kind = 'document' AND (scope = 'org' OR department_id::text = ANY($1)) ORDER BY title LIMIT $2`,
    [departments, limit],
  );
  return { titles: rows.map((r) => r.title), total: rows[0]?.total ?? 0 };
}
