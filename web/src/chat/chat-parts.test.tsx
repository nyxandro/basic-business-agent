import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from './ApprovalCard.tsx';
import { splitAttachments, withAttachments } from '@bba/contracts';
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
  const skillRow = (p: Partial<ToolRowProps>) => render(<ToolRow name="skill" status="complete" parameters={{ name: 'read-documents' }} agent={SKILL_AGENT} {...p} />);

  it('names the skill as people know it, from the heading of its instructions', () => {
    skillRow({ result: '# Чтение документов\n\nФайлы сотрудника лежат в рабочей папке…' });
    expect(screen.getByRole('button', { name: 'Активирован навык «Чтение документов»' })).toBeInTheDocument();
    expect(screen.queryByText('только чтение')).not.toBeInTheDocument();
  });

  it('names it by its name when the instructions have no heading, and says when there is no such skill', () => {
    skillRow({ result: 'Файлы сотрудника лежат в рабочей папке…' });
    expect(screen.getByRole('button', { name: 'Активирован навык «read-documents»' })).toBeInTheDocument();
    cleanup();
    // Mastra's own answer for an unknown name.
    skillRow({ parameters: { name: 'reports' }, result: 'Skill "reports" not found. Available skills: read-documents (/skills/read-documents)' });
    expect(screen.getByText('Навык «reports» не найден')).toBeInTheDocument();
  });

  it('says it is being activated while it loads', () => {
    skillRow({ status: 'executing' });
    expect(screen.getByText('Активирую навык…')).toBeInTheDocument();
  });
});

describe('stack of status lines', () => {
  const COMMAND = 'mastra_workspace_execute_command';
  const STACK_AGENT = { systems: SYSTEMS, actions: { ...AGENT.actions, [COMMAND]: { title: 'Команда в рабочей папке', fields: {}, readOnly: false } } };
  const calls = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({ id, type: 'function' as const, function: { name: COMMAND, arguments: `{"command":"ls ${id}"}` } }));
  const done = (ids: string[]) => ids.map((id) => ({ id: `r-${id}`, role: 'tool' as const, toolCallId: id, content: '{"exitCode":0}' }));
  const stack = (messages: ReturnType<typeof done>) => (
    <MemoryRouter>
      <ToolStack
        calls={calls}
        messages={messages}
        agent={STACK_AGENT}
        renderCall={(c) => <ToolRow name={c.function.name} status={messages.some((m) => m.toolCallId === c.id) ? 'complete' : 'executing'} parameters={JSON.parse(c.function.arguments)} result='{"exitCode":0}' agent={STACK_AGENT} />}
      />
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
  });

  it('turns while the last line runs', () => {
    render(stack(done(['c1', 'c2', 'c3', 'c4'])));
    expect(screen.getByRole('button', { name: /Выполняю действие….*5 действий/ })).toBeInTheDocument();
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
