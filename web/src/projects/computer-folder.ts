// A folder of the person's computer given to a project (spec, section 8.25). The agent works on the server and
// cannot see the computer: the browser holds the folder and answers the agent's questions about it (tools
// of the browser, computer-tools.ts). Chrome, Edge and Yandex Browser keep the folder itself
// (File System Access API: the handle is remembered in IndexedDB of this browser, the right to read it — by
// the browser, which may ask once more after a restart). Firefox and Safari have no such way: the folder is
// chosen with a file input and kept only while the tab is open.
// Nothing is copied ahead: a file goes anywhere only when the agent reads it.

// What the browser offers on top of lib.dom (WICG File System Access).
interface ReadableHandle {
  kind: 'file' | 'directory';
  name: string;
}
interface FileHandle extends ReadableHandle {
  kind: 'file';
  getFile(): Promise<File>;
}
export interface DirectoryHandle extends ReadableHandle {
  kind: 'directory';
  values(): AsyncIterable<FileHandle | DirectoryHandle>;
  getDirectoryHandle(name: string): Promise<DirectoryHandle>;
  getFileHandle(name: string): Promise<FileHandle>;
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
}
type Picker = (options: { mode: 'read'; id?: string }) => Promise<DirectoryHandle>;

export type ComputerFolder =
  // The folder itself, kept by this browser.
  | { kind: 'handle'; name: string; handle: DirectoryHandle }
  // Files chosen once, kept while the tab is open (webkitRelativePath without the folder's name).
  | { kind: 'files'; name: string; files: Map<string, File> };

export type FolderAccess = 'granted' | 'prompt' | 'denied';

export interface Entry {
  path: string;
  kind: 'file' | 'folder';
  bytes?: number;
  modified?: string;
}

// Folders that hold the tools of programs rather than the person's documents: not walked by a search.
const SKIPPED = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);
const MAX_LISTED = 300;
const MAX_FOUND = 100;
const MAX_WALKED = 5000;

export function canKeepFolder(): boolean {
  return typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

// --- Where the choice is kept ---------------------------------------------------------------

const DB = 'bba-computer-folders';
const STORE = 'folders';
const inMemory = new Map<string, ComputerFolder>();
const listeners = new Set<(projectId: string) => void>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB is not available'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  } finally {
    db.close();
  }
}

const told = (projectId: string) => listeners.forEach((l) => l(projectId));

