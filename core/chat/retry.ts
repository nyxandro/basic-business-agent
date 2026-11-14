// «Ответить заново» (spec, section 9.1): only the last answer of a conversation that broke and
// stayed broken is answered again. The question and everything after it leave the conversation, and
// the chat sends the question once more as it was — attachments included — as a new turn, so the
// history keeps one question and its answer.
import type { Memory } from '@mastra/memory';
import { appError } from '../errors/catalog.ts';
import { readHistory, textOfStored, type StoredMessage } from './history.ts';

export async function takeBackBrokenTurn(memory: Memory, threadId: string, resourceId: string): Promise<string> {
  const { messages } = await memory.recall({ threadId, resourceId, perPage: false });
  const stored = messages as StoredMessage[];
  if (!readHistory(stored).broken.some((b) => b.last)) {
    throw appError('APP_CHAT_NOT_INTERRUPTED', `thread ${threadId}: the last answer is not broken`);
  }
  const at = stored.findLastIndex((m) => m.role === 'user');
  const question = stored[at];
  if (!question) {
    throw appError('APP_INTERNAL', `thread ${threadId}: a broken answer without a question`, { userMessage: 'Не удалось ответить заново. Начните новый разговор.' });
  }
  await memory.deleteMessages(stored.slice(at).map((m) => m.id));
  return textOfStored(question);
}
