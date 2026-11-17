// The addresses the file search needs besides /app/api/search (spec, section 8.21): the newest documents for
// the tab «Файлы», whether a found file is still there, and the download of a file of the person's own folder.
import type { SearchFiles, SearchFileStatus } from '@bba/contracts';
import type { Hono } from 'hono';
import { basename, relative } from 'node:path';
import { z } from 'zod';
import { appError } from '../errors/catalog.ts';
import { requireActive, visibleProject } from '../projects/access.ts';
import { listProjects, type ProjectsDeps } from '../projects/projects.ts';
import { trashedAt } from '../projects/trash.ts';
import { logEvent } from '../server/log.ts';
import { access, type AppEnv } from '../server/http.ts';
import { fileResponse } from '../workspace/download.ts';
import { areaOf, filesPrefix, userArea } from '../storage/areas.ts';
import { filesRoot, resolveInside } from '../workspace/layout.ts';
import { recentFiles } from './files.ts';
import { pdfResponse } from '../preview/response.ts';
import type { PreviewService } from '../preview/service.ts';

const statusQuery = z.object({ path: z.string().min(1), projectId: z.uuid().optional() });

export function registerFileSearchRoutes(app: Hono<AppEnv>, deps: ProjectsDeps & { preview: PreviewService }): void {
  app.get('/app/api/search/files', async (c) => {
    const userId = access(c).userId;
    try {
      return c.json<SearchFiles>(await recentFiles(deps, userId, (await listProjects(deps, userId)).projects));
    } catch (error) {
      logEvent('error', 'search_files_failed', { code: 'APP_SEARCH_FAILED', userId, error });
      throw appError('APP_SEARCH_FAILED', 'recent files failed', { cause: error });
    }
  });

  // As the file block of the chat: a file removed meanwhile is told, and found in the project's trash.
  app.get('/app/api/files/status', async (c) => {
    const parsed = statusQuery.safeParse(c.req.query());
    if (!parsed.success) throw appError('APP_VALIDATION_FAILED', `bad file status query: ${parsed.error.message}`);
    const { path, projectId } = parsed.data;
    const userId = access(c).userId;
    const project = projectId ? requireActive(await visibleProject(deps.db, userId, projectId)) : null;
    const folder = filesRoot(deps.workspaceRoot, project?.user_id ?? userId, project?.id ?? null);
    const name = basename(resolveInside(folder, path));
    const area = areaOf(userId, project);
    // From the copy, or from the list of the bucket: a check brings nothing to the disk (spec, 8.23).
    if (await deps.storage.exists(area, `${filesPrefix(area)}${relative(folder, resolveInside(folder, path))}`)) return c.json<SearchFileStatus>({ state: 'ok' });
    const trashed = project ? await trashedAt(deps.db, project.id, relative(folder, resolveInside(folder, path))) : null;
    if (project && trashed) return c.json<SearchFileStatus>({ state: 'trash', name, projectId: project.id, trashId: trashed.id, expiresAt: trashed.expiresAt.toISOString() });
    return c.json<SearchFileStatus>({ state: 'deleted', name });
  });

  // A file of the person's conversations outside projects: only their own folder.
  app.get('/app/api/files/file', async (c) => {
    const userId = access(c).userId;
    const folder = filesRoot(deps.workspaceRoot, userId, null);
    const rel = relative(folder, resolveInside(folder, c.req.query('path') ?? ''));
    return fileResponse(await deps.storage.openFile(userArea(userId), rel), 'Файл не найден.', basename(rel), c.req.query('inline') === '1');
  });

  // «Посмотреть» of the window of a found file: the PDF of a Word, Excel or PowerPoint file (spec, 8.27).
  app.get('/app/api/files/file/preview', async (c) => {
    const userId = access(c).userId;
    const folder = filesRoot(deps.workspaceRoot, userId, null);
    const rel = relative(folder, resolveInside(folder, c.req.query('path') ?? ''));
    return pdfResponse(await deps.preview.pdf(userArea(userId), rel, 'Файл не найден.'), basename(rel), c.req.header('range'));
  });
}
