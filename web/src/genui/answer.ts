// The answer to a choice or a form (spec, section 7): the first message of the person after the
// agent's message that asked — its words without the block of files. Null until there is one.
import { splitAttachments } from '@bba/contracts';
import type { Message } from '@copilotkit/react-core';
import { textOf } from '../chat/messages.ts';

export function answerOf(messages: readonly Message[], toolCallId: string): string | null {
  const index = messages.findIndex((m) => m.role === 'assistant' && (m.toolCalls ?? []).some((c) => c.id === toolCallId));
  if (index < 0) return null;
  const reply = messages.slice(index + 1).find((m) => m.role === 'user');
  return reply ? splitAttachments(textOf(reply.content)).text.trim() : null;
}
