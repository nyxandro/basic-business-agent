// «Недавние» load again after an answer or a new name (spec, section 8.16) without being drawn anew:
// a name the person is typing stays, and the list does not blink.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../test/fetch-mock.ts';
import { RecentThreads } from './RecentThreads.tsx';

const page = (title: string) => ({
  body: { threads: [{ id: 't1', title, kind: 'chat', unread: false, updatedAt: '2026-11-14T08:00:00Z', agentId: 'sales', projectId: null }], next: null },
});

const list = (refreshKey: number) => (
  <MemoryRouter>
    <RecentThreads refreshKey={refreshKey} currentThreadId={null} onNavigate={() => undefined} />
  </MemoryRouter>
);

describe('«Недавние» loaded again', () => {
  it('keeps the name being typed and the list on the screen, and shows the fresh list', async () => {
    const s = mockServer({ 'GET /app/api/threads': page('Привет') });
    const { rerender } = render(list(0));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия с разговором «Привет»' }));
    await user.click(screen.getByRole('menuitem', { name: 'Переименовать' }));
    await user.type(screen.getByRole('textbox', { name: 'Название разговора' }), ' и сделки');

    s.set('GET /app/api/threads', page('Сделки без движения'));
    rerender(list(1));
    expect(screen.queryByLabelText('Загрузка…')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Название разговора' })).toHaveValue('Привет и сделки');
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('link', { name: 'Сделки без движения' })).toBeInTheDocument();
    expect(s.calls.filter((c) => c.path === '/app/api/threads')).toHaveLength(2);
  });
});
