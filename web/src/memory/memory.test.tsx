// Memory as a list of entries (spec, section 8.26): the block on the page of a project and «Моя память».
import type { MemoryEntryDto, MemoryListDto } from '@bba/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const TENDER = { id: 'p1', name: 'Тендер Альфа', instructions: '', threadCount: 0, lastActiveAt: '2026-11-10T08:00:00Z', pinned: false, createdAt: '2026-11-10T08:00:00Z', role: 'owner' as const, owner: { id: 'u-olga', name: 'Ольга' }, shared: false, unseen: false, access: { mode: 'private' as const, departments: [], people: [] }, archivedAt: null };
const MEMORY = '/app/api/projects/p1/memory';

function entry(over: Partial<MemoryEntryDto> & Pick<MemoryEntryDto, 'id' | 'number' | 'text'>): MemoryEntryDto {
  return { version: 1, editor: { name: 'Анна Смирнова', byAgent: true, you: false }, updatedAt: new Date().toISOString(), ...over };
}

const list = (entries: MemoryEntryDto[], over: Partial<MemoryListDto> = {}): MemoryListDto => ({ entries, usedChars: entries.reduce((n, e) => n + e.text.length, 0), maxChars: 6000, readOnly: false, ...over });

function projectServer(memory: MemoryListDto | ReturnType<typeof apiError>, extra: Parameters<typeof mockServer>[0] = {}) {
  return mockServer({
    'GET /app/api/me': { body: ME },
    'GET /app/api/agents': { body: { agents: [] } },
    'GET /app/api/threads': { body: { threads: [], next: null } },
    'GET /app/api/projects': { body: { projects: [TENDER], archivedCount: 0 } },
    'GET /app/api/projects/p1': { body: TENDER },
    'GET /app/api/projects/p1/files': { body: { files: [] } },
    'GET /app/api/projects/p1/trash': { body: { batches: [] } },
    [`GET ${MEMORY}`]: 'status' in memory ? memory : { body: memory },
    ...extra,
  });
}

async function block() {
  return (await screen.findByRole('heading', { name: 'Память проекта' })).parentElement!.parentElement!;
}

