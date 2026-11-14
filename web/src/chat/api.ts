import type { ThreadSummaryDto, UploadedFile } from '@bba/contracts';
import { api, apiForm } from '../api/client.ts';

const enc = encodeURIComponent;

export const fetchThreads = (agentId: string) => api<{ threads: ThreadSummaryDto[] }>('GET', `/app/api/agents/${enc(agentId)}/threads`);
export const deleteThread = (threadId: string) => api<{ ok: true }>('DELETE', `/app/api/threads/${enc(threadId)}`);

export function uploadFile(threadId: string, file: File): Promise<UploadedFile> {
  const form = new FormData();
  form.append('file', file);
  return apiForm<UploadedFile>(`/app/api/threads/${enc(threadId)}/files`, form);
}
