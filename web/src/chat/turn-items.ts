// How a turn of the agent is laid out (decision of the owner 15.11): the words of the agent and the
// things it draws stay in sight; the status lines between two of them go into one stack, which shows
// the last of them and unfolds into all. A lone line is a stack of one, so the line stays the same
// when the next call comes and only turns to it. Within one message the words come first: AG-UI puts
// the calls of a step on the message of the words said before them.
// What the agent does now is not here but in the live line under the answer (decision of the owner 21.11): a call under
// way comes into the turn once it is done — into its stack, or as its block; a widget comes as soon as it has something
// to draw, since the engine draws it as it is written.
import { GENUI_TOOL, toolTableResultSchema, WEB_RESEARCH_TOOL, WIDGET_TOOL } from '@bba/contracts';
import type { AssistantMessage, Message } from '@copilotkit/react-core';
import { drawsWhileWritten } from '../widgets/operations.ts';
import { toolMessageOf } from './messages.ts';
import { parseToolResult } from './tool-result.ts';

export type ToolCall = NonNullable<AssistantMessage['toolCalls']>[number];

// The arguments of a call come as JSON text, still unfinished while the model writes them.
export function argumentsOf(call: ToolCall): unknown {
  try {
    return JSON.parse(call.function.arguments);
  } catch {
    return null;
  }
}

export type TurnItem =
  | { kind: 'text'; id: string; text: string; message: AssistantMessage }
  | { kind: 'call'; call: ToolCall }
  // `key` — the first call of the run of status lines, done or still under way: the stack stays the same one when an
  // earlier call of it is done after a later one.
  | { kind: 'stack'; key: string; calls: ToolCall[] };

// The live block of a search of the internet stands alone too (spec, section 8.30): it is the search itself.
const BLOCKS: ReadonlySet<string> = new Set([...Object.values(GENUI_TOOL), WEB_RESEARCH_TOOL, WIDGET_TOOL.render]);

// A block of the catalog, or a call whose result is a table the person reads: content, not status.
function standsAlone(call: ToolCall, messages: readonly Message[]): boolean {
  if (BLOCKS.has(call.function.name)) return true;
  const result = toolMessageOf(messages, call.id)?.content;
  if (typeof result !== 'string') return false;
  const outcome = parseToolResult(result);
  return outcome.kind === 'ok' && toolTableResultSchema.safeParse(outcome.value).success;
}

// `underWay` — the ids of the calls the answer being written works on now (callsUnderWay, call-progress.ts).
export function turnItems(turn: readonly AssistantMessage[], messages: readonly Message[], underWay: ReadonlySet<string> = new Set()): TurnItem[] {
  const items: TurnItem[] = [];
  // A status call under way that would begin a stack.
  let anchor: string | null = null;
  for (const m of turn) {
    const text = typeof m.content === 'string' ? m.content : '';
    if (text) {
      items.push({ kind: 'text', id: m.id, text, message: m });
      anchor = null;
    }
    for (const call of m.toolCalls ?? []) {
      const alone = standsAlone(call, messages);
      if (underWay.has(call.id) && !(call.function.name === WIDGET_TOOL.render && drawsWhileWritten(call))) {
        if (!alone && items.at(-1)?.kind !== 'stack') anchor ??= call.id;
        continue;
      }
      const open = items.at(-1);
      if (alone) {
        items.push({ kind: 'call', call });
        anchor = null;
      } else if (open?.kind === 'stack') open.calls.push(call);
      else {
        items.push({ kind: 'stack', key: anchor ?? call.id, calls: [call] });
        anchor = null;
      }
    }
  }
  return items;
}
