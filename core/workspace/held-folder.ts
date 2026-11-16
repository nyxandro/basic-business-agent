// Walking, linking and moving files of a folder the agent writes into, safely against its tricks
// (independent review 16.11): the agent may swap a folder of a path for a link to someone else's
// files, or put a named pipe in place of a file, at any moment. So a folder is opened once — without
// following a link (O_NOFOLLOW) — and its entries are reached through the opened folder itself
// (/proc/self/fd/<fd>/<name> on Linux): a swap after the opening changes nothing. A file is opened
// without waiting (a pipe would hang the server) and only a regular file is read. Elsewhere (macOS,
// development only) the checked path stays, with a narrow race, as in core/workspace/layout.ts.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const LINUX = process.platform === 'linux';
const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const CHUNK = 1024 * 1024;
// A link, a file or nothing where a folder was expected: there is no such folder.
const NOT_A_FOLDER = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

interface Held {
  fd: number;
  // The path that reaches the opened folder itself.
  path: string;
}

function hold(path: string): Held | null {
  let fd: number;
  try {
    fd = openSync(path, DIR);
  } catch (error) {
    if (NOT_A_FOLDER.has((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
  return { fd, path: LINUX ? `/proc/self/fd/${fd}` : path };
}

const release = (held: Held) => closeSync(held.fd);

export interface HeldFile {
  // The path from the walked folder, with «/».
  rel: string;
  ino: number;
  size: number;
  modifiedMs: number;
  // Reaches the file through its opened folder: valid only inside the visit.
  path: string;
}

// Every regular file of `root`, its folders entered without following links. Hidden entries (".renders"
// of the skills, the snapshots) are skipped unless `hidden`.
export function walkRegularFiles(root: string, visit: (file: HeldFile) => void, hidden = false): void {
  let real: string;
  try {
    real = realpathSync(root);
  } catch (error) {
    // No such folder yet (a trash nothing went into): nothing to walk.
    if (NOT_A_FOLDER.has((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
  const top = hold(real);
  if (!top) return;
  const walk = (held: Held, prefix: string) => {
    for (const entry of readdirSync(held.path, { withFileTypes: true })) {
      if (!hidden && entry.name.startsWith('.')) continue;
      const path = join(held.path, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const sub = hold(path);
        if (!sub) continue;
        try {
          walk(sub, rel);
        } finally {
          release(sub);
        }
      } else if (entry.isFile()) {
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (stat?.isFile()) visit({ rel, ino: stat.ino, size: stat.size, modifiedMs: stat.mtimeMs, path });
      }
    }
  };
  try {
    walk(top, '');
  } finally {
    release(top);
  }
}

// The folder of `rel` (its folders from `root`, none a link) held for `work`; null when one of them
// is missing or is not a folder. With `make`, missing folders are made.
export function inFolderOf<T>(root: string, rel: string, make: boolean, work: (folder: string, name: string) => T): T | null {
  const parts = rel.split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) return null;
  let held = hold(realpathSync(root));
  if (!held) return null;
  try {
    for (const part of parts) {
      const next = join(held.path, part);
      if (make && !lstatSync(next, { throwIfNoEntry: false })) mkdirSync(next);
      const sub = hold(next);
      if (!sub) return null;
      release(held);
      held = sub;
    }
    return work(held.path, name);
  } finally {
    release(held);
  }
}

// A regular file opened without waiting and without following a link, or null.
export function openRegular(path: string): number | null {
  let fd: number;
  try {
    fd = openSync(path, FILE);
  } catch (error) {
    if (NOT_A_FOLDER.has((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
  if (fstatSync(fd).isFile()) return fd;
  closeSync(fd);
  return null;
}

// Copies an opened file into a new file `dest`.
export function copyOpened(fd: number, dest: string): void {
  const out = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (let position = 0; ; ) {
      const read = readSync(fd, buffer, 0, CHUNK, position);
      if (read === 0) break;
      writeSync(out, buffer, 0, read);
      position += read;
    }
  } finally {
    closeSync(out);
  }
}

// The two opened files hold the same bytes.
export function sameContent(a: number, b: number): boolean {
  if (fstatSync(a).size !== fstatSync(b).size) return false;
  const x = Buffer.allocUnsafe(CHUNK);
  const y = Buffer.allocUnsafe(CHUNK);
  for (let position = 0; ; position += CHUNK) {
    const n = readSync(a, x, 0, CHUNK, position);
    const m = readSync(b, y, 0, CHUNK, position);
    if (n !== m || !x.subarray(0, n).equals(y.subarray(0, m))) return false;
    if (n === 0) return true;
  }
}

