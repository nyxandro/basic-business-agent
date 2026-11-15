// Answers that broke (spec, section 9.1) as the chat shows them: the words of a broken attempt go
// off the screen, broken answers keep a mark and the last one can be answered again.
import { CHAT_EVENTS } from '@bba/contracts';
import type { Message } from '@copilotkit/react-core';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockServer } from '../test/fetch-mock.ts';
import { ToastProvider } from '../ui/Toast.tsx';
import { answerAgain, failureSubscriber, lastTurnIds } from './answer-failures.ts';
import { chatFailureOf } from './chat-errors.ts';
import { TurnFooter } from './AssistantMessage.tsx';

const user = (id: string, content: string): Message => ({ id, role: 'user', content });
const inPage = (ui: ReactElement) => render(<ToastProvider>{ui}</ToastProvider>);
const said = (id: string, content: string): Message => ({ id, role: 'assistant', content });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a failed turn', () => {
  it('can be answered again when it failed inside the run, not when it was refused or the connection to the server broke', () => {
    const broke = chatFailureOf(Object.assign(new Error('Модель сейчас не отвечает.'), { code: 'APP_MODEL_UNAVAILABLE' }));
    expect([broke.error.code, broke.answerAgain]).toEqual(['APP_MODEL_UNAVAILABLE', true]);
    const refused = chatFailureOf(new Error('HTTP 402: {"error":{"code":"APP_USAGE_LIMIT_EXCEEDED","message":"Ваш лимит исчерпан."}}'));
    expect([refused.error.code, refused.error.message, refused.answerAgain]).toEqual(['APP_USAGE_LIMIT_EXCEEDED', 'Ваш лимит исчерпан.', false]);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const lost = chatFailureOf(new Error('socket hang up'));
    expect([lost.error.code, lost.answerAgain]).toEqual(['APP_CHAT_STREAM_INTERRUPTED', false]);
  });
});

describe('events of the chat stream', () => {
  const event = (name: string, value: unknown) => ({ event: { type: 'CUSTOM', name, value }, messages: [user('u1', 'привет'), said('a1', 'Пр'), said('a2', 'Привет!')] });

  const handlers = () => ({ onMessageDiscarded: vi.fn(), onTurnsFailed: vi.fn() });

  it('names the message whose words a broken attempt left on the screen, and leaves the run as it is', () => {
    const h = handlers();
    expect(failureSubscriber(h).onCustomEvent(event(CHAT_EVENTS.messageDiscarded, { messageId: 'a1' }))).toBeUndefined();
    expect(h.onMessageDiscarded).toHaveBeenCalledWith('a1');
    expect(h.onTurnsFailed).not.toHaveBeenCalled();
  });

  it('hands over the broken answers of an opened conversation', () => {
    const h = handlers();
    const value = { interruptedMessageIds: ['a1'], last: { code: 'APP_MODEL_UNAVAILABLE', message: 'Модель сейчас не отвечает.' } };
    expect(failureSubscriber(h).onCustomEvent(event(CHAT_EVENTS.turnsFailed, value))).toBeUndefined();
    expect(h.onTurnsFailed).toHaveBeenCalledWith(value);
  });

  it('leaves the screen as it is on a malformed event', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = handlers();
    expect(failureSubscriber(h).onCustomEvent(event(CHAT_EVENTS.messageDiscarded, { id: 'a1' }))).toBeUndefined();
    expect(failureSubscriber(h).onCustomEvent(event(CHAT_EVENTS.turnsFailed, { last: 'x' }))).toBeUndefined();
    expect(h.onMessageDiscarded).not.toHaveBeenCalled();
    expect(h.onTurnsFailed).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(2);
  });
});

describe('«Ответить заново»', () => {
  it('takes the question and the broken answer off the screen and sends the question as the server gave it back', async () => {
    const question = 'Прочитай счёт\n\nВложения:\n- Счёт.pdf (файл в рабочей папке: Счёт.pdf)';
    const { calls } = mockServer({ 'POST /app/api/threads/t1/retry': { body: { text: question } } });
    const agent = { messages: [user('u0', 'привет'), said('a0', 'Готово.'), user('u1', question), said('a1', 'При')], setMessages: vi.fn() };
    const send = vi.fn();
    await answerAgain('t1', agent, send);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/app/api/threads/t1/retry')).toBe(true);
    expect(agent.setMessages).toHaveBeenCalledWith([user('u0', 'привет'), said('a0', 'Готово.')]);
    expect(send).toHaveBeenCalledWith(question);
  });

  it('leaves the conversation as it is when the server refuses', async () => {
    mockServer({ 'POST /app/api/threads/t1/retry': apiError('APP_CHAT_NOT_INTERRUPTED', 'Последний ответ не оборван — отвечать заново нечего. Обновите страницу.', 409) });
    const agent = { messages: [user('u1', 'привет'), said('a1', 'Готово.')], setMessages: vi.fn() };
    const send = vi.fn();
    await expect(answerAgain('t1', agent, send)).rejects.toMatchObject({ code: 'APP_CHAT_NOT_INTERRUPTED' });
    expect(agent.setMessages).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('knows the messages of the last answer', () => {
    expect(lastTurnIds([user('u0', 'a'), said('a0', 'b'), user('u1', 'c'), said('a1', 'd'), said('a2', 'e')])).toEqual(['a1', 'a2']);
    expect(lastTurnIds([user('u1', 'c')])).toEqual([]);
  });
});

describe('under an answer', () => {
  it('marks a broken answer and offers to answer it again', async () => {
    const onAnswerAgain = vi.fn();
    inPage(<TurnFooter text="При" streaming={false} interrupted onAnswerAgain={onAnswerAgain} />);
    expect(screen.getByText('Ответ прервался')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Копировать' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ответить заново' }));
    expect(onAnswerAgain).toHaveBeenCalledTimes(1);
  });

  it('only marks an earlier broken answer, and shows nothing new under a whole one', () => {
    const { unmount } = inPage(<TurnFooter text="При" streaming={false} interrupted />);
    expect(screen.getByText('Ответ прервался')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ответить заново' })).not.toBeInTheDocument();
    unmount();
    inPage(<TurnFooter text="Готово." streaming={false} interrupted={false} />);
    expect(screen.queryByText('Ответ прервался')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ответить заново' })).not.toBeInTheDocument();
  });

  it('offers to answer again when the answer broke before its first words', () => {
    inPage(<TurnFooter text="" streaming={false} interrupted onAnswerAgain={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Копировать' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ответить заново' })).toBeInTheDocument();
  });
});
