// The operations of `render_ui` calls as the engine of widgets takes them (spec, section 8.31).
// - A call that begins with `createSurface` draws a screen; a later call of the same answer that begins with
//   `updateComponents` or `updateDataModel` for its surfaceId changes it in place (the server let it through only then).
// - The surface's id gets the number of the creating call: the same name in two answers makes two screens.
// - Each component comes as an operation of its own (the first inside `createSurface`, which CopilotKit wants non-empty,
//   the rest as `updateComponents` with one), so while the agent writes the call the list only grows: CopilotKit's
//   manager applies what is new and does not build the screen again from the start.
// - While a call is still written, its last component may be cut: it waits for the next one or for the end; a screen
//   whose data may still be written waits for it.
import { operationsOf, WIDGET_TOOL } from '@bba/contracts';
import { ɵparseToolCallArguments as parseToolCallArguments } from '@copilotkit/react-core';

type Op = Record<string, unknown>;
type Body = Record<string, unknown>;

export interface Drawable {
  // The surfaceId the agent wrote; null — the call does not create a screen (a change of one, or nothing yet).
  written: string | null;
  surfaceId: string | null;
  ops: Op[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const KINDS = ['createSurface', 'updateComponents', 'updateDataModel'] as const;
type Kind = (typeof KINDS)[number];

function kindOf(op: Op): Kind | null {
  return KINDS.find((kind) => isObject(op[kind])) ?? null;
}

const componentsOf = (body: Body): Record<string, unknown>[] => (Array.isArray(body.components) ? body.components.filter(isObject) : []);

// A screen is drawn only with its data whole: once the call is written, once an operation follows, or while the
// components are written when the data came before them. CopilotKit does not apply the first operation again, so data
// cut in the middle would stay on the screen (review 20.11); a screen whose data may still follow waits.
function dataIsWhole(body: Body, complete: boolean, last: boolean): boolean {
  if (complete || !last) return true;
  const keys = Object.keys(body);
  return keys.includes('dataModel') && keys.includes('components') && keys.indexOf('dataModel') < keys.indexOf('components');
}

// The operations of one call for the screen `surfaceId`, one component each. `complete` — the call is written.
// `created` — the screen exists already (the changes of later calls).
function explode(raw: readonly Op[], written: string, surfaceId: string, complete: boolean, created = false): Op[] {
  const ops: Op[] = [];
  // `createSurface` waits for its first component, with its data, and the data changes written meanwhile wait after
  // it: CopilotKit wants a component in createSurface, and a screen may get its components by a later operation.
  let waiting: Body | null = null;
  let held: Op[] = [];
  const addComponent = (component: Record<string, unknown>) => {
    if (!waiting) {
      ops.push({ version: '1.0', updateComponents: { surfaceId, components: [component] } });
      return;
    }
    ops.push({ version: '1.0', createSurface: { surfaceId, ...waiting, components: [component] } }, ...held);
    waiting = null;
    held = [];
  };
  let open = created;
  raw.forEach((op, index) => {
    const kind = kindOf(op);
    const body = kind ? (op[kind] as Body) : null;
    if (!kind || !body || body.surfaceId !== written) return;
    const last = index === raw.length - 1;
    if (kind === 'updateDataModel') {
      // A data change is drawn only when written whole.
      if (!complete && last) return;
      const change = { version: '1.0', updateDataModel: { ...body, surfaceId } };
      if (waiting) held.push(change);
      else if (open) ops.push(change);
      return;
    }
    const components = componentsOf(body);
    const ready = complete || !last ? components : components.slice(0, -1);
    if (kind === 'createSurface') {
      if (!dataIsWhole(body, complete, last)) return;
      waiting = { ...(typeof body.catalogId === 'string' ? { catalogId: body.catalogId } : {}), ...(isObject(body.dataModel) ? { dataModel: body.dataModel } : {}) };
      open = true;
    }
    if (!open) return;
    for (const component of ready) addComponent(component);
  });
  return ops;
}

export function drawableOperations(parameters: unknown, callId: string, complete: boolean): Drawable {
  const raw = operationsOf(parameters);
  const first = raw[0];
  const body = first && kindOf(first) === 'createSurface' ? (first.createSurface as Body) : null;
  if (!body || typeof body.surfaceId !== 'string' || body.surfaceId === '') return { written: null, surfaceId: null, ops: [] };
  const written = body.surfaceId;
  const surfaceId = `${written}@${callId}`;
  return { written, surfaceId, ops: explode(raw, written, surfaceId, complete) };
}

// A screen still being written is in sight from its first whole component: the engine draws it as it comes (spec,
// section 8.31; decision of the owner 21.11 — until then the live line under the answer says it is being written).
// The arguments are read the way CopilotKit reads them for the block of the call.
export function drawsWhileWritten(call: { id: string; function: { arguments: string } }): boolean {
  const drawn = drawableOperations(parseToolCallArguments(call.function.arguments, { partial: true }), call.id, false);
  return drawn.written !== null && drawn.ops.length > 0;
}

// The messages of the agent as CopilotKit holds them: assistant messages with tool calls, and their results.
interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}
interface Message {
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

const shownResult = (content: unknown): boolean => typeof content === 'string' && (parse(content) as { shown?: unknown } | null)?.shown === true;

// The changes later calls made to the screen the call `callId` drew (written `written`), for its surface `surfaceId`:
// only calls written whole whose result says the screen was shown, up to the next shown screen of the same name.
export function laterChanges(messages: readonly Message[], callId: string, written: string, surfaceId: string): Op[] {
  const calls = messages.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : [])).filter((c) => c.function.name === WIDGET_TOOL.render);
  const results = new Map(messages.filter((m) => m.role === 'tool' && typeof m.toolCallId === 'string').map((m) => [m.toolCallId!, m.content]));
  const from = calls.findIndex((c) => c.id === callId);
  if (from < 0) return [];
  const ops: Op[] = [];
  for (const call of calls.slice(from + 1)) {
    const raw = operationsOf(parse(call.function.arguments));
    const first = raw[0];
    const kind = first ? kindOf(first) : null;
    const target = kind && first ? (first[kind] as Body).surfaceId : null;
    if (target !== written || !shownResult(results.get(call.id))) continue;
    // A new screen of the same name ends this one's changes; a refused one is no screen at all.
    if (kind === 'createSurface') break;
    ops.push(...explode(raw, written, surfaceId, true, true));
  }
  return ops;
}
