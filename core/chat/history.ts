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

// One stored assistant message may hold text, then tool calls, then more text: it becomes several
// messages in that order, so a reload shows the conversation as it streamed.
export function toHistory(messages: StoredMessage[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const role = m.role;
    const createdAt = new Date(m.createdAt).toISOString();
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content.parts ?? [{ type: 'text', text: m.content.content ?? '' }]);
    let segment: HistoryMessage = { id: m.id, role, text: '', toolCalls: [], createdAt };
    const flush = () => {
      if (segment.text || segment.toolCalls.length) out.push(segment);
      segment = { id: `${m.id}:${out.length}`, role, text: '', toolCalls: [], createdAt };
    };
    for (const p of parts) {
      if (p.type === 'text' && p.text) {
        if (segment.toolCalls.length) flush();
        segment.text += p.text;
      } else if (p.type === 'tool-invocation' && p.toolInvocation) {
        const t = p.toolInvocation;
        segment.toolCalls.push({ id: t.toolCallId, name: t.toolName, args: t.args ?? {}, result: t.result ?? null, state: t.state ?? 'result' });
      }
    }
    flush();
  }
  return out;
}
