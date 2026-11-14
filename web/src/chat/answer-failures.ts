// Answers that broke (spec, section 9.1) in the chat. The server drops the words of a broken model
// call when it asks the model again, tells which answers stayed broken when a conversation opens,
// and «Ответить заново» takes the broken last turn back so the question is sent once more.
import { CHAT_EVENTS, failedTurnsSchema, messageDiscardedSchema, type FailedTurns } from '@bba/contracts';
import type { Message } from '@copilotkit/react-core';
import { retryTurn } from './api.ts';

interface CustomEventParams {
  event: { name: string; value: unknown };
  messages: readonly Message[];
}

// An AG-UI subscriber of the chat's agent: a returned list of messages replaces the shown one.
export function failureSubscriber(onTurnsFailed: (value: FailedTurns) => void) {
  return {
    onCustomEvent({ event, messages }: CustomEventParams): { messages: Message[] } | undefined {
      if (event.name === CHAT_EVENTS.messageDiscarded) {
        const parsed = messageDiscardedSchema.safeParse(event.value);
        if (!parsed.success) {
          console.error('malformed chat event', event.name, parsed.error);
          return undefined;
        }
        return { messages: messages.filter((m) => m.id !== parsed.data.messageId) };
      }
      if (event.name === CHAT_EVENTS.turnsFailed) {
        const parsed = failedTurnsSchema.safeParse(event.value);
        if (!parsed.success) {
          console.error('malformed chat event', event.name, parsed.error);
          return undefined;
        }
        onTurnsFailed(parsed.data);
      }
      return undefined;
    },
  };
}

// The messages of the agent's last answer: everything after the person's last message.
export function lastTurnIds(messages: readonly Message[]): string[] {
  const at = messages.findLastIndex((m) => m.role === 'user');
  return messages.slice(at + 1).map((m) => m.id);
}

// The server took the question and its broken answer out of the conversation: the screen drops them
// too, and the question goes again as it was, attachments included.
export async function answerAgain(threadId: string, agent: { messages: Message[]; setMessages(messages: Message[]): void }, send: (text: string) => void): Promise<void> {
  const { text } = await retryTurn(threadId);
  const at = agent.messages.findLastIndex((m) => m.role === 'user');
  agent.setMessages(at >= 0 ? agent.messages.slice(0, at) : agent.messages);
  send(text);
}
