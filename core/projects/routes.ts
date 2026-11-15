// Projects, their files and the list of conversations (spec, sections 8.12 and 17.5). Everything
// here is the signed-in person's own: someone else's project or conversation is "not found".
import { MAX_UPLOAD_BYTES } from '@bba/contracts';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../errors/app-error.ts';
import { appError, ERROR_CATALOG } from '../errors/catalog.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { fileDownload } from '../workspace/download.ts';
import { contextRoot, listFiles, removeFileInside, saveFile } from '../workspace/layout.ts';
import { createProject, deleteProject, getProject, listProjects, listThreadPage, orderProjects, projectDto, projectOfThread, setThreadProject, THREAD_PAGE_MAX, updateProject, type ProjectsDeps } from './projects.ts';

// A multipart body carries the file plus its headers; requests above this are refused unread.
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const createSchema = z.object({ name: z.string() });
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

export function registerProjectRoutes(app: Hono<AppEnv>, deps: ProjectsDeps): void {
  app.get('/app/api/projects', async (c) => c.json({ projects: await listProjects(deps, access(c).userId) }));

  app.post('/app/api/projects', async (c) => {
    const body = await parseJson(c, createSchema);
    return c.json(await createProject(deps, access(c).userId, body.name), 201);
  });

  // Before the routes of one project: those would take «order» for a project's id.
  app.put('/app/api/projects/order', async (c) => {
    const body = await parseJson(c, orderSchema);
    await orderProjects(deps, access(c).userId, body.ids);
    return c.json({ ok: true });
  });

  app.get('/app/api/projects/:id', async (c) => c.json(await projectDto(deps, access(c).userId, c.req.param('id'))));

  app.put('/app/api/projects/:id', async (c) => {
    const body = await parseJson(c, updateSchema);
    return c.json(await updateProject(deps, access(c).userId, c.req.param('id'), body));
  });

  app.delete('/app/api/projects/:id', async (c) => {
    await deleteProject(deps, access(c).userId, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/app/api/projects/:id/files', async (c) => {
    const userId = access(c).userId;
    const project = await getProject(deps, userId, c.req.param('id'));
    return c.json({ files: listFiles(contextRoot(deps.workspaceRoot, userId, project.id)) });
  });

  app.post('/app/api/projects/:id/files', async (c) => {
    const userId = access(c).userId;
    const project = await getProject(deps, userId, c.req.param('id'));
    const file = await readUploadedFile(c);
    return c.json(saveFile(contextRoot(deps.workspaceRoot, userId, project.id), file.name, new Uint8Array(await file.arrayBuffer())), 201);
  });

  app.get('/app/api/projects/:id/file', async (c) => {
    const userId = access(c).userId;
    const project = await getProject(deps, userId, c.req.param('id'));
    return fileDownload(contextRoot(deps.workspaceRoot, userId, project.id), c.req.query('path') ?? '', 'Файл не найден.');
  });

  app.delete('/app/api/projects/:id/file', async (c) => {
    const userId = access(c).userId;
    const project = await getProject(deps, userId, c.req.param('id'));
    if (!removeFileInside(contextRoot(deps.workspaceRoot, userId, project.id), c.req.query('path') ?? '')) throw appError('APP_NOT_FOUND', 'no such project file', { userMessage: 'Файл не найден.' });
    return c.json({ ok: true });
  });

  // The project of a conversation, also of one that has no messages yet (chosen beforehand).
  app.get('/app/api/threads/:threadId/project', async (c) => c.json({ projectId: await projectOfThread(deps.db, access(c).userId, c.req.param('threadId')) }));

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
