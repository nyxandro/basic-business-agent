// The memory of a project and «Моя память» (spec, section 8.26).
import type { MemoryEntryDto, MemoryListDto } from '@bba/contracts';
import { api } from '../api/client.ts';

// Whose memory a screen shows: the project's on its page, the person's own in «Настройки».
export type MemoryTarget = { kind: 'project'; projectId: string } | { kind: 'personal' };

const base = (target: MemoryTarget) => (target.kind === 'project' ? `/app/api/projects/${encodeURIComponent(target.projectId)}/memory` : '/app/api/me/memory');

export const memoryKey = (target: MemoryTarget) => (target.kind === 'project' ? (['project', target.projectId, 'memory'] as const) : (['me', 'memory'] as const));

export const fetchMemory = (target: MemoryTarget) => api<MemoryListDto>('GET', base(target));
export const addMemoryEntry = (target: MemoryTarget, text: string) => api<MemoryEntryDto>('POST', base(target), { text });
export const changeMemoryEntry = (target: MemoryTarget, id: string, text: string, version: number) => api<MemoryEntryDto>('PUT', `${base(target)}/${encodeURIComponent(id)}`, { text, version });
export const removeMemoryEntry = (target: MemoryTarget, id: string) => api<MemoryEntryDto>('DELETE', `${base(target)}/${encodeURIComponent(id)}`);
export const forgetMemory = () => api<{ ok: true }>('DELETE', '/app/api/me/memory');
