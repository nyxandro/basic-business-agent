// Tells the chat which shown messages a repeated model call dropped (spec, section 9.1). The retry
// processor reports the id of Mastra's response message when the step is asked again; on the screen
// that response is AG-UI messages whose ids the Mastra adapter derives from it, and only what the
// broken step showed must go — the actions and words of earlier steps of the turn stay.
import { CHAT_EVENTS } from '@bba/contracts';

interface AguiEvent {
  type?: string;
  messageId?: unknown;
  parentMessageId?: unknown;
  toolCallId?: unknown;
}

function parse(line: string): AguiEvent | null {
  if (!line.startsWith('data:')) return null;
  try {
    return JSON.parse(line.slice(5).trim()) as AguiEvent;
  } catch {
    return null;
  }
}

// The message an event belongs to: text and reasoning events name it, a tool call names the message
// it is in.
function messageOf(event: AguiEvent): string | null {
  if (typeof event.messageId === 'string') return event.messageId;
  return typeof event.parentMessageId === 'string' ? event.parentMessageId : null;
}

// The adapter shows a response as the id itself (the text before tool calls and the calls) and
// `<id>-…` ids (the text after tool calls: `<id>-agui-text`, `<id>-agui-text-2`). Reasoning comes as
// messages of their own ids.
const derivedFrom = (id: string, response: string) => id === response || id.startsWith(`${response}-`);

const discardLine = (messageId: string, toolCallIds?: string[]) =>
  `data: ${JSON.stringify({ type: 'CUSTOM', name: CHAT_EVENTS.messageDiscarded, value: { messageId, ...(toolCallIds ? { toolCallIds } : {}) } })}`;

export interface DiscardTracker {
  // A line of the stream, with the announcements due right before it.
  pass(line: string): string;
  // Announcements still due when the stream ends.
  rest(): string;
}

// `take` gives the responses reported broken since its last call. The report can come before the
// words of the broken step have passed through here, so the announcement waits for the first event
// that is not about them: a message of another response, or the end or failure of the run.
export function createDiscardTracker(take: () => string[]): DiscardTracker {
  let broken: string[] = [];
  // Messages of the run shown before the current step: a call of the broken step may hang on one of
  // them (the adapter puts a step's first call on the message of the step before); only the call goes.
  const earlier = new Set<string>();
  // The current step is everything since the last tool result: the broken step is the last one.
  let stepMessages: string[] = [];
  let stepReasoning = new Set<string>();
  let stepCalls = new Map<string, string[]>();

  const ofBroken = (id: string) => broken.some((response) => derivedFrom(id, response));

  const announce = (): string[] => {
    const lines: string[] = [];
    for (const id of stepMessages) {
      if (!ofBroken(id) && !stepReasoning.has(id)) continue;
      if (!earlier.has(id)) lines.push(discardLine(id), '');
      else if (stepCalls.has(id)) lines.push(discardLine(id, stepCalls.get(id)), '');
    }
    stepMessages = [];
    stepReasoning = new Set();
    stepCalls = new Map();
    broken = [];
    return lines;
  };

  return {
    pass(line) {
      broken.push(...take());
      const event = parse(line);
      if (!event) return line;
      const message = messageOf(event);
      const ends = event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR';
      const other = message !== null && !ofBroken(message) && !stepReasoning.has(message);
      const before = broken.length > 0 && (ends || other) ? announce() : [];
      if (event.type === 'TOOL_CALL_RESULT') {
        for (const id of stepMessages) earlier.add(id);
        stepMessages = [];
        stepReasoning = new Set();
        stepCalls = new Map();
      } else if (message !== null) {
        if (!stepMessages.includes(message)) stepMessages.push(message);
        if (event.type?.startsWith('REASONING')) stepReasoning.add(message);
        if (event.type === 'TOOL_CALL_START' && typeof event.toolCallId === 'string') stepCalls.set(message, [...(stepCalls.get(message) ?? []), event.toolCallId]);
      }
      return before.length > 0 ? [...before, line].join('\n') : line;
    },
    rest() {
      broken.push(...take());
      const due = broken.length > 0 ? announce() : [];
      return due.length > 0 ? `${due.join('\n')}\n` : '';
    },
  };
}
