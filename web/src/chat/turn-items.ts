// How a turn of the agent is laid out (decision of the owner 15.11): the words of the agent and the
// things it draws stay in sight; the status lines between two of them go into one stack, which shows
// the last of them and unfolds into all. A stack of one line is just the line. Within one message the
// words come first: AG-UI puts the calls of a step on the message of the words said before them.
import { GENUI_TOOL, toolTableResultSchema } from '@bba/contracts';
import type { AssistantMessage, Message } from '@copilotkit/react-core';
import { toolMessageOf } from './messages.ts';
import { parseToolResult } from './tool-result.ts';

export type ToolCall = NonNullable<AssistantMessage['toolCalls']>[number];

export type TurnItem =
  | { kind: 'text'; id: string; text: string; message: AssistantMessage }
  | { kind: 'call'; call: ToolCall }
  | { kind: 'stack'; calls: ToolCall[] };

const BLOCKS: ReadonlySet<string> = new Set(Object.values(GENUI_TOOL));

// A block of the catalog, or a call whose result is a table the person reads: content, not status.
function standsAlone(call: ToolCall, messages: readonly Message[]): boolean {
  if (BLOCKS.has(call.function.name)) return true;
  const result = toolMessageOf(messages, call.id)?.content;
  if (typeof result !== 'string') return false;
  const outcome = parseToolResult(result);
  return outcome.kind === 'ok' && toolTableResultSchema.safeParse(outcome.value).success;
}

export function turnItems(turn: readonly AssistantMessage[], messages: readonly Message[]): TurnItem[] {
  const items: TurnItem[] = [];
  for (const m of turn) {
    const text = typeof m.content === 'string' ? m.content : '';
    if (text) items.push({ kind: 'text', id: m.id, text, message: m });
    for (const call of m.toolCalls ?? []) {
      const open = items.at(-1);
      if (standsAlone(call, messages)) items.push({ kind: 'call', call });
      else if (open?.kind === 'stack') open.calls.push(call);
      else items.push({ kind: 'stack', calls: [call] });
    }
  }
  return items.map((item) => (item.kind === 'stack' && item.calls.length === 1 ? { kind: 'call', call: item.calls[0]! } : item));
}
