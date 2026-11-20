// What a past conversation reads like for the agent (spec, section 8.28): what the person saw — words,
// blocks of the interface, files, memory lines and actions after «Да» — and nothing of the service parts.
import { GENUI_TOOL, GENUI_TOOL_IDS, WIDGET_TOOL } from '@bba/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type ApprovalOutcome, visibleOf } from './transcript.ts';

type Part = Record<string, unknown>;
const message = (parts: Part[]) => JSON.stringify({ format: 2, parts });
const text = (value: string): Part => ({ type: 'text', text: value });
const call = (toolName: string, args: unknown, result: unknown, state = 'result', toolCallId = `c-${toolName}`): Part => ({
  type: 'tool-invocation',
  toolInvocation: { state, toolCallId, toolName, args, ...(state === 'result' ? { result } : {}), ...(state === 'output-error' ? { errorText: String(result) } : {}) },
});
const none = new Map<string, ApprovalOutcome>();

describe('visibleOf', () => {
  it('keeps the words of the person and of the agent, and names the files a message brought', () => {
    const asked = visibleOf({ role: 'user', content: message([text('Сделай КП по смете\n\nВложения:\n- Смета.xlsx (файл в рабочей папке: Смета.xlsx)')]) }, none);
    expect(asked).toEqual({ text: 'Сделай КП по смете', marks: ['вложения: Смета.xlsx'] });
    expect(visibleOf({ role: 'assistant', content: message([text('Готово.'), text('Итог — 4,2 млн ₽.')]) }, none).text).toBe('Готово.\nИтог — 4,2 млн ₽.');
  });

  it('turns every block of the interface into lines of text', () => {
    const shown = visibleOf(
      {
        role: 'assistant',
        content: message([
          call(GENUI_TOOL.table, { title: 'Смета', columns: [{ key: 'p', label: 'Позиция' }, { key: 'v', label: 'Цена' }], rows: [{ p: 'Кровля', v: '2 100 000 ₽' }, { p: 'Фасад', v: null }] }, { shown: true }),
          call(GENUI_TOOL.card, { title: 'Условия договора', subtitle: 'с ООО Ромашка', fields: [{ label: 'Аванс', value: '30 %' }] }, { shown: true }),
          call(GENUI_TOOL.chart, { title: 'Маржа', kind: 'bar', labels: ['−5%', '−8%'], series: [{ name: 'Маржа, тыс. ₽', values: [2199.28, 1753.41] }] }, { shown: true }),
          call(GENUI_TOOL.choice, { question: 'Какой вариант?', options: [{ value: 'a', label: 'Первый' }, { value: 'b', label: 'Второй' }] }, { shown: true, waitForAnswer: true }),
          call(GENUI_TOOL.form, { title: 'Реквизиты', fields: [{ name: 'inn', label: 'ИНН', kind: 'text', required: true }, { name: 'kpp', label: 'КПП', kind: 'text', required: false }], submitLabel: 'Отправить' }, { shown: true }),
          call(GENUI_TOOL.file, { path: 'docs/КП_v2.docx' }, { name: 'КП_v2.docx', path: 'docs/КП_v2.docx', bytes: 1000, shown: true }),
        ]),
      },
      none,
    );
    expect(shown.marks).toEqual([
      'таблица «Смета»: Позиция | Цена',
      '  Кровля | 2 100 000 ₽',
      '  Фасад | ',
      'карточка «Условия договора» (с ООО Ромашка): Аванс — 30 %',
      'график «Маржа»: −5% · −8% → Маржа, тыс. ₽: 2199.28 · 1753.41',
      'вопрос с вариантами: «Какой вариант?» — Первый / Второй',
      'форма «Реквизиты»: ИНН, КПП',
      'файл: КП_v2.docx',
    ]);
  });

  it('shows the first rows of a long table and says how many more there are', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ n: `строка ${i + 1}` }));
    const { marks } = visibleOf({ role: 'assistant', content: message([call(GENUI_TOOL.table, { columns: [{ key: 'n', label: 'Что' }], rows }, { shown: true })]) }, none);
    expect(marks[0]).toBe('таблица: Что');
    expect(marks).toHaveLength(1 + 20 + 1);
    expect(marks.at(-1)).toBe('  … ещё 5 строк');
  });

  it('shows a table a tool drew in the chat from its result', () => {
    const result = { table: { columns: [{ key: 'name', label: 'Сделка' }], rows: [{ name: 'Поставка бетона' }] } };
    expect(visibleOf({ role: 'assistant', content: message([call('crm_deals', {}, result)]) }, none).marks).toEqual(['таблица: Сделка', '  Поставка бетона']);
  });

  it('leaves out a block the person never saw: it failed its check or did not finish', () => {
    const failed = call(GENUI_TOOL.card, { title: 'Не та' }, { error: true, message: 'Tool input validation failed' });
    const unfinished = call(GENUI_TOOL.card, { title: 'Ещё нет', fields: [] }, undefined, 'call');
    expect(visibleOf({ role: 'assistant', content: message([failed, unfinished]) }, none).marks).toEqual([]);
  });

  it('names what the agent wrote to memory, as the line in the chat did', () => {
    const project = call('project_memory', { operations: [] }, { results: [{ action: 'add', number: 1, text: 'Подача до 28.11' }, { action: 'remove', number: 2, text: 'Аванс 20 %' }], usedChars: 10, maxChars: 6000 });
    const personal = call('personal_memory', { operations: [] }, { results: [{ action: 'change', number: 1, text: 'Отвечать коротко', previousText: 'Отвечать подробно' }] });
    expect(visibleOf({ role: 'assistant', content: message([project, personal]) }, none).marks).toEqual([
      'записано в память проекта: «Подача до 28.11»',
      'убрано из памяти проекта: «Аванс 20 %»',
      'изменено в личной памяти: «Отвечать коротко»',
    ]);
  });

  it('tells what came of each action that waited for «Да», from its request and from the call itself', () => {
    const summary = 'Отправить письмо «КП ЖК Северный»';
    const outcomes = new Map<string, ApprovalOutcome>([
      ['done', { status: 'approved', errorCode: null, summary }],
      ['broke', { status: 'approved', errorCode: null, summary }],
      ['cut', { status: 'approved', errorCode: null, summary }],
      ['no', { status: 'declined', errorCode: null, summary }],
      ['newer', { status: 'declined', errorCode: 'APP_CHAT_SUPERSEDED', summary }],
      ['gone', { status: 'declined', errorCode: 'APP_TASK_DELETED', summary }],
      ['limit', { status: 'failed', errorCode: 'APP_USAGE_LIMIT_EXCEEDED', summary }],
      ['late', { status: 'expired', errorCode: null, summary }],
      ['wait', { status: 'pending', errorCode: null, summary }],
    ]);
    const parts = [
      call('mail_send', { to: 'ivan@example.com' }, { sent: true }, 'result', 'done'),
      call('mail_send', {}, 'APP_MAIL_SEND_FAILED: SMTP отказал', 'output-error', 'broke'),
      call('mail_send', {}, undefined, 'call', 'cut'),
      call('mail_send', {}, undefined, 'output-denied', 'no'),
      call('mail_send', {}, undefined, 'output-denied', 'newer'),
      call('mail_send', {}, undefined, 'output-denied', 'gone'),
      call('mail_send', {}, undefined, 'call', 'limit'),
      call('mail_send', {}, undefined, 'call', 'late'),
      call('mail_send', {}, undefined, 'call', 'wait'),
    ];
    expect(visibleOf({ role: 'assistant', content: message(parts) }, outcomes).marks).toEqual([
      `сделано после «Да»: ${summary}`,
      `не выполнено после «Да»: ${summary} (APP_MAIL_SEND_FAILED)`,
      `после «Да» итог неизвестен: ${summary}`,
      `сотрудник отказал: ${summary}`,
      `отменено — сотрудник написал новое сообщение: ${summary}`,
      `отменено — фоновую задачу удалили: ${summary}`,
      `не выполнено: ${summary} (APP_USAGE_LIMIT_EXCEEDED)`,
      `не подтверждено вовремя: ${summary}`,
      `ждёт «Да»: ${summary}`,
    ]);
  });

  it('says the answer broke off where the person saw it break', () => {
    expect(visibleOf({ role: 'assistant', content: message([text('Начинаю…'), { type: 'error', error: 'stream' }]) }, none)).toEqual({ text: 'Начинаю…', marks: ['ответ прервался'] });
  });

  it('leaves out everything the person did not see', () => {
    const parts = [
      { type: 'step-start' },
      { type: 'reasoning', reasoning: 'думаю про секрет', details: [] },
      { type: 'data-workspace-metadata', data: { secret: 'x' } },
      call('mastra_workspace_execute_command', { command: 'cat секрет.txt' }, 'секретный вывод'),
      call('mastra_workspace_read_file', { path: 'секрет.txt' }, 'содержимое секрета'),
      call('skill', { name: 'docx' }, '# Docx'),
      call('view_image', { path: 'a.png' }, { shown: true }),
      call('agent-lawyer', { prompt: 'секрет' }, 'ответ'),
      call('mailbox_read', { id: 1 }, { body: 'секретное письмо' }),
      text('Готово.'),
    ];
    const shown = visibleOf({ role: 'assistant', content: message(parts) }, none);
    expect(shown).toEqual({ text: 'Готово.', marks: [] });
  });

  // A widget (spec, section 8.31): its words — texts, cells, items, options, the data it shows — not its ids and codes.
  it('turns a widget into the line of its words and leaves out one the check refused', () => {
    const operations = [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'kp',
          dataModel: { company: 'ООО Ривер' },
          components: [
            { id: 'root', component: 'Card', children: ['t', 'pay', 'tbl', 'sum'] },
            { id: 't', component: 'Title', text: 'КП для клиента' },
            { id: 'pay', component: 'RadioGroup', label: 'Оплата', options: [{ value: 'cashless', label: 'Безнал' }] },
            { id: 'tbl', component: 'Table', columns: ['Позиция'], rows: [['Кровля', 2100000]] },
            { id: 'sum', component: 'Text', text: { '@call': 'formatString', args: { value: 'Итого ${/total} за год' } } },
          ],
        },
      },
    ];
    const shown = visibleOf({ role: 'assistant', content: message([call(WIDGET_TOOL.render, { operations }, { shown: true, surfaceId: 'kp' })]) }, none);
    expect(shown.marks).toEqual(['экран: КП для клиента Оплата Безнал Позиция Кровля 2100000 Итого за год ООО Ривер']);
    const refused = visibleOf({ role: 'assistant', content: message([call(WIDGET_TOOL.render, { operations }, { error: true, code: 'APP_WIDGET_INVALID', message: 'Экран не собран' })]) }, none);
    expect(refused.marks).toEqual([]);
  });

  it('has its own line for every block of the interface: a new block without one fails here', () => {
    const sample: Record<string, unknown> = {
      [GENUI_TOOL.table]: { columns: [{ key: 'a', label: 'A' }], rows: [] },
      [GENUI_TOOL.chart]: { kind: 'bar', labels: ['x'], series: [{ name: 's', values: [1] }] },
      [GENUI_TOOL.card]: { title: 'T', fields: [] },
      [GENUI_TOOL.choice]: { question: 'Q', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      [GENUI_TOOL.form]: { title: 'F', fields: [], submitLabel: 'OK' },
      [GENUI_TOOL.file]: { path: 'a.docx' },
    };
    for (const id of GENUI_TOOL_IDS) {
      expect(sample[id], `no sample for ${id}`).toBeDefined();
      const { marks } = visibleOf({ role: 'assistant', content: message([call(id, sample[id], { shown: true, name: 'a.docx' })]) }, none);
      expect(marks, id).toHaveLength(1);
    }
  });

  it('gives nothing for content that is not the stored form', () => {
    expect(visibleOf({ role: 'user', content: 'просто строка' }, none)).toEqual({ text: '', marks: [] });
    expect(visibleOf({ role: 'user', content: '{"parts": 5}' }, none)).toEqual({ text: '', marks: [] });
    expect(visibleOf({ role: 'user', content: '{битый' }, none)).toEqual({ text: '', marks: [] });
  });

  // Property: whatever the stored parts are, reading never throws and never shows the arguments or results
  // of the agent's service tools — they hold what the person did not see.
  it('never fails and never shows what service tools were given or returned', () => {
    const SECRET = 'ZZSECRETZZ';
    const service = fc.constantFrom('mastra_workspace_execute_command', 'mastra_workspace_read_file', 'skill', 'view_image', 'mailbox_read', 'agent-x', 'crm_lookup');
    const anyPart = fc.oneof(
      fc.record({ type: fc.constant('text'), text: fc.string() }),
      fc.record({ type: fc.string(), payload: fc.anything() }),
      fc.record({
        type: fc.constant('tool-invocation'),
        toolInvocation: fc.record({ state: fc.constantFrom('result', 'call', 'output-error', 'output-denied', 'partial-call'), toolCallId: fc.string(), toolName: service, args: fc.constant({ q: SECRET }), result: fc.constant({ text: SECRET }), errorText: fc.constant(SECRET) }),
      }),
      fc.anything(),
    );
    fc.assert(
      fc.property(fc.array(anyPart, { maxLength: 8 }), fc.constantFrom<'user' | 'assistant'>('user', 'assistant'), (parts, role) => {
        const shown = visibleOf({ role, content: JSON.stringify({ format: 2, parts }) }, none);
        expect([shown.text, ...shown.marks].join('\n')).not.toContain(SECRET);
      }),
    );
  });
});
