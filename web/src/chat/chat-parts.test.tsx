import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from './ApprovalCard.tsx';
import { TurnStateContext, type TurnState } from './call-progress.ts';
import { COMPUTER_TOOLS, splitAttachments, withAttachments } from '@bba/contracts';
import { systemOf } from './systems.ts';
import { parseToolResult } from './tool-result.ts';
import { ToolRow, type ToolRowProps } from './ToolRow.tsx';
import { ToolStack } from './ToolStack.tsx';

const SYSTEMS = { tools: { notes_add: 'Заметки' }, prefixes: { bitrix24_: 'Битрикс24' } };
const AGENT = {
  systems: SYSTEMS,
  actions: {
    notes_add: { title: 'Добавить заметку', fields: { text: 'Текст заметки' }, readOnly: false },
    bitrix24_deals: { title: 'поиск сделок', fields: {}, readOnly: true },
  },
};

describe('confirmation card', () => {
  const interrupt = { metadata: { mastra: { toolName: 'notes_add', args: { text: 'Позвонить в пятницу' } } } };

  it('names the action and its fields from the tool, and answers «Да» once', async () => {
    const onYes = vi.fn();
    const onNo = vi.fn();
    render(<ApprovalCard interrupt={interrupt} agent={AGENT} onYes={onYes} onNo={onNo} />);
    expect(screen.getByText('Подтвердите действие')).toBeInTheDocument();
    expect(screen.getByText('Заметки · Добавить заметку')).toBeInTheDocument();
    expect(screen.getByText('Изменит данные')).toBeInTheDocument();
    expect(screen.getByText('Текст заметки')).toBeInTheDocument();
    expect(screen.getByText('Позвонить в пятницу')).toBeInTheDocument();
    expect(screen.getByText('Новое сообщение в чате отменит это действие')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Да, выполнить' }));
    expect(onYes).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Выполняю: Добавить заметку')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Нет' })).not.toBeInTheDocument();
    expect(onNo).not.toHaveBeenCalled();
  });

  it('answers «Нет»', async () => {
    const onNo = vi.fn();
    render(<ApprovalCard interrupt={interrupt} agent={AGENT} onYes={vi.fn()} onNo={onNo} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Нет' }));
    expect(onNo).toHaveBeenCalledTimes(1);
  });
});

