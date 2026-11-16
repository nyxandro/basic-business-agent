// «Недавние»: the newest conversations and «Ещё» for the rest (decision of the owner 15.11); they
// load again after an answer or a new name (spec, section 8.16) without being drawn anew: a name the
// person is typing stays, and the list does not blink.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { mockServer } from '../test/fetch-mock.ts';
import { ConfirmProvider } from '../ui/Confirm.tsx';
import { ToastProvider } from '../ui/Toast.tsx';
import { RecentThreads } from './RecentThreads.tsx';

const page = (title: string) => ({
  body: { threads: [{ id: 't1', title, kind: 'chat', unread: false, updatedAt: '2026-11-14T08:00:00Z', agentId: 'sales', projectId: null }], next: null },
});

const list = (refreshKey: number, onShowAll = () => undefined) => (
  <MemoryRouter>
    <ToastProvider>
      <ConfirmProvider>
        <RecentThreads refreshKey={refreshKey} currentThreadId={null} onNavigate={() => undefined} onShowAll={onShowAll} onDeleted={() => undefined} />
      </ConfirmProvider>
    </ToastProvider>
  </MemoryRouter>
);

describe('«Недавние» in the panel', () => {
  it('shows the seven newest and «Ещё» that opens all of them', async () => {
    const threads = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, title: `Тема ${i}`, kind: 'chat', unread: false, updatedAt: '2026-11-14T08:00:00Z', agentId: 'sales', projectId: null }));
    const s = mockServer({ 'GET /app/api/threads': { body: { threads, next: 'cursor-7' } } });
    const onShowAll = vi.fn();
    render(list(0, onShowAll));
    expect(await screen.findAllByRole('link', { name: /^Тема/ })).toHaveLength(7);
    expect(s.calls.find((c) => c.path === '/app/api/threads')?.query).toEqual({ limit: '7' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ещё' }));
    expect(onShowAll).toHaveBeenCalledOnce();
  });

  it('has no «Ещё» when it shows them all', async () => {
    mockServer({ 'GET /app/api/threads': page('Привет') });
    render(list(0));
    expect(await screen.findByRole('link', { name: 'Привет' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ещё' })).not.toBeInTheDocument();
  });
});

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
