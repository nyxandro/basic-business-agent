// What the agent does now is said in one place (decision of the owner 21.11): the live line under the answer — «Работаю»
// while nothing is under way, the name of the action in its place while one is, the search with its clock; a done
// action goes up into the stack of the turn, and «Работаю» comes back while the agent goes on. Never two at once.
import { COMPUTER_TOOLS, WEB_RESEARCH_TOOL, WIDGET_TOOL } from '@bba/contracts';
import type { Message } from '@copilotkit/react-core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { RequireAuth, SessionProvider } from '../auth/session.tsx';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { ToastProvider } from '../ui/Toast.tsx';
import { ChatExtrasContext, type ChatExtras } from '../answer/chat-context.ts';
import { ChatView } from './ChatView.tsx';
import { WebSearch } from './WebSearch.tsx';

interface DrawnCall {
  toolCall: { id: string; function: { name: string } };
  toolMessage?: { content?: unknown };
}

vi.mock('@copilotkit/react-core', async (original) => ({
  ...(await original<typeof import('@copilotkit/react-core')>()),
  useAgent: () => ({ agent: { pendingInterrupts: [], subscribe: () => ({ unsubscribe: () => undefined }) } }),
  // CopilotKit draws a call with its renderer: the block of the search for a search, a mark for anything else.
  useRenderToolCall:
    () =>
    ({ toolCall, toolMessage }: DrawnCall) => {
      const result = typeof toolMessage?.content === 'string' ? toolMessage.content : undefined;
      if (toolCall.function.name !== WEB_RESEARCH_TOOL) return <div>{`block ${toolCall.id}`}</div>;
      return <WebSearch call={{ toolCallId: toolCall.id, status: result === undefined ? 'executing' : 'complete', parameters: {}, result }} />;
    },
}));

const COMMAND = 'mastra_workspace_execute_command';
const AGENT = {
  id: 'sales',
  name: 'Продажи',
  description: 'Сделки и клиенты',
 
  mark: { kind: 'icon' as const, icon: 'spark' as const },
  actions: { [COMMAND]: { title: 'Команда в рабочей папке', fields: {}, readOnly: false } },
  systems: { tools: {}, prefixes: {} },
};
const QUESTION: Message = { id: 'u1', role: 'user', content: 'Сверстай почту виджетом' };
const call = (id: string, name: string, args = '{}') => ({ id, type: 'function' as const, function: { name, arguments: args } });
const result = (toolCallId: string, content: string): Message => ({ id: `r-${toolCallId}`, role: 'tool', toolCallId, content });

function extras(): ChatExtras {
  return {
    agent: AGENT,
    agentId: 'sales',
    threadId: 't1',
    draft: false,
    attachments: [],
    addAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    onSubmitted: vi.fn(),
    onRunFinished: vi.fn(),
    onThreadTitled: vi.fn(),
    onUploadError: vi.fn(),
    interrupt: null,
    failure: null,
    onFailure: vi.fn(),
    offline: false,
    interruptedIds: [],
    keepInterrupted: vi.fn(),
    onTurnsFailed: vi.fn(),
    composerExtra: null,
    composerNotice: null,
    stopRun: vi.fn(),
  };
}

const chat = (messages: Message[], running: boolean): ReactElement => (
  <MemoryRouter>
    <SessionProvider>
      <ToastProvider>
        <RequireAuth>
          <ChatExtrasContext value={extras()}>
            <ChatView messages={messages} isRunning={running} />
          </ChatExtrasContext>
        </RequireAuth>
      </ToastProvider>
    </SessionProvider>
  </MemoryRouter>
);

async function show(messages: Message[], running: boolean) {
  mockServer({ 'GET /app/api/me': { body: ME } });
  const view = render(chat(messages, running));
  await screen.findByText('Сверстай почту виджетом');
  return view;
}

const statuses = () => screen.getAllByRole('status');

