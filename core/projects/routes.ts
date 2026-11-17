// Projects, their files and the list of conversations (spec, sections 8.12, 8.20 and 17.5). A project
// is reached only through the rule of ./access.ts: one the person does not see is "not found".
import { basename, relative } from 'node:path';
import { MAX_UPLOAD_BYTES, projectAccessInputSchema, projectCreateSchema, trashRestoreSchema, type ThreadProjectResponse } from '@bba/contracts';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../errors/app-error.ts';
import { appError, ERROR_CATALOG } from '../errors/catalog.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { fileResponse } from '../workspace/download.ts';
import { contextRoot, filesRoot, resolveInside, saveFile } from '../workspace/layout.ts';
import { projectArea } from '../storage/areas.ts';
import { requireActive, threadProjectState, visibleProject } from './access.ts';
import { registerDirectoryRoutes } from './directory.ts';
import { listTrash, restoreFromTrash, TRASH_FOLDER, trashFromPage, trashItem } from './trash.ts';
import { archiveProject, createProject, deleteProject, listArchive, listProjects, listThreadPage, markSeen, orderProjects, projectDto, setProjectAccess, setThreadProject, THREAD_PAGE_MAX, updateProject, type ProjectsDeps } from './projects.ts';
import { pdfResponse } from '../preview/response.ts';
import type { PreviewService } from '../preview/service.ts';

// A multipart body carries the file plus its headers; requests above this are refused unread.
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const updateSchema = z.object({ name: z.string().optional(), instructions: z.string().optional(), pinned: z.boolean().optional() });
const orderSchema = z.object({ ids: z.array(z.string()) });
const linkSchema = z.object({ projectId: z.string().nullable() });
const listSchema = z.object({
  projectId: z.string().optional(),
  agentId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(THREAD_PAGE_MAX).optional(),
  before: z.string().optional(),
});

export async function readUploadedFile(c: Context<AppEnv>): Promise<File> {
  if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES) {
    throw new AppError({ code: 'APP_UPLOAD_TOO_LARGE', message: 'request body over the upload limit', userMessage: ERROR_CATALOG.APP_UPLOAD_TOO_LARGE.userMessage, status: 413 });
  }
  const file = (await c.req.parseBody()).file;
  if (!(file instanceof File)) throw appError('APP_VALIDATION_FAILED', 'no file field', { userMessage: 'Файл не получен. Попробуйте прикрепить его ещё раз.' });
  return file;
}

