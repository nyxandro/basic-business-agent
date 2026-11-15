// Projects of conversations (spec, section 8.12): a person's own folders with instructions and
// files. Conversations are Mastra threads; their link to a project lives in app.thread_projects.
import { randomUUID } from 'node:crypto';
import type { ProjectDto, ThreadPage, ThreadSummaryDto } from '@bba/contracts';
import type { Memory } from '@mastra/memory';
import type { Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { listOwnThreads } from '../memory/memory.ts';
import { removeProjectFolder } from '../workspace/layout.ts';

export const NAME_MAX = 80;
export const INSTRUCTIONS_MAX = 8000;
export const THREAD_PAGE_DEFAULT = 30;
export const THREAD_PAGE_MAX = 100;
// A link to a conversation that never got its first message is removed after this time.
const ORPHAN_LINK_AGE = '1 day';
const UNIQUE_VIOLATION = '23505';

export interface ProjectsDeps {
  db: Db;
  memory: Memory;
  workspaceRoot: string;
}

interface ProjectRow {
  id: string;
  name: string;
  instructions: string;
  pinned: boolean;
  created_at: Date;
}

const COLUMNS = 'id, name, instructions, pinned, created_at';
// The side panel's order (spec, section 8.12): pinned first, each group by the place the person gave.
const PANEL_ORDER = 'pinned DESC, position, lower(name)';
// A new project and an unpinned one: first among the unpinned. A pinned one: after the pinned ones.
const FIRST_UNPINNED = '(SELECT COALESCE(min(position), 1) - 1 FROM app.projects WHERE user_id = $2 AND NOT pinned)';
const AFTER_ALL = '(SELECT max(position) + 1 FROM app.projects WHERE user_id = $2)';

const notFound = (id: string) => appError('APP_NOT_FOUND', `project ${id} is not the person's`, { userMessage: 'Проект не найден.' });

function cleanName(name: string): string {
  const clean = name.replace(/\s+/g, ' ').trim();
  if (clean.length < 1 || clean.length > NAME_MAX) throw appError('APP_VALIDATION_FAILED', `project name of ${clean.length} chars`, { userMessage: `Название проекта — от 1 до ${NAME_MAX} символов.` });
  return clean;
}

function checkInstructions(text: string): string {
  if (text.length > INSTRUCTIONS_MAX) throw appError('APP_VALIDATION_FAILED', `instructions of ${text.length} chars`, { userMessage: `Инструкции — не длиннее ${INSTRUCTIONS_MAX} символов.` });
  return text;
}

function nameTaken(error: unknown, name: string): AppError | null {
  if ((error as { code?: string }).code !== UNIQUE_VIOLATION) return null;
  return new AppError({ code: 'APP_PROJECT_EXISTS', message: `project name "${name}" is taken`, userMessage: `Проект «${name}» уже есть.`, status: 409, cause: error });
}

// Links of the person's existing conversations; links to conversations that never started are
// dropped once they are a day old.
async function liveLinks(deps: ProjectsDeps, userId: string, ownThreadIds: ReadonlySet<string>): Promise<Map<string, string>> {
  const { rows } = await deps.db.query<{ thread_id: string; project_id: string; stale: boolean }>(
    `SELECT thread_id, project_id, created_at < now() - interval '${ORPHAN_LINK_AGE}' AS stale FROM app.thread_projects WHERE user_id = $1`,
    [userId],
  );
  const live = new Map<string, string>();
  const stale: string[] = [];
  for (const r of rows) {
    if (ownThreadIds.has(r.thread_id)) live.set(r.thread_id, r.project_id);
    else if (r.stale) stale.push(r.thread_id);
  }
  if (stale.length > 0) await deps.db.query('DELETE FROM app.thread_projects WHERE user_id = $1 AND thread_id = ANY($2)', [userId, stale]);
  return live;
}

function toDto(row: ProjectRow, threadCount: number): ProjectDto {
  return { id: row.id, name: row.name, instructions: row.instructions, threadCount, pinned: row.pinned, createdAt: row.created_at.toISOString() };
}

export async function listProjects(deps: ProjectsDeps, userId: string): Promise<ProjectDto[]> {
  const threads = await listOwnThreads(deps.memory, userId);
  const links = await liveLinks(deps, userId, new Set(threads.map((t) => t.id)));
  const counts = new Map<string, number>();
  for (const projectId of links.values()) counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
  const { rows } = await deps.db.query<ProjectRow>(`SELECT ${COLUMNS} FROM app.projects WHERE user_id = $1 ORDER BY ${PANEL_ORDER}`, [userId]);
  return rows.map((r) => toDto(r, counts.get(r.id) ?? 0));
}

export async function getProject(deps: Pick<ProjectsDeps, 'db'>, userId: string, projectId: string): Promise<ProjectRow> {
  if (!/^[0-9a-f-]{36}$/.test(projectId)) throw notFound(projectId);
  const { rows } = await deps.db.query<ProjectRow>(`SELECT ${COLUMNS} FROM app.projects WHERE id = $1 AND user_id = $2`, [projectId, userId]);
  if (!rows[0]) throw notFound(projectId);
  return rows[0];
}

export async function projectDto(deps: ProjectsDeps, userId: string, projectId: string): Promise<ProjectDto> {
  const row = await getProject(deps, userId, projectId);
  const threads = await listOwnThreads(deps.memory, userId);
  const links = await liveLinks(deps, userId, new Set(threads.map((t) => t.id)));
  return toDto(row, [...links.values()].filter((id) => id === projectId).length);
}

export async function createProject(deps: ProjectsDeps, userId: string, name: string): Promise<ProjectDto> {
  const clean = cleanName(name);
  try {
    const { rows } = await deps.db.query<ProjectRow>(`INSERT INTO app.projects (id, user_id, name, position) VALUES ($1, $2, $3, ${FIRST_UNPINNED}) RETURNING ${COLUMNS}`, [randomUUID(), userId, clean]);
    return toDto(rows[0]!, 0);
  } catch (error) {
    throw nameTaken(error, clean) ?? error;
  }
}

export async function updateProject(deps: ProjectsDeps, userId: string, projectId: string, change: { name?: string; instructions?: string; pinned?: boolean }): Promise<ProjectDto> {
  await getProject(deps, userId, projectId);
  const name = change.name === undefined ? null : cleanName(change.name);
  const instructions = change.instructions === undefined ? null : checkInstructions(change.instructions);
  try {
    await deps.db.query(
      'UPDATE app.projects SET name = COALESCE($3, name), instructions = COALESCE($4, instructions), updated_at = now() WHERE id = $1 AND user_id = $2',
      [projectId, userId, name, instructions],
    );
  } catch (error) {
    throw nameTaken(error, name ?? '') ?? error;
  }
  // Pinning a pinned project (or unpinning an unpinned one) leaves it in its place.
  if (change.pinned === true) await deps.db.query(`UPDATE app.projects SET pinned = true, position = ${AFTER_ALL} WHERE id = $1 AND user_id = $2 AND NOT pinned`, [projectId, userId]);
  if (change.pinned === false) await deps.db.query(`UPDATE app.projects SET pinned = false, position = ${FIRST_UNPINNED} WHERE id = $1 AND user_id = $2 AND pinned`, [projectId, userId]);
  return projectDto(deps, userId, projectId);
}

// The order the person dragged the projects into, all of them: pinned or not stays as it is, so
// a project dragged among the others only changes its place in its own group.
export async function orderProjects(deps: Pick<ProjectsDeps, 'db'>, userId: string, ids: readonly string[]): Promise<void> {
  const { rows } = await deps.db.query<{ id: string }>('SELECT id FROM app.projects WHERE user_id = $1', [userId]);
  const own = new Set(rows.map((r) => r.id));
  if (new Set(ids).size !== ids.length || ids.length !== own.size || ids.some((id) => !own.has(id))) {
    throw appError('APP_VALIDATION_FAILED', `project order of ${ids.length} ids does not match the person's ${own.size} projects`, { userMessage: 'Список проектов изменился, порядок не сохранён. Перетащите проект ещё раз.' });
  }
  await deps.db.query('UPDATE app.projects p SET position = o.n FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, n) WHERE p.id = o.id AND p.user_id = $1', [userId, ids]);
}

// The project's conversations stay, without a project; its instructions and files go.
export async function deleteProject(deps: ProjectsDeps, userId: string, projectId: string): Promise<void> {
  await getProject(deps, userId, projectId);
  await deps.db.query('DELETE FROM app.projects WHERE id = $1 AND user_id = $2', [projectId, userId]);
  removeProjectFolder(deps.workspaceRoot, userId, projectId);
}

// Puts a conversation into a project (or out of it). The conversation may not exist yet: the person
// chose the project before the first message.
export async function setThreadProject(deps: ProjectsDeps, userId: string, threadId: string, projectId: string | null): Promise<void> {
  const thread = await deps.memory.getThreadById({ threadId });
  if (thread && thread.resourceId !== userId) throw appError('APP_NOT_FOUND', `thread ${threadId} belongs to another resource`, { userMessage: 'Разговор не найден.' });
  if (projectId === null) {
    await deps.db.query('DELETE FROM app.thread_projects WHERE thread_id = $1 AND user_id = $2', [threadId, userId]);
    return;
  }
  await getProject(deps, userId, projectId);
  await deps.db.query(
    `INSERT INTO app.thread_projects (thread_id, user_id, project_id) VALUES ($1, $2, $3)
     ON CONFLICT (thread_id) DO UPDATE SET project_id = EXCLUDED.project_id WHERE app.thread_projects.user_id = EXCLUDED.user_id`,
    [threadId, userId, projectId],
  );
}

// The project a run works in: its files are the sandbox root and its instructions a prompt layer.
export async function projectOfThread(db: Db, userId: string, threadId: string): Promise<string | null> {
  const { rows } = await db.query<{ project_id: string }>('SELECT project_id FROM app.thread_projects WHERE thread_id = $1 AND user_id = $2', [threadId, userId]);
  return rows[0]?.project_id ?? null;
}

function cursorOf(t: ThreadSummaryDto): string {
  return `${t.updatedAt}|${t.id}`;
}

// Conversations of all the person's agents, newest first; `before` continues after a cursor.
export async function listThreadPage(deps: ProjectsDeps, userId: string, query: { projectId?: string | null; agentId?: string; limit?: number; before?: string }): Promise<ThreadPage> {
  const limit = Math.min(Math.max(query.limit ?? THREAD_PAGE_DEFAULT, 1), THREAD_PAGE_MAX);
  if (query.projectId) await getProject(deps, userId, query.projectId);
  const threads = await listOwnThreads(deps.memory, userId);
  const links = await liveLinks(deps, userId, new Set(threads.map((t) => t.id)));
  const all = threads
    .map((t) => ({ ...t, projectId: links.get(t.id) ?? null }))
    .filter((t) => (!query.projectId || t.projectId === query.projectId) && (!query.agentId || t.agentId === query.agentId));
  const start = query.before ? all.findIndex((t) => cursorOf(t) === query.before) + 1 : 0;
  if (query.before && start === 0) throw appError('APP_VALIDATION_FAILED', `unknown cursor ${query.before}`, { userMessage: 'Список разговоров изменился. Обновите страницу.' });
  const page = all.slice(start, start + limit);
  const more = start + limit < all.length;
  return { threads: page, next: more && page.length > 0 ? cursorOf(page.at(-1)!) : null };
}
