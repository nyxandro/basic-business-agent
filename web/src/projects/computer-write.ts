// Writing into the folder of the person's computer (spec, section 8.25, «Запись в папку»): a folder given «Читать и
// записывать» in Chrome and its kin. The browser writes a file through a temporary copy and puts it in place of the old
// one only at the end (File System Access API, createWritable): a tab closed halfway leaves the old file whole.
// Nothing is removed or renamed on the computer.
import { entryOf, FolderError, partsOf, type ComputerFolder, type DirectoryHandle, type FileHandle, type HandleFolder } from './computer-folder.ts';

// The browser can write a folder it keeps: the folder picker and a writable file (Firefox, Safari and Brave have neither).
export function canWriteFolder(): boolean {
  const handleOfFile = (window as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle;
  return typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function' && handleOfFile !== undefined && 'createWritable' in handleOfFile.prototype;
}

export function writableFolder(folder: ComputerFolder): HandleFolder | null {
  return folder.kind === 'handle' && folder.mode === 'readwrite' ? folder : null;
}

const named = (error: unknown): string => (error instanceof DOMException ? error.name : '');

// The right to write, now: granted — on; asked — the browser asks the person (only within a click of theirs); refused —
// what to do.
export async function ensureWritable(folder: ComputerFolder): Promise<HandleFolder> {
  const writable = writableFolder(folder);
  if (!writable) throw new FolderError(`Папка «${folder.name}» подключена только для чтения: запись включается в настройках проекта — «Читать и записывать».`);
  let access = await writable.handle.queryPermission({ mode: 'readwrite' });
  if (access === 'prompt') access = await writable.handle.requestPermission({ mode: 'readwrite' });
  if (access !== 'granted') {
    throw new FolderError(`Браузер запретил этому сайту изменять файлы в папке «${folder.name}». Разрешить можно в настройках сайта (значок слева от адреса) или переключить папку на «Только читать».`);
  }
  return writable;
}

// The folder at `parts`, its name written either way (a folder from a Mac is not made twice); `create` — made if not there.
async function folderAt(root: DirectoryHandle, parts: readonly string[], create: boolean): Promise<DirectoryHandle | null> {
  let dir = root;
  for (const [i, part] of parts.entries()) {
    try {
      const there = await entryOf(dir, part, 'directory');
      if (there) dir = there;
      else if (create) dir = await dir.getDirectoryHandle(part, { create: true });
      else return null;
    } catch (error) {
      if (named(error) === 'TypeMismatchError') throw new FolderError(`«${parts.slice(0, i + 1).join('/')}» — файл, а не папка.`);
      throw error;
    }
  }
  return dir;
}

function split(path: string): { parts: string[]; name: string; clean: string } {
  const parts = partsOf(path);
  const name = parts.pop();
  if (!name) throw new FolderError('Укажите путь файла.');
  return { parts, name, clean: [...parts, name].join('/') };
}

export interface Target {
  path: string;
  // The file there now; null — the write makes a new one.
  exists: { bytes: number; lastModified: number } | null;
}

// What is at `path` now, without making anything.
export async function targetOf(folder: HandleFolder, path: string): Promise<Target> {
  const { parts, name, clean } = split(path);
  const dir = await folderAt(folder.handle, parts, false);
  if (!dir) return { path: clean, exists: null };
  let handle: FileHandle | null;
  try {
    handle = await entryOf(dir, name, 'file');
  } catch (error) {
    if (named(error) === 'TypeMismatchError') throw new FolderError(`«${clean}» — папка, а не файл.`);
    throw error;
  }
  if (!handle) return { path: clean, exists: null };
  const file = await handle.getFile();
  return { path: clean, exists: { bytes: file.size, lastModified: file.lastModified } };
}

// The file at `path` now — the version a write is about to replace.
export async function currentFile(folder: HandleFolder, path: string): Promise<File | null> {
  const { parts, name } = split(path);
  const dir = await folderAt(folder.handle, parts, false);
  if (!dir) return null;
  const handle = await entryOf(dir, name, 'file');
  return handle ? handle.getFile() : null;
}

function writeFailure(error: unknown, path: string): FolderError {
  switch (named(error)) {
    case 'NoModificationAllowedError':
    case 'InvalidStateError':
      return new FolderError(`Не удалось записать «${path}»: файл занят другой программой (например, открыт в Word). Закройте его и попробуйте снова.`);
    case 'QuotaExceededError':
      return new FolderError(`Не удалось записать «${path}»: на диске не хватает места.`);
    case 'NotAllowedError':
    case 'SecurityError':
      return new FolderError(`Браузер не дал записать «${path}»: нет разрешения на запись в папку.`);
    case 'NotFoundError':
      return new FolderError(`Не удалось записать «${path}»: папки больше нет на компьютере.`);
    default:
      return new FolderError(`Не удалось записать «${path}»: ${(error as Error).message}`);
  }
}

// Writes `data` at `path`, making the folders on its way; a file there — its name written either way — is replaced.
export async function writeFileAt(folder: HandleFolder, path: string, data: Blob): Promise<void> {
  const { parts, name, clean } = split(path);
  try {
    const dir = (await folderAt(folder.handle, parts, true))!;
    const handle = (await entryOf(dir, name, 'file')) ?? (await dir.getFileHandle(name, { create: true }));
    const writable = await handle.createWritable();
    try {
      await writable.write(data);
    } catch (error) {
      await writable.abort();
      throw error;
    }
    await writable.close();
  } catch (error) {
    if (error instanceof FolderError) throw error;
    throw writeFailure(error, clean);
  }
}
