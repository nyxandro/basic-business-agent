// Actions with a conversation (owner's list 16.11): «Недавние» rename and delete it from its three
// dots, the header of the open conversation renames and deletes it too.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const AGENTS = [{ id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', starters: [], actions: {}, systems: { tools: {}, prefixes: {} }, mark: { kind: 'icon', icon: 'spark' } }];
const thread = (id: string, title: string) => ({ id, title, kind: 'chat', unread: false, updatedAt: '2026-11-14T08:00:00Z', agentId: 'sales', projectId: null });
const BOTH = { threads: [thread('t1', 'Сделки без движения'), thread('t2', 'Смета склада')], next: null };

function server() {
  return mockServer({
    'GET /app/api/me': { body: ME },
    'GET /app/api/agents': { body: { agents: AGENTS } },
    'GET /app/api/threads': { body: BOTH },
    'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: null, resetsOn: '2026-12-01' }, daily: null } },
    'GET /app/api/projects': { body: { projects: [], archivedCount: 0 } },
    'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' } } } },
  });
}

const projectCalls = (s: ReturnType<typeof server>) => s.calls.filter((c) => /^\/app\/api\/threads\/[^/]+\/project$/.test(c.path)).map((c) => c.path.split('/')[4]);

describe('«Недавние»: three dots of a conversation', () => {
  it('delete the conversation after a question; the open one gives way to a new conversation', async () => {
    const s = server();
    s.set('DELETE /app/api/threads/t1', { body: { ok: true } });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия с разговором «Сделки без движения»' }));
    expect(screen.getByRole('menuitem', { name: 'Переименовать' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Удалить' }));
    const question = await screen.findByRole('alertdialog', { name: 'Удалить этот разговор? Его нельзя будет восстановить.' });
    s.set('GET /app/api/threads', { body: { threads: [thread('t2', 'Смета склада')], next: null } });
    await user.click(within(question).getByRole('button', { name: 'Удалить разговор' }));

    expect(await screen.findByText('Разговор удалён')).toBeInTheDocument();
    expect(s.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/app/api/threads/t1']);
    expect(screen.queryByRole('link', { name: 'Сделки без движения' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Смета склада' })).toBeInTheDocument();
    // The chat now shows a new conversation of the same agent.
    await expect.poll(() => projectCalls(s).at(-1)).not.toBe('t1');
    expect(screen.getByRole('button', { name: /Продажи\. Выбрать агента/ })).toBeInTheDocument();
  });

  it('keeps the open conversation when another one is deleted, and keeps the row when the person says no', async () => {
    const s = server();
    s.set('DELETE /app/api/threads/t2', { body: { ok: true } });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия с разговором «Смета склада»' }));
    await user.click(screen.getByRole('menuitem', { name: 'Удалить' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Отмена' }));
    expect(s.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(screen.getByRole('link', { name: 'Смета склада' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Действия с разговором «Смета склада»' }));
    await user.click(screen.getByRole('menuitem', { name: 'Удалить' }));
    s.set('GET /app/api/threads', { body: { threads: [thread('t1', 'Сделки без движения')], next: null } });
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Удалить разговор' }));
    await expect.poll(() => screen.queryByRole('link', { name: 'Смета склада' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Сделки без движения' })).toHaveAttribute('aria-current', 'page');
    expect(projectCalls(s).every((id) => id === 't1')).toBe(true);
  });

  it('shows why a conversation was not deleted and keeps it in the list', async () => {
    const s = server();
    s.set('DELETE /app/api/threads/t2', apiError('APP_INTERNAL', 'Что-то пошло не так на сервере. Попробуйте ещё раз.', 500));
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия с разговором «Смета склада»' }));
    await user.click(screen.getByRole('menuitem', { name: 'Удалить' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Удалить разговор' }));
    expect(await screen.findByText(/Что-то пошло не так на сервере/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Смета склада' })).toBeInTheDocument();
  });
});

describe('the header of a conversation: three dots', () => {
  it('rename the open conversation in a window with its current name; «Недавние» show the new one', async () => {
    const s = server();
    s.set('GET /app/api/threads/t1', { body: { thread: { id: 't1', title: 'Сделки без движения' } } });
    s.set('PATCH /app/api/threads/t1', { body: { thread: { id: 't1', title: 'Сделки за ноябрь' } } });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия с разговором' }));
    expect(screen.getByRole('menuitem', { name: 'Удалить разговор' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Переименовать' }));
    const dialog = await screen.findByRole('dialog', { name: 'Переименовать разговор' });
    const field = await within(dialog).findByRole('textbox', { name: 'Название разговора' });
    expect(field).toHaveValue('Сделки без движения');
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await user.clear(field);
    await user.type(field, '  Сделки за ноябрь ');
    s.set('GET /app/api/threads', { body: { threads: [thread('t1', 'Сделки за ноябрь'), thread('t2', 'Смета склада')], next: null } });
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    expect(s.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ title: 'Сделки за ноябрь' });
    await expect.poll(() => screen.queryByRole('dialog', { name: 'Переименовать разговор' })).toBeNull();
    expect(await screen.findByRole('link', { name: 'Сделки за ноябрь' })).toBeInTheDocument();
  });

  it('a name from the header wins over one given earlier in «Недавние»', async () => {
    const s = server();
    s.set('PATCH /app/api/threads/t1', (call) => ({ body: { thread: { id: 't1', title: (call.body as { title: string }).title } } }));
    s.set('GET /app/api/threads/t1', { body: { thread: { id: 't1', title: 'Сделки за октябрь' } } });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия с разговором «Сделки без движения»' }));
    await user.click(screen.getByRole('menuitem', { name: 'Переименовать' }));
    const inline = screen.getByRole('textbox', { name: 'Название разговора' });
    await user.clear(inline);
    await user.type(inline, 'Сделки за октябрь{Enter}');
    expect(await screen.findByRole('link', { name: 'Сделки за октябрь' })).toBeInTheDocument();

    s.set('GET /app/api/threads', { body: { threads: [thread('t1', 'Сделки за ноябрь'), thread('t2', 'Смета склада')], next: null } });
    await user.click(screen.getByRole('button', { name: 'Действия с разговором' }));
    await user.click(screen.getByRole('menuitem', { name: 'Переименовать' }));
    const field = await within(await screen.findByRole('dialog', { name: 'Переименовать разговор' })).findByRole('textbox', { name: 'Название разговора' });
    await user.clear(field);
    await user.type(field, 'Сделки за ноябрь{Enter}');
    expect(await screen.findByRole('link', { name: 'Сделки за ноябрь' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Сделки за октябрь' })).not.toBeInTheDocument();
  });

  it('a conversation not started yet has no name to change: the window says so', async () => {
    server();
    renderApp('/agents/sales?thread=new-one');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия с разговором' }));
    await user.click(screen.getByRole('menuitem', { name: 'Переименовать' }));
    const dialog = await screen.findByRole('dialog', { name: 'Переименовать разговор' });
    expect(await within(dialog).findByText('Разговор ещё не начат: название появится после первого сообщения.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('keeps the typed name when saving fails', async () => {
    const s = server();
    s.set('GET /app/api/threads/t1', { body: { thread: { id: 't1', title: 'Сделки без движения' } } });
    s.set('PATCH /app/api/threads/t1', apiError('APP_INTERNAL', 'Что-то пошло не так на сервере. Попробуйте ещё раз.', 500));
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия с разговором' }));
    await user.click(screen.getByRole('menuitem', { name: 'Переименовать' }));
    const dialog = await screen.findByRole('dialog', { name: 'Переименовать разговор' });
    const field = await within(dialog).findByRole('textbox', { name: 'Название разговора' });
    await user.type(field, ' и склад');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(await within(dialog).findByText(/Что-то пошло не так на сервере/)).toBeInTheDocument();
    expect(field).toHaveValue('Сделки без движения и склад');
  });
});
