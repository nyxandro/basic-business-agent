// A screen through CopilotKit's own manager of surfaces — the code that keeps it in the browser (spec, section 8.31).
// `validateOperation` checks the names of the props only; the manager checks their values against the components'
// schemas and drops an operation that does not pass, without a word on the screen. A row of key figures with
// `wrap: true` vanished so (owner 20.11). The server gives the screen to a manager of its own, the way the browser
// gives it (web/src/widgets/operations.ts: one component per operation, createSurface with its first component), and
// every operation the manager drops is a reason to refuse.
import { WIDGET_CATALOG_ID, WIDGET_CHAT_TARGET } from '@bba/contracts';
import { GenerativeUISurfaceManager } from '@copilotkit/core/generative-ui';

type Op = Record<string, unknown>;
type Body = Record<string, unknown>;
type Ui = ConstructorParameters<typeof GenerativeUISurfaceManager>[0];

const VERSION = '1.0';
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const componentsOf = (body: Body): Op[] => (Array.isArray(body.components) ? body.components.filter(isObject) : []);

// The operations one component each, as the browser gives them to its manager.
function oneByOne(operations: readonly Op[]): Op[] {
  const out: Op[] = [];
  let waiting: Body | null = null;
  let held: Op[] = [];
  for (const op of operations) {
    if (isObject(op.updateDataModel)) {
      if (waiting) held.push(op);
      else out.push(op);
      continue;
    }
    const kind = isObject(op.createSurface) ? 'createSurface' : isObject(op.updateComponents) ? 'updateComponents' : null;
    if (!kind) {
      out.push(op);
      continue;
    }
    const body = op[kind] as Body;
    if (kind === 'createSurface') {
      const { components: _components, ...rest } = body;
      waiting = rest;
    }
    for (const component of componentsOf(body)) {
      if (waiting) {
        out.push({ version: VERSION, createSurface: { ...waiting, components: [component] } }, ...held);
        waiting = null;
        held = [];
      } else {
        out.push({ version: VERSION, updateComponents: { surfaceId: body.surfaceId, components: [component] } });
      }
    }
  }
  return out;
}

// What the manager drops of a screen: `before` — the screen as shown earlier in this run, when the call changes it.
export function engineProblems(ui: Ui, surfaceId: string, operations: readonly Op[], before: { components: Iterable<Op>; data: unknown } | undefined): string[] {
  const reasons: string[] = [];
  const manager = new GenerativeUISurfaceManager(ui, { onOperationRejected: ({ reason }) => reasons.push(reason) });
  const shown = before ? [{ version: VERSION, createSurface: { surfaceId, ...(isObject(before.data) ? { dataModel: before.data } : {}), components: [...before.components] } }] : [];
  manager.ingest('check', undefined, { surfaceId, target: WIDGET_CHAT_TARGET, catalogId: WIDGET_CATALOG_ID, operations: oneByOne([...shown, ...operations]) as Parameters<GenerativeUISurfaceManager['ingest']>[2]['operations'], status: 'ready', rejected: [] });
  return [...new Set(reasons)].map((reason) => `браузер не покажет: ${reason}`);
}
