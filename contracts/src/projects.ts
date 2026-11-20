import { z } from 'zod';

// Projects (spec, sections 8.12 and 8.20): a folder of conversations with instructions and files.
// The creator may open it to colleagues — departments, people, or the whole organisation.

// «Только я», «Выбранным» (departments and people together) or «Всей организации».
export const PROJECT_ACCESS_MODES = ['private', 'list', 'org'] as const;
export type ProjectAccessMode = (typeof PROJECT_ACCESS_MODES)[number];
// A list longer than this is a mistake or abuse: an organisation has tens of people, not hundreds.
export const PROJECT_ACCESS_MAX_TARGETS = 500;

export const projectAccessInputSchema = z.object({
  mode: z.enum(PROJECT_ACCESS_MODES),
  departmentIds: z.array(z.uuid()),
  userIds: z.array(z.string().min(1)),
});
export type ProjectAccessInput = z.infer<typeof projectAccessInputSchema>;

export const projectCreateSchema = z.object({ name: z.string(), access: projectAccessInputSchema });
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

// Who the project is open to, as only its creator sees it.
export interface ProjectAccessDto {
  mode: ProjectAccessMode;
  departments: { id: string; name: string; members: number }[];
  people: { id: string; name: string; email: string; blocked: boolean }[];
}

// GET /app/api/projects gives them in the order of the person's side panel: the pinned ones first, in
// the order the person dragged them; then the rest by `byRecentWork`.
export interface ProjectDto {
  id: string;
  name: string;
  instructions: string;
  // The person's own conversations in the project: the others' are theirs alone.
  threadCount: number;
  // When the person last worked in the project: their latest conversation in it; before any — the
  // latest of its creation and the person's first opening of it. The unpinned projects of the side panel
  // and the project picker of the input go by it (`byRecentWork`).
  lastActiveAt: string;
  pinned: boolean;
  createdAt: string;
  role: 'owner' | 'member';
  owner: { id: string; name: string };
  // Open to someone besides the creator.
  shared: boolean;
  // A colleague has not opened this shared project yet: «новое».
  unseen: boolean;
  // Only for the creator.
  access: ProjectAccessDto | null;
  archivedAt: string | null;
}

// «Проект 9» before «Проект 10»; letter case and «ё» do not change the place.
export const byProjectName = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

// The unpinned projects of the side panel and «недавние» of the project picker (decision of the owner
// 17.11): a project a colleague has just opened to the person («новое») first, whenever it was created;
// then the latest work. lastActiveAt is an ISO time of the server: its text sorts as the time.
export function byRecentWork(a: Pick<ProjectDto, 'id' | 'name' | 'lastActiveAt' | 'unseen'>, b: Pick<ProjectDto, 'id' | 'name' | 'lastActiveAt' | 'unseen'>): number {
  return Number(b.unseen) - Number(a.unseen) || b.lastActiveAt.localeCompare(a.lastActiveAt) || byProjectName.compare(a.name, b.name) || a.id.localeCompare(b.id);
}

export interface ProjectListResponse {
  projects: ProjectDto[];
  // The creator's projects in the archive: the line «Архив · N» under «Проекты».
  archivedCount: number;
}

export interface ProjectFile {
  path: string;
  bytes: number;
}

// GET /app/api/colleagues?q=: people to open a project to.
export interface ColleagueDto {
  id: string;
  name: string;
  email: string;
  departments: string[];
}

// GET /app/api/departments: departments to open a project to, with the number of active people.
export interface DepartmentDto {
  id: string;
  name: string;
  members: number;
}

// Why a conversation's project is gone for the person: shown above the input.
export const LOST_PROJECT_REASONS = ['access', 'archived', 'deleted'] as const;
export type LostProjectReason = (typeof LOST_PROJECT_REASONS)[number];

export interface ThreadProjectResponse {
  projectId: string | null;
  // `projectId`: of a project that still exists (closed or archived) — its creator brings it back.
  lost: { projectId: string | null; name: string; reason: LostProjectReason; ownerName: string | null; canUnarchive: boolean } | null;
}

// The trash of a project (spec, section 8.20): what one person removed, or one answer of the agent.
export interface TrashItemDto {
  id: string;
  path: string;
  bytes: number;
  kind: 'deleted' | 'previous_version';
  expiresAt: string;
}

export interface TrashBatchDto {
  id: string;
  via: 'page' | 'agent';
  // Null once the person is removed from the installation.
  deletedBy: string | null;
  deletedAt: string;
  // Other answers ran in the project at the same time: the removal may be any of theirs.
  overlapped: boolean;
  items: TrashItemDto[];
}

export const trashRestoreSchema = z.union([z.object({ ids: z.array(z.uuid()).min(1) }), z.object({ batchId: z.uuid() })]);
export type TrashRestore = z.infer<typeof trashRestoreSchema>;

// A file removed from its folder: in the project's trash, or gone.
type RemovedFile = { state: 'trash'; name: string; projectId: string; trashId: string; expiresAt: string } | { state: 'deleted'; name: string };

// GET /app/api/threads/:threadId/file/status?path=: what «Скачать» of the chat will find. `version` of a file there
// changes whenever the file is written: the marks drawn on it in the viewer belong to one version (spec, 8.32).
export type ThreadFileStatus = { state: 'ok'; version: string } | RemovedFile | { state: 'lost'; name: string; projectName: string; reason: LostProjectReason };

// GET /app/api/files/status: a file the search found (spec, section 8.21) — there, in the project's trash, or gone.
export type SearchFileStatus = { state: 'ok' } | RemovedFile;

// GET /app/api/projects/archive: the creator's archived projects (spec, section 8.20). A project is
// removed for good only from the archive and not before `deletableFrom`.
export interface ArchivedProjectDto {
  id: string;
  name: string;
  archivedAt: string;
  deletableFrom: string;
  files: number;
  shared: boolean;
}
