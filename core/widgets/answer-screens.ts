// The screens the agent showed earlier in the answer it goes on with (spec, section 8.31, «Правки»; issue #25). An
// answer that waited for «Да», «Нет» or a tool of the browser goes on in a new request, and the screens of a request
// live in its context: without this the agent's change of its own screen was refused as «a screen of an earlier answer»
// and it drew a second one. The answer is everything after the person's last message in the prompt; its screens are the
// calls of `render_ui` whose result says shown, replayed through the same check that let them through.
import { operationsOf, WIDGET_TOOL } from '@bba/contracts';
import { checkScreen, type ShownScreens } from './catalog.ts';

type Part = { type?: unknown; toolCallId?: unknown; toolName?: unknown; input?: unknown; output?: unknown };
type PromptMessage = { role: string; content: unknown };

const partsOf = (message: PromptMessage): Part[] => (Array.isArray(message.content) ? (message.content as Part[]) : []);

// A result of a tool in the prompt: an object as JSON, or kept as its text.
function resultOf(output: unknown): Record<string, unknown> | null {
  if (!output || typeof output !== 'object') return null;
  const { type, value } = output as { type?: unknown; value?: unknown };
  if (type === 'json' && value && typeof value === 'object') return value as Record<string, unknown>;
  if (type !== 'text' || typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function screensOfAnswer(prompt: readonly PromptMessage[]): ShownScreens {
  const answer = prompt.slice(prompt.findLastIndex((m) => m.role === 'user') + 1);
  const shown = new Set<unknown>();
  for (const message of answer) {
    if (message.role !== 'tool') continue;
    for (const part of partsOf(message)) if (part.type === 'tool-result' && part.toolName === WIDGET_TOOL.render && resultOf(part.output)?.shown === true) shown.add(part.toolCallId);
  }
  const screens: ShownScreens = new Map();
  for (const message of answer) {
    if (message.role !== 'assistant') continue;
    // A screen that passed then passes again: the check puts it into `screens` as it is after the call.
    for (const part of partsOf(message)) if (part.type === 'tool-call' && part.toolName === WIDGET_TOOL.render && shown.has(part.toolCallId)) checkScreen(operationsOf(part.input), screens);
  }
  return screens;
}
