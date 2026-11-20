// The employee's workspace (spec, sections 8.7, 8.9 and 8.33):
//   /workspace/<userId>/files/                     — the area of the person's conversations outside projects
//   /workspace/<userId>/files/chats/<threadId>/    — the folder of one such conversation
//   /workspace/<userId>/projects/<projectId>/files — files of a project, shared by all its conversations
// A conversation's sandbox root is its own folder, or its project's: the agent works freely inside it, cannot
// see the others, and cannot remove the root itself (it is the sandbox mount point).
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { inFolderOf, walkRegularFiles } from './held-folder.ts';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } from '@bba/contracts';
import { appError } from '../errors/catalog.ts';

const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// As the numbers of conversations are (core/chat/run.ts): no dot, no slash — a name of one folder.
const SAFE_THREAD_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const FILES = 'files';
// The folders of the conversations outside projects, inside the person's area (spec, section 8.33).
export const CHATS = 'chats';
const MAX_NAME_LENGTH = 120;
// The listing shown to people and the model stops here; a project with more needs the knowledge base.
export const MAX_LISTED_FILES = 500;
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(UPLOAD_EXTENSIONS);

export function userRoot(workspaceRoot: string, userId: string): string {
  if (!SAFE_USER_ID.test(userId)) throw new Error(`unsafe user id for a workspace path: ${userId}`);
  return join(workspaceRoot, userId);
}

// The folder of a project — its files, trash and working snapshots — with the project's creator.
export function projectRoot(workspaceRoot: string, userId: string, projectId: string): string {
  if (!SAFE_PROJECT_ID.test(projectId)) throw new Error(`unsafe project id for a workspace path: ${projectId}`);
  return join(userRoot(workspaceRoot, userId), 'projects', projectId);
}

// Where the files folder of a project (`userId` — its creator) or of the person's conversations outside
// projects is; not made — reading it, a missing folder is just no files.
export function filesRoot(workspaceRoot: string, userId: string, projectId: string | null): string {
  return projectId ? join(projectRoot(workspaceRoot, userId, projectId), FILES) : join(userRoot(workspaceRoot, userId), FILES);
}

// A conversation outside projects: its folder in the person's area, and the same as a path of the area.
export function chatPath(threadId: string): string {
  if (!SAFE_THREAD_ID.test(threadId)) throw new Error(`unsafe thread id for a workspace path: ${threadId}`);
  return `${CHATS}/${threadId}`;
}

export function chatRoot(workspaceRoot: string, userId: string, threadId: string): string {
  return join(filesRoot(workspaceRoot, userId, null), chatPath(threadId));
}

