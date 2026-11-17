import type { RenameThreadResponse, RetryTurnResponse, ThreadFileStatus, ThreadNameResponse, ThreadPage, UploadedFile } from '@bba/contracts';
import { api, apiFormWithProgress } from '../api/client.ts';

const enc = encodeURIComponent;

// A page of the list of all conversations in the window of «Поиск».
export const THREAD_PAGE = 30;

// Conversations of all the person's agents, newest first, `limit` at a time; `before` continues
// after a page, `projectId` keeps those of one project.
export function fetchThreadPage(query: { limit: number; before?: string | null }): Promise<ThreadPage> {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.before) params.set('before', query.before);
  return api<ThreadPage>('GET', `/app/api/threads?${params.toString()}`);
}
// «Скачать» of the file block: a file of the folder of the conversation (spec, section 8.18).
export const threadFileUrl = (threadId: string, path: string) => `/app/api/threads/${enc(threadId)}/file?path=${enc(path)}`;
export const fetchThreadFileStatus = (threadId: string, path: string) => api<ThreadFileStatus>('GET', `/app/api/threads/${enc(threadId)}/file/status?path=${enc(path)}`);
export const deleteThread = (threadId: string) => api<{ ok: true }>('DELETE', `/app/api/threads/${enc(threadId)}`);
export const fetchThreadName = (threadId: string) => api<ThreadNameResponse>('GET', `/app/api/threads/${enc(threadId)}`);
export const renameThread = (threadId: string, title: string) => api<RenameThreadResponse>('PATCH', `/app/api/threads/${enc(threadId)}`, { title });
// «Ответить заново»: the server takes the question and its broken answer out and gives the question back.
export const retryTurn = (threadId: string, questionId: string) => api<RetryTurnResponse>('POST', `/app/api/threads/${enc(threadId)}/retry`, { questionId });

// `onProgress` hears how much of the request is sent (the file and a little of the form around it).
export function uploadFile(threadId: string, file: File, onProgress: (sent: number, total: number) => void): Promise<UploadedFile> {
  const form = new FormData();
  form.append('file', file);
  return apiFormWithProgress<UploadedFile>(`/app/api/threads/${enc(threadId)}/files`, form, onProgress);
}
