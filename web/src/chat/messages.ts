// What the feed reads from AG-UI messages: the text of the person's message and the files it named,
// the result of a tool call. Files go with the text (withAttachments), so the feed takes them back.
import type { UploadedFile } from '@bba/contracts';
import type { Message, ToolMessage } from '@copilotkit/react-core';
import { ru } from '../i18n/ru.ts';

export function withAttachments(text: string, files: UploadedFile[]): string {
  if (files.length === 0) return text;
  return [text, '', `${ru.chat.attachmentsTitle}:`, ...files.map((f) => ru.chat.attachmentLine(f.name, f.path))].join('\n');
}

// Text parts of a message: AG-UI content is a string or a list of parts.
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p: { type?: string; text?: unknown }) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('');
}

const FILE_LINE = /^- (.+) \(файл в рабочей папке: .+\)$/;

// The person's own words and the names of the files the message brought.
export function splitAttachments(text: string): { text: string; files: string[] } {
  const marker = `\n\n${ru.chat.attachmentsTitle}:\n`;
  const at = text.lastIndexOf(marker);
  if (at < 0) return { text, files: [] };
  const lines = text.slice(at + marker.length).split('\n');
  const files = lines.map((l) => FILE_LINE.exec(l)?.[1]).filter((n): n is string => Boolean(n));
  return files.length === lines.length ? { text: text.slice(0, at), files } : { text, files: [] };
}

export function toolMessageOf(messages: readonly Message[], toolCallId: string): ToolMessage | undefined {
  return messages.find((m): m is ToolMessage => m.role === 'tool' && (m).toolCallId === toolCallId);
}
