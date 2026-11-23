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

const forbid = (name: string, comment: string, from: IRegularForbiddenRuleType['from'], to: IRegularForbiddenRuleType['to']): IRegularForbiddenRuleType => ({
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

function pluginRules(root: string): IRegularForbiddenRuleType[] {
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

export function architectureRules(root: string): IRegularForbiddenRuleType[] {
  return [
    forbid(
      'no-circular',
      'Files import each other in a circle: the value read first may still be empty when the server or the page starts, ' +
        'and no file of the circle can be changed alone. Move what both need into a third file. Imports of types only do not count.',
      {},
      { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    ),
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
      'contracts-self-contained',
      'contracts/ is shared by the server and web: it imports nothing else of the repository.',
      { path: '^contracts/' },
      { path: `^(core|plugins|${INSTALL}|web)/` },
    ),
  ];
}

export const MUTUAL_MODULES_RULE = 'core-no-mutual-modules';
export const MUTUAL_MODULES_COMMENT =
  'Two core modules import each other at run time: neither can be understood or changed alone, and the circle of modules tightens. ' +
  'Move what both need into a third module, or let only one of them know the other. Imports of types only and tests do not count.';
