// The calls of `render_ui` in a conversation, read once (spec, section 8.31; issue #26). While the agent writes, the
// browser gets its answer in chunks, and every block of a widget looks at the whole conversation on each one — the
// changes of its screen, the screens of its answer. Each block reading every call again made the work grow as «screens
// × messages»: 50 screens took ~30 ms a chunk on a slow phone (×4 CPU), past a frame of 16 ms. Now the list of calls
// is made once per list of messages, for all the blocks, and a call written whole is not parsed again.
// Both memories are weak: they go with the messages CopilotKit no longer holds.
import { operationsOf, WIDGET_TOOL } from '@bba/contracts';

type Op = Record<string, unknown>;

// The messages of the agent as CopilotKit holds them: assistant messages with tool calls, and their results.
export interface HeldCall {
  id: string;
  function: { name: string; arguments: string };
}
export interface HeldMessage {
  role: string;
  toolCalls?: HeldCall[];
  toolCallId?: string;
  content?: unknown;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// A call keeps its object while it is written further: the text of its arguments tells whether it changed.
const operationsByCall = new WeakMap<HeldCall, { args: string; ops: Op[] }>();
export function operationsOfCall(call: HeldCall): Op[] {
  const known = operationsByCall.get(call);
  if (known && known.args === call.function.arguments) return known.ops;
  const ops = operationsOf(parseJson(call.function.arguments));
  operationsByCall.set(call, { args: call.function.arguments, ops });
  return ops;
}

const shownByResult = new WeakMap<HeldMessage, { content: unknown; shown: boolean }>();
export function isShownResult(message: HeldMessage): boolean {
  const known = shownByResult.get(message);
  if (known && known.content === message.content) return known.shown;
  const shown = typeof message.content === 'string' && (parseJson(message.content) as { shown?: unknown } | null)?.shown === true;
  shownByResult.set(message, { content: message.content, shown });
  return shown;
}

export interface RenderCalls {
  // The calls of `render_ui` in their order, and the place of each by its id (the first, as a search would find it).
  calls: HeldCall[];
  order: ReadonlyMap<string, number>;
  // The calls whose latest result says the screen was shown.
  shown: ReadonlySet<string>;
}

const byConversation = new WeakMap<readonly HeldMessage[], RenderCalls>();
export function renderCallsOf(messages: readonly HeldMessage[]): RenderCalls {
  const known = byConversation.get(messages);
  if (known) return known;
  const calls: HeldCall[] = [];
  const order = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      if (call.function.name !== WIDGET_TOOL.render) continue;
      if (!order.has(call.id)) order.set(call.id, calls.length);
      calls.push(call);
    }
  }
  const shown = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool' || typeof message.toolCallId !== 'string' || !order.has(message.toolCallId)) continue;
    if (isShownResult(message)) shown.add(message.toolCallId);
    else shown.delete(message.toolCallId);
  }
  const index = { calls, order, shown };
  byConversation.set(messages, index);
  return index;
}
