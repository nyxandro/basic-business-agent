// The architecture rules of the repository (spec, section 17.2), as dependency-cruiser rules.
// Paths are relative to the repository root. Every rule explains in `comment` why it exists and
// what to do instead; the CLI prints it next to each violation.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IRegularForbiddenRuleType } from 'dependency-cruiser';

// The installation zone: what a customer's copy changes (AGENTS.md, «Где что лежит»).
const INSTALL = 'agents|config|custom|workflows|skills';
const TEST_FILE = '\\.test\\.tsx?$';

// Modules every other module stands on. They import only each other, so the base never grows
// business logic and never joins a circle of modules.
export const FOUNDATION_MODULES = ['audit', 'config', 'crypto', 'db', 'errors', 'log', 'net', 'run-context', 'workspace'];
const FOUNDATION = `^core/(${FOUNDATION_MODULES.join('|')})/`;

// The base of the interface: texts, calls to the server and shared components. Every screen stands on them.
export const WEB_BASE_FOLDERS = ['api', 'i18n', 'ui'];
const WEB_BASE = `^web/src/(${WEB_BASE_FOLDERS.join('|')})/`;

// Every rule of ours has a name and says why: the CLI prints both next to a violation.
export type ArchitectureRule = IRegularForbiddenRuleType & { name: string; comment: string };

const forbid = (name: string, comment: string, from: ArchitectureRule['from'], to: ArchitectureRule['to']): ArchitectureRule => ({
  name,
  comment,
  severity: 'error',
  from,
  to,
});

// Plugins named in `dependsOn: [...]` of plugins/<name>/plugin.ts (a literal list, read as text).
function declaredDependencies(root: string, plugin: string): string[] {
  const file = join(root, 'plugins', plugin, 'plugin.ts');
  if (!existsSync(file)) return [];
  const list = /dependsOn:\s*\[([^\]]*)\]/.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
  return [...list.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

function pluginRules(root: string): ArchitectureRule[] {
  const dir = join(root, 'plugins');
  if (!existsSync(dir)) return [];
  const plugins = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  return plugins.map((plugin) => {
    const deps = declaredDependencies(root, plugin);
    return forbid(
      `plugins-${plugin}-dependencies`,
      `plugins/${plugin} may import another plugin only through the public/ part of a plugin named in dependsOn of its plugin.ts` +
        ` (now: ${deps.length > 0 ? deps.join(', ') : 'none'}).`,
      { path: `^plugins/${plugin}/` },
      { path: '^plugins/', pathNot: [`^plugins/${plugin}/`, ...deps.map((d) => `^plugins/${d}/public/`)] },
    );
  });
}

export function architectureRules(root: string): ArchitectureRule[] {
  return [
    forbid(
      'core-not-into-zones',
      'core/ is shared by every installation: it must not import plugins/, the installation zone (agents, config, custom, workflows, skills) or web/.',
      { path: '^core/' },
      { path: `^(plugins|${INSTALL}|web)/` },
    ),
    forbid(
      'foundation-stays-foundation',
      `Foundation modules (${FOUNDATION_MODULES.join(', ')}) import only each other: everything stands on them. ` +
        'Pass what they need as a parameter, or put the code into the business module that uses it.',
      { path: FOUNDATION, pathNot: TEST_FILE },
      { path: '^core/', pathNot: FOUNDATION },
    ),
    forbid(
      'server-is-composition-root',
      'core/server/ is where the application is assembled from all modules: nothing imports it except tests, tests/ and tooling/. ' +
        'Shared code belongs to its own module (journal — core/log, HTTP helpers — core/http, access guards — core/auth).',
      { path: `^(core|plugins|${INSTALL}|contracts)/`, pathNot: ['^core/server/', TEST_FILE] },
      { path: '^core/server/' },
    ),
    forbid(
      'plugins-core-public-only',
      'A plugin uses core/ only through core/<module>/public/: the rest of core changes without notice.',
      { path: '^plugins/' },
      { path: '^core/', pathNot: '^core/[^/]+/public/' },
    ),
    forbid(
      'plugins-not-into-zones',
      'A plugin is shared by installations: it must not import the installation zone or web/.',
      { path: '^plugins/' },
      { path: `^(${INSTALL}|web)/` },
    ),
    ...pluginRules(root),
    forbid(
      'install-core-public-only',
      'The installation zone uses core/ only through core/<module>/public/.',
      { path: `^(${INSTALL})/` },
      { path: '^core/', pathNot: '^core/[^/]+/public/' },
    ),
    forbid(
      'install-plugins-public-only',
      'The installation zone uses plugins only through plugins/<name>/public/.',
      { path: `^(${INSTALL})/` },
      { path: '^plugins/', pathNot: '^plugins/[^/]+/public/' },
    ),
    forbid('install-not-into-web', 'The installation zone must not import web/.', { path: `^(${INSTALL})/` }, { path: '^web/' }),
    forbid(
      'web-only-web-and-contracts',
      'web/ talks to the server only over HTTP: it imports web/, @bba/contracts and npm packages, never server code.',
      { path: '^web/' },
      { path: `^(core|plugins|${INSTALL})/` },
    ),
    forbid(
      'web-base-stays-base',
      `Base folders of web (${WEB_BASE_FOLDERS.map((f) => `web/src/${f}`).join(', ')}) import code only from each other: every screen stands on them. ` +
        'Move what they need into a base folder, or pass it as a parameter. A type of another folder may be imported (import type): it loads no code.',
      { path: WEB_BASE, pathNot: TEST_FILE },
      { path: '^web/src/', pathNot: WEB_BASE, dependencyTypesNot: ['type-only'] },
    ),
    forbid(
      'contracts-self-contained',
      'contracts/ is shared by the server and web: it imports nothing else of the repository.',
      { path: '^contracts/' },
      { path: `^(core|plugins|${INSTALL}|web)/` },
    ),
  ];
}

// Rules dependency-cruiser cannot express; tooling/architecture/check.ts computes them over its graph.
// Run-time imports only: an `import type` disappears when the code runs and makes no circle.
export const COMPUTED_RULES = {
  'no-circular':
    'Files import each other in a circle at run time: the value read first may still be empty when the server or the page starts, ' +
    'and no file of the circle can be changed alone. Move what both need into a third file. Imports of types only do not count.',
  'no-circular-modules':
    'Modules of core (core/<module>) or folders of web (web/src/<folder>) import each other in a circle at run time, directly or through others: ' +
    'none of them can be understood or changed alone. Each module has its level and imports only modules below it: move what a lower module ' +
    'needs from a higher one down (into its own or a new module), or let the higher one pass it as a parameter. ' +
    'Imports of types only, tests and test helpers (test-*.ts, test/) do not count.',
  'unresolved-local-import':
    'A local import leads to no file, so no rule can check where it goes. Fix the path (with its extension) or remove the import.',
} as const;
