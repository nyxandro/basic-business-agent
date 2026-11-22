import type { Memory } from '@mastra/memory';
import { isServiceTurn } from './service-turns.ts';

// A conversation as the chat screen shows it after a reload: text and tool calls with results.
export interface HistoryToolCall {
  id: string;
  name: string;
  args: unknown;
  result: unknown;
  state: string;
}

export interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolCalls: HistoryToolCall[];
  createdAt: string;
}

interface StoredPart {
  type: string;
  text?: string;
  toolInvocation?: { toolCallId: string; toolName: string; args?: unknown; result?: unknown; state?: string };
  // Mastra keeps the failure of a model call that ended the answer as a part of the answer.
  error?: unknown;
}

export interface StoredMessage {
  id: string;
  role: string;
  createdAt: Date | string;
  content: string | { parts?: StoredPart[]; content?: string };
}

// An answer that broke and stayed broken (spec, section 9.1).
export interface BrokenAnswer {
  // The history message that ends what the answer showed; null when it showed nothing.
  messageId: string | null;
  // The failure as Mastra kept it: technical, for our code and words only — never for the browser.
  error: unknown;
  // It is the last message of the conversation: it can be answered again.
  last: boolean;
}

const partsOf = (m: StoredMessage): StoredPart[] =>
  typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content.parts ?? [{ type: 'text', text: m.content.content ?? '' }]);

// One stored assistant message may hold text, then tool calls, then more text: it becomes several
// messages in that order, so a reload shows the conversation as it streamed.
export function readHistory(messages: StoredMessage[]): { history: HistoryMessage[]; broken: BrokenAnswer[] } {
  const out: HistoryMessage[] = [];
  const broken: BrokenAnswer[] = [];
  // A turn the server started on the person's behalf (core/chat/service-turns.ts) is not their message.
  const said = messages.filter((m) => m.role === 'assistant' || (m.role === 'user' && !isServiceTurn(textOfStored(m))));
  for (const m of said) {
    const role = m.role as 'user' | 'assistant';
    const createdAt = new Date(m.createdAt).toISOString();
    const shownBefore = out.length;
    let failure: { error: unknown } | null = null;
    let segment: HistoryMessage = { id: m.id, role, text: '', toolCalls: [], createdAt };
    const flush = () => {
      if (segment.text || segment.toolCalls.length) out.push(segment);
      segment = { id: `${m.id}:${out.length}`, role, text: '', toolCalls: [], createdAt };
    };
    for (const p of partsOf(m)) {
      if (p.type === 'text' && p.text) {
        if (segment.toolCalls.length) flush();
        segment.text += p.text;
      } else if (p.type === 'tool-invocation' && p.toolInvocation) {
        const t = p.toolInvocation;
        segment.toolCalls.push({ id: t.toolCallId, name: t.toolName, args: t.args ?? {}, result: t.result ?? null, state: t.state ?? 'result' });
      } else if (p.type === 'error' && role === 'assistant') {
        failure = { error: p.error };
      }
    }
    flush();
    if (failure) broken.push({ messageId: out.length > shownBefore ? out.at(-1)!.id : null, error: failure.error, last: m === said.at(-1) });
  }
  return { history: out, broken };
}

export function toHistory(messages: StoredMessage[]): HistoryMessage[] {
  return readHistory(messages).history;
}

// The person's words of a stored message, attachments block included.
export function textOfStored(m: StoredMessage): string {
  return partsOf(m)
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('');
}

// Arguments of the tool calls of a conversation as the model sent them. The approval table keeps
// only a summary (no addresses, no secrets); the person deciding «Да» needs the real values.
// A deleted conversation gives no arguments: the caller shows the summary then.
export async function toolCallArgsOf(memory: Memory, threadId: string, resourceId: string): Promise<Map<string, unknown>> {
  const thread = await memory.getThreadById({ threadId });
  if (!thread || thread.resourceId !== resourceId) return new Map();
  const { messages } = await memory.recall({ threadId, resourceId, perPage: false });
  return new Map(toHistory(messages).flatMap((m) => m.toolCalls.map((c) => [c.id, c.args] as const)));
}
