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

// GET /app/api/projects gives them in the order of the person's side panel: pinned first.
export interface ProjectDto {
  id: string;
  name: string;
  instructions: string;
  // The person's own conversations in the project: the others' are theirs alone.
  threadCount: number;
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
  lost: { name: string; reason: LostProjectReason; ownerName: string | null; canUnarchive: boolean } | null;
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
  items: TrashItemDto[];
}

export const trashRestoreSchema = z.union([z.object({ ids: z.array(z.uuid()).min(1) }), z.object({ batchId: z.uuid() })]);
export type TrashRestore = z.infer<typeof trashRestoreSchema>;

// GET /app/api/threads/:threadId/file/status?path=: what «Скачать» of the chat will find.
export type ThreadFileStatus =
  | { state: 'ok' }
  | { state: 'trash'; name: string; projectId: string; trashId: string; expiresAt: string }
  | { state: 'deleted'; name: string }
  | { state: 'lost'; name: string; projectName: string; reason: LostProjectReason };

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
