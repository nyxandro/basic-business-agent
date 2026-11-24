// A search an earlier answer left unfinished («Стоп», a broken answer) stays «прерван» while the next answer is
// written: the block asks its own turn whether it is under way, not the chat (spec, section 8.30).
import { WEB_RESEARCH_TOOL } from '@bba/contracts';
import type { Message } from '@copilotkit/react-core';
import { render, screen } from '@testing-library/react';
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
  // CopilotKit draws a call with its renderer: here the block of the search for every call.
  useRenderToolCall:
    () =>
    ({ toolCall, toolMessage }: DrawnCall) => {
      const result = typeof toolMessage?.content === 'string' ? toolMessage.content : undefined;
      return <WebSearch call={{ toolCallId: toolCall.id, status: result === undefined ? 'executing' : 'complete', parameters: {}, result }} />;
    },
}));

const AGENT = { id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', mark: { kind: 'icon' as const, icon: 'spark' as const }, actions: {}, systems: { tools: {}, prefixes: {} } };
const search = (id: string) => ({ id, type: 'function' as const, function: { name: WEB_RESEARCH_TOOL, arguments: '{"task":"Найди цены"}' } });

function extras(interrupt: ChatExtras['interrupt'] = null): ChatExtras {
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
    interrupt,
    failure: null,
    onFailure: vi.fn(),
    offline: false,
    interruptedIds: [],
    keepInterrupted: vi.fn(),
    onTurnsFailed: vi.fn(),
    composerExtra: null,
    composerNotice: null,
  };
}

function showChat(messages: Message[], running: boolean, interrupt: ChatExtras['interrupt'] = null) {
  return (
    <MemoryRouter>
      <SessionProvider>
        <ToastProvider>
          <RequireAuth>
            <ChatExtrasContext value={extras(interrupt)}>
              <ChatView messages={messages} isRunning={running} />
            </ChatExtrasContext>
          </RequireAuth>
        </ToastProvider>
      </SessionProvider>
    </MemoryRouter>
  );
}

describe('the block of a search in a conversation', () => {
  it('keeps a search an earlier answer left unfinished stopped while the next answer searches', async () => {
    mockServer({ 'GET /app/api/me': { body: ME } });
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Найди цены на профнастил' },
      { id: 'a1', role: 'assistant', content: '', toolCalls: [search('w1')] },
      { id: 'u2', role: 'user', content: 'Попробуй ещё раз' },
      { id: 'a2', role: 'assistant', content: '', toolCalls: [search('w2')] },
    ];
    render(showChat(messages, true));
    await screen.findByText('Попробуй ещё раз');
    // The earlier one is over; the search of the answer being written now is under way — in the live line, the only
    // clock that goes.
    expect(screen.getByRole('button', { name: 'Поиск в интернете прерван' })).toBeInTheDocument();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status', { name: 'Начинаю поиск в интернете…' })).toBeInTheDocument();
  });

  // A sub-agent's call shows the call of the sub-agent, while the question names its inner action: the whole unfinished
  // part of the last answer waits, and turns again once «Да» runs the action.
  it('says the last answer waits for «Да» while the question is open, and runs again after the answer', async () => {
    mockServer({ 'GET /app/api/me': { body: ME } });
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Напиши клиенту' },
      { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'agent-mailer', arguments: '{}' } }] },
    ];
    const view = render(showChat(messages, false, <div>Подтвердите действие</div>));
    expect(await screen.findByText('Ждёт вашего подтверждения')).toBeInTheDocument();
    view.rerender(showChat(messages, true));
    expect(screen.queryByText('Ждёт вашего подтверждения')).not.toBeInTheDocument();
    expect(screen.queryByText('Прервано')).not.toBeInTheDocument();
    view.rerender(showChat(messages, false));
    expect(screen.getByText('Прервано')).toBeInTheDocument();
  });
});
