// GET /app/api/search (spec, sections 8.13 and 8.21): the person's projects, conversations and documents.
import type { SearchFile, SearchFiles, SearchFileStatus, SearchResponse, SearchScope } from '@bba/contracts';
import { api } from '../api/client.ts';
import { projectFilePreviewUrl, projectFileUrl } from '../projects/api.ts';

const enc = encodeURIComponent;

// The newest documents for the tab «Файлы».
export const fetchRecentFiles = () => api<SearchFiles>('GET', '/app/api/search/files');

export function fetchFileStatus(file: SearchFile): Promise<SearchFileStatus> {
  const project = file.projectId ? `projectId=${enc(file.projectId)}&` : '';
  return api<SearchFileStatus>('GET', `/app/api/files/status?${project}path=${enc(file.path)}`);
}

// A file of a project, or of the person's conversations outside projects.
export function fileUrl(file: SearchFile): string {
  return file.projectId ? projectFileUrl(file.projectId, file.path) : `/app/api/files/file?path=${enc(file.path)}`;
}

// The PDF of a Word, Excel or PowerPoint file for the viewer (spec, section 8.27).
export function filePreviewUrl(file: SearchFile): string {
  return file.projectId ? projectFilePreviewUrl(file.projectId, file.path) : `/app/api/files/file/preview?path=${enc(file.path)}`;
}

export function searchAll(q: string, scope: SearchScope): Promise<SearchResponse> {
  const params = new URLSearchParams({ q, scope });
  return api<SearchResponse>('GET', `/app/api/search?${params.toString()}`);
}
