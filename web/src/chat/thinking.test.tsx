// «Работаю» stays while the agent works and has shown nothing new yet (decision of the owner 15.11):
// also while the model reasons — its reasoning comes as a message of its own that the feed does not
// draw, and it used to take the status away between the steps of the agent.
import type { Message } from '@copilotkit/react-core';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { RequireAuth, SessionProvider } from '../auth/session.tsx';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { ToastProvider } from '../ui/Toast.tsx';
import { ChatExtrasContext, type ChatExtras } from './chat-context.ts';
import { ChatView } from './ChatView.tsx';

vi.mock('@copilotkit/react-core', async (original) => ({
  ...(await original<typeof import('@copilotkit/react-core')>()),
  useAgent: () => ({ agent: { pendingInterrupts: [], subscribe: () => ({ unsubscribe: () => undefined }) } }),
  useRenderToolCall: () => () => null,
}));

const AGENT = { id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', starters: [], mark: { kind: 'icon' as const, icon: 'spark' as const }, actions: {}, systems: { tools: {}, prefixes: {} } };
const QUESTION: Message = { id: 'u1', role: 'user', content: 'Улучши моё резюме' };
const CALL: Message = { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'view_image', arguments: '{}' } }] };
const RESULT: Message = { id: 'r1', role: 'tool', toolCallId: 'c1', content: '{"ok":true}' };
const REASONING: Message = { id: 'th1', role: 'reasoning', content: 'Сначала посмотрю на вёрстку оригинала' };
const WORDS: Message = { id: 'a2', role: 'assistant', content: 'Посмотрю, как выглядит оригинал.' };

function extras(): ChatExtras {
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
    interrupt: null,
    failure: null,
    onFailure: vi.fn(),
    interruptedIds: [],
    keepInterrupted: vi.fn(),
    onTurnsFailed: vi.fn(),
    composerExtra: null,
    composerNotice: null,
  };
}

async function showChat(messages: Message[], running: boolean) {
  mockServer({ 'GET /app/api/me': { body: ME } });
  render(
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
    </MemoryRouter>,
  );
  await screen.findByText('Улучши моё резюме');
}

const thinking = () => screen.queryByRole('status', { name: 'Работаю' });

describe('a conversation opening (spec, section 8.22)', () => {
  it('shows no «Загружаю разговор…» while it connects: nothing, then the line after a second', async () => {
    mockServer({ 'GET /app/api/me': { body: ME } });
    render(
      <MemoryRouter>
        <SessionProvider>
          <ToastProvider>
            <RequireAuth>
              <ChatExtrasContext value={extras()}>
                <ChatView messages={[]} isRunning={false} isConnecting />
              </ChatExtrasContext>
            </RequireAuth>
          </ToastProvider>
        </SessionProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('textbox', { name: 'Сообщение агенту' });
    expect(screen.queryByText('Загружаю разговор…')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(await screen.findByRole('progressbar', {}, { timeout: 2000 })).toBeInTheDocument();
  });
});

describe('«Работаю» while the agent works', () => {
  it('stays while the model reasons before its first words', async () => {
    await showChat([QUESTION, REASONING], true);
    expect(thinking()).toBeInTheDocument();
  });

  it('stays while the model reasons after an action, before the next step', async () => {
    await showChat([QUESTION, CALL, RESULT, REASONING], true);
    expect(thinking()).toBeInTheDocument();
  });

  it('goes when the words of the answer come, and when the agent is done', async () => {
    await showChat([QUESTION, REASONING, WORDS], true);
    expect(thinking()).not.toBeInTheDocument();
    // The answer is drawn word by word, each word in an element of its own.
    expect(document.querySelector('[data-streaming-markdown-root]')).toHaveTextContent('Посмотрю, как выглядит оригинал.');
  });

  it('is not there when the agent is not working', async () => {
    await showChat([QUESTION, CALL, RESULT, REASONING], false);
    expect(thinking()).not.toBeInTheDocument();
  });
});
