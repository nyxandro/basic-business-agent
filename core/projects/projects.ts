// Projects of conversations (spec, sections 8.12 and 8.20): folders with instructions and files that
// their creator may open to colleagues. Who sees which project is decided in ./access.ts only.
// Conversations are Mastra threads; their link to a project lives in app.thread_projects; the place of
// a project in a person's side panel — in app.project_places.
import { randomUUID } from 'node:crypto';
import type { ArchivedProjectDto, ProjectAccessInput, ProjectDto, ProjectListResponse, ThreadPage, ThreadSummaryDto } from '@bba/contracts';
import type { Memory } from '@mastra/memory';
import type pg from 'pg';
import { inTransaction, type Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { listOwnThreads } from '../memory/memory.ts';
import { logEvent } from '../server/log.ts';
import { contextRoot, listFiles, removeProjectFolder } from '../workspace/layout.ts';
import { PROJECT_COLUMNS, requireActive, requireOwner, SEES, SHARED, visibleProject, type ProjectRole, type ProjectRow } from './access.ts';
import { checkAccess, describeAccess, writeAccess } from './sharing.ts';

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

type Queryable = Pick<pg.PoolClient, 'query'>;

interface ListedRow extends ProjectRow {
  placed: boolean;
  pinned: boolean;
  seen_at: Date | null;
  shared: boolean;
}

// The side panel's order (spec, section 8.12): pinned first; then projects the person has no place
// for yet (a colleague's new shared one), newest first; then the rest in the order the person gave.
const PANEL_ORDER = '(pl.pinned IS TRUE) DESC, (pl.user_id IS NULL) DESC, CASE WHEN pl.user_id IS NULL THEN p.created_at END DESC, pl.position, lower(p.name)';
// A new place and an unpinned one: first among the unpinned. A pinned one: after all the places.
const FIRST_UNPINNED = '(SELECT COALESCE(min(position), 1) - 1 FROM app.project_places WHERE user_id = $1 AND NOT pinned)';
const AFTER_ALL = '(SELECT COALESCE(max(position), 0) + 1 FROM app.project_places WHERE user_id = $1)';

function cleanName(name: string): string {
  const clean = name.replace(/\s+/g, ' ').trim();
  if (clean.length < 1 || clean.length > NAME_MAX) throw appError('APP_VALIDATION_FAILED', `project name of ${clean.length} chars`, { userMessage: `Название проекта — от 1 до ${NAME_MAX} символов.` });
  return clean;
}

function checkInstructions(text: string): string {
  if (text.length > INSTRUCTIONS_MAX) throw appError('APP_VALIDATION_FAILED', `instructions of ${text.length} chars`, { userMessage: `Инструкции — не длиннее ${INSTRUCTIONS_MAX} символов.` });
  return text;
}

async function nameTaken(db: Queryable, error: unknown, userId: string, name: string): Promise<AppError | null> {
  if ((error as { code?: string }).code !== UNIQUE_VIOLATION) return null;
  const { rows } = await db.query<{ archived: boolean }>('SELECT archived_at IS NOT NULL AS archived FROM app.projects WHERE user_id = $1 AND lower(name) = lower($2)', [userId, name]);
  const userMessage = rows[0]?.archived ? `Проект «${name}» уже есть в архиве. Верните его из архива или выберите другое название.` : `Проект «${name}» уже есть.`;
  return new AppError({ code: 'APP_PROJECT_EXISTS', message: `project name "${name}" is taken`, userMessage, status: 409, cause: error });
}

// Links of the person's existing conversations (a project removed for good leaves its link empty);
// links to conversations that never started are dropped once they are a day old, and so are links
// that keep neither a project nor the name of a removed one.
async function liveLinks(deps: ProjectsDeps, userId: string, ownThreadIds: ReadonlySet<string>): Promise<Map<string, string | null>> {
  const { rows } = await deps.db.query<{ thread_id: string; project_id: string | null; lost_project_name: string | null; stale: boolean }>(
    `SELECT thread_id, project_id, lost_project_name, created_at < now() - interval '${ORPHAN_LINK_AGE}' AS stale FROM app.thread_projects WHERE user_id = $1`,
    [userId],
  );
  const live = new Map<string, string | null>();
  const drop: string[] = [];
  for (const r of rows) {
    if (!r.project_id && !r.lost_project_name) drop.push(r.thread_id);
    else if (ownThreadIds.has(r.thread_id)) live.set(r.thread_id, r.project_id);
    else if (r.stale) drop.push(r.thread_id);
  }
  if (drop.length > 0) await deps.db.query('DELETE FROM app.thread_projects WHERE user_id = $1 AND thread_id = ANY($2)', [userId, drop]);
  return live;
}

async function threadCounts(deps: ProjectsDeps, userId: string): Promise<Map<string, number>> {
  const threads = await listOwnThreads(deps.memory, userId);
  const counts = new Map<string, number>();
  for (const projectId of (await liveLinks(deps, userId, new Set(threads.map((t) => t.id)))).values()) {
    if (projectId) counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
  }
  return counts;
}

async function listedRows(db: Queryable, userId: string, where: string, params: unknown[] = []): Promise<ListedRow[]> {
  const { rows } = await db.query<ListedRow>(
    `SELECT ${PROJECT_COLUMNS}, ${SHARED} AS shared, pl.user_id IS NOT NULL AS placed,
            pl.pinned IS TRUE AS pinned, pl.seen_at
       FROM app.projects p JOIN app."user" u ON u."id" = p.user_id
       LEFT JOIN app.project_places pl ON pl.project_id = p.id AND pl.user_id = $1
      WHERE ${SEES} AND ${where}
      ORDER BY ${PANEL_ORDER}`,
    [userId, ...params],
  );
  return rows;
}

async function toDto(db: Queryable, userId: string, row: ListedRow, threadCount: number): Promise<ProjectDto> {
  const role: ProjectRole = row.user_id === userId ? 'owner' : 'member';
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    threadCount,
    pinned: row.pinned,
    createdAt: row.created_at.toISOString(),
    role,
    owner: { id: row.user_id, name: row.owner_name },
    shared: row.shared,
    // A place without seen_at is «новое» (a project shared to the person, or given to them); a colleague
    // without a place has not opened the project yet.
    unseen: row.placed ? row.seen_at === null : role === 'member',
    access: role === 'owner' ? await describeAccess(db, row.id, row.access) : null,
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}

export async function listProjects(deps: ProjectsDeps, userId: string): Promise<ProjectListResponse> {
  const counts = await threadCounts(deps, userId);
  const rows = await listedRows(deps.db, userId, 'p.archived_at IS NULL');
  const { rows: archived } = await deps.db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.projects WHERE user_id = $1 AND archived_at IS NOT NULL', [userId]);
  return { projects: await Promise.all(rows.map((r) => toDto(deps.db, userId, r, counts.get(r.id) ?? 0))), archivedCount: archived[0]!.n };
}

// One project as its page shows it: the creator also gets an archived one, for reading.
export async function projectDto(deps: ProjectsDeps, userId: string, projectId: string): Promise<ProjectDto> {
  await visibleProject(deps.db, userId, projectId, 'owner');
  const [row] = await listedRows(deps.db, userId, 'p.id = $2 AND (p.archived_at IS NULL OR p.user_id = $1)', [projectId]);
  if (!row) throw new Error(`project ${projectId} was seen and is gone`);
  return toDto(deps.db, userId, row, (await threadCounts(deps, userId)).get(projectId) ?? 0);
}

// Opening the project's page or working in it takes «новое» off.
export async function markSeen(db: Queryable, userId: string, projectId: string): Promise<void> {
  await db.query(
    `INSERT INTO app.project_places (user_id, project_id, position, pinned, seen_at) VALUES ($1, $2, ${FIRST_UNPINNED}, false, now())
     ON CONFLICT (user_id, project_id) DO UPDATE SET seen_at = now() WHERE app.project_places.seen_at IS NULL`,
    [userId, projectId],
  );
}

export async function createProject(deps: ProjectsDeps, userId: string, input: { name: string; access: ProjectAccessInput }): Promise<ProjectDto> {
  const clean = cleanName(input.name);
  const id = randomUUID();
  try {
    await inTransaction(deps.db, async (c) => {
      const access = await checkAccess(c, userId, input.access);
      await c.query('INSERT INTO app.projects (id, user_id, name, access) VALUES ($1, $2, $3, $4)', [id, userId, clean, access.mode]);
      await writeAccess(c, id, access);
      await c.query(`INSERT INTO app.project_places (user_id, project_id, position, pinned, seen_at) VALUES ($1, $2, ${FIRST_UNPINNED}, false, now())`, [userId, id]);
    });
  } catch (error) {
    throw (await nameTaken(deps.db, error, userId, clean)) ?? error;
  }
  return projectDto(deps, userId, id);
}

// Name and instructions — the creator of a project not in the archive; pinning — anyone who sees
// it, in their own panel.
export async function updateProject(deps: ProjectsDeps, userId: string, projectId: string, change: { name?: string; instructions?: string; pinned?: boolean }): Promise<ProjectDto> {
  if (change.name !== undefined || change.instructions !== undefined) {
    const found = await visibleProject(deps.db, userId, projectId, 'owner');
    requireOwner(found);
    requireActive(found);
    const name = change.name === undefined ? null : cleanName(change.name);
    const instructions = change.instructions === undefined ? null : checkInstructions(change.instructions);
    try {
      await deps.db.query('UPDATE app.projects SET name = COALESCE($2, name), instructions = COALESCE($3, instructions), updated_at = now() WHERE id = $1', [projectId, name, instructions]);
    } catch (error) {
      throw (await nameTaken(deps.db, error, userId, name ?? '')) ?? error;
    }
  }
  if (change.pinned !== undefined) await pinProject(deps.db, userId, projectId, change.pinned);
  return projectDto(deps, userId, projectId);
}

// Pinning a pinned project (or unpinning an unpinned one) leaves it in its place.
async function pinProject(db: Db, userId: string, projectId: string, pinned: boolean): Promise<void> {
  await visibleProject(db, userId, projectId);
  if (pinned) {
    await db.query(
      `INSERT INTO app.project_places (user_id, project_id, position, pinned) VALUES ($1, $2, ${AFTER_ALL}, true)
       ON CONFLICT (user_id, project_id) DO UPDATE SET pinned = true, position = EXCLUDED.position WHERE NOT app.project_places.pinned`,
      [userId, projectId],
    );
    return;
  }
  await db.query(
    `INSERT INTO app.project_places (user_id, project_id, position, pinned) VALUES ($1, $2, ${FIRST_UNPINNED}, false)
     ON CONFLICT (user_id, project_id) DO UPDATE SET pinned = false, position = EXCLUDED.position WHERE app.project_places.pinned`,
    [userId, projectId],
  );
}

export async function setProjectAccess(deps: ProjectsDeps, userId: string, projectId: string, input: ProjectAccessInput): Promise<ProjectDto> {
  const found = await visibleProject(deps.db, userId, projectId, 'owner');
  requireOwner(found);
  requireActive(found);
  const access = await inTransaction(deps.db, async (c) => {
    const { rows } = await c.query<{ user_id: string }>('SELECT user_id FROM app.project_shares WHERE project_id = $1 AND user_id IS NOT NULL', [projectId]);
    const checked = await checkAccess(c, userId, input, rows.map((r) => r.user_id));
    await writeAccess(c, projectId, checked);
    return checked;
  });
  logEvent('info', 'project_access_changed', { projectId, userId, mode: access.mode, departments: access.departmentIds.length, people: access.userIds.length });
  return projectDto(deps, userId, projectId);
}

// The order the person dragged the projects of their panel into, all of them: pinned or not stays
// as it is, so a project dragged among the others only changes its place in its own group.
export async function orderProjects(deps: Pick<ProjectsDeps, 'db'>, userId: string, ids: readonly string[]): Promise<void> {
  const shown = new Set((await listedRows(deps.db, userId, 'p.archived_at IS NULL')).map((r) => r.id));
  if (new Set(ids).size !== ids.length || ids.length !== shown.size || ids.some((id) => !shown.has(id))) {
    throw appError('APP_VALIDATION_FAILED', `project order of ${ids.length} ids does not match the person's ${shown.size} projects`, { userMessage: 'Список проектов изменился, порядок не сохранён. Перетащите проект ещё раз.' });
  }
  await deps.db.query(
    `INSERT INTO app.project_places (user_id, project_id, position, pinned)
     SELECT $1, o.id, o.n, false FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, n)
     ON CONFLICT (user_id, project_id) DO UPDATE SET position = EXCLUDED.position`,
    [userId, ids],
  );
}

// A project is not removed but archived (decision of the owner 16.11): gone from «Проекты» of everyone,
// its conversations go on without it; its creator brings it back whole, or removes it for good once it
// has been in the archive this long.
export const PROJECT_ARCHIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function archiveProject(deps: Pick<ProjectsDeps, 'db'>, userId: string, projectId: string, archived: boolean): Promise<void> {
  requireOwner(await visibleProject(deps.db, userId, projectId, 'owner'));
  await deps.db.query(
    archived ? 'UPDATE app.projects SET archived_at = now(), updated_at = now() WHERE id = $1 AND archived_at IS NULL' : 'UPDATE app.projects SET archived_at = NULL, updated_at = now() WHERE id = $1 AND archived_at IS NOT NULL',
    [projectId],
  );
  logEvent('info', archived ? 'project_archived' : 'project_unarchived', { projectId, userId });
}

export async function listArchive(deps: ProjectsDeps, userId: string): Promise<ArchivedProjectDto[]> {
  const { rows } = await deps.db.query<{ id: string; name: string; archived_at: Date; shared: boolean }>(
    `SELECT p.id, p.name, p.archived_at, ${SHARED} AS shared FROM app.projects p WHERE p.user_id = $1 AND p.archived_at IS NOT NULL ORDER BY p.archived_at DESC, p.id`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    archivedAt: r.archived_at.toISOString(),
    deletableFrom: new Date(r.archived_at.getTime() + PROJECT_ARCHIVE_DAYS * DAY_MS).toISOString(),
    files: listFiles(contextRoot(deps.workspaceRoot, userId, r.id)).length,
    shared: r.shared,
  }));
}