// The folder a conversation works in (spec, section 8.33): its project's, shared by all the project's conversations
// (`ownerId` — the project's creator), or its own; created on first use.
export function conversationRoot(workspaceRoot: string, place: { userId: string; threadId: string; project: { id: string; ownerId: string } | null }): string {
  const dir = place.project ? filesRoot(workspaceRoot, place.project.ownerId, place.project.id) : chatRoot(workspaceRoot, place.userId, place.threadId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The files folder of a project or of the person's area; created on first use.
export function contextRoot(workspaceRoot: string, userId: string, projectId: string | null): string {
  const dir = filesRoot(workspaceRoot, userId, projectId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function safeFileName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  const base = last.replace(/[^\p{L}\p{N}._ ()-]/gu, '_').replace(/^\.+/, '').trim();
  return base.slice(-MAX_NAME_LENGTH) || 'file';
}

export function freeName(dir: string, name: string): string {
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

// Saves a file into a subfolder of a folder the agent writes into (an attachment of a letter, a file of the
// person's computer): the subfolder and its folders are reached without following a link the agent may
// have put there, the name gets « (2)» when taken, the bytes appear under the name only when whole.
export function saveInFolder(root: string, folder: string, fileName: string, data: Uint8Array, options: { anyType?: boolean } = {}): { name: string; path: string; bytes: number } {
  const clean = safeFileName(fileName);
  if (!options.anyType && !ALLOWED_EXTENSIONS.has(extname(clean).toLowerCase())) throw appError('APP_UPLOAD_TYPE_UNSUPPORTED', `extension of ${clean} is not allowed`);
  if (data.byteLength > MAX_UPLOAD_BYTES) throw appError('APP_UPLOAD_TOO_LARGE', `${clean} is ${data.byteLength} bytes`);
  const placed = inFolderOf(root, `${folder}/${clean}`, true, (held) => {
    const name = freeName(held, clean);
    const temp = join(held, `.upload-${randomUUID()}`);
    try {
      writeFileSync(temp, data, { flag: 'wx' });
      linkSync(temp, join(held, name));
    } finally {
      rmSync(temp, { force: true });
    }
    return name;
  });
  if (placed === null) throw appError('APP_VALIDATION_FAILED', `${folder} in the working folder is not a folder`, { userMessage: `«${folder}» в рабочей папке — не папка. Переименуйте этот файл и повторите.` });
  return { name: placed, path: `${folder}/${placed}`, bytes: data.byteLength };
}

// A copy kept at a path of its own inside a folder the agent writes into (a file of the person's computer,
// spec section 8.25): each part of the path made safe, folders reached without following links, an older
// copy at the same path replaced whole (a link put there is replaced, never followed).
// `folder` is the server's own (a working folder such as «.computer»), `path` comes from the person.
export function putInFolder(root: string, folder: string, path: string, data: Uint8Array): { path: string; bytes: number } {
  const parts = path.split(/[\\/]/).filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.some((p) => p === '..')) throw appError('APP_VALIDATION_FAILED', `bad path ${path}`, { userMessage: 'Неверный путь файла.' });
  if (data.byteLength > MAX_UPLOAD_BYTES) throw appError('APP_UPLOAD_TOO_LARGE', `${path} is ${data.byteLength} bytes`);
  const clean = [folder, ...parts.map(safeFileName)].join('/');
  const placed = inFolderOf(root, clean, true, (held, name) => {
    const temp = join(held, `.upload-${randomUUID()}`);
    try {
      writeFileSync(temp, data, { flag: 'wx' });
      renameSync(temp, join(held, name));
    } finally {
      rmSync(temp, { force: true });
    }
    return true;
  });
  if (placed === null) throw appError('APP_VALIDATION_FAILED', `a folder of ${clean} is not a folder`, { userMessage: 'Не удалось положить файл в рабочую папку: на его месте другая папка или файл.' });
  return { path: clean, bytes: data.byteLength };
}

// Removes the files of a working subfolder changed longer ago than `ms` (copies of the person's computer).
// Walked without following links; a missing subfolder is nothing to do.
export function pruneOlderThan(root: string, folder: string, ms: number): number {
  // Where the subfolder really is, and only inside `root`: the agent may have made a part of it a link.
  const base = existingInside(root, folder);
  if (!base || !statSync(base).isDirectory()) return 0;
  const before = Date.now() - ms;
  const old: string[] = [];
  walkRegularFiles(base, (file) => void (file.modifiedMs < before && old.push(file.rel)), true);
  let removed = 0;
  for (const rel of old) if (removeFileInside(base, rel)) removed++;
  return removed;
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
    // A folder of the path turned into a link while it was being looked up.
    if ((error as NodeJS.ErrnoException).code === 'EINVAL') throw appError('APP_VALIDATION_FAILED', `path ${path} changed while it was checked`, { cause: error });
    throw error;
  }
  if (real === realpathSync(dir) || outside(realpathSync(dir), real)) throw appError('APP_VALIDATION_FAILED', `path ${path} leads out of the folder through a link`);
  return real;
}

// Where an opened file or folder really is. Linux tells it for the descriptor itself, so no change of
// the path after the opening can fool the check (an agent swaps a folder of the path for a link to
// the server's files and back in a loop; looking the path up again lost that race — independent
// review 15.11). Elsewhere (macOS, development only) the path is looked up again and compared by
// device and inode, which leaves a narrow race.
function placeOfOpened(fd: number, again: () => string | null): string | null {
  if (process.platform === 'linux') return readlinkSync(`/proc/self/fd/${fd}`);
  const path = again();
  if (!path) return null;
  const opened = fstatSync(fd);
  const current = statSync(path);
  return current.dev === opened.dev && current.ino === opened.ino ? path : null;
}

// Opens `real` and keeps it open only if what was opened is inside `dir` (`root`: the folder itself
// counts, as the parent of a file of its top level).
function openChecked(dir: string, real: string, flags: number, again: () => string | null, root: boolean): number | null {
  let fd: number;
  try {
    fd = openSync(real, flags);
  } catch (error) {
    if (noFile(error)) return null;
    throw error;
  }
  try {
    const place = placeOfOpened(fd, again);
    const top = realpathSync(dir);
    if (!place || outside(top, place) || (!root && place === top)) throw appError('APP_VALIDATION_FAILED', `${real} changed while it was opened`);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// There is a regular file at this path of `dir` (a link inside it to one counts).
export function isFileInside(dir: string, path: string): boolean {
  const real = existingInside(dir, path);
  return real !== null && statSync(real).isFile();
}

// A regular file of `dir` opened for reading, or null when there is none (a folder, a pipe, nothing).
// Opened without waiting: a pipe put in place of a file would otherwise hang the server.
export function openFileInside(dir: string, path: string): { fd: number; size: number } | null {
  const real = existingInside(dir, path);
  if (!real) return null;
  const fd = openChecked(dir, real, constants.O_RDONLY | constants.O_NONBLOCK, () => existingInside(dir, path), false);
  if (fd === null) return null;
  const stat = fstatSync(fd);
  if (stat.isFile()) return { fd, size: stat.size };
  closeSync(fd);
  return null;
}

// Moves a regular file of `dir` to `dest` (outside it, on the same disk) — into the project's trash
// (spec, section 8.20). Null when there is no regular file; a link is not moved (the caller removes
// it). Like removeFileInside, the entry is taken from the folder that was opened and checked.
export function moveFileOutOf(dir: string, path: string, dest: string): { bytes: number } | null {
  const full = resolveInside(dir, path);
  const parentPath = relative(dir, dirname(full));
  const parentOf = () => (parentPath === '' ? realpathSync(dir) : existingInside(dir, parentPath));
  const parent = parentOf();
  if (!parent) return null;
  const fd = openChecked(dir, parent, constants.O_RDONLY | constants.O_DIRECTORY, parentOf, true);
  if (fd === null) return null;
  try {
    const entry = join(process.platform === 'linux' ? `/proc/self/fd/${fd}` : parent, basename(full));
    const stat = lstatSync(entry, { throwIfNoEntry: false });
    if (!stat?.isFile()) return null;
    mkdirSync(dirname(dest), { recursive: true });
    try {
      renameSync(entry, dest);
    } catch (error) {
      if (noFile(error)) return null;
      throw error;
    }
    return { bytes: stat.size };
  } finally {
    closeSync(fd);
  }
}

// Removes a file of `dir` (a link — the link itself); false when there is no file. The entry is
// removed in the folder that was opened and checked, not by its path again.
export function removeFileInside(dir: string, path: string): boolean {
  const full = resolveInside(dir, path);
  const parentPath = relative(dir, dirname(full));
  const parentOf = () => (parentPath === '' ? realpathSync(dir) : existingInside(dir, parentPath));
  const parent = parentOf();
  if (!parent) return false;
  const fd = openChecked(dir, parent, constants.O_RDONLY | constants.O_DIRECTORY, parentOf, true);
  if (fd === null) return false;
  try {
    // Linux names the opened folder itself by its descriptor; elsewhere (macOS for development)
    // the checked path stays.
    const entry = join(process.platform === 'linux' ? `/proc/self/fd/${fd}` : parent, basename(full));
    const stat = lstatSync(entry, { throwIfNoEntry: false });
    if (!stat || !(stat.isFile() || stat.isSymbolicLink())) return false;
    try {
      unlinkSync(entry);
    } catch (error) {
      // Gone meanwhile, or swapped for a folder (EISDIR; some systems say EPERM): there is no file.
      if (noFile(error) || ['EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
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
