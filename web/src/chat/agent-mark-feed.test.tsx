// The agent's mark inside a conversation (spec, section 8.17): next to its words, its «думает…» and
// its question «Да/Нет», by the setting of «Интерфейс»; with «Без значка» — at none of them, and the
// words, the dots and the question are still there.
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
const PICTURE_URL = '/app/api/interface/agent-image?v=0123456789ab';
const QUESTION: Message = { id: 'u1', role: 'user', content: 'Сколько сделок за неделю?' };
const ANSWER: Message = { id: 'a1', role: 'assistant', content: 'Двенадцать сделок.' };

function extras(interrupt: ReactElement | null): ChatExtras {
  return {
    agent: AGENT,
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
  };
}

// Each place is the only words of the agent on the screen: the marks found are the marks of that place.
async function showChat(agentMark: AgentMark, { messages, running = false, interrupt = null }: { messages: Message[]; running?: boolean; interrupt?: ReactElement | null }) {
  mockServer({ 'GET /app/api/me': { body: { ...ME, interface: { agentMark } } } });
  render(
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

const SETTINGS: [string, AgentMark, string[]][] = [
  ['the chosen icon', { kind: 'icon', icon: 'bot' }, ['icon bot']],
  ['the admin’s picture', { kind: 'image', url: PICTURE_URL }, [`picture ${PICTURE_URL}`]],
  ['nothing with «Без значка»', { kind: 'none' }, []],
];

describe.each(SETTINGS)('in a conversation the agent’s mark is %s', (_, agentMark, expected) => {
  it('next to its words', async () => {
    await showChat(agentMark, { messages: [QUESTION, ANSWER] });
    // The answer is drawn word by word, each word in an element of its own.
    const words = document.querySelector('[data-streaming-markdown-root]')!;
    expect(words).toHaveTextContent('Двенадцать сделок.');
    expect(marksIn(rowOf(words))).toEqual(expected);
    expect(marksIn(document)).toEqual(expected);
  });

  it('next to its «думает…»', async () => {
    await showChat(agentMark, { messages: [QUESTION], running: true });
    const thinking = screen.getByRole('status', { name: 'Думает…' });
    expect(marksIn(thinking)).toEqual(expected);
    expect(marksIn(document)).toEqual(expected);
  });

  it('next to its question «Да/Нет»', async () => {
    await showChat(agentMark, { messages: [QUESTION], interrupt: <p>Подтвердите действие</p> });
    expect(marksIn(rowOf(screen.getByText('Подтвердите действие')))).toEqual(expected);
    expect(marksIn(document)).toEqual(expected);
  });
});