// Removed for good — only from the archive, and not before PROJECT_ARCHIVE_DAYS there. The creator's
// conversations stay, without a project; a colleague's conversation keeps the project's name to say
// so above the input. Instructions, files, the trash and places go.
export async function deleteProject(deps: ProjectsDeps, userId: string, projectId: string): Promise<void> {
  const project = requireOwner(await visibleProject(deps.db, userId, projectId, 'owner'));
  if (!project.archived_at) throw appError('APP_VALIDATION_FAILED', `project ${projectId} is not archived`, { userMessage: 'Сначала перенесите проект в архив.' });
  const from = new Date(project.archived_at.getTime() + PROJECT_ARCHIVE_DAYS * DAY_MS);
  if (from.getTime() > Date.now()) {
    throw appError('APP_PROJECT_DELETE_TOO_EARLY', `project ${projectId} is in the archive since ${project.archived_at.toISOString()}`, {
      userMessage: `Удалить навсегда можно будет с ${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(from)}.`,
    });
  }
  await inTransaction(deps.db, async (c) => {
    await c.query('UPDATE app.thread_projects SET lost_project_name = $2 WHERE project_id = $1 AND user_id <> $3', [projectId, project.name, project.user_id]);
    await c.query('DELETE FROM app.thread_projects WHERE project_id = $1 AND user_id = $2', [projectId, project.user_id]);
    await c.query('DELETE FROM app.projects WHERE id = $1', [projectId]);
  });
  removeProjectFolder(deps.workspaceRoot, project.user_id, projectId);
}

