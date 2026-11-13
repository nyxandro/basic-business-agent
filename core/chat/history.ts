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
}

interface StoredMessage {
  id: string;
  role: string;
  createdAt: Date | string;
  content: string | { parts?: StoredPart[]; content?: string };
}

export function toHistory(messages: StoredMessage[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content.parts ?? [{ type: 'text', text: m.content.content ?? '' }]);
    const text = parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('');
    const toolCalls = parts
      .filter((p) => p.type === 'tool-invocation' && p.toolInvocation)
      .map((p) => ({
        id: p.toolInvocation!.toolCallId,
        name: p.toolInvocation!.toolName,
        args: p.toolInvocation!.args ?? {},
        result: p.toolInvocation!.result ?? null,
        state: p.toolInvocation!.state ?? 'result',
      }));
    if (!text && toolCalls.length === 0) continue;
    out.push({ id: m.id, role: m.role, text, toolCalls, createdAt: new Date(m.createdAt).toISOString() });
  }
  return out;
}
