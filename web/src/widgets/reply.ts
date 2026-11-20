// The person's answer to a widget (spec, section 8.31): as with a choice of the chat (owner's list 16.11), the control
// the person pressed stays set apart by colour and a tick, and once the person answered — by a press or in their own
// words — the controls that send are inactive; what works in place (sliders, fields, tabs, links) keeps working. The
// answer is the first message of the person after the answer that drew the widget (web/src/genui/answer.ts).
// Which control sent it is read from the message, so the mark is there again after a reload — only when one control of
// the whole answer sends those words: three plan cards with «Выбрать» send the same message, and a tick on all three
// would be a lie (review 20.11). A control pressed in this window knows it was pressed (its own state).
import { operationsOf, WIDGET_TOOL } from '@bba/contracts';
import type { Message } from '@copilotkit/react-core';
import { createContext } from 'react';

type Op = Record<string, unknown>;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface WidgetReply {
  answered: boolean;
  // The words of the control that sent the answer, when one control of the answer sends that message.
  chosen: ReadonlySet<string>;
  // The words of the controls of this widget that send a message.
  sending: ReadonlySet<string>;
}

// Outside a block of a widget (a test of one component) nothing was answered and nothing is known to send.
export const WidgetReplyContext = createContext<WidgetReply>({ answered: false, chosen: new Set(), sending: new Set() });

// CopilotKit writes a press as «<userMessage or label>», then a blank line and «key: value» lines (buildActionMessageText).
export const replyHead = (reply: string): string => reply.split(/\n\s*\n/)[0]!.trim();

// A press that sends a message: an event (a function call such as openUrl acts in place).
const eventOf = (binding: unknown): Record<string, unknown> | null => (isObject(binding) && isObject(binding.event) ? binding.event : null);
const userMessageOf = (binding: unknown): string | null => {
  const message = eventOf(binding)?.userMessage;
  return typeof message === 'string' ? message.trim() : null;
};
const wordsOf = (component: Op): string | null => (typeof component.label === 'string' ? component.label : typeof component.text === 'string' ? component.text : null);

// A control that sends: its words on the screen, the first line of the message it sends, and which it is — the screen,
// the component, the place among the component's own (a change of a screen in place sends the same component again).
interface Control {
  words: string;
  head: string;
  key: string;
}

function componentsOf(operations: readonly Op[]): Map<string, Op> {
  const components = new Map<string, Op>();
  for (const op of operations) {
    const body = isObject(op.createSurface) ? op.createSurface : isObject(op.updateComponents) ? op.updateComponents : null;
    if (!body || !Array.isArray(body.components)) continue;
    for (const component of body.components) if (isObject(component) && typeof component.id === 'string') components.set(component.id, component);
  }
  return components;
}

export function sendingControls(operations: readonly Op[]): Control[] {
  const components = componentsOf(operations);
  const first = operations[0];
  const body = first ? (isObject(first.createSurface) ? first.createSurface : isObject(first.updateComponents) ? first.updateComponents : isObject(first.updateDataModel) ? first.updateDataModel : null) : null;
  const surface = body && typeof body.surfaceId === 'string' ? body.surfaceId : '';
  const submitsIn = (id: string, seen = new Set<string>()): Op[] => {
    const component = components.get(id);
    if (!component || seen.has(id)) return [];
    seen.add(id);
    const listed: unknown[] = Array.isArray(component.children) ? component.children : [];
    const children = [component.child, ...listed].filter((c): c is string => typeof c === 'string');
    return [...(component.submit === true ? [component] : []), ...children.flatMap((child) => submitsIn(child, seen))];
  };
  const controls: Control[] = [];
  for (const [id, component] of components) {
    const words = wordsOf(component);
    const key = (n: number) => `${surface}|${id}|${n}`;
    if (component.component === 'Button' && words && eventOf(component.onClick)) controls.push({ words, head: userMessageOf(component.onClick) ?? words, key: key(0) });
    if (component.component === 'Form' && eventOf(component.onSubmit)) {
      submitsIn(id).forEach((submit, n) => {
        const label = wordsOf(submit);
        if (label) controls.push({ words: label, head: userMessageOf(component.onSubmit) ?? label, key: key(n) });
      });
    }
    if (component.component === 'EntityCard' && eventOf(component.onAction) && Array.isArray(component.actions)) {
      component.actions.forEach((action: unknown, n) => {
        if (!isObject(action) || typeof action.label !== 'string' || typeof action.href === 'string') return;
        controls.push({ words: action.label, head: userMessageOf(component.onAction) ?? action.label, key: key(n) });
      });
    }
    if (component.component === 'FollowUp' && Array.isArray(component.items)) {
      component.items.forEach((item: unknown, n) => {
        const label = typeof item === 'string' ? item : isObject(item) && typeof item.label === 'string' ? item.label : null;
        if (!label) return;
        const message = isObject(item) && typeof item.message === 'string' ? item.message : label;
        controls.push({ words: label, head: userMessageOf(component.onFollowUp) ?? message.trim(), key: key(n) });
      });
    }
  }
  return controls;
}

// The answer to a widget: `own` — its operations, `screens` — the operations of every screen of the same answer
// (its own among them), `reply` — the person's next message or null.
export function widgetReply(own: readonly Op[], screens: readonly (readonly Op[])[], reply: string | null): WidgetReply {
  const mine = sendingControls(own);
  const sending = new Set(mine.map((c) => c.words));
  if (reply === null) return { answered: false, chosen: new Set(), sending };
  const head = replyHead(reply);
  const everywhere = new Set(screens.flatMap((ops) => sendingControls(ops)).filter((c) => c.head === head).map((c) => c.key));
  const here = mine.filter((c) => c.head === head);
  return { answered: true, chosen: new Set(everywhere.size === 1 && here.length === 1 ? [here[0]!.words] : []), sending };
}

// The messages of the agent as CopilotKit holds them.
interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}
interface Held {
  role: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  content?: unknown;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// The screens shown in the answer that drew the call `callId`: between the person's message before it and the next.
export function screensOfAnswer(messages: readonly Message[], callId: string): Op[][] {
  const held = messages as readonly Held[];
  const at = held.findIndex((m) => m.role === 'assistant' && (m.toolCalls ?? []).some((c) => c.id === callId));
  if (at < 0) return [];
  let from = at;
  while (from > 0 && held[from - 1]!.role !== 'user') from--;
  let to = at;
  while (to < held.length - 1 && held[to + 1]!.role !== 'user') to++;
  const turn = held.slice(from, to + 1);
  const shown = new Set(turn.filter((m) => m.role === 'tool' && typeof m.content === 'string' && (parse(m.content) as { shown?: unknown } | null)?.shown === true).map((m) => m.toolCallId));
  return turn
    .flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []))
    .filter((c) => c.function.name === WIDGET_TOOL.render && shown.has(c.id))
    .map((c) => operationsOf(parse(c.function.arguments)));
}
