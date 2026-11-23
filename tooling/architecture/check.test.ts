import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkArchitecture, type Violation } from './check.ts';

let root: string | undefined;

const OK = 'export const x = 1;\n';

// Every imported file must exist: the graph holds only imports that resolve to a file.
function repo(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'bba-arch-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const lines = (violations: Violation[]) => violations.map((v) => `${v.rule}: ${v.from} -> ${v.to}`);

describe('checkArchitecture: zones', () => {
  it('flags core importing a plugin', async () => {
    const r = repo({
      'core/chat/run.ts': "import { x } from './util.ts';\nimport { x as send } from '../../plugins/mail/send.ts';\nexport const y = [x, send];\n",
      'core/chat/util.ts': OK,
      'plugins/mail/send.ts': OK,
    });
    expect(lines(await checkArchitecture(r))).toEqual(['core-not-into-zones: core/chat/run.ts -> plugins/mail/send.ts']);
  });

  it('flags core importing the installation zone and web', async () => {
    const r = repo({
      'core/loader/load.ts': ['agents/sales/agent.ts', 'config/app.ts', 'custom/x.ts', 'workflows/w.ts', 'skills/s.ts', 'web/src/App.tsx']
        .map((p) => `import '../../${p}';`)
        .join('\n'),
      'agents/sales/agent.ts': OK,
      'config/app.ts': OK,
      'custom/x.ts': OK,
      'workflows/w.ts': OK,
      'skills/s.ts': OK,
      'web/src/App.tsx': OK,
    });
    expect(lines(await checkArchitecture(r))).toEqual([
      'core-not-into-zones: core/loader/load.ts -> agents/sales/agent.ts',
      'core-not-into-zones: core/loader/load.ts -> config/app.ts',
      'core-not-into-zones: core/loader/load.ts -> custom/x.ts',
      'core-not-into-zones: core/loader/load.ts -> skills/s.ts',
      'core-not-into-zones: core/loader/load.ts -> web/src/App.tsx',
      'core-not-into-zones: core/loader/load.ts -> workflows/w.ts',
    ]);
  });

  it('lets core import another core module, contracts and npm packages', async () => {
    const r = repo({
      'core/chat/run.ts': "import '../auth/session.ts';\nimport { z } from 'zod';\nimport '../../contracts/src/index.ts';\nexport const s = z;\n",
      'core/auth/session.ts': OK,
      'contracts/src/index.ts': OK,
    });
    expect(await checkArchitecture(r)).toEqual([]);
  });

  it('catches dynamic imports and re-exports', async () => {
    const r = repo({
      'core/chat/run.ts': "export { x } from '../../plugins/mail/send.ts';\nexport const m = await import('../../plugins/mail/other.ts');\n",
      'plugins/mail/send.ts': OK,
      'plugins/mail/other.ts': OK,
    });
    expect(lines(await checkArchitecture(r))).toEqual([
      'core-not-into-zones: core/chat/run.ts -> plugins/mail/other.ts',
      'core-not-into-zones: core/chat/run.ts -> plugins/mail/send.ts',
    ]);
  });

  it('lets a plugin import only the public part of core', async () => {
    const r = repo({
      'plugins/mail/tools/send.ts': [
        "import '../../../core/tools/public/index.ts';",
        "import '../../../core/tools/internal/registry.ts';",
        "import '../lib/helper.ts';",
      ].join('\n'),
      'plugins/mail/lib/helper.ts': OK,
      'core/tools/public/index.ts': OK,
      'core/tools/internal/registry.ts': OK,
    });
    expect(lines(await checkArchitecture(r))).toEqual(['plugins-core-public-only: plugins/mail/tools/send.ts -> core/tools/internal/registry.ts']);
  });

  it('forbids a plugin importing another plugin it does not declare', async () => {
    const r = repo({ 'plugins/mail/send.ts': "import '../bitrix24/public/index.ts';\n", 'plugins/bitrix24/public/index.ts': OK });
    expect(lines(await checkArchitecture(r))).toEqual(['plugins-mail-dependencies: plugins/mail/send.ts -> plugins/bitrix24/public/index.ts']);
  });

  it('lets a plugin import the public part of a plugin declared in dependsOn, and nothing else of it', async () => {
    const r = repo({
      'plugins/mail/plugin.ts': "export default { name: 'mail', dependsOn: ['bitrix24'] };\n",
      'plugins/mail/send.ts': "import '../bitrix24/public/index.ts';\nimport '../bitrix24/internal/token.ts';\n",
      'plugins/bitrix24/public/index.ts': OK,
      'plugins/bitrix24/internal/token.ts': OK,
    });
    expect(lines(await checkArchitecture(r))).toEqual(['plugins-mail-dependencies: plugins/mail/send.ts -> plugins/bitrix24/internal/token.ts']);
  });

  it('forbids a plugin importing the installation zone or web', async () => {
    const r = repo({
      'plugins/mail/send.ts': "import '../../agents/sales/agent.ts';\nimport '../../web/src/App.tsx';\n",
      'agents/sales/agent.ts': OK,
      'web/src/App.tsx': OK,
    });
    expect(lines(await checkArchitecture(r))).toEqual([
      'plugins-not-into-zones: plugins/mail/send.ts -> agents/sales/agent.ts',
      'plugins-not-into-zones: plugins/mail/send.ts -> web/src/App.tsx',
    ]);
  });

  it('lets the installation zone use public parts of core and plugins only', async () => {
    const r = repo({
      'agents/sales/tools/report.ts': [
        "import '../../../core/tools/public/index.ts';",
        "import '../../../plugins/mail/public/index.ts';",
        "import '../../../core/tools/internal/registry.ts';",
        "import '../../../plugins/mail/tools/send.ts';",
        "import '../../../custom/pricing.ts';",
      ].join('\n'),
      'core/tools/public/index.ts': OK,
      'core/tools/internal/registry.ts': OK,
      'plugins/mail/public/index.ts': OK,
      'plugins/mail/tools/send.ts': OK,
      'custom/pricing.ts': OK,
    });
    expect(lines(await checkArchitecture(r))).toEqual([
      'install-core-public-only: agents/sales/tools/report.ts -> core/tools/internal/registry.ts',
      'install-plugins-public-only: agents/sales/tools/report.ts -> plugins/mail/tools/send.ts',
    ]);
  });

  it('keeps web away from server code: only web, contracts and npm packages', async () => {
    const r = repo({
      'web/src/App.tsx': [
        "import { useState } from 'react';",
        "import '../../contracts/src/index.ts';",
        "import { x } from './chat/Chat.tsx';",
        "import '../../core/auth/public/index.ts';",
        'export const a = [useState, x];',
      ].join('\n'),
      'web/src/chat/Chat.tsx': OK,
      'contracts/src/index.ts': OK,
      'core/auth/public/index.ts': OK,
    });
    expect(lines(await checkArchitecture(r))).toEqual(['web-only-web-and-contracts: web/src/App.tsx -> core/auth/public/index.ts']);
  });

  it('keeps contracts self-contained', async () => {
    const r = repo({
      'contracts/src/index.ts': "import '../../core/auth/public/index.ts';\nimport { z } from 'zod';\nexport const s = z;\n",
      'core/auth/public/index.ts': OK,
    });
    expect(lines(await checkArchitecture(r))).toEqual(['contracts-self-contained: contracts/src/index.ts -> core/auth/public/index.ts']);
  });

  it('ignores node_modules, inbox, tooling and files at the root', async () => {
    const r = repo({
      'core/node_modules/x/a.ts': "import '../../../plugins/p.ts';\n",
      'inbox/notes.ts': "import '../plugins/p.ts';\n",
      'tooling/arch.ts': "import '../core/chat/run.ts';\n",
      'vitest.config.ts': "import './core/chat/run.ts';\n",
      'core/chat/run.ts': OK,
      'plugins/p.ts': OK,
    });
    expect(await checkArchitecture(r)).toEqual([]);
  });
});

describe('checkArchitecture: circular imports', () => {
  it('flags files that import each other at run time, with the circle', async () => {
    const r = repo({
      'core/chat/a.ts': "import { b } from './b.ts';\nexport const a = () => b;\n",
      'core/chat/b.ts': "import { a } from './a.ts';\nexport const b = () => a;\n",
    });
    // dependency-cruiser reports a circle once or once per arrow; what matters is the circle itself.
    expect(await checkArchitecture(r)).toEqual([
      { rule: 'no-circular', from: 'core/chat/a.ts', to: 'core/chat/b.ts', detail: 'core/chat/b.ts -> core/chat/a.ts' },
    ]);
  });

  it('flags a circle through several folders of web', async () => {
    const r = repo({
      'web/src/a/A.tsx': "import { b } from '../b/B.tsx';\nexport const a = () => b;\n",
      'web/src/b/B.tsx': "import { c } from '../c/C.tsx';\nexport const b = () => c;\n",
      'web/src/c/C.tsx': "import { a } from '../a/A.tsx';\nexport const c = () => a;\n",
    });
    const found = await checkArchitecture(r);
    expect(found.length).toBeGreaterThan(0);
    for (const v of found) {
      expect(v.rule).toBe('no-circular');
      expect(v.detail?.split(' -> ').sort()).toEqual(['web/src/a/A.tsx', 'web/src/b/B.tsx', 'web/src/c/C.tsx']);
    }
  });

  it('lets two files share only types both ways: types disappear at run time', async () => {
    const r = repo({
      'core/chat/a.ts': "import type { B } from './b.ts';\nexport type A = { b?: B };\n",
      'core/chat/b.ts': "import type { A } from './a.ts';\nexport type B = { a?: A };\n",
    });
    expect(await checkArchitecture(r)).toEqual([]);
  });

  it('counts a file that takes both a type and a value from the other as a run-time import', async () => {
    const r = repo({
      'core/chat/a.ts': "import type { B } from './b.ts';\nimport { b } from './b.ts';\nexport type A = B;\nexport const a = () => b;\n",
      'core/chat/b.ts': "import { a } from './a.ts';\nexport type B = number;\nexport const b = () => a;\n",
    });
    expect(lines(await checkArchitecture(r))).toEqual(['no-circular: core/chat/a.ts -> core/chat/b.ts']);
  });
});

describe('checkArchitecture: foundation modules', () => {
  it('flags a foundation module importing a module with business logic', async () => {
    const r = repo({
      'core/db/pool.ts': "import '../errors/app-error.ts';\nimport '../log/log.ts';\nimport '../projects/access.ts';\n",
      'core/errors/app-error.ts': OK,
      'core/log/log.ts': OK,
      'core/projects/access.ts': OK,
    });
    expect(lines(await checkArchitecture(r))).toEqual(['foundation-stays-foundation: core/db/pool.ts -> core/projects/access.ts']);
  });

  it('applies to type-only imports too: a foundation module knows nothing of business modules', async () => {
    const r = repo({
      'core/run-context/request-keys.ts': "import type { Abilities } from '../abilities/abilities.ts';\nexport type K = Abilities;\n",
      'core/abilities/abilities.ts': 'export type Abilities = { web: boolean };\n',
    });
    expect(lines(await checkArchitecture(r))).toEqual(['foundation-stays-foundation: core/run-context/request-keys.ts -> core/abilities/abilities.ts']);
  });

  it('lets tests of a foundation module use anything', async () => {
    const r = repo({
      'core/db/migrations.test.ts': "import '../interface-settings/store.ts';\n",
      'core/interface-settings/store.ts': OK,
    });
    expect(await checkArchitecture(r)).toEqual([]);
  });
});

describe('checkArchitecture: core/server is where everything is assembled', () => {
  it('flags a core module, a plugin or the installation zone importing core/server', async () => {
    const r = repo({
      'core/chat/run.ts': "import '../server/app.ts';\n",
      'core/server/app.ts': OK,
      'core/server/public/index.ts': OK,
      'plugins/mail/send.ts': "import '../../core/server/public/index.ts';\n",
      'agents/sales/agent.ts': "import '../../core/server/public/index.ts';\n",
    });
    expect(lines(await checkArchitecture(r))).toEqual([
      'server-is-composition-root: agents/sales/agent.ts -> core/server/public/index.ts',
      'server-is-composition-root: core/chat/run.ts -> core/server/app.ts',
      'server-is-composition-root: plugins/mail/send.ts -> core/server/public/index.ts',
    ]);
  });

  it('lets tests, end-to-end scenarios and tooling use the test application of core/server', async () => {
    const r = repo({
      'core/server/test-app.ts': "import '../chat/run.ts';\n",
      'core/chat/run.ts': OK,
      'core/chat/run.test.ts': "import '../server/test-app.ts';\n",
      'tests/e2e/stand.ts': "import '../../core/server/test-app.ts';\n",
      'tooling/dev-people.ts': "import '../core/server/test-app.ts';\n",
    });
    expect(await checkArchitecture(r)).toEqual([]);
  });
});

describe('checkArchitecture: core modules do not depend on each other both ways', () => {
  it('flags two core modules that import each other at run time, once, with a file of each direction', async () => {
    const r = repo({
      'core/approvals/continue.ts': "import { run } from '../chat/run.ts';\nexport const go = () => run;\n",
      'core/approvals/requests.ts': OK,
      'core/chat/run.ts': OK,
      'core/chat/connect.ts': "import { x } from '../approvals/requests.ts';\nexport const c = x;\n",
    });
    expect(await checkArchitecture(r)).toEqual([
      {
        rule: 'core-no-mutual-modules',
        from: 'core/approvals',
        to: 'core/chat',
        detail: 'core/approvals/continue.ts -> core/chat/run.ts; core/chat/connect.ts -> core/approvals/requests.ts',
      },
    ]);
  });

  it('does not count imports of types only, or imports made by tests', async () => {
    const r = repo({
      'core/http/http.ts': "import type { Access } from '../auth/access.ts';\nexport type Env = { access: Access };\n",
      'core/auth/access.ts': 'export type Access = { userId: string };\n',
      'core/auth/guards.ts': "import type { Env } from '../http/http.ts';\nexport type G = Env;\n",
      'core/auth/guards.test.ts': "import '../http/http.ts';\n",
      'core/memory/routes.ts': "import '../projects/access.ts';\n",
      'core/projects/access.ts': OK,
      'core/projects/access.test.ts': "import '../memory/routes.ts';\n",
    });
    expect(await checkArchitecture(r)).toEqual([]);
  });
});
