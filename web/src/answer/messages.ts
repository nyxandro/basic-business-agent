// What the feed reads from AG-UI messages: the text of the person's message and the result of a
// tool call. Files go with the text (withAttachments of @bba/contracts), so the feed takes them back.
import type { Message, ToolMessage } from '@copilotkit/react-core';

// Text parts of a message: AG-UI content is a string or a list of parts.
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p: { type?: string; text?: unknown }) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('');
}

export function toolMessageOf(messages: readonly Message[], toolCallId: string): ToolMessage | undefined {
  return messages.find((m): m is ToolMessage => m.role === 'tool' && (m).toolCallId === toolCallId);
}
