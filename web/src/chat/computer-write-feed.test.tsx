// A write onto the person's computer in the feed of the chat (spec, section 8.25, «Запись в папку»): while the browser's
// tool waits for «Да», its card is in the answer — not only the live line — and the input waits too: no new message
// goes beside the write still to come; «Стоп» lets the write go.
import type { Message } from '@copilotkit/react-core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ChatExtrasContext, type ChatExtras } from '../answer/chat-context.ts';
import { RequireAuth, SessionProvider } from '../auth/session.tsx';
import { askToWrite } from '../projects/computer-saves.ts';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { ToastProvider } from '../ui/Toast.tsx';
import { ChatView } from './ChatView.tsx';
import { ComputerWriteCall } from './ComputerWriteCall.tsx';

interface DrawnCall {
  toolCall: { id: string; function: { name: string } };
  toolMessage?: { content?: unknown };
}

const AGENT = {
  id: 'sales',
  name: 'Продажи',
  description: 'Сделки и клиенты',
  mark: { kind: 'icon' as const, icon: 'spark' as const },
  actions: { computer_folder_write: { title: 'Запись файлов в папку на компьютере', fields: {}, readOnly: false } },
  systems: { tools: { computer_folder_write: 'Компьютер' }, prefixes: {} },
};

vi.mock('@copilotkit/react-core', async (original) => ({
  ...(await original<typeof import('@copilotkit/react-core')>()),
  useAgent: () => ({ agent: { pendingInterrupts: [], subscribe: () => ({ unsubscribe: () => undefined }) } }),
  // CopilotKit draws a call with its renderer: here the block of the write, as renderers.tsx registers it.
  useRenderToolCall:
    () =>
    ({ toolCall, toolMessage }: DrawnCall) => {
      const result = typeof toolMessage?.content === 'string' ? toolMessage.content : undefined;
      return <ComputerWriteCall call={{ toolCallId: toolCall.id, status: result === undefined ? 'executing' : 'complete', parameters: {}, result }} agent={AGENT} />;
    },
}));

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
  };
}

const MESSAGES: Message[] = [
  { id: 'u1', role: 'user', content: 'Сохрани КП в папку' },
  { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'w1', type: 'function', function: { name: 'computer_folder_write', arguments: '{"files":[]}' } }] },
];

describe('a write onto the computer in the feed', () => {
  it('shows its card in the answer while «Да» is awaited, keeps the input from sending, and «Стоп» lets it go', async () => {
    mockServer({ 'GET /app/api/me': { body: ME } });
    const answer = askToWrite('w1', { threadId: 't1', folder: 'Тендер', items: [{ file: 'КП.docx', to: 'КП.docx', replace: false, exists: null, changedSinceRead: false }] });
    const submitted = vi.fn();
    const stopped = vi.fn();
    render(
      <MemoryRouter>
        <SessionProvider>
          <ToastProvider>
            <RequireAuth>
              <ChatExtrasContext value={extras()}>
                <ChatView messages={MESSAGES} isRunning={false} inputValue="Ещё вопрос" onSubmitMessage={submitted} onStop={stopped} />
              </ChatExtrasContext>
            </RequireAuth>
          </ToastProvider>
        </SessionProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('group', { name: 'Сохранить на компьютер в папку «Тендер»?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отправить' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Остановить ответ' }));
    expect(await answer).toBe('stopped');
    expect(stopped).toHaveBeenCalledOnce();
    expect(submitted).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('group', { name: /Сохранить на компьютер/ })).not.toBeInTheDocument());
  });
});
