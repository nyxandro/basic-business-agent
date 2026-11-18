// Projects of conversations (spec, scenario 6, section 17.5).
import type { ArchivedProjectDto, ColleagueDto, DepartmentDto, ProjectAccessInput, ProjectDto, ProjectFile, ProjectListResponse, ThreadPage, ThreadProjectResponse, TrashBatchDto, TrashRestore } from '@bba/contracts';
import { api, apiForm } from '../api/client.ts';

const enc = encodeURIComponent;
const P = '/app/api/projects';

export const fetchProjects = () => api<ProjectListResponse>('GET', P);
export const createProject = (name: string, access: ProjectAccessInput) => api<ProjectDto>('POST', P, { name, access });
export const fetchProject = (id: string) => api<ProjectDto>('GET', `${P}/${enc(id)}`);
export const updateProject = (id: string, change: { name?: string; instructions?: string; pinned?: boolean }) => api<ProjectDto>('PUT', `${P}/${enc(id)}`, change);
// All the person's projects in the order of the side panel.
export const orderProjects = (ids: string[]) => api<{ ok: true }>('PUT', `${P}/order`, { ids });
// Removed for good: only from the archive, 30 days after archiving (spec, section 8.20).
export const deleteProject = (id: string) => api<{ ok: true }>('DELETE', `${P}/${enc(id)}`);
export const setProjectAccess = (id: string, access: ProjectAccessInput) => api<ProjectDto>('PUT', `${P}/${enc(id)}/access`, access);
export const archiveProject = (id: string) => api<{ ok: true }>('POST', `${P}/${enc(id)}/archive`);
export const unarchiveProject = (id: string) => api<{ ok: true }>('POST', `${P}/${enc(id)}/unarchive`);
export const fetchArchive = () => api<{ projects: ArchivedProjectDto[] }>('GET', `${P}/archive`);
export const fetchTrash = (id: string) => api<{ batches: TrashBatchDto[] }>('GET', `${P}/${enc(id)}/trash`);
export const restoreFromTrash = (id: string, what: TrashRestore) => api<{ restored: string[] }>('POST', `${P}/${enc(id)}/trash/restore`, what);
export const trashFileUrl = (id: string, trashId: string) => `${P}/${enc(id)}/trash/${enc(trashId)}/file`;
export const fetchColleagues = (q: string) => api<{ colleagues: ColleagueDto[] }>('GET', `/app/api/colleagues?q=${enc(q)}`);
export const fetchDepartments = () => api<{ departments: DepartmentDto[] }>('GET', '/app/api/departments');
export const fetchProjectFiles = (id: string) => api<{ files: ProjectFile[] }>('GET', `${P}/${enc(id)}/files`);
// Into the project's trash: `trashId` brings it back («Вернуть»); null for a link, which is just removed.
export const deleteProjectFile = (id: string, path: string) => api<{ ok: true; trashId: string | null }>('DELETE', `${P}/${enc(id)}/file?path=${enc(path)}`);
export const projectFileUrl = (id: string, path: string) => `${P}/${enc(id)}/file?path=${enc(path)}`;
// The PDF of a Word, Excel or PowerPoint file for the viewer (spec, section 8.27).
export const projectFilePreviewUrl = (id: string, path: string) => `${P}/${enc(id)}/file/preview?path=${enc(path)}`;
export const fetchProjectThreads = (id: string) => api<ThreadPage>('GET', `/app/api/threads?projectId=${enc(id)}&limit=100`);
export const fetchThreadProject = (threadId: string) => api<ThreadProjectResponse>('GET', `/app/api/threads/${enc(threadId)}/project`);
export const setThreadProject = (threadId: string, projectId: string | null) => api<{ ok: true }>('PUT', `/app/api/threads/${enc(threadId)}/project`, { projectId });

export function uploadProjectFile(id: string, file: File): Promise<ProjectFile> {
  const form = new FormData();
  form.append('file', file);
  return apiForm<ProjectFile>(`${P}/${enc(id)}/files`, form);
}
