// Answers that broke (spec, section 9.1) in the chat. The server drops the words of a broken model
// call when it asks the model again, tells which answers stayed broken when a conversation opens,
// and «Ответить заново» takes the broken last turn back so the question is sent once more.
import { ANSWER_AGAIN_CODES, CHAT_EVENTS, failedTurnsSchema, messageDiscardedSchema, type ActionDescription, type FailedTurns } from '@bba/contracts';
import type { Message } from '@copilotkit/react-core';
import { retryTurn } from './api.ts';
import { parseToolResult } from './tool-result.ts';

interface CustomEventParams {
  event: { name: string; value: unknown };
  messages: readonly Message[];
}

// The message goes with the results of its calls, or — when only calls of a broken step hang on a message of an earlier
// step — only those calls and whatever they may already show.
function withoutDiscarded(messages: readonly Message[], messageId: string, toolCallIds: string[] | undefined): Message[] {
  const gone = messages.find((m) => m.id === messageId);
  const calls = new Set(toolCallIds ?? (gone?.role === 'assistant' ? (gone.toolCalls ?? []).map((c) => c.id) : []));
  if (!toolCallIds) return messages.filter((m) => m.id !== messageId && !(m.role === 'tool' && calls.has(m.toolCallId)));
  return messages
    .filter((m) => !(m.role === 'tool' && calls.has(m.toolCallId)))
    .map((m) => (m.id === messageId && m.role === 'assistant' && m.toolCalls ? { ...m, toolCalls: m.toolCalls.filter((c) => !calls.has(c.id)) } : m));
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
        return { messages: withoutDiscarded(messages, parsed.data.messageId, parsed.data.toolCallIds) };
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

// An action that changes data — it needs «Да» — ran in the last answer: answering it again would ask
// for it again (decision of the owner 15.11). The server checks the same by the «Да» it recorded.
function actionRanInLastTurn(messages: readonly Message[], actions: Record<string, ActionDescription>): boolean {
  const turn = messages.slice(messages.findLastIndex((m) => m.role === 'user') + 1);
  return turn.some(
    (m) =>
      m.role === 'assistant' &&
      (m.toolCalls ?? []).some((call) => {
        if (actions[call.function.name]?.readOnly !== false) return false;
        const result = turn.find((r) => r.role === 'tool' && r.toolCallId === call.id);
        return result !== undefined && parseToolResult(typeof result.content === 'string' ? result.content : null).kind !== 'declined';
      }),
  );
}

// What the chat offers under an answer that broke just now (spec, section 9.1).
export function liveVerdict(code: string, messages: readonly Message[], actions: Record<string, ActionDescription>): { answerAgain: boolean; actionDone: boolean } {
  const actionDone = actionRanInLastTurn(messages, actions);
  return { actionDone, answerAgain: ANSWER_AGAIN_CODES.includes(code) && !actionDone };
}

// The server takes the question the person sees and its broken answer out of the conversation: the
// screen drops them too, and the question goes again as it was, attachments included.
export async function answerAgain(threadId: string, agent: { messages: Message[]; setMessages(messages: Message[]): void }, send: (text: string) => void): Promise<void> {
  const at = agent.messages.findLastIndex((m) => m.role === 'user');
  const question = agent.messages[at];
  if (!question) throw new Error('«Ответить заново» without a question on the screen');
  const { text } = await retryTurn(threadId, question.id);
  agent.setMessages(agent.messages.slice(0, at));
  send(text);
}
