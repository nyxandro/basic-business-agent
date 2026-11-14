import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer, type MockCall, type Route } from '../test/fetch-mock.ts';
import { PHONE_WIDTH, stubSystemTheme } from '../test/match-media.ts';
import { renderApp } from '../test/render.tsx';

const AGENTS = [{ id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', starters: [], actions: {}, systems: { tools: {}, prefixes: {} } }];
const PROJECTS = [
  { id: 'p1', name: 'Тендер Северный', instructions: '', threadCount: 2, createdAt: '2026-11-10T08:00:00Z' },
  { id: 'p2', name: 'Ключевые клиенты', instructions: '', threadCount: 1, createdAt: '2026-11-11T08:00:00Z' },
];
const FOUND = {
  projects: [{ id: 'p1', name: 'Тендер Северный', threadCount: 2 }],
  threads: [
    { id: 't7', agentId: 'sales', title: 'Договор поставки', snippet: '…договор со Стройресурс на поставку…', projectId: 'p1', updatedAt: new Date().toISOString() },
    { id: 't8', agentId: 'sales', title: 'Письмо Стройресурс', snippet: '…ответ по договору…', projectId: null, updatedAt: '2026-11-02T10:00:00Z' },
  ],
};

function server(search: Route = { body: FOUND }) {
  return mockServer({
    'GET /app/api/me': { body: ME },
    'GET /app/api/agents': { body: { agents: AGENTS } },
    'GET /app/api/threads': { body: { threads: [], next: null } },
    'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: 3000, resetsOn: '2026-12-01' }, daily: null } },
    'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' } } } },
    'GET /app/api/projects': { body: { projects: PROJECTS } },
    'GET /app/api/projects/p1': { body: PROJECTS[0] },
    'GET /app/api/projects/p1/files': { body: { files: [] } },
    'GET /app/api/search': search,
  });
}

const searches = (s: { calls: MockCall[] }) => s.calls.filter((c) => c.path === '/app/api/search');

async function open() {
  const user = userEvent.setup();
  await screen.findByRole('button', { name: /Продажи\. Выбрать агента/ });
  await user.keyboard('{Control>}k{/Control}');
  return { user, dialog: await screen.findByRole('dialog', { name: 'Поиск' }) };
}

describe('search over conversations and projects', () => {
  it('opens by Ctrl+K and does not send a query shorter than two letters', async () => {
    const s = server();
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    expect(within(dialog).getByText('Начните вводить — найду разговоры и проекты')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: 'Поиск по разговорам и проектам' }), 'д');
    await new Promise((r) => setTimeout(r, 400));
    expect(searches(s)).toHaveLength(0);
  });

  it('shows projects and conversations in groups, the count, and opens a conversation', async () => {
    const s = server();
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    await user.type(within(dialog).getByRole('textbox'), 'договор строй');
    expect(await within(dialog).findByText('Найдено: 3')).toBeInTheDocument();
    expect(searches(s).at(-1)?.query).toEqual({ q: 'договор строй', scope: 'all' });
    expect(within(dialog).getByRole('button', { name: /Тендер Северный.*2 разговора/ })).toBeInTheDocument();
    const thread = within(dialog).getByRole('button', { name: /Договор поставки/ });
    expect(within(thread).getByText('сегодня')).toBeInTheDocument();
    expect(within(thread).getByText('Тендер Северный')).toBeInTheDocument();
    expect(within(within(dialog).getByRole('button', { name: /Письмо Стройресурс/ })).getByText('Без проекта')).toBeInTheDocument();
    await user.click(thread);
    expect(screen.queryByRole('dialog', { name: 'Поиск' })).not.toBeInTheDocument();
  });

  it('keeps the newest answer when an older one comes later', async () => {
    let releaseOld: () => void = () => undefined;
    const s = server((call) =>
      call.query.q === 'дог'
        ? new Promise((resolve) => (releaseOld = () => resolve({ body: { projects: [], threads: [{ ...FOUND.threads[1]!, title: 'Старый ответ' }] } })))
        : { body: { projects: [], threads: [{ ...FOUND.threads[0]!, title: 'Новый ответ' }] } },
    );
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    const input = within(dialog).getByRole('textbox');
    await user.type(input, 'дог');
    await waitFor(() => expect(searches(s)).toHaveLength(1));
    await user.type(input, 'овор');
    expect(await within(dialog).findByText('Новый ответ')).toBeInTheDocument();
    releaseOld();
    await new Promise((r) => setTimeout(r, 50));
    expect(within(dialog).queryByText('Старый ответ')).not.toBeInTheDocument();
  });

  it('says nothing was found and sends the filters', async () => {
    const s = server({ body: { projects: [], threads: [] } });
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    await user.type(within(dialog).getByRole('textbox'), 'ромашка');
    expect(await within(dialog).findByText('Ничего не нашлось')).toBeInTheDocument();
    expect(within(dialog).getByText('Попробуйте другие слова или выберите все проекты')).toBeInTheDocument();
    expect(within(dialog).getByText('Нет совпадений')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Разговоры' }));
    await waitFor(() => expect(searches(s).at(-1)?.query.scope).toBe('threads'));
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'В проекте' }), 'Ключевые клиенты');
    await waitFor(() => expect(searches(s).at(-1)?.query).toEqual({ q: 'ромашка', scope: 'threads', projectId: 'p2' }));
  });

  it('shows a failed search with its code and a repeat', async () => {
    const s = server(apiError('APP_SEARCH_FAILED', 'Поиск сейчас не работает. Попробуйте ещё раз.', 500));
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    await user.type(within(dialog).getByRole('textbox'), 'договор');
    expect(await within(dialog).findByText('Поиск сейчас не работает. Попробуйте ещё раз.')).toBeInTheDocument();
    expect(within(dialog).getByText(/APP_SEARCH_FAILED/)).toBeInTheDocument();
    s.set('GET /app/api/search', { body: FOUND });
    await user.click(within(dialog).getByRole('button', { name: 'Повторить' }));
    expect(await within(dialog).findByText('Найдено: 3')).toBeInTheDocument();
  });

  it('opens from «Поиск» in the menu of a phone and closes by «Отмена»', async () => {
    stubSystemTheme('light', PHONE_WIDTH);
    server();
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Меню' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Меню' })).getByRole('button', { name: 'Поиск' }));
    const dialog = await screen.findByRole('dialog', { name: 'Поиск' });
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('dialog', { name: 'Поиск' })).not.toBeInTheDocument();
  });
});
