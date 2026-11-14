// Projects of conversations (spec, scenario 6, section 17.5).
import type { ProjectDto, ProjectFile, ThreadPage } from '@bba/contracts';
import { api, apiForm } from '../api/client.ts';

const enc = encodeURIComponent;
const P = '/app/api/projects';

export const fetchProjects = () => api<{ projects: ProjectDto[] }>('GET', P);
export const createProject = (name: string) => api<ProjectDto>('POST', P, { name });
export const fetchProject = (id: string) => api<ProjectDto>('GET', `${P}/${enc(id)}`);
export const updateProject = (id: string, change: { name?: string; instructions?: string }) => api<ProjectDto>('PUT', `${P}/${enc(id)}`, change);
export const deleteProject = (id: string) => api<{ ok: true }>('DELETE', `${P}/${enc(id)}`);
export const fetchProjectFiles = (id: string) => api<{ files: ProjectFile[] }>('GET', `${P}/${enc(id)}/files`);
export const deleteProjectFile = (id: string, path: string) => api<{ ok: true }>('DELETE', `${P}/${enc(id)}/file?path=${enc(path)}`);
export const projectFileUrl = (id: string, path: string) => `${P}/${enc(id)}/file?path=${enc(path)}`;
export const fetchProjectThreads = (id: string) => api<ThreadPage>('GET', `/app/api/threads?projectId=${enc(id)}&limit=100`);
export const fetchThreadProject = (threadId: string) => api<{ projectId: string | null }>('GET', `/app/api/threads/${enc(threadId)}/project`);
export const setThreadProject = (threadId: string, projectId: string | null) => api<{ ok: true }>('PUT', `/app/api/threads/${enc(threadId)}/project`, { projectId });

export function uploadProjectFile(id: string, file: File): Promise<ProjectFile> {
  const form = new FormData();
  form.append('file', file);
  return apiForm<ProjectFile>(`${P}/${enc(id)}/files`, form);
}
