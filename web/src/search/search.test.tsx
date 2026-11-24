import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer, type MockCall, type Route } from '../test/fetch-mock.ts';
import { PHONE_WIDTH, stubSystemTheme } from '../test/match-media.ts';
import { renderApp } from '../test/render.tsx';

const AGENTS = [{ id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } }];
const PROJECTS = [
  { id: 'p1', name: 'Тендер Северный', instructions: '', threadCount: 2, createdAt: '2026-11-10T08:00:00Z' },
  { id: 'p2', name: 'Ключевые клиенты', instructions: '', threadCount: 1, createdAt: '2026-11-11T08:00:00Z', role: 'member', owner: { id: 'u9', name: 'Игорь Петров' }, shared: true },
  { id: 'p3', name: 'Архив договоров', instructions: '', threadCount: 0, createdAt: '2026-11-12T08:00:00Z' },
];
const NO_FILES = { files: [], unreadable: [], more: false };
const FOUND = {
  files: NO_FILES,
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
    'GET /app/api/search/files': { body: RECENT },
    'GET /app/api/files/status': { body: { state: 'ok' } },
  });
}

const KP = { path: 'KP_Yelka_v2.pdf', name: 'KP_Yelka_v2.pdf', projectId: 'p1', conversation: null, modifiedAt: new Date().toISOString(), bytes: 2048 };
const CONTRACT = { path: 'Договор поставки.docx', name: 'Договор поставки.docx', projectId: null, conversation: null, modifiedAt: '2026-11-02T10:00:00Z', bytes: 18_432 };
const WORKING_COPY = { ...CONTRACT, path: 'work/Договор поставки.docx', modifiedAt: '2026-11-01T10:00:00Z' };
// Documents of conversations outside projects (spec, section 8.33): named by their conversation, not its folder.
const ESTIMATE = { path: 'chats/t9/Смета.xlsx', name: 'Смета.xlsx', projectId: null, conversation: { id: 't9', title: 'КП для Ёлки' }, modifiedAt: '2026-10-30T10:00:00Z', bytes: 900 };
const BILL = { ...ESTIMATE, path: 'chats/t9/Почта/Счёт.pdf', name: 'Счёт.pdf' };
const OLD = { ...ESTIMATE, path: 'chats/t8/Старое КП.pdf', name: 'Старое КП.pdf', conversation: { id: 't8', title: null } };
const RECENT = { files: [KP, CONTRACT, WORKING_COPY, ESTIMATE, BILL, OLD], unreadable: [], more: false };

const searches = (s: { calls: MockCall[] }) => s.calls.filter((c) => c.path === '/app/api/search');
const lists = (s: { calls: MockCall[] }) => s.calls.filter((c) => c.path === '/app/api/threads' && c.query.limit !== '7');

const conversation = (id: string, title: string, projectId: string | null, unread = false) => ({ id, title, kind: 'chat', unread, updatedAt: '2026-11-14T08:00:00Z', agentId: 'sales', projectId });
// 31 conversations: the panel asks 7, the window asks pages of 30; the last page is one, the oldest.
const ALL = Array.from({ length: 30 }, (_, i) => conversation(`t${i}`, `Тема ${i}`, i === 0 ? 'p1' : null, i === 1));
const OLDEST = conversation('t30', 'Самый старый разговор', null);
const threadList: Route = (call) => {
  if (call.query.before === 'cursor-30') return { body: { threads: [OLDEST], next: null } };
  const limit = Number(call.query.limit);
  return { body: { threads: ALL.slice(0, limit), next: `cursor-${limit}` } };
};

async function open() {
  const user = userEvent.setup();
  await screen.findByRole('button', { name: /Продажи\. Выбрать агента/ });
  await user.keyboard('{Control>}k{/Control}');
  return { user, dialog: await screen.findByRole('dialog', { name: 'Поиск' }) };
}

