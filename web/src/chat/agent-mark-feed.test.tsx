// The agent's mark inside a conversation (spec, section 8.17): the conversation's agent's own mark
// next to its words and its question «Да/Нет»; with the marks turned off in «Интерфейс» — at none of
// them, and the words and the question are still there. «Работаю» has no mark at all (owner 18.11).
import type { AgentMark } from '@bba/contracts';
import type { Message } from '@copilotkit/react-core';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { RequireAuth, SessionProvider } from '../auth/session.tsx';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { ToastProvider } from '../ui/Toast.tsx';
import { ChatExtrasContext, type ChatExtras } from './chat-context.ts';
import { ChatView } from './ChatView.tsx';

// CopilotChat hands its window the agent; here the window is drawn alone, next to a quiet agent.
vi.mock('@copilotkit/react-core', async (original) => ({
  ...(await original<typeof import('@copilotkit/react-core')>()),
  useAgent: () => ({ agent: { pendingInterrupts: [], subscribe: () => ({ unsubscribe: () => undefined }) } }),
  useRenderToolCall: () => () => null,
}));

const AGENT = { id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', starters: [], actions: {}, systems: { tools: {}, prefixes: {} } };
const PICTURE_URL = '/app/api/agents/sales/image?v=0123456789ab';
const QUESTION: Message = { id: 'u1', role: 'user', content: 'Сколько сделок за неделю?' };
const ANSWER: Message = { id: 'a1', role: 'assistant', content: 'Двенадцать сделок.' };

function extras(mark: AgentMark, interrupt: ReactElement | null): ChatExtras {
  return {
    agent: { ...AGENT, mark },
    agentId: 'sales',
    threadId: 't1',
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
    interruptedIds: [],
    keepInterrupted: vi.fn(),
    onTurnsFailed: vi.fn(),
    composerExtra: null,
    composerNotice: null,
  };
}

// Each place is the only words of the agent on the screen: the marks found are the marks of that place.
async function showChat([mark, showAgentMark]: Setting, { messages, running = false, interrupt = null }: { messages: Message[]; running?: boolean; interrupt?: ReactElement | null }) {
  mockServer({ 'GET /app/api/me': { body: { ...ME, interface: { showAgentMark } } } });
  render(
    <MemoryRouter>
      <SessionProvider>
        <ToastProvider>
          <RequireAuth>
            <ChatExtrasContext value={extras(mark, interrupt)}>
              <ChatView messages={messages} isRunning={running} />
            </ChatExtrasContext>
          </RequireAuth>
        </ToastProvider>
      </SessionProvider>
    </MemoryRouter>,
  );
  await screen.findByText('Сколько сделок за неделю?');
}

// The row of the agent's words: the mark, then the body that holds them.
const rowOf = (inBody: Element) => inBody.parentElement!.parentElement!;

function marksIn(place: ParentNode): string[] {
  return [...place.querySelectorAll('[data-agent-mark]')].map((mark) =>
    mark.getAttribute('data-agent-mark') === 'icon' ? `icon ${mark.getAttribute('data-icon')}` : `picture ${mark.querySelector('img')?.getAttribute('src')}`,
  );
}

// The agent's own mark and the switch of «Интерфейс».
type Setting = [AgentMark, boolean];
const SETTINGS: [string, Setting, string[]][] = [
  ['its icon', [{ kind: 'icon', icon: 'bot' }, true], ['icon bot']],
  ['its picture', [{ kind: 'image', url: PICTURE_URL }, true], [`picture ${PICTURE_URL}`]],
  ['nothing with the marks turned off', [{ kind: 'image', url: PICTURE_URL }, false], []],
];

describe.each(SETTINGS)('in a conversation the agent’s mark is %s', (_, setting, expected) => {
  it('next to its words', async () => {
    await showChat(setting, { messages: [QUESTION, ANSWER] });
    // The answer is drawn word by word, each word in an element of its own.
    const words = document.querySelector('[data-streaming-markdown-root]')!;
    expect(words).toHaveTextContent('Двенадцать сделок.');
    expect(marksIn(rowOf(words.closest('[data-answer-text]')!))).toEqual(expected);
    expect(marksIn(document)).toEqual(expected);
  });

  it('not at its «Работаю»', async () => {
    await showChat(setting, { messages: [QUESTION], running: true });
    expect(screen.getByRole('status', { name: 'Работаю' })).toHaveTextContent('Работаю');
    expect(marksIn(document)).toEqual([]);
  });

  it('next to its question «Да/Нет»', async () => {
    await showChat(setting, { messages: [QUESTION], interrupt: <p>Подтвердите действие</p> });
    expect(marksIn(rowOf(screen.getByText('Подтвердите действие')))).toEqual(expected);
    expect(marksIn(document)).toEqual(expected);
  });
});
