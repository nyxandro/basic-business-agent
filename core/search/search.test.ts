import { randomUUID } from 'node:crypto';
import { GENUI_TOOL_IDS, type SearchResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureThread } from '../memory/memory.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { SNIPPET_RADIUS } from './snippet.ts';

let t: TestApp;
let olgaId: string;
let petrId: string;
let olga: string;

type Part = { type: 'text'; text: string } | { type: 'tool-invocation'; toolInvocation: { state: 'result'; toolCallId: string; toolName: string; args: unknown; result: unknown } };

async function conversation(userId: string, title: string, turns: [role: 'user' | 'assistant', parts: Part[]][], agentId = 'sales'): Promise<string> {
  const threadId = randomUUID();
  await ensureThread(t.memory, { threadId, resourceId: userId, agentId, kind: 'chat', title });
  await t.memory.saveMessages({
    messages: turns.map(([role, parts], i) => ({ id: randomUUID(), threadId, resourceId: userId, role, createdAt: new Date(Date.now() + i), content: { format: 2 as const, parts } })),
  });
  return threadId;
}

const text = (value: string): Part => ({ type: 'text', text: value });
const search = async (q: string, extra = '') => (await (await t.call('GET', `/app/api/search?q=${encodeURIComponent(q)}${extra}`, { cookie: olga })).json()) as SearchResponse;

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('search', () => {
  it('finds a conversation when every word is in its title or in any of its messages, with a piece of text around the match', async () => {
    const id = await conversation(olgaId, 'Договор поставки', [
      ['user', [text('Проверь договор на риски')]],
      ['assistant', [text('В разделе 7 штраф 0,1% в день. Поставщик — ООО Стройресурс, срок — 10 дней после оплаты.')]],
    ]);
    await conversation(olgaId, 'Другое', [['user', [text('Сводка по воронке')]]]);
    const found = await search('договор стройресурс');
    expect(found.threads.map((x) => x.id)).toEqual([id]);
    expect(found.threads[0]).toMatchObject({ title: 'Договор поставки', agentId: 'sales', projectId: null });
    expect(found.threads[0]!.snippet).toContain('Стройресурс');
    expect(found.threads[0]!.snippet.length).toBeLessThanOrEqual(130);
  });

  it('shows the agent’s answer in the piece of text as the chat does, without Markdown', async () => {
    await conversation(olgaId, 'Что ты умеешь', [
      ['user', [text('Что ты умеешь?')]],
      ['assistant', [text('Вот что я реально умею. **Из инструментов:**\n1. **Заметки** — вести персональные заметки\n\n| Что | Где |\n|---|---|\n| Счета | `bills/` |')]],
    ]);
    const [found] = (await search('заметки')).threads;
    // From 20 characters before the word, at the start of a word.
    expect(found!.snippet).toBe('…Из инструментов: Заметки — вести персональные заметки Что Где Счета bills/');
  });

  it('shows the person’s first message when the word is only in the title', async () => {
    const id = await conversation(olgaId, 'Цемент марки М500', [
      ['user', [text('Сколько мешков брать на фундамент?')]],
      ['assistant', [text('Около сорока.')]],
    ]);
    const found = (await search('цемент')).threads.find((x) => x.id === id);
    expect(found?.snippet).toBe('Сколько мешков брать на фундамент?');
  });

  it('reads only the text of the person and the agent: not tool results, not the service words of the stored format', async () => {
    await conversation(olgaId, 'Сделки', [
      ['user', [text('Покажи сделки')]],
      ['assistant', [{ type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'c1', toolName: 'crm_deals', args: {}, result: { rows: ['ООО Секретный-Клиент'] } } }, text('Вот сделки.')]],
    ]);
    expect((await search('Секретный')).threads).toEqual([]);
    expect((await search('format')).threads).toEqual([]);
    expect((await search('parts')).threads).toEqual([]);
  });

  it('finds the words the person saw in blocks of the interface, not in what a block failed with or what tools were given (spec, 8.28, F25)', async () => {
    const block = (toolName: string, args: unknown, result: unknown = { shown: true }): Part => ({ type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: randomUUID(), toolName, args, result } });
    const card = await conversation(olgaId, 'Договор', [
      ['user', [text('Что по договору?')]],
      ['assistant', [block('show_card', { title: 'Условия', fields: [{ label: 'Предоплата', value: 'тридцать процентов' }] }), text('Условия — в карточке.')]],
    ]);
    const table = await conversation(olgaId, 'Смета', [['assistant', [block('show_table', { columns: [{ key: 'p', label: 'Позиция' }], rows: [{ p: 'Гидроизоляция' }] })]]]);
    const drawn = await conversation(olgaId, 'Сделки CRM', [['assistant', [block('crm_deals', {}, { table: { columns: [{ key: 'n', label: 'Сделка' }], rows: [{ n: 'Пескоструйка' }] } })]]]);
    const chart = await conversation(olgaId, 'График', [['assistant', [block('show_chart', { title: 'Выручка филиалов', kind: 'bar', labels: ['Тверь'], series: [{ name: 'План', values: [1] }] })]]]);
    const choice = await conversation(olgaId, 'Выбор', [['assistant', [block('ask_choice', { question: 'Какой подрядчик?', options: [{ value: 'a', label: 'Монолитстрой' }, { value: 'b', label: 'Другой' }] })]]]);
    const file = await conversation(olgaId, 'Файл', [['assistant', [block('show_file', { path: 'out/Калькуляция.xlsx' }, { name: 'Калькуляция.xlsx', path: 'out/Калькуляция.xlsx', bytes: 10, shown: true })]]]);
    const form = await conversation(olgaId, 'Форма', [['assistant', [block('ask_form', { title: 'Реквизиты', fields: [{ name: 'b', label: 'Бенефициар', kind: 'text', required: true }, { name: 'k', label: 'КПП', kind: 'text', required: false }], submitLabel: 'Отправить' })]]]);
    await conversation(olgaId, 'Сбой', [['assistant', [block('show_card', { title: 'Невидимка' }, { error: true, message: 'Tool input validation failed' })]]]);
    await conversation(olgaId, 'Команда', [['assistant', [block('mastra_workspace_execute_command', { command: 'grep Тайносекрет' }, 'Тайносекрет найден')]]]);

    expect((await search('предоплата')).threads.map((x) => x.id)).toEqual([card]);
    expect((await search('тридцать')).threads.map((x) => x.id)).toEqual([card]);
    expect((await search('гидроизоляция')).threads.map((x) => x.id)).toEqual([table]);
    expect((await search('пескоструйка')).threads.map((x) => x.id)).toEqual([drawn]);
    expect((await search('филиалов')).threads.map((x) => x.id)).toEqual([chart]);
    expect((await search('монолитстрой')).threads.map((x) => x.id)).toEqual([choice]);
    expect((await search('калькуляция')).threads.map((x) => x.id)).toEqual([file]);
    expect((await search('бенефициар')).threads.map((x) => x.id)).toEqual([form]);
    expect((await search('невидимка')).threads).toEqual([]);
    expect((await search('тайносекрет')).threads).toEqual([]);
  });

  it('has words in the search for every block of the interface: a new block without them fails here', async () => {
    const sample: Record<string, unknown> = {
      show_table: { columns: [{ key: 'a', label: 'Столбецблок' }], rows: [] },
      show_chart: { title: 'Графикблок', kind: 'bar', labels: ['x'], series: [{ name: 's', values: [1] }] },
      show_card: { title: 'Карточкаблок', fields: [] },
      ask_choice: { question: 'Выборблок', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      ask_form: { title: 'Формаблок', fields: [], submitLabel: 'OK' },
      show_file: { path: 'Файлблок.docx' },
    };
    for (const id of GENUI_TOOL_IDS) {
      expect(sample[id], `no sample for ${id}`).toBeDefined();
      const word = JSON.stringify(sample[id]).match(/[А-Яа-я]+блок/)![0];
      const threadId = await conversation(olgaId, `Блок ${id}`, [['assistant', [{ type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: randomUUID(), toolName: id, args: sample[id], result: { shown: true } } }]]]);
      expect((await search(word)).threads.map((x) => x.id), id).toEqual([threadId]);
    }
  });

  // A widget (spec, section 8.31): the words the person saw are found; ids, codes of options and a refused screen not.
  it('finds the words of a widget, not its ids, and not a screen the check refused', async () => {
    const operations = [{ version: '1.0', createSurface: { surfaceId: 'qzxsurfaceid', dataModel: { client: 'Виджетклиент' }, components: [{ id: 'root', component: 'Column', children: ['t', 'r'] }, { id: 't', component: 'Title', text: 'Виджетзаголовок' }, { id: 'r', component: 'RadioGroup', options: [{ value: 'wqvcodeopt', label: 'Виджетвариант' }] }] } }];
    const shown = await conversation(olgaId, 'Экран', [['assistant', [{ type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: randomUUID(), toolName: 'render_ui', args: { operations }, result: { shown: true, surfaceId: 'qzxsurfaceid' } } }]]]);
    for (const word of ['Виджетзаголовок', 'Виджетвариант', 'Виджетклиент']) expect((await search(word)).threads.map((x) => x.id), word).toEqual([shown]);
    for (const word of ['qzxsurfaceid', 'wqvcodeopt']) expect((await search(word)).threads, word).toEqual([]);
    const refusedOps = [{ version: '1.0', createSurface: { surfaceId: 'x', components: [{ id: 'root', component: 'Title', text: 'Отклонённыйэкран' }] } }];
    await conversation(olgaId, 'Отказ', [['assistant', [{ type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: randomUUID(), toolName: 'render_ui', args: { operations: refusedOps }, result: { error: true, code: 'APP_WIDGET_INVALID', message: 'нет' } } }]]]);
    expect((await search('Отклонённыйэкран')).threads).toEqual([]);
  });

  it('never shows someone else’s conversation and takes % and _ as plain characters', async () => {
    await conversation(petrId, 'Арматура', [['user', [text('Смета по арматуре А500С')]]]);
    expect((await search('арматур')).threads).toEqual([]);
    const pct = await conversation(olgaId, 'Скидки', [['user', [text('Скидка 10% на бетон')]]]);
    expect((await search('10%')).threads.map((x) => x.id)).toEqual([pct]);
    expect((await search('1_%')).threads).toEqual([]);
  });

  it('finds projects by name with their conversation count', async () => {
    const project = (await (await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Тендер ЖК Северный', access: { mode: 'private', departmentIds: [], userIds: [] } } })).json()) as { id: string };
    const inProject = await conversation(olgaId, 'Смета по тендеру', [['user', [text('Смета для тендера')]]]);
    await t.call('PUT', `/app/api/threads/${inProject}/project`, { cookie: olga, body: { projectId: project.id } });
    await conversation(olgaId, 'Тендер другой', [['user', [text('Ещё тендер')]]]);

    const all = await search('тендер');
    expect(all.projects).toEqual([{ id: project.id, name: 'Тендер ЖК Северный', nameMarks: [[0, 6]], threadCount: 1, shared: false, ownerName: null }]);
    // Found with a typo: the word of the name within the allowed edits is marked.
    expect((await search('тедер', '&scope=projects')).projects.map((p) => p.nameMarks)).toEqual([[[0, 6]]]);
    expect(all.threads).toHaveLength(2);
    expect((await search('тендер', '&scope=projects')).threads).toEqual([]);
    expect((await search('тендер', '&scope=threads')).projects).toEqual([]);
    expect(all.threads.find((x) => x.id === inProject)?.projectId).toBe(project.id);
  });

  it('finds a word in another form, in Latin, in the other layout and with a typo; typos below direct finds', async () => {
    const titled = await conversation(olgaId, 'Договор поставки', [['user', [text('Проверь условия')]]]);
    const inText = await conversation(olgaId, 'Разное', [['user', [text('Пришлю по договору завтра')]]]);
    const typo = await conversation(olgaId, 'Склад', [['user', [text('Нужен догвор аренды')]]]);
    await conversation(olgaId, 'Отчёт', [['user', [text('Цифры за октябрь')]]]);
    const ids = async (q: string) => (await search(q)).threads.map((x) => x.id).filter((id) => [titled, inText, typo].includes(id));
    expect(await ids('договоры')).toEqual([inText, titled, typo]);
    expect(await ids('dogovor')).toEqual([inText, titled, typo]);
    expect(await ids('ljujdjh')).toEqual([inText, titled, typo]);
    // Only typos: newest first. «договро» is three edits from «догвор»: not found.
    expect(await ids('дговор')).toEqual([typo, inText, titled]);
    expect(await ids('договро')).toEqual([inText, titled]);
    const found = (await search('договоры')).threads;
    expect(found.find((x) => x.id === inText)?.snippet).toBe('Пришлю по договору завтра');
    expect(found.find((x) => x.id === typo)?.snippet).toBe('Нужен догвор аренды');
  });

  it('says what of the title and the piece of text it found: the form, the Latin, the typo only where found by it', async () => {
    const titled = await conversation(olgaId, 'Договор поставки', [['user', [text('Проверь условия')]]]);
    const inText = await conversation(olgaId, 'Разное', [['user', [text('Пришлю по договору завтра')]]]);
    const typo = await conversation(olgaId, 'Склад', [['user', [text('Нужен догвор аренды')]]]);
    const marked = (t: string, marks: [number, number][]) => marks.map(([from, to]) => t.slice(from, to));
    const found = (await search('договоры')).threads;
    const of = (id: string) => found.find((x) => x.id === id)!;
    expect(marked(of(titled).title, of(titled).titleMarks)).toEqual(['Договор']);
    expect(marked(of(inText).snippet, of(inText).snippetMarks)).toEqual(['договор']);
    expect(of(inText).titleMarks).toEqual([]);
    expect(marked(of(typo).snippet, of(typo).snippetMarks)).toEqual(['догвор']);
    const latin = (await search('dogovor')).threads.find((x) => x.id === titled)!;
    expect(marked(latin.title, latin.titleMarks)).toEqual(['Договор']);
  });

  it('starts the piece of text close before the word, so a one-line row shows it', async () => {
    const id = await conversation(olgaId, 'Длинный ответ', [['user', [text(`${'Вступление без нужного слова. '.repeat(6)}Здесь арматура А500С на складе. ${'Хвост. '.repeat(30)}`)]]]);
    const found = (await search('арматура')).threads.find((x) => x.id === id)!;
    const from = found.snippetMarks[0]![0];
    expect(found.snippet.slice(from, from + 8)).toBe('арматура');
    // Up to 20 characters before it and the «…».
    expect(from).toBeLessThanOrEqual(21);
    expect(found.snippet.length).toBeLessThanOrEqual(2 * SNIPPET_RADIUS + 2);
  });

  it('keeps finding a piece of a word, and finds project names by the same rules', async () => {
    await conversation(olgaId, 'Субподряд 2026', [['user', [text('Сроки')]]]);
    expect((await search('подряд')).threads.map((x) => x.title)).toContain('Субподряд 2026');
    await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Договоры 2026', access: { mode: 'private', departmentIds: [], userIds: [] } } });
    expect((await search('dogovor')).projects.map((x) => x.name)).toContain('Договоры 2026');
    expect((await search('дговоры')).projects.map((x) => x.name)).toContain('Договоры 2026');
  });

  it('refuses a query shorter than 2 characters, of one-letter words only, or too long', async () => {
    expect((await t.call('GET', '/app/api/search?q=a', { cookie: olga })).status).toBe(400);
    expect((await t.call('GET', `/app/api/search?q=${encodeURIComponent('с и')}`, { cookie: olga })).status).toBe(400);
    const long = await t.call('GET', `/app/api/search?q=${encodeURIComponent('слово '.repeat(11))}`, { cookie: olga });
    expect(long.status).toBe(400);
    expect(await long.text()).toContain('Запрос слишком длинный');
  });

  // Messages are heavy with tool results (24 KB on average in the development installation, 16.11): the
  // piece of text of 50 found conversations must not read them all.
  it('M3: answers within the limit when the found conversations are heavy with tool results', { timeout: 120_000 }, async () => {
    const ivan = await t.createUser({ email: 'ivan@example.com', name: 'Иван' });
    const cookie = await t.signIn('ivan@example.com');
    const heavy = { type: 'tool-invocation' as const, toolInvocation: { state: 'result' as const, toolCallId: 'c', toolName: 'read_file', args: {}, result: { text: 'Строка ведомости материалов. '.repeat(700) } } };
    for (let c = 0; c < 50; c++) {
      const threadId = randomUUID();
      await ensureThread(t.memory, { threadId, resourceId: ivan, agentId: 'sales', kind: 'chat', title: `Смета ${c}` });
      await t.memory.saveMessages({
        messages: Array.from({ length: 30 }, (_, i) => ({
          id: randomUUID(),
          threadId,
          resourceId: ivan,
          role: (i % 2 ? 'assistant' : 'user'),
          createdAt: new Date(Date.now() + i),
          content: { format: 2 as const, parts: i % 2 ? [heavy, text(i === 15 ? 'Арматура А500С по договору' : 'Готово')] : [text('Посчитай')] },
        })),
      });
    }
    await t.db.query('ANALYZE app.message_texts');
    const timings: number[] = [];
    for (const q of ['арматура', 'договор', 'арматуры договору']) {
      const started = performance.now();
      const res = await t.call('GET', `/app/api/search?q=${encodeURIComponent(q)}`, { cookie });
      timings.push(performance.now() - started);
      expect(res.status).toBe(200);
      expect((await res.json() as SearchResponse).threads).toHaveLength(50);
    }
    console.log(`M3 heavy timings: ${timings.map(Math.round).join(', ')} ms`);
    expect(Math.max(...timings)).toBeLessThan(800);
  });

  // M3 (14.11): 190–300 ms on 50 000 messages of one person — far more than a real person has.
  // The bound guards against a slowdown; above 300 ms the server writes search_slow to the log.
  it('M3: answers on 50 000 messages of one person within the limit', { timeout: 120_000 }, async () => {
    const lena = await t.createUser({ email: 'lena@example.com', name: 'Лена' });
    const cookie = await t.signIn('lena@example.com');
    const words = ['сделка', 'поставка', 'бетон', 'арматура', 'смета', 'счёт', 'договор', 'клиент', 'оплата', 'доставка'];
    for (let c = 0; c < 500; c++) {
      const threadId = randomUUID();
      await ensureThread(t.memory, { threadId, resourceId: lena, agentId: 'sales', kind: 'chat', title: `Разговор ${c}` });
      await t.memory.saveMessages({
        messages: Array.from({ length: 100 }, (_, i) => ({
          id: randomUUID(),
          threadId,
          resourceId: lena,
          role: (i % 2 ? 'assistant' : 'user'),
          createdAt: new Date(Date.now() + i),
          content: { format: 2 as const, parts: [text(`${words[(c + i) % 10]} номер ${c}-${i}: обычный текст сообщения о работе отдела продаж`)] },
        })),
      });
    }
    // As the database's background maintenance does for a table that grew: the plan needs its statistics.
    await t.db.query('ANALYZE app.message_texts');
    const timings: number[] = [];
    for (const q of ['бетон 250-7', 'договор', 'оплата 120-33', 'дговор']) {
      const started = performance.now();
      const res = await t.call('GET', `/app/api/search?q=${encodeURIComponent(q)}`, { cookie });
      timings.push(performance.now() - started);
      expect(res.status).toBe(200);
    }
    console.log(`M3 timings: ${timings.map(Math.round).join(', ')} ms`);
    expect(Math.max(...timings)).toBeLessThan(800);
  });
});
