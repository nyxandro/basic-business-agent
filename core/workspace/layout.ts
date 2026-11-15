// The employee's workspace (spec, sections 8.7 and 8.9):
//   /workspace/<userId>/files/                     — files of conversations outside projects
//   /workspace/<userId>/projects/<projectId>/files — files of a project
// A conversation's sandbox root is one of these files folders: the agent works freely inside it,
// cannot see the others, and cannot remove the root itself (it is the sandbox mount point).
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } from '@bba/contracts';
import { appError } from '../errors/catalog.ts';

const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILES = 'files';
const MAX_NAME_LENGTH = 120;
// The listing shown to people and the model stops here; a project with more needs the knowledge base.
export const MAX_LISTED_FILES = 500;
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(UPLOAD_EXTENSIONS);

export function userRoot(workspaceRoot: string, userId: string): string {
  if (!SAFE_USER_ID.test(userId)) throw new Error(`unsafe user id for a workspace path: ${userId}`);
  return join(workspaceRoot, userId);
}

function projectRoot(workspaceRoot: string, userId: string, projectId: string): string {
  if (!SAFE_PROJECT_ID.test(projectId)) throw new Error(`unsafe project id for a workspace path: ${projectId}`);
  return join(userRoot(workspaceRoot, userId), 'projects', projectId);
}

// The files folder a conversation works in; created on first use.
export function contextRoot(workspaceRoot: string, userId: string, projectId: string | null): string {
  const dir = projectId ? join(projectRoot(workspaceRoot, userId, projectId), FILES) : join(userRoot(workspaceRoot, userId), FILES);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function safeFileName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  const base = last.replace(/[^\p{L}\p{N}._ ()-]/gu, '_').replace(/^\.+/, '').trim();
  return base.slice(-MAX_NAME_LENGTH) || 'file';
}

function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

// Saves a person's file into a folder: same name gets « (2)», the write goes to a temporary name
// first, so an interrupted upload never leaves half a file under the real name.
export function saveFile(dir: string, fileName: string, data: Uint8Array): { name: string; path: string; bytes: number } {
  const clean = safeFileName(fileName);
  if (!ALLOWED_EXTENSIONS.has(extname(clean).toLowerCase())) throw appError('APP_UPLOAD_TYPE_UNSUPPORTED', `extension of ${clean} is not allowed`);
  if (data.byteLength > MAX_UPLOAD_BYTES) throw appError('APP_UPLOAD_TOO_LARGE', `${clean} is ${data.byteLength} bytes`);
  mkdirSync(dir, { recursive: true });
  const name = freeName(dir, clean);
  const temp = join(dir, `.upload-${randomUUID()}`);
  try {
    writeFileSync(temp, data);
    renameSync(temp, join(dir, name));
  } finally {
    rmSync(temp, { force: true });
  }
  return { name, path: name, bytes: data.byteLength };
}

// Files of a folder for people and for the model: hidden working folders (".renders") are skipped.
export function listFiles(dir: string): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  const walk = (current: string) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'ru'))) {
      if (out.length >= MAX_LISTED_FILES) return;
      if (entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push({ path: relative(dir, full), bytes: statSync(full).size });
    }
  };
  walk(dir);
  return out;
}

// A path from the folder, or an absolute one inside it (the document skills pass absolute paths of
// the pages they drew); anything leading out of the folder is refused.
export function resolveInside(dir: string, path: string): string {
  const full = isAbsolute(path) ? resolve(path) : join(dir, path);
  const rel = relative(dir, full);
  if (rel.startsWith('..') || isAbsolute(rel) || rel === '') throw appError('APP_VALIDATION_FAILED', `path ${path} is outside the folder`);
  return full;
}

// The real place of an existing file or folder of `dir`, or null when there is none (a broken link
// is none). The server reads these files outside the sandbox, and the agent can make links in its
// folder (ln -s /proc/self/environ x.docx): a link is followed only to a place inside the folder.
export function existingInside(dir: string, path: string): string | null {
  const full = resolveInside(dir, path);
  let real: string;
  try {
    real = realpathSync(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const rel = relative(realpathSync(dir), real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw appError('APP_VALIDATION_FAILED', `path ${path} leads out of the folder through a link`);
  return real;
}

export function removeProjectFolder(workspaceRoot: string, userId: string, projectId: string): void {
  rmSync(projectRoot(workspaceRoot, userId, projectId), { recursive: true, force: true });
}

export function deleteUserWorkspace(workspaceRoot: string, userId: string): void {
  rmSync(userRoot(workspaceRoot, userId), { recursive: true, force: true });
}
