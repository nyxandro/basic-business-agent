// The catalog of widgets on the server (spec, section 8.31): CopilotKit's standard declarations of the 43 components
// of contracts/src/widgets.ts, without React. The descriptions for the model and the check of a screen come from it,
// never from the browser: the browser builds the same catalog from `standardUI` (a test compares the two).
import { WIDGET_CATALOG_ID, WIDGET_CHAT_TARGET, WIDGET_COMPONENTS, WIDGET_OMITTED } from '@bba/contracts';
import { buildCatalogManifest } from '@copilotkit/core/generative-ui';
import { A2UI_CHILD_LIST_REF, A2UI_COMPONENT_ID_REF, buildGenerativeUIPrompt, createGenerativeUI, standardDeclarations, STANDARD_CATALOG_ID, validateOperation, withComponents, withStandardParameterOrder } from '@copilotkit/shared/generative-ui';
import { changedData, valueProblems } from './values.ts';

type Manifest = ReturnType<typeof buildCatalogManifest>;

// The server never draws: each component needs a value only so that CopilotKit builds the catalog.
const NO_COMPONENT = (): null => null;

function buildManifest(): Manifest {
  const names = Object.keys(standardDeclarations) as (keyof typeof standardDeclarations)[];
  const missing = WIDGET_COMPONENTS.filter((name) => !(name in standardDeclarations));
  if (missing.length > 0) throw new Error(`APP_CONFIG_INVALID: CopilotKit has no standard components ${missing.join(', ')}`);
  const components = Object.fromEntries(names.map((name) => [name, NO_COMPONENT])) as Record<keyof typeof standardDeclarations, typeof NO_COMPONENT>;
  // The same shape as the browser's catalog (web/src/widgets/catalog.ts): CopilotKit's standard catalog without the
  // components the agent does not get, and ours on top of it — so a screen may name either catalog.
  const standard = createGenerativeUI({ id: STANDARD_CATALOG_ID, components: withComponents(withStandardParameterOrder(standardDeclarations), components) });
  return buildCatalogManifest(createGenerativeUI({ id: WIDGET_CATALOG_ID, extends: [standard.omit(WIDGET_OMITTED)], components: {} }));
}

let manifest: Manifest | null = null;
export function widgetManifest(): Manifest {
  manifest ??= buildManifest();
  return manifest;
}

const firstSentence = (text: string): string => /^.*?[.!?](?=\s|$)/.exec(text.trim())?.[0] ?? text.trim();

// One line per component, in the order of the list: what the model sees in every request.
export function componentIndex(): string {
  const { components } = widgetManifest();
  return WIDGET_COMPONENTS.map((name) => `- ${name}: ${firstSentence(components[name]?.description ?? '')}`).join('\n');
}

// The full description of the named components and the rules of writing a screen, made by CopilotKit's own guide
// for a catalog of only these components.
// CopilotKit's guide tells the model to «stream progressively … then send one updateComponents operation per child»;
// the model took it for a call per part, and our server checks each call as a whole screen (M11, 20.11). Our line
// before the guide says where the operations go; streaming within the one call stays (the browser draws as it comes).
const ONE_CALL =
  'У нас все операции экрана — в одном вызове render_ui: operations — массив объектов (не строка), в нём createSurface и сразу за ним все updateComponents. Экран частями по разным вызовам не собирается — сервер проверяет каждый вызов как целый экран. Ниже — описание CopilotKit.';

export function componentsGuide(names: readonly string[]): string {
  const full = widgetManifest();
  const components = Object.fromEntries(names.map((name) => [name, full.components[name]!]));
  return `${ONE_CALL}\n\n${buildGenerativeUIPrompt({ ...full, components, targets: [{ id: WIDGET_CHAT_TARGET, kind: 'chat' }], surfaces: {} })}`;
}

export const unknownComponents = (names: readonly string[]): string[] => names.filter((name) => !(WIDGET_COMPONENTS as readonly string[]).includes(name));

// The problems of a screen are given to the model by the number of the operation (from 1).
const PROBLEMS_SHOWN = 10;
const ALLOWED_KINDS = ['createSurface', 'updateComponents', 'updateDataModel'] as const;
type Op = Record<string, unknown>;

