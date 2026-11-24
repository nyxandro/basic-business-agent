// Files the person finds by name (spec, section 8.21): the documents of their own folder and of the projects
// they see, not archived. Read from the folders at every search, as «Файлы проекта» are: the agent writes into
// a folder directly, so a list kept elsewhere would lag behind it. Folders are walked without following links
// (held-folder.ts), one at a time with a pause between them, so the server answers others meanwhile (a walk
// of 10 000 files held it ~0.1 s; walking with promises took four times longer, 16.11); the names are compared
// in the database by the same rules as titles (match-sql.ts).
import { basename, extname } from 'node:path';
import { DOCUMENT_EXTENSIONS, type ProjectDto, type SearchFile, type SearchFiles } from '@bba/contracts';
import type pg from 'pg';
import { draftResourceId } from '../memory/memory.ts';
import type { ProjectsDeps } from '../projects/projects.ts';
import { logEvent } from '../log/log.ts';
import { setImmediate as pause } from 'node:timers/promises';
import { projectArea, userArea } from '../storage/areas.ts';
import { CHATS } from '../workspace/layout.ts';
import { marksOf } from './marks.ts';
import { matchNames } from './match-sql.ts';
import type { WordVariants } from './variants.ts';

export const MAX_FOUND_FILES = 50;
// Documents read from one folder; more are left out with search_files_capped in the log.
const MAX_FOLDER_DOCUMENTS = 5000;
const DOCUMENTS: ReadonlySet<string> = new Set(DOCUMENT_EXTENSIONS);

interface Listed extends SearchFile {
  modifiedMs: number;
}

export interface Collected {
  files: Listed[];
  unreadable: SearchFiles['unreadable'];
}

// The folder of a conversation outside projects in the person's area (spec, section 8.33).
const CHAT_FILE = new RegExp(`^${CHATS}/([^/]+)/`);

// The files of the person's own area, each with the conversation whose folder it lies in, by its title.
async function withConversations(deps: ProjectsDeps, userId: string, files: Listed[]): Promise<Listed[]> {
  const ids = [...new Set(files.map((f) => CHAT_FILE.exec(f.path)?.[1]).filter((id): id is string => id !== undefined))];
  if (ids.length === 0) return files;
  // A draft check of a prompt works in a folder of the person's area too (core/memory/memory.ts).
  const { rows } = await deps.db.query<{ id: string; title: string }>('SELECT id, title FROM mastra.mastra_threads WHERE "resourceId" = ANY($1::text[]) AND id = ANY($2::text[])', [[userId, draftResourceId(userId)], ids]);
  const titles = new Map(rows.map((r) => [r.id, r.title]));
  return files.map((f) => {
    const id = CHAT_FILE.exec(f.path)?.[1];
    return id ? { ...f, conversation: { id, title: titles.get(id) ?? null } } : f;
  });
}

// `projects` — what the person sees (listProjects): never an archived one, never someone's own folder. Reads the database
// (titles of conversations, the bucket's list): call it before a transaction of the search, never inside one — inside it
// would ask the pool for one more connection while the transaction holds one (review 24.11).
export async function collectFiles(deps: ProjectsDeps, userId: string, projects: ProjectDto[]): Promise<Collected> {
  const folders = [{ project: null, area: userArea(userId) }, ...projects.map((p) => ({ project: p, area: projectArea(p.id, p.owner.id) }))];
  const out: Collected = { files: [], unreadable: [] };
  for (const { project, area } of folders) {
    const found: Listed[] = [];
    let capped = false;
    try {
      await pause();
      // From the folder, or from the list of the bucket while the folder has no copy on the disk (8.23).
      await deps.storage.walkFiles(area, (file) => {
        if (!DOCUMENTS.has(extname(file.rel).toLowerCase())) return true;
        // The walk stops at the limit: a folder of tens of thousands of files is not read to its end.
        if (found.length >= MAX_FOLDER_DOCUMENTS) {
          capped = true;
          return false;
        }
        found.push({ path: file.rel, name: basename(file.rel), nameMarks: [], projectId: project?.id ?? null, conversation: null, modifiedAt: new Date(file.modifiedMs).toISOString(), bytes: file.bytes, modifiedMs: file.modifiedMs });
        return true;
      });
    } catch (error) {
      // A folder the agent shut (chmod) or a failing disk: its files are left out and the person is told;
      // the rest is found. The name of the error only: its text may hold a piece of a path.
      logEvent('error', 'search_files_folder_failed', { code: 'APP_SEARCH_FILES_UNREADABLE', userId, projectId: project?.id ?? null, error: (error as NodeJS.ErrnoException).code ?? (error as Error).name });
      out.unreadable.push({ projectId: project?.id ?? null, name: project?.name ?? null });
      continue;
    }
    if (capped) logEvent('warn', 'search_files_capped', { userId, projectId: project?.id ?? null, limit: MAX_FOLDER_DOCUMENTS });
    out.files.push(...(project ? found : await withConversations(deps, userId, found)));
  }
  return out;
}

const listed = ({ modifiedMs: _, ...file }: Listed): SearchFile => file;
const shown = (files: Listed[]): SearchFile[] => files.slice(0, MAX_FOUND_FILES).map(listed);

// Found directly first, then with a typo; newest first in each part; what of each name was found is marked.
// The files gathered by collectFiles that match the words, on the search's own connection.
export async function searchFiles(client: pg.PoolClient, { files, unreadable }: Collected, words: WordVariants[]): Promise<SearchFiles> {
  const hits = await matchNames(client, files.map((f) => f.name), words, MAX_FOUND_FILES + 1);
  const ordered = hits.map((hit) => ({ file: files[hit.index]!, direct: hit.direct })).sort((a, b) => Number(b.direct) - Number(a.direct) || b.file.modifiedMs - a.file.modifiedMs);
  // Marks only for the files shown: with a typo thousands of names may match.
  const found = ordered.slice(0, MAX_FOUND_FILES).map((o) => ({ ...listed(o.file), nameMarks: marksOf(o.file.name, words, o.direct ? 'direct' : 'name-typo') }));
  return { files: found, unreadable, more: ordered.length > MAX_FOUND_FILES };
}

// The tab «Файлы» before a query: the newest documents.
export async function recentFiles(deps: ProjectsDeps, userId: string, projects: ProjectDto[]): Promise<SearchFiles> {
  const { files, unreadable } = await collectFiles(deps, userId, projects);
  const ordered = [...files].sort((a, b) => b.modifiedMs - a.modifiedMs);
  return { files: shown(ordered), unreadable, more: ordered.length > MAX_FOUND_FILES };
}
