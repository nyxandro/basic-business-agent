// The units the files are stored in (spec, section 8.23): an area is one folder the server works in as a
// whole — the files of a person's conversations outside projects, or a project (its files and its trash).
// On the disk an area keeps the layout of core/workspace/layout.ts; in the bucket a project is found by its
// id alone, so a project given to another person keeps its objects where they are.
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { projectRoot, userRoot } from '../workspace/layout.ts';

export type Area = { kind: 'user'; userId: string } | { kind: 'project'; projectId: string; ownerId: string };

export const userArea = (userId: string): Area => ({ kind: 'user', userId });
export const projectArea = (projectId: string, ownerId: string): Area => ({ kind: 'project', projectId, ownerId });
export const areaOf = (userId: string, project: { id: string; user_id: string } | null): Area => (project ? projectArea(project.id, project.user_id) : userArea(userId));

// The name of the area in the list of stored files and in the bucket.
export function areaKey(area: Area): string {
  return area.kind === 'user' ? `users/${area.userId}/files` : `projects/${area.projectId}`;
}

// The area's folder on the disk.
export function areaDir(workspaceRoot: string, area: Area): string {
  return area.kind === 'user' ? join(userRoot(workspaceRoot, area.userId), 'files') : projectRoot(workspaceRoot, area.ownerId, area.projectId);
}

// Where the person's files are inside the area: the whole area for conversations outside projects,
// «files/» of a project (its trash is beside).
export function filesPrefix(area: Area): string {
  return area.kind === 'user' ? '' : 'files/';
}

// The note that the folder on the disk is a full working copy of what the bucket holds — written last
// when a copy is made. It lies outside the folder the agent works in, so the agent cannot touch it.
export function markerPath(workspaceRoot: string, area: Area): string {
  return area.kind === 'user' ? join(userRoot(workspaceRoot, area.userId), '.storage-files.json') : join(projectRoot(workspaceRoot, area.ownerId, area.projectId), '.storage.json');
}

// Working files that are not stored: snapshots of an answer, pictures of pages the skills draw, files of
// the person's computer brought for one answer (section 8.25), half-written uploads.
const WORKING_FOLDERS: ReadonlySet<string> = new Set(['.snapshots', '.renders', '.computer']);
const WORKING_FILE = /^\.(?:upload|copy|hydrate|evict)-/;

export function isWorkingPath(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.some((p) => WORKING_FOLDERS.has(p))) return true;
  if (parts.length === 1 && parts[0] === '.storage.json') return true;
  return WORKING_FILE.test(basename(rel)) || parts.some((p) => WORKING_FILE.test(p));
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Every area that has a folder on the disk now.
export function localAreas(workspaceRoot: string): Area[] {
  if (!existsSync(workspaceRoot)) return [];
  const out: Area[] = [];
  for (const userId of readdirSync(workspaceRoot)) {
    if (!SAFE_SEGMENT.test(userId)) continue;
    if (existsSync(join(workspaceRoot, userId, 'files'))) out.push(userArea(userId));
    const projects = join(workspaceRoot, userId, 'projects');
    if (!existsSync(projects)) continue;
    for (const projectId of readdirSync(projects)) if (PROJECT_ID.test(projectId)) out.push(projectArea(projectId, userId));
  }
  return out;
}

// The area named in the list of stored files; the owner of a project comes from the database.
export function parseAreaKey(key: string): { kind: 'user'; userId: string } | { kind: 'project'; projectId: string } | null {
  const user = /^users\/([A-Za-z0-9_-]{1,128})\/files$/.exec(key);
  if (user) return { kind: 'user', userId: user[1]! };
  const project = /^projects\/([0-9a-f-]{36})$/.exec(key);
  if (project && PROJECT_ID.test(project[1]!)) return { kind: 'project', projectId: project[1]! };
  return null;
}