// Puts a conversation into a project the person sees (or out of any). The conversation may not
// exist yet: the person chose the project before the first message.
export async function setThreadProject(deps: ProjectsDeps, userId: string, threadId: string, projectId: string | null): Promise<void> {
  const thread = await deps.memory.getThreadById({ threadId });
  if (thread && thread.resourceId !== userId) throw appError('APP_NOT_FOUND', `thread ${threadId} belongs to another resource`, { userMessage: 'Разговор не найден.' });
  if (projectId === null) {
    await deps.db.query('DELETE FROM app.thread_projects WHERE thread_id = $1 AND user_id = $2', [threadId, userId]);
    return;
  }
  await visibleProject(deps.db, userId, projectId);
  await deps.db.query(
    `INSERT INTO app.thread_projects (thread_id, user_id, project_id) VALUES ($1, $2, $3)
     ON CONFLICT (thread_id) DO UPDATE SET project_id = EXCLUDED.project_id, lost_project_name = NULL WHERE app.thread_projects.user_id = EXCLUDED.user_id`,
    [threadId, userId, projectId],
  );
}

function cursorOf(t: ThreadSummaryDto): string {
  return `${t.updatedAt}|${t.id}`;
}

// Conversations of all the person's agents, newest first; `before` continues after a cursor. A
// conversation whose project the person no longer sees is shown without one.
export async function listThreadPage(deps: ProjectsDeps, userId: string, query: { projectId?: string | null; agentId?: string; limit?: number; before?: string }): Promise<ThreadPage> {
  const limit = Math.min(Math.max(query.limit ?? THREAD_PAGE_DEFAULT, 1), THREAD_PAGE_MAX);
  // The page of an archived project lists its creator's conversations in it too.
  if (query.projectId) await visibleProject(deps.db, userId, query.projectId, 'owner');
  const threads = await listOwnThreads(deps.memory, userId);
  const links = await liveLinks(deps, userId, new Set(threads.map((t) => t.id)));
  const seen = new Set((await listedRows(deps.db, userId, 'p.archived_at IS NULL')).map((r) => r.id));
  if (query.projectId) seen.add(query.projectId);
  const all = threads
    .map((t) => {
      const linked = links.get(t.id) ?? null;
      return { ...t, projectId: linked && seen.has(linked) ? linked : null };
    })
    .filter((t) => (!query.projectId || t.projectId === query.projectId) && (!query.agentId || t.agentId === query.agentId));
  const start = query.before ? all.findIndex((t) => cursorOf(t) === query.before) + 1 : 0;
  if (query.before && start === 0) throw appError('APP_VALIDATION_FAILED', `unknown cursor ${query.before}`, { userMessage: 'Список разговоров изменился. Обновите страницу.' });
  const page = all.slice(start, start + limit);
  const more = start + limit < all.length;
  return { threads: page, next: more && page.length > 0 ? cursorOf(page.at(-1)!) : null };
}
