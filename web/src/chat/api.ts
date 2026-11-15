import type { RetryTurnResponse, ThreadPage, UploadedFile } from '@bba/contracts';
import { api, apiForm } from '../api/client.ts';

const enc = encodeURIComponent;

export const THREAD_PAGE = 30;

// Conversations of all the person's agents, newest first; `before` continues after a page.
export const fetchThreadPage = (before: string | null) =>
  api<ThreadPage>('GET', `/app/api/threads?limit=${THREAD_PAGE}${before ? `&before=${enc(before)}` : ''}`);
export const deleteThread = (threadId: string) => api<{ ok: true }>('DELETE', `/app/api/threads/${enc(threadId)}`);
// «Ответить заново»: the server takes the question and its broken answer out and gives the question back.
export const retryTurn = (threadId: string, questionId: string) => api<RetryTurnResponse>('POST', `/app/api/threads/${enc(threadId)}/retry`, { questionId });

export function uploadFile(threadId: string, file: File): Promise<UploadedFile> {
  const form = new FormData();
  form.append('file', file);
  return apiForm<UploadedFile>(`/app/api/threads/${enc(threadId)}/files`, form);
}