describe('tool line', () => {
  const row = (p: Partial<ToolRowProps>) =>
    render(
      <MemoryRouter>
        <ToolRow name="bitrix24_deals" status="complete" agent={AGENT} {...p} />
      </MemoryRouter>,
    );

  it('names the call of a sub-agent and counts nothing in its answer', () => {
    render(
      <MemoryRouter>
        <ToolRow name="agent-mailer" status="complete" agent={{ systems: SYSTEMS, actions: { 'agent-mailer': { title: 'Поручение агенту «Почтальон»', fields: {}, readOnly: false } } }} result='{"text":"Готово","toolResults":[{"ok":true}]}' />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /Поручение агенту «Почтальон»/ })).toBeInTheDocument();
    expect(screen.queryByText(/найдено/)).not.toBeInTheDocument();
  });

  it('names the system while the call runs', () => {
    row({ status: 'executing' });
    expect(screen.getByText('Ищу в «Битрикс24»…')).toBeInTheDocument();
  });

  // Every call is in the chat the moment the agent makes it (decision of the owner 20.11): a call of the server without
  // its result turns only while its answer is being written.
  it('says a call waits for «Да» or was stopped when its answer ended without the result', () => {
    const line = (turn: TurnState, name = 'bitrix24_deals') =>
      render(
        <MemoryRouter>
          <TurnStateContext value={turn}>
            <ToolRow name={name} status="inProgress" agent={AGENT} />
          </TurnStateContext>
        </MemoryRouter>,
      );
    line('answering');
    expect(screen.getByText('Ищу в «Битрикс24»…')).toBeInTheDocument();
    cleanup();
    line('asking');
    expect(screen.getByText('Ждёт вашего подтверждения')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    cleanup();
    line('ended');
    expect(screen.getByText('Прервано')).toBeInTheDocument();
    cleanup();
    // The browser's own tools answer themselves after the run: still under way.
    line('ended', COMPUTER_TOOLS.read);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('tells a declined action from one cancelled by a new message', () => {
    const { unmount } = row({ result: '{"declined":true,"superseded":false}' });
    expect(screen.getByText('Действие отменено')).toBeInTheDocument();
    unmount();
    row({ result: '{"declined":true,"superseded":true}' });
    expect(screen.getByText('Отменено: вы написали новое сообщение')).toBeInTheDocument();
  });

  it('links to the settings when the personal connection is missing', () => {
    row({ result: JSON.stringify({ error: true, message: 'APP_CONNECTOR_NOT_CONNECTED: подключите Битрикс24' }) });
    expect(screen.getByText(/Действие «Битрикс24» не выполнилось/)).toBeInTheDocument();
    expect(screen.getByText(/APP_CONNECTOR_NOT_CONNECTED/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Подключить в настройках' })).toHaveAttribute('href', '/settings/connections');
  });

  it('draws a table that came in the result as is', () => {
    const table = { title: 'Сделки', columns: [{ key: 'n', label: 'Сделка' }], rows: [{ n: 'Поставка' }] };
    row({ result: JSON.stringify({ table }) });
    const line = screen.getByRole('button', { name: /Битрикс24 · поиск сделок/ });
    expect(line).toHaveTextContent('только чтение');
    expect(line).toHaveTextContent('1 найдено');
    expect(screen.getByRole('cell', { name: 'Поставка' })).toBeInTheDocument();
  });
});

describe('activation of a skill', () => {
  // As the agents of an installation get it from the server (core/sandbox/workspace.ts).
  const SKILL_AGENT = { systems: SYSTEMS, actions: { skill: { title: 'Активация навыка', fields: {}, readOnly: true } } };
  const skillRow = (p: Partial<ToolRowProps>) => render(<ToolRow name="skill" status="complete" parameters={{ name: 'contract-check' }} agent={SKILL_AGENT} {...p} />);

  it('names the skill as people know it, from the heading of its instructions', () => {
    skillRow({ result: '# Проверка договора\n\nСроки, штрафы, приёмка…' });
    expect(screen.getByRole('button', { name: 'Активирован навык «Проверка договора»' })).toBeInTheDocument();
    expect(screen.queryByText('только чтение')).not.toBeInTheDocument();
  });

  it('names it by its name when the instructions have no heading, and says when there is no such skill', () => {
    skillRow({ result: 'Файлы сотрудника лежат в рабочей папке…' });
    expect(screen.getByRole('button', { name: 'Активирован навык «contract-check»' })).toBeInTheDocument();
    cleanup();
    // Mastra's own answer for an unknown name.
    skillRow({ parameters: { name: 'reports' }, result: 'Skill "reports" not found. Available skills: contract-check (/skills/contract-check)' });
    expect(screen.getByText('Навык «reports» не найден')).toBeInTheDocument();
  });

  it('says it is being activated while it loads', () => {
    skillRow({ status: 'executing' });
    expect(screen.getByText('Активирую навык…')).toBeInTheDocument();
  });
});

// What the agent remembered (spec, section 8.26): the line says it in words, the details keep «было / стало».
describe('a line of the memory', () => {
  const MEMORY_AGENT = { systems: SYSTEMS, actions: { project_memory: { title: 'Память проекта', fields: {}, readOnly: false }, personal_memory: { title: 'Память о сотруднике', fields: {}, readOnly: false } } };
  const memoryRow = (name: string, operations: unknown[], result?: unknown, status: ToolRowProps['status'] = 'complete') =>
    render(<ToolRow name={name} status={status} parameters={{ operations }} {...(result === undefined ? {} : { result: JSON.stringify(result) })} agent={MEMORY_AGENT} />);

  it('says what one operation remembered, changed or removed — in the project and about the person', () => {
    memoryRow('project_memory', [{ action: 'add', text: 'Подача до 28.11' }], { results: [{ action: 'add', number: 1, text: 'Подача до 28.11' }], usedChars: 15, maxChars: 6000 });
    expect(screen.getByRole('button', { name: 'Запомнил в проекте: «Подача до 28.11»' })).toBeInTheDocument();
    cleanup();
    memoryRow('project_memory', [{ action: 'change', number: 1, text: 'Подача до 01.12' }], { results: [{ action: 'change', number: 1, text: 'Подача до 01.12', previousText: 'Подача до 28.11' }], usedChars: 15, maxChars: 6000 });
    expect(screen.getByRole('button', { name: 'Поправил в памяти проекта: «Подача до 01.12»' })).toBeInTheDocument();
    cleanup();
    // The text of a removed entry comes in the result: the call names only its number.
    memoryRow('project_memory', [{ action: 'remove', number: 2 }], { results: [{ action: 'remove', number: 2, text: 'Аванс не предусмотрен' }], usedChars: 0, maxChars: 6000 });
    expect(screen.getByRole('button', { name: 'Убрал из памяти проекта: «Аванс не предусмотрен»' })).toBeInTheDocument();
    cleanup();
    memoryRow('personal_memory', [{ action: 'add', text: 'Ведёт только юрлиц' }], { results: [{ action: 'add', number: 1, text: 'Ведёт только юрлиц' }], usedChars: 18, maxChars: 3000 });
    expect(screen.getByRole('button', { name: 'Запомнил о вас: «Ведёт только юрлиц»' })).toBeInTheDocument();
    cleanup();
    memoryRow('personal_memory', [{ action: 'remove', number: 1 }], { results: [{ action: 'remove', number: 1, text: 'Ведёт только юрлиц' }], usedChars: 0, maxChars: 3000 });
    expect(screen.getByRole('button', { name: 'Убрал из памяти о вас: «Ведёт только юрлиц»' })).toBeInTheDocument();
  });

  it('counts several operations of one call', () => {
    const adds = [1, 2, 3].map((n) => ({ action: 'add', number: n, text: `Факт ${n}` }));
    memoryRow('project_memory', adds, { results: adds, usedChars: 18, maxChars: 6000 });
    expect(screen.getByRole('button', { name: 'Запомнил в проекте: 3 записи' })).toBeInTheDocument();
    cleanup();
    const mixed = [{ action: 'remove', number: 1, text: 'Старое' }, { action: 'change', number: 2, text: 'Новое', previousText: 'Было' }];
    memoryRow('project_memory', mixed, { results: mixed, usedChars: 5, maxChars: 6000 });
    expect(screen.getByRole('button', { name: 'Обновил память проекта: 2 изменения' })).toBeInTheDocument();
  });

  it('keeps what was there before in the details', async () => {
    memoryRow('project_memory', [{ action: 'change', number: 1, text: 'Подача до 01.12' }], { results: [{ action: 'change', number: 1, text: 'Подача до 01.12', previousText: 'Подача до 28.11' }], usedChars: 15, maxChars: 6000 });
    await userEvent.setup().click(screen.getByRole('button', { name: /Поправил в памяти проекта/ }));
    expect(screen.getByText(/Подача до 28\.11/)).toBeInTheDocument();
  });

  it('says it is remembering while it runs, and what failed with the code', () => {
    memoryRow('project_memory', [{ action: 'add', text: 'Срок' }], undefined, 'executing');
    expect(screen.getByText('Запоминаю…')).toBeInTheDocument();
    cleanup();
    memoryRow('project_memory', [{ action: 'add', text: 'Срок' }], { error: true, code: 'APP_MEMORY_FULL', message: 'Память проекта заполнена…' });
    expect(screen.getByText(/Не удалось записать в память проекта/)).toBeInTheDocument();
    expect(screen.getByText(/APP_MEMORY_FULL/)).toBeInTheDocument();
    cleanup();
    memoryRow('personal_memory', [{ action: 'add', text: 'Факт' }], { error: true, code: 'APP_MEMORY_SAVE_FAILED', message: 'Не удалось…' });
    expect(screen.getByText(/Не удалось записать в память о вас/)).toBeInTheDocument();
    cleanup();
    // The adapter's word for a call the broken answer left without a result.
    memoryRow('project_memory', [{ action: 'add', text: 'Срок' }], 'The tool call ended without a result.');
    expect(screen.getByText(/Не удалось записать в память проекта/)).toBeInTheDocument();
  });
});

describe('a line of past conversations', () => {
  const HISTORY_AGENT = { systems: SYSTEMS, actions: { conversations: { title: 'Прошлые разговоры', fields: {}, readOnly: true } } };
  const historyRow = (parameters: unknown, result?: unknown, status: ToolRowProps['status'] = 'complete') =>
    render(<ToolRow name="conversations" status={status} parameters={parameters} {...(result === undefined ? {} : { result: JSON.stringify(result) })} agent={HISTORY_AGENT} />);
  const item = (title: string) => ({ ref: '7c1e9a02', title, project: 'вне проекта', agent: 'Продажи', started: '12.11.2026', last: '12.11.2026', messages: 4 });

  it('says what the agent looked at: the list, a search, a conversation it read — reading only', () => {
    historyRow({ mode: 'list' }, { scope: 'project', page: 1, total: 23, more: true, conversations: [item('КП')] });
    expect(screen.getByRole('button', { name: /Прошлые разговоры: 23/ })).toBeInTheDocument();
    expect(screen.getByText('только чтение')).toBeInTheDocument();
    cleanup();
    historyRow({ mode: 'search', query: 'аванс' }, { scope: 'all', conversations: [item('Договор'), item('Кровля')] });
    expect(screen.getByRole('button', { name: /Поиск по разговорам «аванс»: 2/ })).toBeInTheDocument();
    cleanup();
    historyRow({ mode: 'search', query: 'аванс' }, { scope: 'all', conversations: [], note: 'Ничего не нашлось.' });
    expect(screen.getByRole('button', { name: /Поиск по разговорам «аванс»: ничего не нашлось/ })).toBeInTheDocument();
    cleanup();
    historyRow({ mode: 'read', conversation: '7c1e9a02' }, { title: 'КП для ЖК Северный', ref: '7c1e9a02', transcript: '…' });
    expect(screen.getByRole('button', { name: /Прочитал разговор «КП для ЖК Северный»/ })).toBeInTheDocument();
    cleanup();
    historyRow({ mode: 'read', conversation: 'current' }, { title: 'Этот', ref: 'aaaaaaaa', transcript: '…' });
    expect(screen.getByRole('button', { name: /Перечитал ранние сообщения разговора/ })).toBeInTheDocument();
  });

  // A file taken from a past conversation (spec, section 8.33) is a copy in the agent's folder: not «reading only».
  it('says which file the agent took from a past conversation', () => {
    historyRow({ mode: 'take', conversation: '7c1e9a02', file: 'КП Ёлка.docx' }, undefined, 'executing');
    expect(screen.getByText('Беру файл из прошлого разговора…')).toBeInTheDocument();
    cleanup();
    historyRow({ mode: 'take', conversation: '7c1e9a02', file: 'КП Ёлка.docx' }, { name: 'КП Ёлка (2).docx', path: 'КП Ёлка (2).docx', bytes: 4, copied: true, result: '…' });
    expect(screen.getByRole('button', { name: /Взял файл «КП Ёлка\.docx» из прошлого разговора/ })).toBeInTheDocument();
    expect(screen.queryByText('только чтение')).not.toBeInTheDocument();
    cleanup();
    historyRow({ mode: 'take', conversation: '7c1e9a02', file: 'Договор.docx' }, { error: true, code: 'APP_NOT_FOUND', message: 'нет файла' });
    expect(screen.getByText(/Не получилось взять файл из прошлого разговора/)).toBeInTheDocument();
  });

  it('says it is looking while it runs, and what failed with the code', () => {
    historyRow({ mode: 'list' }, undefined, 'executing');
    expect(screen.getByText('Смотрю прошлые разговоры…')).toBeInTheDocument();
    cleanup();
    historyRow({ mode: 'read', conversation: 'ffffffff' }, { error: true, code: 'APP_NOT_FOUND', message: 'Разговор не найден…' });
    expect(screen.getByText(/Не получилось посмотреть прошлые разговоры/)).toBeInTheDocument();
    expect(screen.getByText(/APP_NOT_FOUND/)).toBeInTheDocument();
    cleanup();
    // The adapter's word for a call the broken answer left without a result.
    historyRow({ mode: 'read', conversation: '7c1e9a02' }, 'The tool call ended without a result.');
    expect(screen.getByText(/Не получилось посмотреть прошлые разговоры/)).toBeInTheDocument();
  });
});

describe('stack of status lines', () => {
  const COMMAND = 'mastra_workspace_execute_command';
  const STACK_AGENT = { systems: SYSTEMS, actions: { ...AGENT.actions, [COMMAND]: { title: 'Команда в рабочей папке', fields: {}, readOnly: false } } };
  const calls = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({ id, type: 'function' as const, function: { name: COMMAND, arguments: `{"command":"ls ${id}"}` } }));
  const done = (ids: string[]) => ids.map((id) => ({ id: `r-${id}`, role: 'tool' as const, toolCallId: id, content: '{"exitCode":0}' }));
  // A stack in the answer being written now, or in an answer that ended and waits for «Да» on some calls.
  const stack = (messages: ReturnType<typeof done>, turn: TurnState = 'answering') => (
    <MemoryRouter>
      <TurnStateContext value={turn}>
        <ToolStack
          calls={calls}
          messages={messages}
          agent={STACK_AGENT}
          renderCall={(c) => <ToolRow name={c.function.name} status={messages.some((m) => m.toolCallId === c.id) ? 'complete' : 'inProgress'} parameters={JSON.parse(c.function.arguments)} result='{"exitCode":0}' agent={STACK_AGENT} />}
        />
      </TurnStateContext>
    </MemoryRouter>
  );

  it('shows the last line and how many there are; unfolds all of them, each on its own', async () => {
    render(stack(done(['c1', 'c2', 'c3', 'c4', 'c5'])));
    const user = userEvent.setup();
    const head = screen.getByRole('button', { name: /Команда в рабочей папке.*5 действий/ });
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('button')).toHaveLength(1);

    await user.click(head);
    const rows = screen.getAllByRole('button', { name: /^Команда в рабочей папке$/ });
    expect(rows).toHaveLength(5);
    await user.click(rows[2]!);
    expect(screen.getByText(/ls c3/)).toBeInTheDocument();
    expect(screen.queryByText(/ls c4/)).not.toBeInTheDocument();

    await user.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('while the model writes what the action is to do, says how much it has written; then only turns', () => {
    const writing = (text: string) => (
      <MemoryRouter>
        <TurnStateContext value="answering">
          <ToolStack calls={[{ id: 'w1', type: 'function', function: { name: COMMAND, arguments: text } }]} messages={[]} agent={STACK_AGENT} renderCall={() => null} />
        </TurnStateContext>
      </MemoryRouter>
    );
    // Nothing written yet: only the name of the action, turning.
    const { rerender } = render(writing(''));
    expect(screen.getByRole('button', { name: 'Команда в рабочей папке…' })).toBeInTheDocument();
    // The model is writing: the count of what came, as it comes.
    const part = `{"command":"cat > build.js <<'EOF'\\n${'x'.repeat(4194)}`;
    rerender(writing(part));
    expect(screen.getByRole('button', { name: `Команда в рабочей папке… ${part.length.toLocaleString('ru-RU')} знаков` })).toBeInTheDocument();
    // Written whole: the action runs — no count that would stand still.
    rerender(writing(`${part}\\nEOF\\nnode build.js"}`));
    expect(screen.getByRole('button', { name: 'Команда в рабочей папке…' })).toBeInTheDocument();
    // An action with no name of its own is said in general words.
    rerender(
      <MemoryRouter>
        <TurnStateContext value="answering">
          <ToolStack calls={[{ id: 'w2', type: 'function', function: { name: 'something_unknown', arguments: '{"a":' } }]} messages={[]} agent={STACK_AGENT} renderCall={() => null} />
        </TurnStateContext>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /^Выполняю действие… 5 знаков$/ })).toBeInTheDocument();
  });

  it('turns while the last line runs', () => {
    render(stack(done(['c1', 'c2', 'c3', 'c4'])));
    expect(screen.getByRole('button', { name: /Команда в рабочей папке….*5 действий/ })).toBeInTheDocument();
  });

  it('stops turning when its answer ended: the last line waits for «Да» or was stopped', () => {
    render(stack(done(['c1', 'c2', 'c3', 'c4']), 'asking'));
    expect(screen.getByRole('button', { name: /Ждёт вашего подтверждения.*5 действий/ })).toBeInTheDocument();
    cleanup();
    render(stack(done(['c1', 'c2', 'c3', 'c4']), 'ended'));
    expect(screen.getByRole('button', { name: /Прервано.*5 действий/ })).toBeInTheDocument();
  });

  it('is the line itself for one call: unfolds what it was asked and found; does not unfold while it runs', async () => {
    const one = (messages: ReturnType<typeof done>) => (
      <MemoryRouter>
        <TurnStateContext value="answering">
          <ToolStack calls={[calls[0]!]} messages={messages} agent={STACK_AGENT} renderCall={() => null} />
        </TurnStateContext>
      </MemoryRouter>
    );
    const { rerender } = render(one([]));
    expect(screen.getByRole('button', { name: 'Команда в рабочей папке…' })).toBeDisabled();

    rerender(one(done(['c1'])));
    const line = screen.getByRole('button', { name: 'Команда в рабочей папке' });
    expect(line).toHaveAttribute('aria-expanded', 'false');
    await userEvent.setup().click(line);
    expect(screen.getByText(/ls c1/)).toBeInTheDocument();
    expect(screen.getByText(/exitCode/)).toBeInTheDocument();
  });
});

describe('chat helpers', () => {
  it('reads tool results', () => {
    expect(parseToolResult('{"declined":true,"superseded":true}')).toEqual({ kind: 'declined', superseded: true });
    expect(parseToolResult('{"error":true,"message":"x APP_TOOL_FAILED"}')).toEqual({ kind: 'failed', code: 'APP_TOOL_FAILED', message: 'x APP_TOOL_FAILED' });
    expect(parseToolResult('{"deals":12}')).toEqual({ kind: 'ok', value: { deals: 12 } });
    expect(parseToolResult('просто текст')).toEqual({ kind: 'ok', value: 'просто текст' });
  });

  it('finds the system of a tool by exact name or prefix', () => {
    expect(systemOf(SYSTEMS, 'notes_add')).toBe('Заметки');
    expect(systemOf(SYSTEMS, 'bitrix24_connection')).toBe('Битрикс24');
    expect(systemOf(SYSTEMS, 'sales_report')).toBeNull();
  });

  it('names attached files in the message and takes them back for the feed', () => {
    expect(withAttachments('Прочитай счёт', [])).toBe('Прочитай счёт');
    const sent = withAttachments('Прочитай счёт', [{ name: 'Счёт.pdf', path: 'Счёт.pdf' }]);
    expect(sent).toBe('Прочитай счёт\n\nВложения:\n- Счёт.pdf (файл в рабочей папке: Счёт.pdf)');
    expect(splitAttachments(sent)).toEqual({ text: 'Прочитай счёт', files: [{ name: 'Счёт.pdf', path: 'Счёт.pdf' }] });
    expect(splitAttachments('Просто текст')).toEqual({ text: 'Просто текст', files: [] });
  });

});
