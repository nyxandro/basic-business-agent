// The person's answer to a widget (spec, section 8.31): as with a choice of the chat (owner's list 16.11), the control
// the person pressed stays set apart by colour and a tick, and once the person answered — by a press or in their own
// words — the controls that send are inactive; what works in place (sliders, fields, tabs, links) keeps working. The
// answer is the first message of the person after the answer that drew the widget (web/src/genui/answer.ts).
// Which control sent it is read from the message, so the mark is there again after a reload — only when one control of
// the whole answer sends those words: three plan cards with «Выбрать» send the same message, and a tick on all three
// would be a lie (review 20.11). A control pressed in this window knows it was pressed (its own state).
import { WIDGET_TOOL } from '@bba/contracts';
import type { Message } from '@copilotkit/react-core';
import { createContext } from 'react';
import { isShownResult, operationsOfCall, type HeldMessage } from './calls.ts';

type Op = Record<string, unknown>;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface WidgetReply {
  answered: boolean;
  // The words of the control that sent the answer, when one control of the answer sends that message.
  chosen: ReadonlySet<string>;
  // The words of the controls of this widget that send a message.
  sending: ReadonlySet<string>;
  // A list of this widget sends with words that come from its data (a template of items, items bound to a path): the
  // words are known only on the screen, so its items count as sending.
  sendsUnnamed: boolean;
  // The words of the list items whose words the screen itself names (not from the data): they never count as unnamed.
  namedWords: ReadonlySet<string>;
}

// Outside a block of a widget (a test of one component) nothing was answered and nothing is known to send.
export const WidgetReplyContext = createContext<WidgetReply>({ answered: false, chosen: new Set(), sending: new Set(), sendsUnnamed: false, namedWords: new Set() });

// CopilotKit writes a press as «<userMessage or label>», then a blank line and «key: value» lines (buildActionMessageText).
export const replyHead = (reply: string): string => reply.split(/\n\s*\n/)[0]!.trim();

// A press that sends a message: an event (a function call such as openUrl acts in place).
const eventOf = (binding: unknown): Record<string, unknown> | null => (isObject(binding) && isObject(binding.event) ? binding.event : null);
const userMessageOf = (binding: unknown): string | null => {
  const message = eventOf(binding)?.userMessage;
  return typeof message === 'string' ? message.trim() : null;
};
const wordsOf = (component: Op): string | null => (typeof component.label === 'string' ? component.label : typeof component.text === 'string' ? component.text : null);
// The first line CopilotKit writes for a pick (buildActionMessageText): `userMessage`, else the «message» or «label» of
// the event's context, else the words of the item.
const pickHeadOf = (binding: unknown, words: string): string => {
  const event = eventOf(binding);
  const context = event && isObject(event.context) ? event.context : {};
  const head = [event?.userMessage, context.message, context.label].find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return head?.trim() ?? words;
};
const itemLabelOf = (item: unknown): string | null => (typeof item === 'string' ? item : isObject(item) && typeof item.label === 'string' ? item.label : null);

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

// A list with a pick whose words come from its data: a ListItem with words bound to a path, a List of bound items.
export function sendsUnnamed(operations: readonly Op[]): boolean {
  for (const component of componentsOf(operations).values()) {
    if (component.component === 'ListItem' && eventOf(component.action) && wordsOf(component) === null) return true;
    // Items bound to a path; a List of children carries its picks on the children (ListItem).
    if (component.component === 'List' && eventOf(component.action) && component.items !== undefined && !Array.isArray(component.items)) return true;
  }
  return false;
}

// The words of list items the screen names itself.
function namedItemWords(operations: readonly Op[]): Set<string> {
  const out = new Set<string>();
  for (const component of componentsOf(operations).values()) {
    if (component.component !== 'ListItem') continue;
    const words = wordsOf(component);
    if (words !== null) out.add(words);
  }
  return out;
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
    // A pick of a list (issue #23): a ListItem sends its own words, a List the label of the picked item.
    if (component.component === 'ListItem' && words && eventOf(component.action)) controls.push({ words, head: pickHeadOf(component.action, words), key: key(0) });
    if (component.component === 'List' && eventOf(component.action) && Array.isArray(component.items)) {
      component.items.forEach((item: unknown, n) => {
        const label = itemLabelOf(item);
        if (label) controls.push({ words: label, head: pickHeadOf(component.action, label), key: key(n) });
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
  const unnamed = sendsUnnamed(own);
  const namedWords = namedItemWords(own);
  if (reply === null) return { answered: false, chosen: new Set(), sending, sendsUnnamed: unnamed, namedWords };
  const head = replyHead(reply);
  const everywhere = new Set(screens.flatMap((ops) => sendingControls(ops)).filter((c) => c.head === head).map((c) => c.key));
  const here = mine.filter((c) => c.head === head);
  return { answered: true, chosen: new Set(everywhere.size === 1 && here.length === 1 ? [here[0]!.words] : []), sending, sendsUnnamed: unnamed, namedWords };
}

// The screens shown in the answer that drew the call `callId`: between the person's message before it and the next.
export function screensOfAnswer(messages: readonly Message[], callId: string): Op[][] {
  const held = messages as readonly HeldMessage[];
  const at = held.findIndex((m) => m.role === 'assistant' && (m.toolCalls ?? []).some((c) => c.id === callId));
  if (at < 0) return [];
  let from = at;
  while (from > 0 && held[from - 1]!.role !== 'user') from--;
  let to = at;
  while (to < held.length - 1 && held[to + 1]!.role !== 'user') to++;
  const turn = held.slice(from, to + 1);
  const shown = new Set(turn.filter((m) => m.role === 'tool' && isShownResult(m)).map((m) => m.toolCallId));
  return turn
    .flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []))
    .filter((c) => c.function.name === WIDGET_TOOL.render && shown.has(c.id))
    .map(operationsOfCall);
}
