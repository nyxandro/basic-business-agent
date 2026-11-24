// A write of the agent into the folder of the person's computer (spec, section 8.25, «Запись в папку»): the browser's
// tool waits for the person's «Да» on a card the chat draws for its call (the tool and the card meet here by the number
// of the call), then for each file the server keeps a snapshot and the version it replaces, and the browser writes it.
// «Вернуть прежнюю версию» writes the kept version back, by a click of the person.
import type { ComputerSaveResponse, ComputerWriteItem } from '@bba/contracts';
import { useSyncExternalStore } from 'react';
import { api, apiBlob, apiForm, asApiError } from '../api/client.ts';
import { threadFileUrl } from '../threads/api.ts';
import { FolderError, type DirectoryHandle, type HandleFolder } from './computer-folder.ts';
import { currentFile, ensureWritable, targetOf, writeFileAt, type Target } from './computer-write.ts';

export interface WriteAskItem {
  file: string;
  to: string;
  // The agent asked to replace a file there: without it a file that appears before «Да» is not touched.
  replace: boolean;
  exists: Target['exists'];
  // The file was saved on the computer after the agent read it: the write would lose what the person did.
  changedSinceRead: boolean;
}

export interface WriteAsk {
  threadId: string;
  folder: string;
  items: WriteAskItem[];
}

// --- «Да» of a call ---------------------------------------------------------------------------------

// `stopped` — «Стоп», or the person left the conversation: nothing is written, and the agent is not told «Нет».
export type WriteAnswer = 'yes' | 'no' | 'stopped';

const asks = new Map<string, { ask: WriteAsk; answer: (answer: WriteAnswer) => void }>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

// Resolves with the person's answer; the card is there until then.
export function askToWrite(toolCallId: string, ask: WriteAsk, signal?: AbortSignal): Promise<WriteAnswer> {
  return new Promise((resolve) => {
    const done = (answer: WriteAnswer) => {
      asks.delete(toolCallId);
      signal?.removeEventListener('abort', stopped);
      changed();
      resolve(answer);
    };
    const stopped = () => done('stopped');
    if (signal?.aborted) return resolve('stopped');
    signal?.addEventListener('abort', stopped);
    asks.set(toolCallId, { ask, answer: done });
    changed();
  });
}

export function answerWrite(toolCallId: string, yes: boolean): void {
  asks.get(toolCallId)?.answer(yes ? 'yes' : 'no');
}

// «Стоп» of the input, or the conversation closed: every write it waits on gives up.
export function stopPendingWrites(threadId: string): void {
  for (const [, pending] of [...asks].filter(([, p]) => p.ask.threadId === threadId)) pending.answer('stopped');
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

// The conversation waits for the person's answer on a write: its input waits too, as while the agent answers — a new
// message would run beside the write still to come.
export function useWriteAsked(threadId: string): boolean {
  return useSyncExternalStore(subscribe, () => [...asks.values()].some((p) => p.ask.threadId === threadId));
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

export function threadFolderNow(threadId: string): HandleFolder | null {
  return threadFolders.get(threadId) ?? null;
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

const savesOf = (threadId: string) => `/app/api/threads/${encodeURIComponent(threadId)}/computer-saves`;

// One file: what is at the place is looked at again (the person may have saved a file there while the card waited), the
// version on the computer goes to the server first, then the snapshot is written over it. A write that failed takes its
// save off the server: failed tries do not pile up.
export async function saveToComputer(folder: HandleFolder, threadId: string, item: WriteAskItem): Promise<ComputerWriteItem> {
  let saved: ComputerSaveResponse | null = null;
  try {
    const now = await targetOf(folder, item.to);
    if (now.exists && !item.replace) return { to: item.to, written: false, error: `Пока ждали «Да», на этом месте появился файл «${now.path}» — он не тронут. Попросите агента записать заново.` };
    const previous = now.exists ? await currentFile(folder, item.to) : null;
    const form = new FormData();
    form.append('source', item.file);
    form.append('target', item.to);
    if (previous) form.append('previous', previous, previous.name);
    saved = await apiForm<ComputerSaveResponse>(savesOf(threadId), form);
    await writeFileAt(folder, item.to, await apiBlob(threadFileUrl(threadId, saved.snapshot)));
    // The agent's own write: the next write of the file is not «changed after the agent read it».
    const written = (await targetOf(folder, item.to)).exists;
    if (written) noteRead(folder, item.to, written.lastModified);
    return { to: item.to, written: true, name: saved.name, bytes: saved.bytes, snapshot: saved.snapshot, previous: saved.previous, replaced: previous !== null };
  } catch (error) {
    const failure = failureText(error);
    if (!saved) return { to: item.to, written: false, error: failure };
    try {
      await api('DELETE', `${savesOf(threadId)}/${encodeURIComponent(saved.id)}`);
    } catch (cleanup) {
      return { to: item.to, written: false, error: `${failure} Копию на сервере убрать не удалось: ${failureText(cleanup)}` };
    }
    return { to: item.to, written: false, error: failure };
  }
}

// «Вернуть прежнюю версию»: by a click, so the browser may ask for the right to write.
export async function restorePrevious(folder: HandleFolder, threadId: string, to: string, previous: string): Promise<void> {
  const writable = await ensureWritable(folder);
  await writeFileAt(writable, to, await apiBlob(threadFileUrl(threadId, previous)));
}
