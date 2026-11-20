// The person's answer to a widget (spec, section 8.31): as with a choice of the chat (owner's list 16.11), the control
// the person pressed stays set apart by colour and a tick, and once the person answered — by a press or in their own
// words — the controls that send are inactive; what works in place (sliders, fields, tabs) keeps working. The answer is
// the first message of the person after the answer that drew the widget (web/src/genui/answer.ts), so the mark is there
// again after a reload.
import { createContext } from 'react';

type Op = Record<string, unknown>;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface WidgetReply {
  answered: boolean;
  // The words on the controls that sent the answer.
  chosen: ReadonlySet<string>;
}

// Outside a block of a widget (a test of one component) nothing was answered.
export const WidgetReplyContext = createContext<WidgetReply>({ answered: false, chosen: new Set() });

// CopilotKit writes a press as «<userMessage or label>», then a blank line and «key: value» lines (buildActionMessageText).
export const replyHead = (reply: string): string => reply.split(/\n\s*\n/)[0]!.trim();

const textOf = (component: Op): string | null => (typeof component.label === 'string' ? component.label : typeof component.text === 'string' ? component.text : null);
const userMessageOf = (binding: unknown): string | null => {
  const event = isObject(binding) && isObject(binding.event) ? binding.event : null;
  return event && typeof event.userMessage === 'string' ? event.userMessage.trim() : null;
};

// The words of the controls whose press sent `head`: the control's own words, a button whose message differs from its
// label, and the submit button of a form whose message it is.
export function chosenWords(operations: readonly Op[], head: string): Set<string> {
  const components = new Map<string, Op>();
  for (const op of operations) {
    const body = isObject(op.createSurface) ? op.createSurface : isObject(op.updateComponents) ? op.updateComponents : null;
    if (!body || !Array.isArray(body.components)) continue;
    for (const component of body.components) if (isObject(component) && typeof component.id === 'string') components.set(component.id, component);
  }
  const chosen = new Set([head]);
  const submitsIn = (id: string, seen = new Set<string>()): Op[] => {
    const component = components.get(id);
    if (!component || seen.has(id)) return [];
    seen.add(id);
    const listed: unknown[] = Array.isArray(component.children) ? component.children : [];
    const children = [component.child, ...listed].filter((c): c is string => typeof c === 'string');
    return [...(component.submit === true ? [component] : []), ...children.flatMap((child) => submitsIn(child, seen))];
  };
  for (const [id, component] of components) {
    if (userMessageOf(component.onClick) === head) {
      const words = textOf(component);
      if (words) chosen.add(words);
    }
    if (userMessageOf(component.onSubmit) === head) {
      for (const submit of submitsIn(id)) {
        const words = textOf(submit);
        if (words) chosen.add(words);
      }
    }
  }
  return chosen;
}
