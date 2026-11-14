// Tells the chat which shown messages a repeated model call dropped (spec, section 9.1). The retry
// processor reports the id of Mastra's response message when the step is asked again; on the screen
// that response is AG-UI messages whose ids the Mastra adapter derives from it, and only those of
// the broken step must go — the actions and words of earlier steps of the turn stay.
import { CHAT_EVENTS } from '@bba/contracts';

interface AguiEvent {
  type?: string;
  messageId?: unknown;
  parentMessageId?: unknown;
}

function parse(line: string): AguiEvent | null {
  if (!line.startsWith('data:')) return null;
  try {
    return JSON.parse(line.slice(5).trim()) as AguiEvent;
  } catch {
    return null;
  }
}

// The message an event belongs to: text events name it, a tool call names the message it is in.
function messageOf(event: AguiEvent): string | null {
  if (typeof event.messageId === 'string') return event.messageId;
  return typeof event.parentMessageId === 'string' ? event.parentMessageId : null;
}

// The adapter shows a response as the id itself (the text before tool calls and the calls) and
// `<id>-…` ids (the text after tool calls: `<id>-agui-text`, `<id>-agui-text-2`).
const derivedFrom = (id: string, response: string) => id === response || id.startsWith(`${response}-`);

const discardLine = (messageId: string) => `data: ${JSON.stringify({ type: 'CUSTOM', name: CHAT_EVENTS.messageDiscarded, value: { messageId } })}`;

export interface DiscardTracker {
  // A line of the stream, with the announcements due right before it.
  pass(line: string): string;
  // Announcements still due when the stream ends.
  rest(): string;
}

// `take` gives the responses reported broken since its last call. The report can come before the
// words of the broken step have passed through here, so the announcement waits for the first event
// that is not about those words: a message of another response, or the end or failure of the run.
export function createDiscardTracker(take: () => string[]): DiscardTracker {
  let broken: string[] = [];
  // Messages shown since the last tool result: the broken step is the last one.
  let stepMessages: string[] = [];

  const announce = (): string[] => {
    const dropped = stepMessages.filter((id) => broken.some((response) => derivedFrom(id, response)));
    stepMessages = stepMessages.filter((id) => !dropped.includes(id));
    broken = [];
    return dropped.flatMap((id) => [discardLine(id), '']);
  };

  return {
    pass(line) {
      broken.push(...take());
      const event = parse(line);
      if (!event) return line;
      const message = messageOf(event);
      const ends = event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR';
      const other = message !== null && !broken.some((response) => derivedFrom(message, response));
      const before = broken.length > 0 && (ends || other) ? announce() : [];
      if (event.type === 'TOOL_CALL_RESULT') stepMessages = [];
      else if (message !== null && !stepMessages.includes(message)) stepMessages.push(message);
      return before.length > 0 ? [...before, line].join('\n') : line;
    },
    rest() {
      broken.push(...take());
      const due = broken.length > 0 ? announce() : [];
      return due.length > 0 ? `${due.join('\n')}\n` : '';
    },
  };
}