const kindOf = (op: Op): string | undefined => ALLOWED_KINDS.find((kind) => kind in op) ?? Object.keys(op).find((key) => key !== 'version');

// An operation is { version, <kind>: { surfaceId, … } }. A model wrote a change as its bare body (M11, 20.11); the
// reason shows the shape rather than naming the first key of the body as an unknown kind.
const OPERATION_SHAPE =
  'каждая операция пишется так: { "version": "1.0", "createSurface": { "surfaceId": …, "components": […] } }, { "version": "1.0", "updateComponents": { "surfaceId": …, "components": […] } } или { "version": "1.0", "updateDataModel": { "surfaceId": …, "path": …, "value": … } }';
const BODY_KEYS = ['surfaceId', 'components', 'path', 'value', 'dataModel'];

function kindProblem(n: number, kind: string | undefined): string | null {
  if (kind && (ALLOWED_KINDS as readonly string[]).includes(kind)) return null;
  if (!kind || BODY_KEYS.includes(kind)) return `операция ${n}: нет вида операции — ${OPERATION_SHAPE}`;
  return `операция ${n}: ${kind} — на экране только createSurface, updateComponents, updateDataModel`;
}
const bodyOf = (op: Op, kind: string | undefined): Record<string, unknown> => {
  const body = kind ? op[kind] : undefined;
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
};
const componentsOf = (body: Record<string, unknown>): Record<string, unknown>[] => (Array.isArray(body.components) ? body.components.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object') : []);

// The ids of the components one component draws inside it: its slots (`child`, `children`, …) and the props whose
// schema refers to a component (the panels of `Tabs`). A list may be a template (`{ componentId, path }`).
type Schema = { $ref?: string; type?: unknown; properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[] };

function listIds(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) if (typeof v === 'string') out.add(v);
    return;
  }
  const template = value && typeof value === 'object' ? (value as { componentId?: unknown }).componentId : undefined;
  if (typeof template === 'string') out.add(template);
}

function refIds(schema: Schema | undefined, value: unknown, out: Set<string>): void {
  if (!schema || value === undefined || value === null) return;
  if (schema.$ref === A2UI_COMPONENT_ID_REF || schema.$ref === A2UI_CHILD_LIST_REF) return listIds(value, out);
  if (Array.isArray(value) && schema.items) for (const item of value) refIds(schema.items, item, out);
  if (typeof value === 'object' && !Array.isArray(value) && schema.properties) for (const [key, sub] of Object.entries(schema.properties)) refIds(sub, (value as Record<string, unknown>)[key], out);
  for (const alternative of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) refIds(alternative, value, out);
}

function childIds(component: Record<string, unknown>, declared: { props?: unknown; slots?: Record<string, unknown> } | undefined): Set<string> {
  const out = new Set<string>();
  if (!declared) return out;
  for (const slot of Object.keys(declared.slots ?? {})) listIds(component[slot], out);
  refIds(declared.props as Schema | undefined, component, out);
  return out;
}

const declaredOf = (full: ReturnType<typeof widgetManifest>, component: Record<string, unknown>) => (typeof component.component === 'string' ? full.components[component.component] : undefined);

