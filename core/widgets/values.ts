// The values of a screen computed as the browser computes them when it first shows the screen (spec, section 8.31):
// `${…}` of formatString, calc and every other function, by CopilotKit's own code, with the screen's initial data.
// A value that fails here fails in the browser too, and the person sees «this part could not be displayed» in place
// of it — an e2e screen with a `${…}` inside `${…}` passed the other checks and broke so (20.11).
// The components drawn per item of a template list are left out: their paths are of an item, not of the whole data.
import { containsDynamicValue, tryResolveDynamicValue } from '@copilotkit/core/generative-ui';

type Component = Record<string, unknown>;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// A JSON pointer as A2UI writes it: «/deals/0/name»; «~1» is «/», «~0» is «~».
const segments = (path: string): string[] =>
  path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));

function read(data: unknown, path: string): unknown {
  let at: unknown = data;
  for (const key of segments(path)) {
    if (Array.isArray(at)) at = at[Number(key)];
    else if (isObject(at)) at = at[key];
    else return undefined;
  }
  return at;
}

// The data after an `updateDataModel` of `path` with `value`; the root path replaces the whole data.
export function changedData(data: unknown, path: unknown, value: unknown): unknown {
  const keys = typeof path === 'string' ? segments(path) : [];
  if (keys.length === 0) return value;
  const [head, ...rest] = keys as [string, ...string[]];
  const base: Record<string, unknown> | unknown[] = Array.isArray(data) ? [...(data as unknown[])] : isObject(data) ? { ...data } : {};
  const inner = Array.isArray(base) ? base[Number(head)] : base[head];
  const next = rest.length === 0 ? value : changedData(inner, `/${rest.join('/')}`, value);
  if (Array.isArray(base)) base[Number(head)] = next;
  else base[head] = next;
  return base;
}

// The ids of template components (`{ componentId, path }` in a component's props) and of everything inside them.
function perItem(components: ReadonlyMap<string, Component>, childrenOf: (component: Component) => Set<string>): Set<string> {
  const out = new Set<string>();
  const templatesIn = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(templatesIn);
    if (!isObject(value) || '@call' in value || '@path' in value) return;
    if (typeof value.componentId === 'string' && typeof value.path === 'string') out.add(value.componentId);
    Object.values(value).forEach(templatesIn);
  };
  for (const component of components.values()) templatesIn(component);
  const queue = [...out];
  while (queue.length > 0) {
    const component = components.get(queue.pop()!);
    if (!component) continue;
    for (const child of childrenOf(component)) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

const OWN_KEYS = new Set(['id', 'component']);

export function valueProblems(components: ReadonlyMap<string, Component>, data: unknown, childrenOf: (component: Component) => Set<string>): string[] {
  const skipped = perItem(components, childrenOf);
  const reader = { get: (path: string) => read(data, path) };
  const problems: string[] = [];
  for (const [id, component] of components) {
    if (skipped.has(id)) continue;
    for (const [key, value] of Object.entries(component)) {
      if (OWN_KEYS.has(key) || !containsDynamicValue(value)) continue;
      const attempt = tryResolveDynamicValue(value, { data: reader, basePath: undefined }, key === 'checks' ? { isChecks: true } : {});
      if (!attempt.ok) problems.push(`компонент «${id}», поле «${key}»: ${attempt.error.message}`);
    }
  }
  return problems;
}