describe('search over conversations and projects', () => {
  it('opens by Ctrl+K with all conversations and does not send a query shorter than two letters', async () => {
    const s = server();
    s.set('GET /app/api/threads', threadList);
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    expect(within(dialog).getByRole('button', { name: 'Везде' })).toHaveAttribute('aria-pressed', 'true');
    // Text, not role queries, for long lists: naming 30 buttons is slow in jsdom on a busy machine.
    expect(await within(dialog).findAllByText(/^Тема \d+$/)).toHaveLength(30);
    await user.type(within(dialog).getByRole('textbox', { name: 'Поиск по разговорам, проектам и файлам' }), 'д');
    await new Promise((r) => setTimeout(r, 400));
    expect(searches(s)).toHaveLength(0);
    expect(within(dialog).getAllByText(/^Тема \d+$/)).toHaveLength(30);
  });

  it('opens all conversations by «Ещё» in the panel: newest first, more further down', async () => {
    const s = server();
    s.set('GET /app/api/threads', threadList);
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ещё' }));
    const dialog = await screen.findByRole('dialog', { name: 'Поиск' });
    expect(within(dialog).getByRole('button', { name: 'Разговоры' })).toHaveAttribute('aria-pressed', 'true');
    const titles = await within(dialog).findAllByText(/^Тема \d+$/);
    expect(titles.map((title) => title.textContent)).toEqual(ALL.map((t) => t.title));
    expect(lists(s).at(-1)?.query).toEqual({ limit: '30' });
    const rows = titles.map((title) => title.closest('button')!);
    expect(within(rows[0]!).getByText('Тендер Северный')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('новое')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Показать ещё' }));
    expect(await within(dialog).findByRole('button', { name: /Самый старый разговор/ })).toBeInTheDocument();
    expect(lists(s).at(-1)?.query).toEqual({ limit: '30', before: 'cursor-30' });
    expect(within(dialog).queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument();

    await user.type(within(dialog).getByRole('textbox'), 'договор');
    expect(await within(dialog).findByText('Найдено: 2')).toBeInTheDocument();
    expect(searches(s).at(-1)?.query).toEqual({ q: 'договор', scope: 'threads' });
    await user.clear(within(dialog).getByRole('textbox'));
    expect(await within(dialog).findAllByText(/^Тема \d+$/)).toHaveLength(30);

    await user.click(within(dialog).getByText('Тема 2').closest('button')!);
    expect(screen.queryByRole('dialog', { name: 'Поиск' })).not.toBeInTheDocument();
  });

  it('drops the pages loaded further when the first page comes anew from the server (spec, section 8.22)', async () => {
    const s = server();
    s.set('GET /app/api/threads', threadList);
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ещё' }));
    let dialog = await screen.findByRole('dialog', { name: 'Поиск' });
    expect(await within(dialog).findAllByText(/^Тема \d+$/)).toHaveLength(30);
    await user.keyboard('{Escape}');
    // A new conversation comes first now, and the server gives the first page slowly.
    const NEWEST = conversation('t99', 'Новый разговор', null);
    let answer: (() => void) | null = null;
    s.set('GET /app/api/threads', (call) => {
      if (call.query.before) return threadList(call);
      if (call.query.limit !== '30') return { body: { threads: [NEWEST, ...ALL.slice(0, 6)], next: 'cursor-7' } };
      return new Promise((resolve) => (answer = () => resolve({ body: { threads: [NEWEST, ...ALL.slice(0, 29)], next: 'cursor-new' } })));
    });
    await user.click(screen.getByRole('button', { name: 'Ещё' }));
    dialog = await screen.findByRole('dialog', { name: 'Поиск' });
    // From memory at once, and more of it from the old place.
    expect(within(dialog).getAllByText(/^Тема \d+$/)).toHaveLength(30);
    await user.click(within(dialog).getByRole('button', { name: 'Показать ещё' }));
    expect(await within(dialog).findByRole('button', { name: /Самый старый разговор/ })).toBeInTheDocument();
    await waitFor(() => expect(answer).not.toBeNull());
    act(() => (answer as unknown as () => void)());
    // The new first page: the newest on top, «Тема 29» not lost, nothing twice, the rest from its own place.
    expect(await within(dialog).findByRole('button', { name: /Новый разговор/ })).toBeInTheDocument();
    expect(within(dialog).getAllByText(/^Тема \d+$/)).toHaveLength(29);
    expect(within(dialog).queryByRole('button', { name: /Самый старый разговор/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Показать ещё' })).toBeInTheDocument();
  });

  it('says when there are no conversations yet and shows a list that did not load with a repeat', async () => {
    const s = server();
    s.set('GET /app/api/threads', (call) => (call.query.limit === '7' ? { body: { threads: [], next: null } } : apiError('APP_INTERNAL', 'Сервер сейчас не отвечает. Попробуйте позже.', 500)));
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    expect(await within(dialog).findByText('Сервер сейчас не отвечает. Попробуйте позже.')).toBeInTheDocument();
    s.set('GET /app/api/threads', { body: { threads: [], next: null } });
    await user.click(within(dialog).getByRole('button', { name: 'Повторить' }));
    expect(await within(dialog).findByText('Разговоров пока нет')).toBeInTheDocument();
  });

  it('shows all the person’s projects above all conversations on «Везде» before a query', async () => {
    const s = server();
    s.set('GET /app/api/threads', threadList);
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    // Text, not role queries, next to 30 conversations: naming every button is slow in jsdom.
    const project = (await within(dialog).findByText('2 разговора')).closest('button')!;
    expect(within(project).getByText('Тендер Северный')).toBeInTheDocument();
    expect(within(within(dialog).getByText('1 разговор · Открыл(а): Игорь Петров').closest('button')!).getByText('Ключевые клиенты')).toBeInTheDocument();
    const titles = await within(dialog).findAllByText(/^Тема \d+$/);
    expect(titles).toHaveLength(30);
    expect(project.compareDocumentPosition(titles[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Разговоры' }));
    expect(within(dialog).queryByText('2 разговора')).not.toBeInTheDocument();
    expect(within(dialog).getAllByText(/^Тема \d+$/)).toHaveLength(30);
    expect(searches(s)).toHaveLength(0);
  });

  it('lists all the person’s projects on «Проекты» before a query, in the panel’s order, and opens one', async () => {
    const s = server();
    s.set('GET /app/api/threads', threadList);
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole('button', { name: 'Проекты' }));
    const rows = await within(dialog).findAllByRole('button', { name: /\d+ разговор|Пусто/ });
    // A project without the person's conversations says so in a word, not «0 разговоров».
    expect(rows.map((row) => row.textContent)).toEqual(['Тендер Северный2 разговора', 'Ключевые клиенты1 разговор · Открыл(а): Игорь Петров', 'Архив договоровПусто']);
    expect(within(dialog).queryByText(/^Тема \d+$/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Начните вводить/)).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /Тендер Северный.*2 разговора/ }));
    expect(screen.queryByRole('dialog', { name: 'Поиск' })).not.toBeInTheDocument();
    expect(searches(s)).toHaveLength(0);
  });

  // Decision of the owner 17.11: a project beyond the seven of the side panel goes into it from here.
  it('pins a project to the side panel from its row, before a query and among the found ones', async () => {
    const s = server();
    s.set('PUT /app/api/projects/p3', { body: { ...PROJECTS[2], pinned: true } });
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole('button', { name: 'Проекты' }));
    await within(dialog).findByRole('button', { name: /Архив договоровПусто/ });
    const panelLoads = () => s.calls.filter((c) => c.method === 'GET' && c.path === '/app/api/projects').length;
    const loaded = panelLoads();
    s.set('GET /app/api/projects', { body: { projects: [{ ...PROJECTS[2], pinned: true }, PROJECTS[0], PROJECTS[1]] } });
    await user.click(within(dialog).getByRole('button', { name: 'Закрепить «Архив договоров» в панели' }));
    // The row is pinned at once and stays under the pointer with the keyboard on its pin: a row that
    // jumped up would put another project's pin under a second click. The panel loads its list again.
    expect(within(dialog).getByRole('button', { name: 'Открепить «Архив договоров» от панели' })).toHaveFocus();
    expect(within(dialog).getAllByRole('button', { name: /\d+ разговор|Пусто/ }).at(-1)).toHaveTextContent('Архив договоров');
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT' && c.path === '/app/api/projects/p3')?.body).toEqual({ pinned: true }));
    await waitFor(() => expect(panelLoads()).toBeGreaterThan(loaded));

    await user.type(within(dialog).getByRole('textbox'), 'договор строй');
    expect(await within(dialog).findByText('Найдено: 1')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Закрепить «Тендер Северный» в панели' })).toBeInTheDocument();
  });

  it('says when a pin was not saved and shows the projects of the server again', async () => {
    const s = server();
    s.set('PUT /app/api/projects/p3', apiError('APP_INTERNAL', 'Что-то пошло не так на сервере.', 500));
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole('button', { name: 'Проекты' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Закрепить «Архив договоров» в панели' }));
    expect(await within(dialog).findByText('Изменение в «Проектах» не сохранилось')).toBeInTheDocument();
    expect(await within(dialog).findByRole('button', { name: 'Закрепить «Архив договоров» в панели' })).toBeInTheDocument();
  });

  it('a pin that fails after the window closed is told in the panel', async () => {
    const s = server();
    let fail: (() => void) | null = null;
    s.set('PUT /app/api/projects/p3', () => new Promise((resolve) => (fail = () => resolve(apiError('APP_INTERNAL', 'Что-то пошло не так на сервере.', 500)))));
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole('button', { name: 'Проекты' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Закрепить «Архив договоров» в панели' }));
    await waitFor(() => expect(fail).not.toBeNull());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Поиск' })).not.toBeInTheDocument();
    act(() => fail!());
    expect(await screen.findByText('Изменение в «Проектах» не сохранилось')).toBeInTheDocument();
  });

  it('shows a project list that did not load with a repeat and says when there are no projects', async () => {
    const s = server();
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await screen.findByRole('button', { name: /Продажи\. Выбрать агента/ });
    s.set('GET /app/api/projects', apiError('APP_INTERNAL', 'Сервер сейчас не отвечает. Попробуйте позже.', 500));
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Поиск' });
    // «Везде» tells it above the conversations: there is no filter row to carry a note any more.
    expect(await within(dialog).findByText('Список проектов не загрузился')).toBeInTheDocument();
    expect(await within(dialog).findByText('Разговоров пока нет')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Проекты' }));
    expect(await within(dialog).findByText('Сервер сейчас не отвечает. Попробуйте позже.')).toBeInTheDocument();
    s.set('GET /app/api/projects', { body: { projects: [] } });
    await user.click(within(dialog).getByRole('button', { name: 'Повторить' }));
    expect(await within(dialog).findByText('Проектов пока нет')).toBeInTheDocument();
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

  it('marks what of the names and the piece of text the search found', async () => {
    const thread = { ...FOUND.threads[0]!, titleMarks: [[0, 7]], snippetMarks: [[1, 8], [90, 120]] };
    const project = { id: 'p1', name: 'Тендер Северный', nameMarks: [[0, 6]], threadCount: 2, shared: false, ownerName: null };
    server({ body: { files: { files: [{ ...KP, nameMarks: [[0, 2], [3, 8]] }], unreadable: [], more: false }, projects: [project], threads: [thread] } });
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    await user.type(within(dialog).getByRole('textbox'), 'договор');
    const row = await within(dialog).findByRole('button', { name: /Договор поставки/ });
    const marks = (el: HTMLElement) => [...el.querySelectorAll('mark')].map((m) => m.textContent);
    // A mark past the end of the text is left out, the rest is drawn.
    expect(marks(row)).toEqual(['Договор', 'договор']);
    expect(row.textContent).toContain('Договор поставки');
    expect(row.textContent).toContain('…договор со Стройресурс на поставку…');
    expect(marks(within(dialog).getByRole('button', { name: /Тендер Северный.*2 разговора/ }))).toEqual(['Тендер']);
    expect(marks(within(dialog).getByRole('button', { name: /KP_Yelka_v2\.pdf/ }))).toEqual(['KP', 'Yelka']);
  });

  it('keeps the newest answer when an older one comes later', async () => {
    let releaseOld: () => void = () => undefined;
    const s = server((call) =>
      call.query.q === 'дог'
        ? new Promise((resolve) => (releaseOld = () => resolve({ body: { projects: [], files: NO_FILES, threads: [{ ...FOUND.threads[1]!, title: 'Старый ответ' }] } })))
        : { body: { projects: [], files: NO_FILES, threads: [{ ...FOUND.threads[0]!, title: 'Новый ответ' }] } },
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

  it('says nothing was found and sends the scope', async () => {
    const s = server({ body: { projects: [], threads: [], files: NO_FILES } });
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    await user.type(within(dialog).getByRole('textbox'), 'ромашка');
    expect(await within(dialog).findByText('Ничего не нашлось')).toBeInTheDocument();
    expect(within(dialog).getByText('Попробуйте другие слова')).toBeInTheDocument();
    expect(within(dialog).getByText('Нет совпадений')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Разговоры' }));
    await waitFor(() => expect(searches(s).at(-1)?.query).toEqual({ q: 'ромашка', scope: 'threads' }));
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

  it('has no project filter: the projects are in the list itself (decision of the owner 16.11)', async () => {
    server();
    renderApp('/agents/sales?thread=t1');
    const { dialog } = await open();
    expect(await within(dialog).findByText('2 разговора')).toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('В проекте')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Все проекты')).not.toBeInTheDocument();
  });

  it('lists the newest documents on «Файлы» before a query; a document opens its window with «Закрыть», «Посмотреть» and «Скачать»', async () => {
    const s = server();
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole('button', { name: 'Файлы' }));
    const kp = await within(dialog).findByRole('button', { name: /KP_Yelka_v2\.pdf.*Тендер Северный/ });
    // Two files of one name are told apart by the folder inside the project.
    expect(within(dialog).getAllByRole('button', { name: /Договор поставки\.docx/ }).map((row) => row.textContent)).toEqual([expect.stringMatching(/Без проекта$/), expect.stringMatching(/Без проекта \/ work$/)]);
    expect(within(dialog).getByRole('button', { name: /Смета\.xlsx/ }).textContent).toMatch(/Разговор «КП для Ёлки»$/);
    expect(within(dialog).getByRole('button', { name: /Счёт\.pdf/ }).textContent).toMatch(/Разговор «КП для Ёлки» \/ Почта$/);
    expect(within(dialog).getByRole('button', { name: /Старое КП\.pdf/ }).textContent).toMatch(/Удалённый разговор$/);
    await user.click(kp);
    const file = await screen.findByRole('dialog', { name: 'KP_Yelka_v2.pdf' });
    const download = await within(file).findByRole('link', { name: 'Скачать' });
    expect(download).toHaveAttribute('href', '/app/api/projects/p1/file?path=KP_Yelka_v2.pdf');
    expect(download).toHaveAttribute('download', 'KP_Yelka_v2.pdf');
    // «Закрыть», «Посмотреть» — the document viewer over the window (decision of the owner 18.11), «Скачать».
    expect([...within(file).getAllByRole('button'), download].map((el) => el.textContent).slice(-3)).toEqual(['Закрыть', 'Посмотреть', 'Скачать']);
    expect(within(file).getByText(/Тендер Северный · сегодня · 2 КБ/)).toBeInTheDocument();
    expect(s.calls.find((c) => c.path === '/app/api/files/status')?.query).toEqual({ projectId: 'p1', path: 'KP_Yelka_v2.pdf' });
    await user.click(within(file).getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog', { name: 'KP_Yelka_v2.pdf' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Поиск' })).toBeInTheDocument();

    await user.click(within(dialog).getAllByRole('button', { name: /Договор поставки\.docx/ })[0]!);
    const own = await screen.findByRole('dialog', { name: 'Договор поставки.docx' });
    expect(await within(own).findByRole('link', { name: 'Скачать' })).toHaveAttribute('href', `/app/api/files/file?path=${encodeURIComponent('Договор поставки.docx')}`);
    // A Word document is shown too: the server turns it into PDF (spec, section 8.27).
    expect(within(own).getByRole('button', { name: 'Посмотреть' })).toBeInTheDocument();
  });

  it('says in the window of a file that it was removed meanwhile', async () => {
    const s = server();
    s.set('GET /app/api/files/status', { body: { state: 'deleted', name: 'KP_Yelka_v2.pdf' } });
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole('button', { name: 'Файлы' }));
    await user.click(await within(dialog).findByRole('button', { name: /KP_Yelka_v2\.pdf/ }));
    const file = await screen.findByRole('dialog', { name: 'KP_Yelka_v2.pdf' });
    expect(await within(file).findByText(/удалён/)).toBeInTheDocument();
    expect(within(file).queryByRole('link', { name: 'Скачать' })).not.toBeInTheDocument();
  });

  it('offers a file removed into the project trash from there, shows a failed check with a repeat, and Esc closes only the file', async () => {
    const s = server();
    s.set('GET /app/api/files/status', { body: { state: 'trash', name: 'KP_Yelka_v2.pdf', projectId: 'p1', trashId: 'tr1', expiresAt: '2026-12-16T10:00:00Z' } });
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole('button', { name: 'Файлы' }));
    await user.click(await within(dialog).findByRole('button', { name: /KP_Yelka_v2\.pdf/ }));
    const file = await screen.findByRole('dialog', { name: 'KP_Yelka_v2.pdf' });
    expect(await within(file).findByText(/в корзине проекта до/)).toBeInTheDocument();
    expect(within(file).getByRole('link', { name: /Скачать из корзины/ })).toHaveAttribute('href', '/app/api/projects/p1/trash/tr1/file');
    expect(within(file).queryByRole('link', { name: 'Скачать' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'KP_Yelka_v2.pdf' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Поиск' })).toBeInTheDocument();

    s.set('GET /app/api/files/status', apiError('APP_NOT_FOUND', 'Проект не найден.', 404));
    await user.click(within(dialog).getByRole('button', { name: /KP_Yelka_v2\.pdf/ }));
    const failed = await screen.findByRole('dialog', { name: 'KP_Yelka_v2.pdf' });
    expect(await within(failed).findByText('Проект не найден.')).toBeInTheDocument();
    s.set('GET /app/api/files/status', { body: { state: 'ok' } });
    await user.click(within(failed).getByRole('button', { name: 'Повторить' }));
    expect(await within(failed).findByRole('link', { name: 'Скачать' })).toBeInTheDocument();
  });

  it('shows found files in their group, says there are more, and names a project folder it could not read', async () => {
    server({ body: { ...FOUND, files: { files: [KP], unreadable: [{ projectId: 'p2', name: 'Ключевые клиенты' }], more: true } } });
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    await user.type(within(dialog).getByRole('textbox'), 'кп');
    expect(await within(dialog).findByText('Найдено: 4')).toBeInTheDocument();
    expect(within(dialog).getByText('Файлы', { selector: 'div' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /KP_Yelka_v2\.pdf/ })).toBeInTheDocument();
    expect(within(dialog).getByText('Показаны первые 50 — уточните запрос')).toBeInTheDocument();
    expect(within(dialog).getByText('Файлы проекта «Ключевые клиенты» сейчас не открываются. Сообщите администратору.')).toBeInTheDocument();
  });

  it('says on «Файлы» when there are none and shows a list that did not load with a repeat', async () => {
    const s = server();
    s.set('GET /app/api/search/files', apiError('APP_SEARCH_FAILED', 'Поиск сейчас не работает. Попробуйте ещё раз.', 500));
    renderApp('/agents/sales?thread=t1');
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole('button', { name: 'Файлы' }));
    expect(await within(dialog).findByText('Не удалось загрузить файлы')).toBeInTheDocument();
    s.set('GET /app/api/search/files', { body: NO_FILES });
    await user.click(within(dialog).getByRole('button', { name: 'Повторить' }));
    expect(await within(dialog).findByText('Файлов пока нет')).toBeInTheDocument();
  });

  it('opens from «Поиск» in the menu of a phone without project chips and closes by «Отмена»', async () => {
    stubSystemTheme('light', PHONE_WIDTH);
    server();
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Меню' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Меню' })).getByRole('button', { name: 'Поиск' }));
    const dialog = await screen.findByRole('dialog', { name: 'Поиск' });
    expect(await within(dialog).findByText('2 разговора')).toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: 'В проекте' })).not.toBeInTheDocument();
    // No tabs on a phone: found files are a group of the list.
    expect(within(dialog).queryByRole('button', { name: 'Файлы' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Все проекты' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('dialog', { name: 'Поиск' })).not.toBeInTheDocument();
  });
});