export function registerProjectRoutes(app: Hono<AppEnv>, deps: ProjectsDeps & { preview: PreviewService }): void {
  // The files folder of a project: it lives with its creator, whoever works in it.
  const folderOf = (project: { id: string; user_id: string }) => contextRoot(deps.workspaceRoot, project.user_id, project.id);
  const areaOf = (project: { id: string; user_id: string }) => projectArea(project.id, project.user_id);
  // Where the files folder of a project would be — not made: for paths only.
  const filesOf = (project: { id: string; user_id: string }) => filesRoot(deps.workspaceRoot, project.user_id, project.id);
  // The project's folder is on the disk while `work` runs (an S3 bucket keeps the files, spec 8.23).
  async function inProject<T>(project: { id: string; user_id: string }, how: 'read' | 'write', work: () => T | Promise<T>): Promise<T> {
    const release = await deps.storage.hold(areaOf(project), how);
    try {
      return await work();
    } finally {
      await release();
    }
  }

  registerDirectoryRoutes(app, deps.db);

  app.get('/app/api/projects', async (c) => c.json(await listProjects(deps, access(c).userId)));

  app.post('/app/api/projects', async (c) => {
    const body = await parseJson(c, projectCreateSchema);
    return c.json(await createProject(deps, access(c).userId, body), 201);
  });

  // Before the routes of one project: those would take «order» for a project's id.
  app.put('/app/api/projects/order', async (c) => {
    const body = await parseJson(c, orderSchema);
    await orderProjects(deps, access(c).userId, body.ids);
    return c.json({ ok: true });
  });

  // Opening the page takes «новое» off.
  app.get('/app/api/projects/archive', async (c) => c.json({ projects: await listArchive(deps, access(c).userId) }));

  app.post('/app/api/projects/:id/archive', async (c) => {
    await archiveProject(deps, access(c).userId, c.req.param('id'), true);
    return c.json({ ok: true });
  });

  app.post('/app/api/projects/:id/unarchive', async (c) => {
    await archiveProject(deps, access(c).userId, c.req.param('id'), false);
    return c.json({ ok: true });
  });

  app.get('/app/api/projects/:id', async (c) => {
    const userId = access(c).userId;
    const project = await projectDto(deps, userId, c.req.param('id'));
    if (project.unseen) {
      await markSeen(deps.db, userId, project.id);
      return c.json({ ...project, unseen: false });
    }
    return c.json(project);
  });

  app.put('/app/api/projects/:id', async (c) => {
    const body = await parseJson(c, updateSchema);
    return c.json(await updateProject(deps, access(c).userId, c.req.param('id'), body));
  });

  app.put('/app/api/projects/:id/access', async (c) => {
    const body = await parseJson(c, projectAccessInputSchema);
    return c.json(await setProjectAccess(deps, access(c).userId, c.req.param('id'), body));
  });

  app.delete('/app/api/projects/:id', async (c) => {
    await deleteProject(deps, access(c).userId, c.req.param('id'));
    return c.json({ ok: true });
  });

  // Reading the files of an archived project is left to its creator; changing them — to nobody.
  app.get('/app/api/projects/:id/files', async (c) => {
    const { project } = await visibleProject(deps.db, access(c).userId, c.req.param('id'), 'owner');
    // From the list of the bucket while the project has no copy on the disk: opening the page brings nothing.
    return c.json({ files: await deps.storage.list(areaOf(project)) });
  });

  app.post('/app/api/projects/:id/files', async (c) => {
    const project = requireActive(await visibleProject(deps.db, access(c).userId, c.req.param('id'), 'owner'));
    const file = await readUploadedFile(c);
    const data = new Uint8Array(await file.arrayBuffer());
    return c.json(await inProject(project, 'write', () => saveFile(folderOf(project), file.name, data)), 201);
  });

  app.get('/app/api/projects/:id/file', async (c) => {
    const { project } = await visibleProject(deps.db, access(c).userId, c.req.param('id'), 'owner');
    const path = c.req.query('path') ?? '';
    // From the copy, or straight from the bucket: one file does not bring the whole project (spec, 8.23).
    const inArea = `files/${relative(filesOf(project), resolveInside(filesOf(project), path))}`;
    return fileResponse(await deps.storage.openFile(areaOf(project), inArea), 'Файл не найден.', basename(inArea), c.req.query('inline') === '1');
  });

  // The viewer of «Файлы проекта»: the PDF of a Word, Excel or PowerPoint file (spec, section 8.27).
  app.get('/app/api/projects/:id/file/preview', async (c) => {
    const { project } = await visibleProject(deps.db, access(c).userId, c.req.param('id'), 'owner');
    const inArea = `files/${relative(filesOf(project), resolveInside(filesOf(project), c.req.query('path') ?? ''))}`;
    return pdfResponse(await deps.preview.pdf(areaOf(project), inArea, 'Файл не найден.'), basename(inArea), c.req.header('range'));
  });

  // «Удалить» of the page: into the project's trash (spec, section 8.20).
  app.delete('/app/api/projects/:id/file', async (c) => {
    const userId = access(c).userId;
    const project = requireActive(await visibleProject(deps.db, userId, c.req.param('id'), 'owner'));
    const removed = await inProject(project, 'write', () => trashFromPage(deps.db, deps.workspaceRoot, project, c.req.query('path') ?? '', userId));
    if (!removed) throw appError('APP_NOT_FOUND', 'no such project file', { userMessage: 'Файл не найден.' });
    return c.json({ ok: true, trashId: removed.trashId });
  });

  // The trash is seen by everyone who sees the project; in the archive — by its creator, for reading.
  app.get('/app/api/projects/:id/trash', async (c) => {
    const { project } = await visibleProject(deps.db, access(c).userId, c.req.param('id'), 'owner');
    return c.json({ batches: await listTrash(deps.db, project.id) });
  });

  app.post('/app/api/projects/:id/trash/restore', async (c) => {
    const project = requireActive(await visibleProject(deps.db, access(c).userId, c.req.param('id'), 'owner'));
    const body = await parseJson(c, trashRestoreSchema);
    return c.json({ restored: await inProject(project, 'write', () => restoreFromTrash(deps.db, deps.workspaceRoot, project, body)) });
  });

  app.get('/app/api/projects/:id/trash/:trashId/file', async (c) => {
    const { project } = await visibleProject(deps.db, access(c).userId, c.req.param('id'), 'owner');
    const item = await trashItem(deps.db, project.id, c.req.param('trashId'));
    if (!item) throw appError('APP_NOT_FOUND', 'no such trash item', { userMessage: 'Этого файла в корзине уже нет.' });
    return fileResponse(await deps.storage.openFile(areaOf(project), `${TRASH_FOLDER}/${item.id}`), 'Этого файла в корзине уже нет.', basename(item.path));
  });

  // The project of a conversation, also of one that has no messages yet (chosen beforehand), or why
  // it is gone for the person.
  app.get('/app/api/threads/:threadId/project', async (c) => {
    const state = await threadProjectState(deps.db, access(c).userId, c.req.param('threadId'));
    const body: ThreadProjectResponse =
      state.state === 'active'
        ? { projectId: state.project.id, lost: null }
        : state.state === 'lost'
          ? { projectId: null, lost: { projectId: state.projectId, name: state.name, reason: state.reason, ownerName: state.ownerName, canUnarchive: state.canUnarchive } }
          : { projectId: null, lost: null };
    return c.json(body);
  });

  app.put('/app/api/threads/:threadId/project', async (c) => {
    const body = await parseJson(c, linkSchema);
    await setThreadProject(deps, access(c).userId, c.req.param('threadId'), body.projectId);
    return c.json({ ok: true });
  });

  app.get('/app/api/threads', async (c) => {
    const parsed = listSchema.safeParse(c.req.query());
    if (!parsed.success) throw appError('APP_VALIDATION_FAILED', `bad thread list query: ${parsed.error.message}`);
    return c.json(await listThreadPage(deps, access(c).userId, parsed.data));
  });
}