// The functions a component calls inside `${…}` of its strings.
const CALLED = /\$\{\s*([A-Za-z_][\w]*)\s*\(/g;
function functionsCalledIn(value: unknown): string[] {
  if (typeof value === 'string') return [...value.matchAll(CALLED)].map((m) => m[1]!);
  if (Array.isArray(value)) return value.flatMap(functionsCalledIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(functionsCalledIn);
  return [];
}

export type ScreenCheck = { ok: true; surfaceId: string; created: boolean } | { ok: false; problems: string[] };

// The screens shown earlier in the run, by their surfaceId: the components and the data each has now. A later call of
// the same run may change one of them in place; a screen of an earlier answer is not here, and the agent draws a new one.
export type ShownScreen = { components: Map<string, Record<string, unknown>>; data: unknown };
export type ShownScreens = Map<string, ShownScreen>;

const limited = (problems: string[]): ScreenCheck => {
  const more = problems.length - PROBLEMS_SHOWN;
  return { ok: false, problems: [...problems.slice(0, PROBLEMS_SHOWN), ...(more > 0 ? [`и ещё ${more}`] : [])] };
};

// One screen per call. A new screen begins with `createSurface`; a call that begins with `updateComponents` or
// `updateDataModel` changes a screen shown earlier in this run. Every operation is about that one screen and passes
// CopilotKit's own check against the catalog; the screen has its `root`, and every child a component names is on it.
// On success the screen goes into `shown` as it is now.
export function checkScreen(operations: readonly Op[], shown: ShownScreens): ScreenCheck {
  const full = widgetManifest();
  const first = operations[0];
  const firstKind = first ? kindOf(first) : undefined;
  if (!first) return limited(['нет операций: новый экран начинается с createSurface']);
  const wrongKind = kindProblem(1, firstKind);
  if (wrongKind) return limited([wrongKind]);
  const surfaceId = bodyOf(first, firstKind).surfaceId;
  if (typeof surfaceId !== 'string' || surfaceId === '') return limited([`операция 1: у ${firstKind} нет surfaceId`]);
  const created = firstKind === 'createSurface';
  if (created && shown.has(surfaceId)) return limited([`экран «${surfaceId}» уже показан в этом ответе: чтобы изменить его, начни вызов с updateComponents или updateDataModel для него; новый экран назови иначе`]);
  if (!created && !shown.has(surfaceId)) return limited([`экрана «${surfaceId}» в этом ответе нет: новый экран начинается с createSurface (экран прошлого ответа не меняется — нарисуй новый)`]);
  const problems: string[] = [];
  const known = new Set<string>(created ? [] : [surfaceId]);
  const before = created ? undefined : shown.get(surfaceId);
  const ids = new Map<string, Record<string, unknown>>(before?.components);
  let data: unknown = before?.data;
  operations.forEach((op, i) => {
    const n = i + 1;
    const kind = kindOf(op);
    const wrongKind = kindProblem(n, kind);
    if (wrongKind) {
      problems.push(wrongKind);
      return;
    }
    const body = bodyOf(op, kind);
    if (kind === 'createSurface' && i > 0) {
      problems.push(`операция ${n}: второй createSurface — один вызов render_ui рисует один экран`);
      return;
    }
    if (body.surfaceId !== surfaceId) {
      problems.push(`операция ${n}: surfaceId «${String(body.surfaceId)}», а экран — «${surfaceId}»`);
      return;
    }
    const verdict = validateOperation(op, { manifest: full, knownSurfaces: known, functions: full.functions });
    if (!verdict.ok) {
      problems.push(`операция ${n}: ${verdict.reason}`);
      return;
    }
    if (kind === 'createSurface') {
      known.add(surfaceId);
      data = body.dataModel;
    }
    if (kind === 'updateDataModel') data = changedData(data, body.path, body.value);
    for (const component of componentsOf(body)) if (typeof component.id === 'string') ids.set(component.id, component);
  });
  if (problems.length === 0) {
    if (!ids.has('root')) problems.push('на экране нет компонента с id «root» — с него начинается отрисовка');
    // `${fn(…)}` inside formatString runs in the browser: an unknown function would leave the part undrawn there.
    for (const [id, component] of ids) {
      const unknown = [...new Set(functionsCalledIn(component))].filter((name) => !(name in full.functions));
      if (unknown.length > 0) problems.push(`компонент «${id}»: функций ${unknown.map((u) => `«${u}»`).join(', ')} нет — в \${…} только функции из описания (${Object.keys(full.functions).join(', ')})`);
    }
    // A model sent a screen in parts, a call per few components (M11, 20.11): the first such line says how to send it.
    let partsHint = ' — весь экран — одним вызовом render_ui, все компоненты сразу, не частями';
    for (const [id, component] of ids) {
      const missing = [...childIds(component, declaredOf(full, component))].filter((child) => !ids.has(child));
      if (missing.length === 0) continue;
      problems.push(`компонент «${id}»: нет компонентов ${missing.map((m) => `«${m}»`).join(', ')}, на которые он ссылается${partsHint}`);
      partsHint = '';
    }
  }
  // Last, what the person would see at once: every value computed with the data of the screen.
  if (problems.length === 0) problems.push(...valueProblems(ids, data, (component) => childIds(component, declaredOf(full, component))));
  if (problems.length > 0) return limited(problems);
  shown.set(surfaceId, { components: ids, data });
  return { ok: true, surfaceId, created };
}
