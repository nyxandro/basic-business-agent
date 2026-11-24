// The agent's mark inside a conversation (spec, section 8.17): the conversation's agent's own mark
// next to its words and its question «Да/Нет»; with the marks turned off in «Интерфейс» — at none of
// them, and the words and the question are still there. An answer has its mark from its first «Работаю» (owner 21.11).
import type { AgentMark } from '@bba/contracts';
import type { Message } from '@copilotkit/react-core';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { RequireAuth, SessionProvider } from '../auth/session.tsx';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { ToastProvider } from '../ui/Toast.tsx';
import { ChatExtrasContext, type ChatExtras } from '../answer/chat-context.ts';
import { ChatView } from './ChatView.tsx';

// CopilotChat hands its window the agent; here the window is drawn alone, next to a quiet agent.
vi.mock('@copilotkit/react-core', async (original) => ({
  ...(await original<typeof import('@copilotkit/react-core')>()),
  useAgent: () => ({ agent: { pendingInterrupts: [], subscribe: () => ({ unsubscribe: () => undefined }) } }),
  useRenderToolCall: () => () => null,
}));

const AGENT = { id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', actions: {}, systems: { tools: {}, prefixes: {} } };
const PICTURE_URL = '/app/api/agents/sales/image?v=0123456789ab';
const QUESTION: Message = { id: 'u1', role: 'user', content: 'Сколько сделок за неделю?' };
const ANSWER: Message = { id: 'a1', role: 'assistant', content: 'Двенадцать сделок.' };

function extras(mark: AgentMark, interrupt: ReactElement | null): ChatExtras {
  return {
    agent: { ...AGENT, mark },
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
    stopRun: vi.fn(),
  };
}

interface Place {
  messages: Message[];
  running?: boolean;
  interrupt?: ReactElement | null;
}

const chatOf = ([mark]: Setting, { messages, running = false, interrupt = null }: Place) => (
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
  </MemoryRouter>
);

// Each place is the only words of the agent on the screen: the marks found are the marks of that place.
async function showChat(setting: Setting, place: Place) {
  mockServer({ 'GET /app/api/me': { body: { ...ME, interface: { showAgentMark: setting[1] } } } });
  const view = render(chatOf(setting, place));
  await screen.findByText('Сколько сделок за неделю?');
  return view;
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

  // Decision of the owner 21.11 (18.11 «Работаю» had none): the answer's mark is there from its first «Работаю», and
  // the words that come stand beside the same mark.
  it('beside its «Работаю» from the first moment, and the same one beside the words that come', async () => {
    const view = await showChat(setting, { messages: [QUESTION], running: true });
    const working = screen.getByRole('status', { name: 'Работаю' });
    expect(marksIn(document)).toEqual(expected);
    const mark = document.querySelector('[data-agent-mark]');
    if (expected.length > 0) expect(working.closest('[class*="assistant"]')?.contains(mark)).toBe(true);
    view.rerender(chatOf(setting, { messages: [QUESTION, ANSWER], running: true }));
    expect(marksIn(document)).toEqual(expected);
    expect(document.querySelector('[data-agent-mark]')).toBe(mark);
  });

  it('next to its question «Да/Нет»', async () => {
    await showChat(setting, { messages: [QUESTION], interrupt: <p>Подтвердите действие</p> });
    expect(marksIn(rowOf(screen.getByText('Подтвердите действие')))).toEqual(expected);
    expect(marksIn(document)).toEqual(expected);
  });
});