export function onFolderChange(listener: (projectId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function folderOf(projectId: string): Promise<ComputerFolder | null> {
  const kept = inMemory.get(projectId);
  if (kept) return kept;
  if (!canKeepFolder()) return null;
  const stored = await withStore<{ name: string; handle: DirectoryHandle } | undefined>('readonly', (s) => s.get(projectId) as IDBRequest<{ name: string; handle: DirectoryHandle } | undefined>).catch(() => undefined);
  if (!stored) return null;
  const folder: ComputerFolder = { kind: 'handle', name: stored.name, handle: stored.handle };
  inMemory.set(projectId, folder);
  return folder;
}

// Chrome and its kin: the folder is chosen and kept. Null when the person closed the window.
export async function pickFolder(projectId: string): Promise<ComputerFolder | null> {
  const picker = (window as unknown as { showDirectoryPicker: Picker }).showDirectoryPicker;
  let handle: DirectoryHandle;
  try {
    handle = await picker({ mode: 'read', id: 'bba-project-folder' });
  } catch (error) {
    if ((error as DOMException).name === 'AbortError') return null;
    throw error;
  }
  const folder: ComputerFolder = { kind: 'handle', name: handle.name, handle };
  await withStore('readwrite', (s) => s.put({ name: handle.name, handle }, projectId));
  inMemory.set(projectId, folder);
  told(projectId);
  return folder;
}

// Firefox and Safari: the files of a folder chosen with an input, for this tab.
export function adoptFiles(projectId: string, list: FileList): ComputerFolder | null {
  const files = new Map<string, File>();
  let name = '';
  for (const file of Array.from(list)) {
    const [top, ...rest] = (file.webkitRelativePath || file.name).split('/');
    name ||= top ?? '';
    if (rest.length > 0) files.set(rest.join('/'), file);
  }
  if (!name) return null;
  const folder: ComputerFolder = { kind: 'files', name, files };
  inMemory.set(projectId, folder);
  told(projectId);
  return folder;
}

export async function forgetFolder(projectId: string): Promise<void> {
  inMemory.delete(projectId);
  if (canKeepFolder()) await withStore('readwrite', (s) => s.delete(projectId)).catch(() => undefined);
  told(projectId);
}

export async function accessOf(folder: ComputerFolder): Promise<FolderAccess> {
  if (folder.kind === 'files') return 'granted';
  return folder.handle.queryPermission({ mode: 'read' });
}

// Needs a click of the person: the browser asks them.
export async function allowAccess(projectId: string, folder: ComputerFolder): Promise<FolderAccess> {
  if (folder.kind === 'files') return 'granted';
  const access = await folder.handle.requestPermission({ mode: 'read' });
  told(projectId);
  return access;
}

// --- Reading -------------------------------------------------------------------------------------

export class FolderError extends Error {}

// «Договоры/2026» → its parts; nothing that leads out of the folder.
export function partsOf(path: string): string[] {
  const parts = path.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new FolderError(`Путь «${path}» ведёт за пределы папки.`);
  return parts;
}

async function directoryAt(root: DirectoryHandle, parts: string[]): Promise<DirectoryHandle> {
  let dir = root;
  for (const part of parts) {
    try {
      dir = await dir.getDirectoryHandle(part);
    } catch {
      throw new FolderError(`Папки «${parts.join('/')}» нет.`);
    }
  }
  return dir;
}

const byName = (a: Entry, b: Entry) => (a.kind === b.kind ? a.path.localeCompare(b.path, 'ru') : a.kind === 'folder' ? -1 : 1);

// The files and folders right inside `path` (the folder itself for '').
export async function listEntries(folder: ComputerFolder, path: string): Promise<{ entries: Entry[]; more: boolean }> {
  const parts = partsOf(path);
  const prefix = parts.length ? `${parts.join('/')}/` : '';
  const out: Entry[] = [];
  if (folder.kind === 'files') {
    const folders = new Set<string>();
    for (const [rel, file] of folder.files) {
      if (!rel.startsWith(prefix)) continue;
      const [first, ...rest] = rel.slice(prefix.length).split('/');
      if (rest.length > 0) folders.add(first!);
      else out.push({ path: rel, kind: 'file', bytes: file.size, modified: new Date(file.lastModified).toISOString() });
    }
    out.push(...[...folders].map((f) => ({ path: `${prefix}${f}`, kind: 'folder' as const })));
    if (out.length === 0 && parts.length > 0) throw new FolderError(`Папки «${parts.join('/')}» нет.`);
  } else {
    const dir = await directoryAt(folder.handle, parts);
    for await (const entry of dir.values()) {
      if (entry.kind === 'directory') out.push({ path: `${prefix}${entry.name}`, kind: 'folder' });
      else {
        const file = await entry.getFile();
        out.push({ path: `${prefix}${entry.name}`, kind: 'file', bytes: file.size, modified: new Date(file.lastModified).toISOString() });
      }
      if (out.length > MAX_LISTED) break;
    }
  }
  out.sort(byName);
  return { entries: out.slice(0, MAX_LISTED), more: out.length > MAX_LISTED };
}

// Files whose path holds every word of the query, without regard to case and «ё».
export async function findFiles(folder: ComputerFolder, query: string): Promise<{ files: Entry[]; more: boolean }> {
  const norm = (s: string) => s.toLocaleLowerCase('ru').replace(/ё/g, 'е');
  const words = norm(query).split(/\s+/).filter(Boolean);
  const hit = (rel: string) => words.every((w) => norm(rel).includes(w));
  const found: Entry[] = [];
  if (folder.kind === 'files') {
    for (const [rel, file] of folder.files) if (hit(rel) && !rel.split('/').some((p) => SKIPPED.has(p))) found.push({ path: rel, kind: 'file', bytes: file.size, modified: new Date(file.lastModified).toISOString() });
  } else {
    let walked = 0;
    const walk = async (dir: DirectoryHandle, prefix: string): Promise<void> => {
      for await (const entry of dir.values()) {
        if (++walked > MAX_WALKED || found.length > MAX_FOUND) return;
        const rel = `${prefix}${entry.name}`;
        if (entry.kind === 'directory') {
          if (!SKIPPED.has(entry.name) && !entry.name.startsWith('.')) await walk(entry, `${rel}/`);
        } else if (hit(rel)) {
          const file = await entry.getFile();
          found.push({ path: rel, kind: 'file', bytes: file.size, modified: new Date(file.lastModified).toISOString() });
        }
      }
    };
    await walk(folder.handle, '');
  }
  found.sort(byName);
  return { files: found.slice(0, MAX_FOUND), more: found.length > MAX_FOUND };
}

export async function fileAt(folder: ComputerFolder, path: string): Promise<File> {
  const parts = partsOf(path);
  const name = parts.pop();
  if (!name) throw new FolderError('Укажите путь файла.');
  if (folder.kind === 'files') {
    const file = folder.files.get([...parts, name].join('/'));
    if (!file) throw new FolderError(`Файла «${path}» нет.`);
    return file;
  }
  const dir = await directoryAt(folder.handle, parts);
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    throw new FolderError(`Файла «${path}» нет.`);
  }
}
