// A folder of the person's computer for tests (spec, section 8.25): the File System Access API over a plain object — a
// File is a file, an object a folder. `access` answers queryPermission for a mode; `request` — what the browser answers to
// requestPermission; `fail` — the name of the error a write throws; `gone` — the folder was removed from the computer.
import { vi } from 'vitest';
import type { DirectoryHandle, FolderMode, HandleFolder } from '../projects/computer-folder.ts';

export type Tree = { [name: string]: Tree | File };

export interface Fake {
  handle: DirectoryHandle;
  asked: FolderMode[];
}

export function fakeFolder(tree: Tree, options: { access?: Partial<Record<FolderMode, PermissionState>>; request?: PermissionState; fail?: string; gone?: boolean } = {}): Fake {
  const asked: FolderMode[] = [];
  // As the browser: what the person allows is the answer from then on.
  const access: Partial<Record<FolderMode, PermissionState>> = { ...options.access };
  const dirOf = (name: string, node: Tree): DirectoryHandle => ({
    kind: 'directory',
    name,
    async *values() {
      if (options.gone) throw new DOMException('gone', 'NotFoundError');
      for (const [n, v] of Object.entries(node)) yield await Promise.resolve(v instanceof File ? fileOf(n, node) : dirOf(n, v));
    },
    getDirectoryHandle: (n: string, o?: { create?: boolean }) => {
      const v = node[n];
      if (v instanceof File) return Promise.reject(new DOMException('a file', 'TypeMismatchError'));
      if (v) return Promise.resolve(dirOf(n, v));
      if (!o?.create) return Promise.reject(new DOMException('no', 'NotFoundError'));
      node[n] = {};
      return Promise.resolve(dirOf(n, node[n]));
    },
    getFileHandle: (n: string, o?: { create?: boolean }) => {
      const v = node[n];
      if (v && !(v instanceof File)) return Promise.reject(new DOMException('a folder', 'TypeMismatchError'));
      if (!v && !o?.create) return Promise.reject(new DOMException('no', 'NotFoundError'));
      if (!v) node[n] = new File([], n);
      return Promise.resolve(fileOf(n, node));
    },
    queryPermission: ({ mode }) => Promise.resolve(access[mode] ?? 'granted'),
    requestPermission: ({ mode }) => {
      asked.push(mode);
      const answer = options.request ?? 'granted';
      access[mode] = answer;
      return Promise.resolve(answer);
    },
  });
  const fileOf = (n: string, node: Tree) => ({
    kind: 'file' as const,
    name: n,
    getFile: () => Promise.resolve(node[n] as File),
    createWritable: () => {
      if (options.fail) return Promise.reject(new DOMException('failed', options.fail));
      let written: Blob = new Blob([]);
      return Promise.resolve({
        write: (data: Blob) => {
          written = data;
          return Promise.resolve();
        },
        close: () => {
          node[n] = new File([written], n, { lastModified: Date.UTC(2026, 10, 25, 9) });
          return Promise.resolve();
        },
        abort: () => Promise.resolve(),
      });
    },
  });
  return { handle: dirOf('Тендер', tree), asked };
}

export const folderOn = (fake: Fake, mode: FolderMode = 'readwrite'): HandleFolder => ({ kind: 'handle', name: 'Тендер', handle: fake.handle, mode });

// The text of the file at `path` of the tree.
export async function textAt(tree: Tree, ...path: string[]): Promise<string> {
  let node: Tree | File = tree;
  for (const p of path) node = (node as Tree)[p]!;
  return (node as File).text();
}

// --- The browser around the folder ------------------------------------------------------------------

// IndexedDB of this browser, where the folder is kept (computer-folder.ts): one store, values by key, answered a moment later.
export function stubFolderStore(): Map<string, unknown> {
  const kept = new Map<string, unknown>();
  const request = <T,>(value: () => T) => {
    const r: { result?: T; onsuccess: (() => void) | null; onerror: (() => void) | null } = { onsuccess: null, onerror: null };
    setTimeout(() => {
      r.result = value();
      r.onsuccess?.();
    }, 0);
    return r;
  };
  const db = {
    transaction: () => ({
      objectStore: () => ({
        get: (key: string) => request(() => kept.get(key)),
        put: (value: unknown, key: string) => request(() => void kept.set(key, value)),
        delete: (key: string) => request(() => void kept.delete(key)),
      }),
    }),
    createObjectStore: () => undefined,
    close: () => undefined,
  };
  vi.stubGlobal('indexedDB', { open: () => request(() => db) });
  return kept;
}

// The folder picker of Chrome and its kin (`write` — files can be written too): resolves with `handle`, records the modes asked.
export function stubPicker(handle: DirectoryHandle | null, options: { write?: boolean } = {}): { modes: FolderMode[] } {
  const asked = { modes: [] as FolderMode[] };
  vi.stubGlobal('showDirectoryPicker', ({ mode }: { mode: FolderMode }) => {
    asked.modes.push(mode);
    return handle ? Promise.resolve(handle) : Promise.reject(new DOMException('closed', 'AbortError'));
  });
  vi.stubGlobal('FileSystemFileHandle', options.write === false ? function NoWrite() {} : Object.assign(function Writable() {}, { prototype: { createWritable: () => undefined } }));
  return asked;
}
