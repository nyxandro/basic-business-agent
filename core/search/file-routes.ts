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
import { fileDownload } from '../workspace/download.ts';
import { filesRoot, isFileInside, resolveInside } from '../workspace/layout.ts';
import { recentFiles } from './files.ts';

const statusQuery = z.object({ path: z.string().min(1), projectId: z.uuid().optional() });

export function registerFileSearchRoutes(app: Hono<AppEnv>, deps: ProjectsDeps): void {
  app.get('/app/api/search/files', async (c) => {
    const userId = access(c).userId;
    try {
      return c.json<SearchFiles>(recentFiles(deps, userId, (await listProjects(deps, userId)).projects));
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
    if (isFileInside(folder, path)) return c.json<SearchFileStatus>({ state: 'ok' });
    const trashed = project ? await trashedAt(deps.db, project.id, relative(folder, resolveInside(folder, path))) : null;
    if (project && trashed) return c.json<SearchFileStatus>({ state: 'trash', name, projectId: project.id, trashId: trashed.id, expiresAt: trashed.expiresAt.toISOString() });
    return c.json<SearchFileStatus>({ state: 'deleted', name });
  });

  // A file of the person's conversations outside projects: only their own folder.
  app.get('/app/api/files/file', (c) => {
    const userId = access(c).userId;
    return fileDownload(filesRoot(deps.workspaceRoot, userId, null), c.req.query('path') ?? '', 'Файл не найден.', undefined, c.req.query('inline') === '1');
  });
}
