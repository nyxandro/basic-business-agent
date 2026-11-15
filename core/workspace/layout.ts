// The employee's workspace (spec, sections 8.7 and 8.9):
//   /workspace/<userId>/files/                     — files of conversations outside projects
//   /workspace/<userId>/projects/<projectId>/files — files of a project
// A conversation's sandbox root is one of these files folders: the agent works freely inside it,
// cannot see the others, and cannot remove the root itself (it is the sandbox mount point).
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
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

// No such file: missing, a broken link, a path through a file, a link to itself.
const NO_FILE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);
const noFile = (error: unknown) => NO_FILE.has((error as NodeJS.ErrnoException).code ?? '');

const outside = (root: string, real: string) => {
  const rel = relative(root, real);
  return rel.startsWith('..') || isAbsolute(rel);
};

// The real place of an existing file or folder of `dir`, or null when there is none. The server reads
// these files outside the sandbox, and the agent can make links in its folder
// (ln -s /proc/self/environ x.docx): a link is followed only to a place inside the folder.
export function existingInside(dir: string, path: string): string | null {
  const full = resolveInside(dir, path);
  let real: string;
  try {
    real = realpathSync(full);
  } catch (error) {
    if (noFile(error)) return null;
    throw error;
  }
  if (real === realpathSync(dir) || outside(realpathSync(dir), real)) throw appError('APP_VALIDATION_FAILED', `path ${path} leads out of the folder through a link`);
  return real;
}

// Opens `real` and makes sure the opened thing is what `check()` finds inside the folder after the
// opening: the agent can swap a folder of the path for a link between a check and an open, and the
// server would read or delete outside (the way of Mastra's LocalFilesystem.openContainedPath).
function openChecked(real: string, flags: number, check: () => string | null): number | null {
  let fd: number;
  try {
    fd = openSync(real, flags);
  } catch (error) {
    if (noFile(error)) return null;
    throw error;
  }
  try {
    const opened = fstatSync(fd);
    const again = check();
    const current = again ? statSync(again) : null;
    if (!current || current.dev !== opened.dev || current.ino !== opened.ino) throw appError('APP_VALIDATION_FAILED', `${real} changed while it was opened`);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// A regular file of `dir` opened for reading, or null when there is none (a folder, a pipe, nothing).
// Opened without waiting: a pipe put in place of a file would otherwise hang the server.
export function openFileInside(dir: string, path: string): { fd: number; size: number } | null {
  const real = existingInside(dir, path);
  if (!real) return null;
  const fd = openChecked(real, constants.O_RDONLY | constants.O_NONBLOCK, () => existingInside(dir, path));
  if (fd === null) return null;
  const stat = fstatSync(fd);
  if (stat.isFile()) return { fd, size: stat.size };
  closeSync(fd);
  return null;
}

// Removes a file of `dir` (a link — the link itself); false when there is no file. The entry is
// removed in the folder that was opened and checked, not by its path again.
export function removeFileInside(dir: string, path: string): boolean {
  const full = resolveInside(dir, path);
  const parentPath = relative(dir, dirname(full));
  const parentOf = () => (parentPath === '' ? realpathSync(dir) : existingInside(dir, parentPath));
  const parent = parentOf();
  if (!parent) return false;
  const fd = openChecked(parent, constants.O_RDONLY | constants.O_DIRECTORY, parentOf);
  if (fd === null) return false;
  try {
    // Linux names the opened folder itself by its descriptor; elsewhere (macOS for development)
    // the checked path stays.
    const entry = join(process.platform === 'linux' ? `/proc/self/fd/${fd}` : parent, basename(full));
    const stat = lstatSync(entry, { throwIfNoEntry: false });
    if (!stat || !(stat.isFile() || stat.isSymbolicLink())) return false;
    unlinkSync(entry);
    return true;
  } finally {
    closeSync(fd);
  }
}

export function removeProjectFolder(workspaceRoot: string, userId: string, projectId: string): void {
  rmSync(projectRoot(workspaceRoot, userId, projectId), { recursive: true, force: true });
}

export function deleteUserWorkspace(workspaceRoot: string, userId: string): void {
  rmSync(userRoot(workspaceRoot, userId), { recursive: true, force: true });
}