describe('the live line of the answer being written', () => {
  // 21.11: the widget was being written, and «Готовлю…» turned under the answer while «Работаю» turned below it.
  it('says the widget being written in place of «Работаю», and nothing else turns', async () => {
    const said: Message = {
      id: 'a1',
      role: 'assistant',
      content: 'Соберу экран с кнопками.',
      // The adapter of Mastra puts the call of the next step on this message, above the result of the step before.
      toolCalls: [call('d1', WIDGET_TOOL.components, '{"names":["Button"]}'), call('u1', WIDGET_TOOL.render, '{"operations":[{"version":"1.0","createSurface":{')],
    };
    await show([QUESTION, said, result('d1', '{"guide":"…"}')], true);
    expect(statuses()).toHaveLength(1);
    expect(screen.getByRole('status', { name: 'Собираю виджет…' })).toBeInTheDocument();
    expect(screen.queryByText('Работаю')).not.toBeInTheDocument();
    expect(screen.queryByText('Готовлю…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Подобраны элементы виджета: 1' })).toBeInTheDocument();
  });

  // 21.11: the check let the screen through at the fifth try; the attempts before showed nothing — a mark beside nothing.
  it('puts the attempts the check refused into the stack above the line', async () => {
    const refused = '{"error":true,"code":"APP_WIDGET_INVALID","message":"Экран не собран"}';
    const tries: Message = { id: 'a1', role: 'assistant', content: '', toolCalls: [call('u1', WIDGET_TOOL.render, '{"operations":[]}'), call('u2', WIDGET_TOOL.render, '{"operations":')] };
    await show([QUESTION, tries, result('u1', refused)], true);
    expect(statuses()).toHaveLength(1);
    expect(screen.getByRole('status', { name: 'Собираю виджет…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Виджет не прошёл проверку' })).toBeInTheDocument();
  });

  // Unfolded, a stack shows the line of a widget or a file, not the screen or the file again.
  it('unfolds the attempts of a widget into their lines', async () => {
    const refused = '{"error":true,"code":"APP_WIDGET_INVALID","message":"Экран не собран"}';
    const tries: Message = { id: 'a1', role: 'assistant', content: '', toolCalls: [call('d1', WIDGET_TOOL.components, '{"names":["Card"]}'), call('u1', WIDGET_TOOL.render, '{"operations":[]}'), call('u2', WIDGET_TOOL.render, '{"operations":')] };
    await show([QUESTION, tries, result('d1', '{"guide":"…"}'), result('u1', refused)], true);
    await userEvent.setup().click(screen.getByRole('button', { name: /Виджет не прошёл проверку.*2 действия/ }));
    expect(screen.getByText(/APP_WIDGET_INVALID/)).toBeInTheDocument();
    expect(screen.queryByText('block u1')).not.toBeInTheDocument();
  });

  it('counts what the model has written of the action, and puts the action into the stack once it is done', async () => {
    const part = `{"command":"cat > build.js <<'EOF'\\n${'x'.repeat(4194)}`;
    const writing: Message = { id: 'a1', role: 'assistant', content: 'Соберу документ.', toolCalls: [call('c1', COMMAND, part)] };
    const view = await show([QUESTION, writing], true);
    const line = screen.getByRole('status', { name: 'Команда в рабочей папке…' });
    // The count is beside the words, not in what a screen reader says at every piece of it.
    expect(line.parentElement?.textContent).toContain(`${part.length.toLocaleString('ru-RU')} знаков`);
    expect(line.textContent).not.toContain('знаков');
    // Under way, it is not a line of the stack yet.
    expect(screen.queryByRole('button', { name: /Команда в рабочей папке/ })).not.toBeInTheDocument();

    // Written whole: the action runs — no count that would stand still.
    const whole: Message = { ...writing, toolCalls: [call('c1', COMMAND, '{"command":"node build.js"}')] };
    view.rerender(chat([QUESTION, whole], true));
    expect(screen.getByRole('status', { name: 'Команда в рабочей папке…' })).toBeInTheDocument();
    expect(screen.queryByText(/знаков/)).not.toBeInTheDocument();

    view.rerender(chat([QUESTION, whole, result('c1', '{"exitCode":0}')], true));
    expect(screen.getByRole('button', { name: 'Команда в рабочей папке' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Работаю' })).toBeInTheDocument();
  });

  it('shows the search under way there, with its clock and no spinner; done, the search is in the answer', async () => {
    const searching: Message = { id: 'a1', role: 'assistant', content: '', toolCalls: [call('w1', WEB_RESEARCH_TOOL, '{"task":"Найди цены"}')] };
    const view = await show([QUESTION, searching], true);
    expect(statuses()).toHaveLength(1);
    expect(screen.getByRole('status', { name: 'Начинаю поиск в интернете…' })).toBeInTheDocument();
    expect(screen.getByText('0:00')).toBeInTheDocument();
    // The clock is beside the words: a screen reader does not say it every second.
    expect(screen.getByRole('status').textContent).not.toContain('0:00');
    expect(view.container.querySelector('[class*="spin"]')).toBeNull();
    expect(screen.queryByText('Работаю')).not.toBeInTheDocument();

    view.rerender(chat([QUESTION, searching, result('w1', JSON.stringify({ answer: 'От 520 ₽', sources: [], steps: [], ms: 4000 }))], true));
    expect(screen.getByRole('button', { name: /^Поиск в интернете · 0 запросов · 0 источников/ })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Работаю' })).toBeInTheDocument();
  });

  it('names an action without a name of its own in general words', async () => {
    const writing: Message = { id: 'a1', role: 'assistant', content: '', toolCalls: [call('c1', 'something_unknown', '{"a":')] };
    await show([QUESTION, writing], true);
    expect(screen.getByRole('status', { name: 'Выполняю действие…' }).parentElement?.textContent).toContain('5 знаков');
  });

  // The browser runs its own tools after the run that called them has ended; the next run goes on with the answer.
  it('keeps a tool of the browser in the live line between the runs', async () => {
    const reading: Message = { id: 'a1', role: 'assistant', content: 'Прочитаю файл.', toolCalls: [call('b1', COMPUTER_TOOLS.read, '{"path":"КП.docx"}')] };
    await show([QUESTION, reading], false);
    expect(statuses()).toHaveLength(1);
    expect(screen.getByRole('status', { name: 'Выполняю действие…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Выполняю действие/ })).not.toBeInTheDocument();
  });

  it('leaves the calls of an ended answer in their stack', async () => {
    const left: Message = { id: 'a1', role: 'assistant', content: 'Соберу документ.', toolCalls: [call('c1', COMMAND, '{"command":"ls"}')] };
    await show([QUESTION, left], false);
    expect(screen.getByRole('button', { name: 'Прервано' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
