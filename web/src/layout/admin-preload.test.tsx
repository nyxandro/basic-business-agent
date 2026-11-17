// The code of the admin panel is loaded in the background for a person with rights to it, so a click
// opens it at once; an employee without rights never loads it (spec, section 8.22).
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preloadAdminCode } from '../app/admin-code.ts';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

vi.mock('../app/admin-code.ts', () => ({ loadAdminCode: vi.fn(() => new Promise(() => undefined)), preloadAdminCode: vi.fn() }));

const AGENTS = [{ id: 'sales', name: 'Продажи', description: 'Сделки', starters: [], mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } }];

function server(me: typeof ME) {
  mockServer({
    'GET /app/api/me': { body: me },
    'GET /app/api/agents': { body: { agents: AGENTS } },
    'GET /app/api/threads': { body: { threads: [], next: null } },
    'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: 3000, resetsOn: '2026-12-01' }, daily: null } },
    'GET /app/api/projects': { body: { projects: [], archivedCount: 0 } },
    'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' } } } },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(preloadAdminCode).mockClear();
});

describe('the admin panel loaded beforehand', () => {
  it('is loaded in the background for a person with rights to it', async () => {
    server({ ...ME, isSuperadmin: true });
    renderApp('/agents/sales');
    expect(await screen.findByRole('link', { name: 'Админка' })).toBeInTheDocument();
    // It starts right after the panel is drawn.
    await waitFor(() => expect(preloadAdminCode).toHaveBeenCalledOnce());
  });

  it('is never loaded for an employee without rights', async () => {
    server(ME);
    renderApp('/agents/sales');
    expect(await screen.findByRole('button', { name: /Продажи/ })).toBeInTheDocument();
    // Past the moment it would have started.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(preloadAdminCode).not.toHaveBeenCalled();
  });
});
