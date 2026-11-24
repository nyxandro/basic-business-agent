// A write of the agent into the folder of the person's computer (spec, section 8.25, «Запись в папку»): the browser's
// tool waits for the person's «Да» on a card the chat draws for its call (the tool and the card meet here by the number
// of the call), then for each file the server keeps a snapshot and the version it replaces, and the browser writes it.
// «Вернуть прежнюю версию» writes the kept version back, by a click of the person.
import type { ComputerSaveResponse, ComputerWriteItem } from '@bba/contracts';
import { useSyncExternalStore } from 'react';
import { apiBlob, apiForm, asApiError } from '../api/client.ts';
import { threadFileUrl } from '../threads/api.ts';
import { FolderError, type DirectoryHandle, type HandleFolder } from './computer-folder.ts';
import { currentFile, ensureWritable, writeFileAt, type Target } from './computer-write.ts';

export interface WriteAskItem {
  file: string;
  to: string;
  exists: Target['exists'];
  // The file was saved on the computer after the agent read it: the write would lose what the person did.
  changedSinceRead: boolean;
}

export interface WriteAsk {
  folder: string;
  items: WriteAskItem[];
}

// --- «Да» of a call ---------------------------------------------------------------------------------

const asks = new Map<string, { ask: WriteAsk; answer: (yes: boolean) => void }>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

// Resolves with the person's answer; a stop of the answer — false, and the card goes.
export function askToWrite(toolCallId: string, ask: WriteAsk, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (yes: boolean) => {
      asks.delete(toolCallId);
      signal?.removeEventListener('abort', stopped);
      changed();
      resolve(yes);
    };
    const stopped = () => done(false);
    if (signal?.aborted) return resolve(false);
    signal?.addEventListener('abort', stopped);
    asks.set(toolCallId, { ask, answer: done });
    changed();
  });
}

export function answerWrite(toolCallId: string, yes: boolean): void {
  asks.get(toolCallId)?.answer(yes);
}

export function pendingWrite(toolCallId: string): WriteAsk | null {
  return asks.get(toolCallId)?.ask ?? null;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function usePendingWrite(toolCallId: string): WriteAsk | null {
  return useSyncExternalStore(subscribe, () => pendingWrite(toolCallId));
}

// --- The folder of a conversation in this tab ----------------------------------------------------------

// The folder the tools of a conversation work with now (set by useComputerTools): «Вернуть прежнюю версию» of a block of
// the chat writes into it.
const threadFolders = new Map<string, HandleFolder>();
const folderListeners = new Set<() => void>();

export function setThreadFolder(threadId: string, folder: HandleFolder | null): void {
  if (folder) threadFolders.set(threadId, folder);
  else threadFolders.delete(threadId);
  folderListeners.forEach((l) => l());
}

const subscribeFolders = (listener: () => void) => {
  folderListeners.add(listener);
  return () => folderListeners.delete(listener);
};

export function useThreadFolder(threadId: string): HandleFolder | null {
  return useSyncExternalStore(subscribeFolders, () => threadFolders.get(threadId) ?? null);
}

// --- What the agent read --------------------------------------------------------------------------

// The time of each file of a folder when the agent read it, for this tab.
const reads = new WeakMap<DirectoryHandle, Map<string, number>>();

export function noteRead(folder: HandleFolder, path: string, lastModified: number): void {
  const map = reads.get(folder.handle) ?? new Map<string, number>();
  map.set(path, lastModified);
  reads.set(folder.handle, map);
}

export function changedSinceRead(folder: HandleFolder, path: string, exists: Target['exists']): boolean {
  const readAt = reads.get(folder.handle)?.get(path);
  return readAt !== undefined && exists !== null && exists.lastModified > readAt;
}

// --- The write --------------------------------------------------------------------------------------

const failureText = (error: unknown): string => (error instanceof FolderError ? error.message : asApiError(error).message);

// One file: the version on the computer goes to the server first, then the snapshot is written over it.
export async function saveToComputer(folder: HandleFolder, threadId: string, item: WriteAskItem): Promise<ComputerWriteItem> {
  try {
    const previous = item.exists ? await currentFile(folder, item.to) : null;
    const form = new FormData();
    form.append('source', item.file);
    form.append('target', item.to);
    if (previous) form.append('previous', previous, previous.name);
    const saved = await apiForm<ComputerSaveResponse>(`/app/api/threads/${encodeURIComponent(threadId)}/computer-saves`, form);
    await writeFileAt(folder, item.to, await apiBlob(threadFileUrl(threadId, saved.snapshot)));
    return { to: item.to, written: true, name: saved.name, bytes: saved.bytes, snapshot: saved.snapshot, previous: saved.previous, replaced: previous !== null };
  } catch (error) {
    return { to: item.to, written: false, error: failureText(error) };
  }
}

// «Вернуть прежнюю версию»: by a click, so the browser may ask for the right to write.
export async function restorePrevious(folder: HandleFolder, threadId: string, to: string, previous: string): Promise<void> {
  const writable = await ensureWritable(folder);
  await writeFileAt(writable, to, await apiBlob(threadFileUrl(threadId, previous)));
}
