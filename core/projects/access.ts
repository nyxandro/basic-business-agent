// Who sees a project (spec, section 8.20). The only place that decides it: every read of a project —
// its page, files, conversations, search, a run of the agent — goes through here. A person sees a
// project they created, one open to the whole organisation, and one open «Выбранным» to them or to a
// department they are in. Counted on every request: moving a person to another department works at
// once. An archived project is seen by its creator only, read-only, on its page and in the archive.
import type { LostProjectReason, ProjectAccessMode } from '@bba/contracts';
import type pg from 'pg';
import { appError } from '../errors/catalog.ts';

type Queryable = Pick<pg.PoolClient, 'query'>;

export type ProjectRole = 'owner' | 'member';

export interface ProjectRow {
  id: string;
  user_id: string;
  owner_name: string;
  name: string;
  instructions: string;
  access: ProjectAccessMode;
  archived_at: Date | null;
  created_at: Date;
}

export interface VisibleProject {
  project: ProjectRow;
  role: ProjectRole;
}

const SAFE_PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The project `p` is seen by the person in parameter `$1`.
export const SEES = `(p.user_id = $1 OR p.access = 'org' OR (p.access = 'list' AND EXISTS (
  SELECT 1 FROM app.project_shares s
   WHERE s.project_id = p.id
     AND (s.user_id = $1 OR s.department_id IN (SELECT m.department_id FROM app.department_members m WHERE m.user_id = $1)))))`;
// Open to anyone besides the creator: a list whose departments were all removed is «только я».
export const SHARED = `(p.access = 'org' OR (p.access = 'list' AND EXISTS (SELECT 1 FROM app.project_shares s WHERE s.project_id = p.id)))`;
export const PROJECT_COLUMNS = 'p.id, p.user_id, u."name" AS owner_name, p.name, p.instructions, p.access, p.archived_at, p.created_at';

export const projectNotFound = (id: string) =>
  appError('APP_NOT_FOUND', `project ${id} is not seen by the person`, { userMessage: 'Проект недоступен. Возможно, его перенесли в архив или закрыли к нему доступ.' });

// `archived`: 'exclude' — what people work with (lists, files, runs); 'owner' — the creator also gets
// an archived one (its page for reading, the archive, return and removal).
export async function findVisibleProject(db: Queryable, userId: string, projectId: string, archived: 'exclude' | 'owner'): Promise<VisibleProject | null> {
  if (!SAFE_PROJECT_ID.test(projectId)) return null;
  const { rows } = await db.query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM app.projects p JOIN app."user" u ON u."id" = p.user_id
      WHERE p.id = $2 AND ${SEES} AND (p.archived_at IS NULL OR ($3 AND p.user_id = $1))`,
    [userId, projectId, archived === 'owner'],
  );
  const project = rows[0];
  return project ? { project, role: project.user_id === userId ? 'owner' : 'member' } : null;
}

export async function visibleProject(db: Queryable, userId: string, projectId: string, archived: 'exclude' | 'owner' = 'exclude'): Promise<VisibleProject> {
  const found = await findVisibleProject(db, userId, projectId, archived);
  if (!found) throw projectNotFound(projectId);
  return found;
}

export function requireOwner(found: VisibleProject): ProjectRow {
  if (found.role !== 'owner') throw appError('APP_PROJECT_OWNER_ONLY', `project ${found.project.id}: only its creator may do this`);
  return found.project;
}

export function requireActive(found: VisibleProject): ProjectRow {
  if (found.project.archived_at) throw appError('APP_PROJECT_ARCHIVED', `project ${found.project.id} is archived`);
  return found.project;
}

// The project of a conversation for a run, the chip and the notice above the input.
export type ThreadProjectState =
  | { state: 'none' }
  | { state: 'active'; project: ProjectRow; role: ProjectRole }
  | { state: 'lost'; name: string; reason: LostProjectReason; ownerName: string | null; canUnarchive: boolean };

// What a run of the conversation works in, fixed for the whole run (spec, section 8.20): the files and
// instructions of a project the person sees, or their own files with a word for the agent why the
// project is gone. Every run — a message, «Да», a background run — asks anew.
export interface RunProject {
  projectId: string | null;
  projectOwnerId: string | null;
  lostProject: { name: string; reason: LostProjectReason } | null;
}

export async function runProjectOf(db: Queryable, userId: string, threadId: string): Promise<RunProject> {
  const state = await threadProjectState(db, userId, threadId);
  if (state.state === 'active') return { projectId: state.project.id, projectOwnerId: state.project.user_id, lostProject: null };
  if (state.state === 'lost') return { projectId: null, projectOwnerId: null, lostProject: { name: state.name, reason: state.reason } };
  return { projectId: null, projectOwnerId: null, lostProject: null };
}

// The project of an answer that waited for «Да»: Mastra goes on with that same answer, its prompt
// still holding the project, so it is finished there — with the files of the project as they are now,
// with its creator — even when access was closed meanwhile (the owner: the agent finishes the request).
// A project removed since then leaves the answer the person's own folder.
export async function runProjectOfWaitingAnswer(db: Queryable, projectId: string | null): Promise<RunProject> {
  if (!projectId) return { projectId: null, projectOwnerId: null, lostProject: null };
  const { rows } = await db.query<{ user_id: string }>('SELECT user_id FROM app.projects WHERE id = $1', [projectId]);
  return rows[0] ? { projectId, projectOwnerId: rows[0].user_id, lostProject: null } : { projectId: null, projectOwnerId: null, lostProject: null };
}

export async function threadProjectState(db: Queryable, userId: string, threadId: string): Promise<ThreadProjectState> {
  const { rows } = await db.query<{ project_id: string | null; lost_project_name: string | null }>(
    'SELECT project_id, lost_project_name FROM app.thread_projects WHERE thread_id = $1 AND user_id = $2',
    [threadId, userId],
  );
  const link = rows[0];
  if (!link) return { state: 'none' };
  if (!link.project_id) return link.lost_project_name ? { state: 'lost', name: link.lost_project_name, reason: 'deleted', ownerName: null, canUnarchive: false } : { state: 'none' };
  const seen = await findVisibleProject(db, userId, link.project_id, 'owner');
  if (seen && !seen.project.archived_at) return { state: 'active', project: seen.project, role: seen.role };
  const { rows: existing } = await db.query<ProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM app.projects p JOIN app."user" u ON u."id" = p.user_id WHERE p.id = $1`, [link.project_id]);
  const project = existing[0];
  if (!project) return { state: 'none' };
  if (project.archived_at) return { state: 'lost', name: project.name, reason: 'archived', ownerName: project.owner_name, canUnarchive: project.user_id === userId };
  return { state: 'lost', name: project.name, reason: 'access', ownerName: project.owner_name, canUnarchive: false };
}
