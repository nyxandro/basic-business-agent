// Checks the architecture of the repository (spec, section 17.2): dependency-cruiser builds the
// import graph and applies the rules of rules.ts; over its graph we compute what its rules cannot
// express — circles of run-time imports, core modules importing each other, imports leading nowhere.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cruise, type ICruiseResult, type IDependency } from 'dependency-cruiser';
import { architectureRules, type COMPUTED_RULES } from './rules.ts';

export interface Violation {
  rule: string;
  from: string;
  to: string;
  // The circle for a circular import; one file of each direction for mutual modules.
  detail?: string;
}

// Folders with our code. inbox/, docs/ and data folders are never read.
const SCANNED_DIRS = ['core', 'plugins', 'agents', 'config', 'custom', 'workflows', 'skills', 'web', 'contracts', 'tooling', 'tests'];
const EXCLUDED = ['(^|/)node_modules/', '(^|/)(dist|coverage)/'];
// Files that stay in the graph, so imports into them are checked, but whose own imports are not read:
// Anthropic's skills kept exactly as published (spec, section 8.18) and sample servers of the MCP runner.
const NOT_FOLLOWED = ['node_modules', '^core/system-skills/', '^core/mcp-runner/fixtures/'];
// How imports resolve: our files are imported with their extension, packages through `exports`
// of their package.json (@bba/contracts -> contracts/src/index.ts).
const RESOLVE = {
  exportsFields: ['exports'],
  conditionNames: ['import', 'require', 'node', 'default', 'types'],
  extensions: ['.ts', '.tsx', '.mts', '.js', '.mjs', '.d.ts'],
};

const CORE_MODULE = /^core\/([^/]+)\//;
const TEST_FILE = /\.test\.tsx?$/;

type ComputedRule = keyof typeof COMPUTED_RULES;
const violation = (rule: ComputedRule, from: string, to: string, detail?: string): Violation => ({ rule, from, to, ...(detail ? { detail } : {}) });

// `import type` (and an import used only for types) is gone when the code runs.
const isRunTime = (d: IDependency) => !d.couldNotResolve && !d.dependencyTypes.includes('type-only') && d.preCompilationOnly !== true;

// file -> files it imports at run time, in the order dependency-cruiser lists them.
function runTimeGraph(result: ICruiseResult): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const m of result.modules) graph.set(m.source, [...new Set(m.dependencies.filter(isRunTime).map((d) => d.resolved))]);
  return graph;
}

// Groups of files that reach each other (Tarjan); every group of two or more files, or a file importing itself, holds a circle.
function circularGroups(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  let next = 0;
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const group: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      group.push(w);
    } while (w !== v);
    if (group.length > 1 || (graph.get(v) ?? []).includes(v)) groups.push(group);
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return groups;
}

// The shortest circle through the first file of the group (by name), as `start -> … -> start`.
function circleOf(group: string[], graph: Map<string, string[]>): string[] {
  const members = new Set(group);
  const start = [...group].sort()[0]!;
  const cameFrom = new Map<string, string>();
  const queue = [start];
  while (queue.length > 0) {
    const v = queue.shift()!;
    for (const w of graph.get(v) ?? []) {
      if (!members.has(w)) continue;
      if (w === start) {
        const path = [start];
        for (let at = v; at !== start; at = cameFrom.get(at)!) path.unshift(at);
        return [start, ...path];
      }
      if (!cameFrom.has(w)) {
        cameFrom.set(w, v);
        queue.push(w);
      }
    }
  }
  throw new Error(`APP_ARCH_CHECK_FAILED: no circle found inside the circular group of ${start}`);
}

function circles(graph: Map<string, string[]>): Violation[] {
  return circularGroups(graph).map((group) => {
    const circle = circleOf(group, graph);
    // As dependency-cruiser shows a circle: the arrow, then the way from its end back to its start.
    return violation('no-circular', circle[0]!, circle[1]!, circle.slice(1).join(' -> '));
  });
}

function mutualModules(graph: Map<string, string[]>): Violation[] {
  // `a>b` -> the first run-time import from module a to module b, as "file -> file".
  const edges = new Map<string, string>();
  for (const [source, targets] of graph) {
    const from = CORE_MODULE.exec(source)?.[1];
    if (!from || TEST_FILE.test(source)) continue;
    for (const target of targets) {
      const to = CORE_MODULE.exec(target)?.[1];
      if (!to || to === from) continue;
      const key = `${from}>${to}`;
      if (!edges.has(key)) edges.set(key, `${source} -> ${target}`);
    }
  }
  const pairs: Violation[] = [];
  for (const [key, example] of edges) {
    const [from, to] = key.split('>') as [string, string];
    const back = edges.get(`${to}>${from}`);
    if (back && from < to) pairs.push(violation('core-no-mutual-modules', `core/${from}`, `core/${to}`, `${example}; ${back}`));
  }
  return pairs;
}

function unresolvedLocalImports(result: ICruiseResult): Violation[] {
  return result.modules.flatMap((m) =>
    m.dependencies.filter((d) => d.couldNotResolve && d.module.startsWith('.')).map((d) => violation('unresolved-local-import', m.source, d.module)),
  );
}

export async function checkArchitecture(root: string): Promise<Violation[]> {
  const dirs = SCANNED_DIRS.filter((d) => existsSync(join(root, d)));
  const { output } = await cruise(
    dirs,
    {
      baseDir: root,
      validate: true,
      ruleSet: { forbidden: architectureRules(root) },
      // Tells `import type` apart: such imports disappear at run time and make no circle.
      tsPreCompilationDeps: true,
      doNotFollow: { path: NOT_FOLLOWED },
      exclude: { path: EXCLUDED },
    },
    RESOLVE,
  );
  if (typeof output === 'string') throw new Error('APP_ARCH_CHECK_FAILED: dependency-cruiser returned text instead of its result object');
  const graph = runTimeGraph(output);
  const violations: Violation[] = [
    ...output.summary.violations.map((v) => ({ rule: v.rule.name, from: v.from, to: v.to })),
    ...circles(graph),
    ...mutualModules(graph),
    ...unresolvedLocalImports(output),
  ];
  return violations.sort((a, b) => a.rule.localeCompare(b.rule) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}
