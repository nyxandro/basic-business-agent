// Routes of the knowledge base (docs/specs/[20.11.2026]-knowledge-base.md, section 17): the bases a person keeps, the
// documents of a base, upload, «Заменить», the title and «Редакция от», «Удалить», «Повторить», the synonyms of a base;
// the file of a document for whoever reads its base (the viewer, «Скачать»).
import { kbDocumentPatchSchema, kbSynonymGroupSchema, type KbBasesResponse } from '@bba/contracts';
import type { Context, Hono } from 'hono';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { readUploadedFile } from '../projects/routes.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import type { KnowledgeIndexer } from './indexer.ts';
import { assertKeeper, deleteDocument, documentBaseForKeeper, documentFile, keepsDocument, listDocuments, readableDepartments, replaceDocument, retryDocument, updateDocument, uploadDocument, versionFile, type Base } from './store.ts';
import { deleteGroup, listGroups, saveGroup } from './synonyms.ts';

const K = '/app/api/knowledge';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_MAX = 1_000_000;
const departmentMissing = (id: string) => appError('APP_NOT_FOUND', `department ${id} not found`, { userMessage: 'Отдел не найден. Обновите страницу.' });

export function registerKnowledgeRoutes(app: Hono<AppEnv>, deps: { db: Db; indexer: KnowledgeIndexer }): void {
  const { db } = deps;

  // The base a request names: `?department=<id>` — a department's (one that exists), none — the organisation's.
  async function baseOf(c: Context<AppEnv>): Promise<Base> {
    const department = c.req.query('department');
    if (!department) return { scope: 'org', departmentId: null };
    if (!UUID.test(department) || !(await db.query('SELECT 1 FROM app.departments WHERE id = $1', [department])).rowCount) throw departmentMissing(department);
    return { scope: 'department', departmentId: department };
  }

  app.get(`${K}/bases`, async (c) => {
    const a = access(c);
    const org = a.isSuperadmin || a.permissions.has('documents.org.manage');
    const mine = a.isSuperadmin ? null : await readableDepartments(db, a.userId);
    const { rows } = await db.query<{ id: string; name: string }>('SELECT id::text, name FROM app.departments ORDER BY name');
    const departments = a.isSuperadmin || a.permissions.has('documents.department.manage') ? rows.filter((d) => mine === null || mine.includes(d.id)) : [];
    return c.json({ org, departments } satisfies KbBasesResponse);
  });

  app.get(`${K}/documents`, async (c) => {
    const base = await baseOf(c);
    await assertKeeper(db, access(c), base);
    return c.json({ documents: await listDocuments(db, base) });
  });

  app.post(`${K}/documents`, async (c) => {
    const base = await baseOf(c);
    await assertKeeper(db, access(c), base);
    const file = await readUploadedFile(c);
    const id = await uploadDocument(db, access(c).userId, base, 'document', file.name, new Uint8Array(await file.arrayBuffer()));
    deps.indexer.wake();
    return c.json({ id }, 201);
  });

  app.post(`${K}/documents/:id/versions`, async (c) => {
    await documentBaseForKeeper(db, access(c), c.req.param('id'));
    const file = await readUploadedFile(c);
    await replaceDocument(db, access(c).userId, c.req.param('id'), file.name, new Uint8Array(await file.arrayBuffer()));
    deps.indexer.wake();
    return c.json({ ok: true });
  });

  app.patch(`${K}/documents/:id`, async (c) => {
    await documentBaseForKeeper(db, access(c), c.req.param('id'));
    await updateDocument(db, access(c).userId, c.req.param('id'), await parseJson(c, kbDocumentPatchSchema));
    return c.json({ ok: true });
  });

  app.delete(`${K}/documents/:id`, async (c) => {
    await documentBaseForKeeper(db, access(c), c.req.param('id'));
    await deleteDocument(db, access(c).userId, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post(`${K}/documents/:id/retry`, async (c) => {
    await documentBaseForKeeper(db, access(c), c.req.param('id'));
    await retryDocument(db, c.req.param('id'));
    deps.indexer.wake();
    return c.json({ ok: true });
  });

  // The file of a document: the current version for whoever reads its base; any version (`?version=N`, the history) and
  // the current one too for whoever keeps the base — a superadmin keeps a department's base without being in it.
  app.get(`${K}/documents/:id/file`, async (c) => {
    const raw = c.req.query('version');
    const version = raw ? Number(raw) : null;
    if (version !== null && (!Number.isInteger(version) || version < 1 || version > VERSION_MAX)) throw appError('APP_VALIDATION_FAILED', `bad version "${raw}"`);
    const keeper = await keepsDocument(db, access(c), c.req.param('id'));
    if (!keeper && version !== null) throw appError('APP_NOT_FOUND', `version ${version} of ${c.req.param('id')} is for its keeper`, { userMessage: 'Документ не найден или недоступен.' });
    const file = keeper ? await versionFile(db, c.req.param('id'), version) : await documentFile(db, access(c).userId, c.req.param('id'), null);
    return new Response(new Uint8Array(file.content), {
      headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'x-content-type-options': 'nosniff' },
    });
  });

  app.get(`${K}/synonyms`, async (c) => {
    const base = await baseOf(c);
    await assertKeeper(db, access(c), base);
    return c.json({ groups: await listGroups(db, base.departmentId) });
  });

  app.post(`${K}/synonyms`, async (c) => {
    const base = await baseOf(c);
    await assertKeeper(db, access(c), base);
    const { words } = await parseJson(c, kbSynonymGroupSchema);
    return c.json(await saveGroup(db, access(c).userId, base.departmentId, null, words), 201);
  });

  app.put(`${K}/synonyms/:id`, async (c) => {
    const base = await baseOf(c);
    await assertKeeper(db, access(c), base);
    const { words } = await parseJson(c, kbSynonymGroupSchema);
    return c.json(await saveGroup(db, access(c).userId, base.departmentId, c.req.param('id'), words));
  });

  app.delete(`${K}/synonyms/:id`, async (c) => {
    const base = await baseOf(c);
    await assertKeeper(db, access(c), base);
    await deleteGroup(db, access(c).userId, base.departmentId, c.req.param('id'));
    return c.json({ ok: true });
  });
}
