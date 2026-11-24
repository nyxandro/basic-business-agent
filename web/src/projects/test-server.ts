// The server as the tests of projects see it (projects.test.tsx, project-files.test.tsx): two projects of
// Ольга, two agents and everything a project page asks; a test adds or replaces routes.
import { ME, mockServer } from '../test/fetch-mock.ts';

export const AGENTS = [
  { id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } },
  { id: 'assistant', name: 'Общий помощник', description: 'Вопросы и заметки', mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } },
];
export const TENDER = { id: 'p1', name: 'Тендер Альфа', instructions: '', threadCount: 0, lastActiveAt: '2026-11-10T08:00:00Z', pinned: false, createdAt: '2026-11-10T08:00:00Z', role: 'owner' as const, owner: { id: 'u-olga', name: 'Ольга' }, shared: false, unseen: false, access: { mode: 'private' as const, departments: [], people: [] }, archivedAt: null };
export const REPORTS = { id: 'p2', name: 'Отчёты', instructions: 'Кратко', threadCount: 3, lastActiveAt: '2026-11-16T08:00:00Z', pinned: false, createdAt: '2026-11-11T08:00:00Z', role: 'owner' as const, owner: { id: 'u-olga', name: 'Ольга' }, shared: false, unseen: false, access: { mode: 'private' as const, departments: [], people: [] }, archivedAt: null };

export function server(extra: Record<string, Parameters<typeof mockServer>[0][string]> = {}) {
  return mockServer({
    'GET /app/api/me': { body: ME },
    'GET /app/api/agents': { body: { agents: AGENTS } },
    'GET /app/api/threads': { body: { threads: [], next: null } },
    'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: 3000, resetsOn: '2026-12-01' }, daily: null } },
    'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' }, assistant: { name: 'assistant', description: '', className: 'MastraAgent' } } } },
    'GET /app/api/projects': { body: { projects: [TENDER, REPORTS], archivedCount: 0 } },
    'GET /app/api/projects/p1': { body: TENDER },
    'GET /app/api/projects/p2': { body: REPORTS },
    'GET /app/api/projects/p1/files': { body: { files: [] } },
    'GET /app/api/projects/p1/trash': { body: { batches: [] } },
    'GET /app/api/projects/p2/files': { body: { files: [] } },
    'GET /app/api/projects/p2/trash': { body: { batches: [] } },
    'GET /app/api/projects/p1/memory': { body: { entries: [], usedChars: 0, maxChars: 6000, readOnly: false } },
    'GET /app/api/projects/p2/memory': { body: { entries: [], usedChars: 0, maxChars: 6000, readOnly: false } },
    'GET /app/api/departments': { body: { departments: [] } },
    ...extra,
  });
}