describe('the memory of a project', () => {
  it('says what to do when nothing is remembered yet', async () => {
    projectServer(list([]));
    renderApp('/projects/p1');
    expect(await screen.findByText('Агенты пока ничего не запомнили. Скажите агенту в разговоре проекта «Запомни, что…» — или добавьте запись сами.')).toBeInTheDocument();
    expect(screen.getByText(/Что агенты запомнили о проекте между разговорами/)).toBeInTheDocument();
  });

  it('shows who changed an entry last — a person or their agent, or a removed employee', async () => {
    projectServer(
      list([
        entry({ id: 'e1', number: 1, text: 'Подача до 28.11.2026 09:00' }),
        entry({ id: 'e2', number: 2, text: 'Аванс не предусмотрен', editor: { name: 'Пётр Иванов', byAgent: false, you: false } }),
        entry({ id: 'e3', number: 3, text: 'НМЦК 14 862 400 ₽', editor: { name: null, byAgent: false, you: false } }),
      ]),
    );
    renderApp('/projects/p1');
    expect(await screen.findByText('Подача до 28.11.2026 09:00')).toBeInTheDocument();
    expect(screen.getByText('Анна Смирнова через агента · сегодня')).toBeInTheDocument();
    expect(screen.getByText('Пётр Иванов · сегодня')).toBeInTheDocument();
    expect(screen.getByText('Бывший сотрудник · сегодня')).toBeInTheDocument();
  });

  it('warns from 80 % of the limit and says when it is full', async () => {
    projectServer(list([entry({ id: 'e1', number: 1, text: 'Срок' })], { usedChars: 5000 }));
    const view = renderApp('/projects/p1');
    expect(await screen.findByText(/^Занято 5\s000 из 6\s000 знаков\. Когда память заполнится, агент будет освобождать место сам/)).toBeInTheDocument();
    view.unmount();
    projectServer(list([entry({ id: 'e1', number: 1, text: 'Срок' })], { usedChars: 6000 }));
    renderApp('/projects/p1');
    expect(await screen.findByText('Память заполнена: агент освобождает место сам, можно удалить лишнее и вручную.')).toBeInTheDocument();
  });

  it('of an archived project is only read', async () => {
    projectServer(list([entry({ id: 'e1', number: 1, text: 'Итоги 02.12' })], { readOnly: true }));
    renderApp('/projects/p1');
    expect(await screen.findByText('Итоги 02.12')).toBeInTheDocument();
    expect(screen.getByText('Проект в архиве: память не меняется.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Добавить запись' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Действия с записью 1' })).not.toBeInTheDocument();
  });

  it('that did not load says so and loads again', async () => {
    const s = projectServer(apiError('APP_INTERNAL', 'Что-то пошло не так.', 500));
    renderApp('/projects/p1');
    expect(await screen.findByText('Память проекта не загрузилась')).toBeInTheDocument();
    s.set(`GET ${MEMORY}`, { body: list([entry({ id: 'e1', number: 1, text: 'Подача до 28.11' })]) });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Подача до 28.11')).toBeInTheDocument();
  });

  it('adds an entry and keeps the text when the memory is full', async () => {
    const s = projectServer(list([]), { [`POST ${MEMORY}`]: apiError('APP_MEMORY_FULL', 'Память проекта заполнена. Удалите устаревшие записи и попробуйте снова.', 409) });
    renderApp('/projects/p1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Добавить запись' }));
    await user.type(screen.getByRole('textbox', { name: 'Запись' }), 'Письма заказчику — только через площадку');
    expect(screen.getByText('40 из 400')).toBeInTheDocument();
    await user.click(within(await block()).getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Память проекта заполнена. Удалите устаревшие записи и попробуйте снова.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Запись' })).toHaveValue('Письма заказчику — только через площадку');

    s.set(`POST ${MEMORY}`, () => {
      s.set(`GET ${MEMORY}`, { body: list([entry({ id: 'e9', number: 1, text: 'Письма заказчику — только через площадку', editor: { name: 'Ольга', byAgent: false, you: true } })]) });
      return { body: entry({ id: 'e9', number: 1, text: 'Письма заказчику — только через площадку' }) };
    });
    await user.click(within(await block()).getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Запись добавлена')).toBeInTheDocument();
    expect(await screen.findByText('Ольга · сегодня')).toBeInTheDocument();
    expect(s.calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({ text: 'Письма заказчику — только через площадку' });
  });

  it('does not let an entry over 400 signs be saved', async () => {
    projectServer(list([]));
    renderApp('/projects/p1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Добавить запись' }));
    await user.click(screen.getByRole('textbox', { name: 'Запись' }));
    await user.paste('я'.repeat(401));
    expect(screen.getByText('401 из 400')).toBeInTheDocument();
    expect(within(await block()).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  });

  it('keeps the person’s text when the entry was changed meanwhile, and saves it over the new version', async () => {
    const s = projectServer(list([entry({ id: 'e1', number: 1, text: 'Подача до 28.11', version: 1 })]));
    s.set(`PUT ${MEMORY}/e1`, (call) => {
      if ((call.body as { version: number }).version === 1) {
        s.set(`GET ${MEMORY}`, { body: list([entry({ id: 'e1', number: 1, text: 'Подача до 30.11', version: 2 })]) });
        return apiError('APP_MEMORY_CONFLICT', 'Запись изменили, пока вы её правили.', 409);
      }
      s.set(`GET ${MEMORY}`, { body: list([entry({ id: 'e1', number: 1, text: 'Подача до 01.12', version: 3 })]) });
      return { body: entry({ id: 'e1', number: 1, text: 'Подача до 01.12', version: 3 }) };
    });
    renderApp('/projects/p1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия с записью 1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Изменить' }));
    const field = screen.getByRole('textbox', { name: 'Запись' });
    await user.clear(field);
    await user.type(field, 'Подача до 01.12');
    await user.click(within(await block()).getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Запись изменили, пока вы её правили. Сейчас в ней: «Подача до 30.11». Ваш текст остался в поле — сохраните, если он вернее.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Запись' })).toHaveValue('Подача до 01.12');
    await user.click(within(await block()).getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Запись сохранена')).toBeInTheDocument();
    expect(s.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { text: 'Подача до 01.12', version: 1 },
      { text: 'Подача до 01.12', version: 2 },
    ]);
  });

  it('offers to save the text as a new entry when the entry was removed meanwhile', async () => {
    const s = projectServer(list([entry({ id: 'e1', number: 1, text: 'Аванс 30 %' })]));
    s.set(`PUT ${MEMORY}/e1`, () => {
      s.set(`GET ${MEMORY}`, { body: list([]) });
      return apiError('APP_MEMORY_ENTRY_NOT_FOUND', 'Этой записи уже нет: её удалили.', 404);
    });
    s.set(`POST ${MEMORY}`, { body: entry({ id: 'e2', number: 2, text: 'Аванс 20 %' }) });
    renderApp('/projects/p1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия с записью 1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Изменить' }));
    const field = screen.getByRole('textbox', { name: 'Запись' });
    await user.clear(field);
    await user.type(field, 'Аванс 20 %');
    await user.click(within(await block()).getByRole('button', { name: 'Сохранить' }));
    // The field moves from the removed row above the list once the list is read again.
    await waitFor(() => expect(screen.getByText('Этой записи уже нет: её удалили. Ваш текст остался в поле.')).toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Запись' })).toHaveValue('Аванс 20 %');
    await user.click(screen.getByRole('button', { name: 'Сохранить как новую запись' }));
    expect(await screen.findByText('Запись добавлена')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({ text: 'Аванс 20 %' });
  });

  it('removes an entry without a question and brings it back by «Вернуть»; a full memory keeps its text in sight', async () => {
    const s = projectServer(list([entry({ id: 'e1', number: 1, text: 'Обеспечение заявки 1 %' })]));
    s.set(`DELETE ${MEMORY}/e1`, () => {
      s.set(`GET ${MEMORY}`, { body: list([]) });
      return { body: entry({ id: 'e1', number: 1, text: 'Обеспечение заявки 1 %' }) };
    });
    s.set(`POST ${MEMORY}`, apiError('APP_MEMORY_FULL', 'Память проекта заполнена. Удалите устаревшие записи и попробуйте снова.', 409));
    renderApp('/projects/p1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия с записью 1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Удалить' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const toast = await screen.findByText('Запись удалена');
    await user.click(within(toast.parentElement!).getByRole('button', { name: 'Вернуть' }));
    expect(await screen.findByText('Не удалось вернуть запись: память заполнена. Текст записи: «Обеспечение заявки 1 %».')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({ text: 'Обеспечение заявки 1 %' });
  });
});

describe('«Моя память»', () => {
  function meServer(memory: MemoryListDto) {
    return mockServer({ 'GET /app/api/me': { body: ME }, 'GET /app/api/me/memory': { body: memory } });
  }

  it('shows the person’s entries as theirs or their agents’, and forgets all only after «да»', async () => {
    const s = meServer(list([entry({ id: 'm1', number: 1, text: 'Ведёт только юрлиц', editor: { name: 'Ольга', byAgent: true, you: true } }), entry({ id: 'm2', number: 2, text: 'Звонить после обеда', editor: { name: 'Ольга', byAgent: false, you: true } })], { maxChars: 3000 }));
    s.set('DELETE /app/api/me/memory', () => {
      s.set('GET /app/api/me/memory', { body: list([], { maxChars: 3000 }) });
      return { body: { ok: true } };
    });
    renderApp('/settings/memory');
    const user = userEvent.setup();
    expect(await screen.findByText('Ведёт только юрлиц')).toBeInTheDocument();
    expect(screen.getByText('Агент · сегодня')).toBeInTheDocument();
    expect(screen.getByText('Вы · сегодня')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Забыть всё' }));
    const question = screen.getByRole('alertdialog', { name: 'Забыть всё?' });
    await user.click(within(question).getByRole('button', { name: 'Отмена' }));
    expect(s.calls.some((c) => c.method === 'DELETE')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Забыть всё' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Забыть всё' }));
    expect(await screen.findByText('Память очищена')).toBeInTheDocument();
    expect(await screen.findByText('Агенты пока ничего о вас не запомнили')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Забыть всё' })).not.toBeInTheDocument());
  });
});
