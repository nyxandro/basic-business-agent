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
import { assertKeeper, deleteDocument, documentBaseForKeeper, documentFile, listDocuments, readableDepartments, replaceDocument, retryDocument, updateDocument, uploadDocument, type Base } from './store.ts';
import { deleteGroup, listGroups, saveGroup } from './synonyms.ts';

const K = '/app/api/knowledge';

// The base a request names: `?department=<id>` — a department's, none — the organisation's.
function baseOf(c: Context<AppEnv>): Base {
  const department = c.req.query('department');
  return department ? { scope: 'department', departmentId: department } : { scope: 'org', departmentId: null };
}

export function registerKnowledgeRoutes(app: Hono<AppEnv>, deps: { db: Db; indexer: KnowledgeIndexer }): void {
  const { db } = deps;

  app.get(`${K}/bases`, async (c) => {
    const a = access(c);
    const org = a.isSuperadmin || a.permissions.has('documents.org.manage');
    const mine = a.isSuperadmin ? null : await readableDepartments(db, a.userId);
    const { rows } = await db.query<{ id: string; name: string }>('SELECT id::text, name FROM app.departments ORDER BY name');
    const departments = a.isSuperadmin || a.permissions.has('documents.department.manage') ? rows.filter((d) => mine === null || mine.includes(d.id)) : [];
    return c.json({ org, departments } satisfies KbBasesResponse);
  });

  app.get(`${K}/documents`, async (c) => {
    const base = baseOf(c);
    await assertKeeper(db, access(c), base);
    return c.json({ documents: await listDocuments(db, base) });
  });

  app.post(`${K}/documents`, async (c) => {
    const base = baseOf(c);
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

  // The file of a document: the current version, or `?version=N` for its keeper's history.
  app.get(`${K}/documents/:id/file`, async (c) => {
    const raw = c.req.query('version');
    const version = raw ? Number(raw) : null;
    if (version !== null && !Number.isInteger(version)) throw appError('APP_VALIDATION_FAILED', `bad version "${raw}"`);
    const file = await documentFile(db, access(c).userId, c.req.param('id'), version);
    return new Response(new Uint8Array(file.content), { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` } });
  });

  app.get(`${K}/synonyms`, async (c) => {
    const base = baseOf(c);
    await assertKeeper(db, access(c), base);
    return c.json({ groups: await listGroups(db, base.departmentId) });
  });

  app.post(`${K}/synonyms`, async (c) => {
    const base = baseOf(c);
    await assertKeeper(db, access(c), base);
    const { words } = await parseJson(c, kbSynonymGroupSchema);
    return c.json(await saveGroup(db, access(c).userId, base.departmentId, null, words), 201);
  });

  app.put(`${K}/synonyms/:id`, async (c) => {
    const base = baseOf(c);
    await assertKeeper(db, access(c), base);
    const { words } = await parseJson(c, kbSynonymGroupSchema);
    return c.json(await saveGroup(db, access(c).userId, base.departmentId, c.req.param('id'), words));
  });

  app.delete(`${K}/synonyms/:id`, async (c) => {
    const base = baseOf(c);
    await assertKeeper(db, access(c), base);
    await deleteGroup(db, base.departmentId, c.req.param('id'));
    return c.json({ ok: true });
  });
}
