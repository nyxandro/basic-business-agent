// Checks the architecture of the repository (spec, section 17.2): dependency-cruiser builds the
// import graph and applies the rules of rules.ts; on top of its graph we find pairs of core
// modules that import each other, which its rules cannot express.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cruise, type ICruiseResult, type IDependency } from 'dependency-cruiser';
import { architectureRules, MUTUAL_MODULES_RULE } from './rules.ts';

export interface Violation {
  rule: string;
  from: string;
  to: string;
  // The circle for a circular import; one file of each direction for mutual modules.
  detail?: string;
}

// Folders with our code. inbox/, docs/ and data folders are never read.
const SCANNED_DIRS = ['core', 'plugins', 'agents', 'config', 'custom', 'workflows', 'skills', 'web', 'contracts', 'tooling', 'tests'];
const EXCLUDED = [
  '(^|/)node_modules/',
  '(^|/)(dist|coverage)/',
  // Anthropic's skills, kept exactly as published (spec, section 8.18).
  '^core/system-skills/',
  '^core/mcp-runner/fixtures/',
];
// How imports resolve: our files are imported with their extension, packages through `exports`
// of their package.json (@bba/contracts -> contracts/src/index.ts).
const RESOLVE = {
  exportsFields: ['exports'],
  conditionNames: ['import', 'require', 'node', 'default', 'types'],
  extensions: ['.ts', '.tsx', '.mts', '.js', '.mjs', '.d.ts'],
};

const CORE_MODULE = /^core\/([^/]+)\//;
const TEST_FILE = /\.test\.tsx?$/;

const isRunTime = (d: IDependency) => !d.dependencyTypes.includes('type-only') && d.preCompilationOnly !== true;

function mutualModules(result: ICruiseResult): Violation[] {
  // `a>b` -> the first run-time import from module a to module b, as "file -> file".
  const edges = new Map<string, string>();
  for (const m of result.modules) {
    const from = CORE_MODULE.exec(m.source)?.[1];
    if (!from || TEST_FILE.test(m.source)) continue;
    for (const d of m.dependencies) {
      const to = CORE_MODULE.exec(d.resolved)?.[1];
      if (!to || to === from || !isRunTime(d)) continue;
      const key = `${from}>${to}`;
      if (!edges.has(key)) edges.set(key, `${m.source} -> ${d.resolved}`);
    }
  }
  const pairs: Violation[] = [];
  for (const [key, example] of edges) {
    const [from, to] = key.split('>') as [string, string];
    const back = edges.get(`${to}>${from}`);
    if (back && from < to) pairs.push({ rule: MUTUAL_MODULES_RULE, from: `core/${from}`, to: `core/${to}`, detail: `${example}; ${back}` });
  }
  return pairs;
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
      doNotFollow: { path: 'node_modules' },
      exclude: { path: EXCLUDED },
    },
    RESOLVE,
  );
  if (typeof output === 'string') throw new Error('APP_ARCH_CHECK_FAILED: dependency-cruiser returned text instead of its result object');
  const violations: Violation[] = output.summary.violations.map((v) => ({
    rule: v.rule.name,
    from: v.from,
    to: v.to,
    ...(v.cycle ? { detail: v.cycle.map((step) => step.name).join(' -> ') } : {}),
  }));
  violations.push(...mutualModules(output));
  return violations.sort((a, b) => a.rule.localeCompare(b.rule) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}
