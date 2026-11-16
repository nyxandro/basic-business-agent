// Files the person finds by name (spec, section 8.21): the documents of their own folder and of the projects
// they see, not archived. Read from the folders at every search, as «Файлы проекта» are: the agent writes into
// a folder directly, so a list kept elsewhere would lag behind it. Folders are walked without following links
// (held-folder.ts); the names are compared in the database by the same rules as titles (match-sql.ts).
import { basename, extname } from 'node:path';
import { DOCUMENT_EXTENSIONS, type ProjectDto, type SearchFile, type SearchFiles } from '@bba/contracts';
import type pg from 'pg';
import type { ProjectsDeps } from '../projects/projects.ts';
import { logEvent } from '../server/log.ts';
import { walkRegularFiles } from '../workspace/held-folder.ts';
import { filesRoot } from '../workspace/layout.ts';
import { matchNames } from './match-sql.ts';
import type { WordVariants } from './variants.ts';

export const MAX_FOUND_FILES = 50;
// Documents read from one folder; more are left out with search_files_capped in the log.
const MAX_FOLDER_DOCUMENTS = 5000;
const DOCUMENTS: ReadonlySet<string> = new Set(DOCUMENT_EXTENSIONS);

interface Listed extends SearchFile {
  modifiedMs: number;
}

interface Collected {
  files: Listed[];
  unreadable: SearchFiles['unreadable'];
}

// `projects` — what the person sees (listProjects): never an archived one, never someone's own folder.
function collect(deps: ProjectsDeps, userId: string, projects: ProjectDto[]): Collected {
  const folders = [{ project: null, root: filesRoot(deps.workspaceRoot, userId, null) }, ...projects.map((p) => ({ project: p, root: filesRoot(deps.workspaceRoot, p.owner.id, p.id) }))];
  const out: Collected = { files: [], unreadable: [] };
  for (const { project, root } of folders) {
    const found: Listed[] = [];
    let capped = false;
    try {
      walkRegularFiles(root, (file) => {
        if (!DOCUMENTS.has(extname(file.rel).toLowerCase())) return;
        if (found.length >= MAX_FOLDER_DOCUMENTS) {
          capped = true;
          return;
        }
        found.push({ path: file.rel, name: basename(file.rel), projectId: project?.id ?? null, modifiedAt: new Date(file.modifiedMs).toISOString(), bytes: file.size, modifiedMs: file.modifiedMs });
      });
    } catch (error) {
      // A folder the agent shut (chmod) or a failing disk: its files are left out and the person is told;
      // the rest is found. The name of the error only: its text may hold a piece of a path.
      logEvent('error', 'search_files_folder_failed', { code: 'APP_SEARCH_FILES_UNREADABLE', userId, projectId: project?.id ?? null, error: (error as NodeJS.ErrnoException).code ?? (error as Error).name });
      out.unreadable.push({ projectId: project?.id ?? null, name: project?.name ?? null });
      continue;
    }
    if (capped) logEvent('warn', 'search_files_capped', { userId, projectId: project?.id ?? null, limit: MAX_FOLDER_DOCUMENTS });
    out.files.push(...found);
  }
  return out;
}

const shown = (files: Listed[]): SearchFile[] => files.slice(0, MAX_FOUND_FILES).map(({ modifiedMs: _, ...file }) => file);

// Found directly first, then with a typo; newest first in each part.
export async function searchFiles(deps: ProjectsDeps, client: pg.PoolClient, userId: string, words: WordVariants[], projects: ProjectDto[]): Promise<SearchFiles> {
  const { files, unreadable } = collect(deps, userId, projects);
  const hits = await matchNames(client, files.map((f) => f.name), words, MAX_FOUND_FILES + 1);
  const ordered = hits.map((hit) => ({ file: files[hit.index]!, direct: hit.direct })).sort((a, b) => Number(b.direct) - Number(a.direct) || b.file.modifiedMs - a.file.modifiedMs);
  return { files: shown(ordered.map((o) => o.file)), unreadable, more: ordered.length > MAX_FOUND_FILES };
}

// The tab «Файлы» before a query: the newest documents.
export function recentFiles(deps: ProjectsDeps, userId: string, projects: ProjectDto[]): SearchFiles {
  const { files, unreadable } = collect(deps, userId, projects);
  const ordered = [...files].sort((a, b) => b.modifiedMs - a.modifiedMs);
  return { files: shown(ordered), unreadable, more: ordered.length > MAX_FOUND_FILES };
}
