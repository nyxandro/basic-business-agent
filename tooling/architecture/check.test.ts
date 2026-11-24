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

  it('stops on a local import that leads to no file: no rule could check where it goes', async () => {
    const r = repo({ 'web/src/App.tsx': "import '../../core/auth/gone.ts';\nimport { x } from './ok.ts';\nexport const a = x;\n", 'web/src/ok.ts': OK });
    expect(lines(await checkArchitecture(r))).toEqual(['unresolved-local-import: web/src/App.tsx -> ../../core/auth/gone.ts']);
  });

  it('still checks imports into the skills of Anthropic kept as published', async () => {
    const r = repo({
      'plugins/mail/send.ts': "import '../../core/system-skills/docx/scripts/x.js';\n",
      'core/system-skills/docx/scripts/x.js': "import './missing-helper.js';\nexport const x = 1;\n",
    });
    expect(lines(await checkArchitecture(r))).toEqual(['plugins-core-public-only: plugins/mail/send.ts -> core/system-skills/docx/scripts/x.js']);
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
    const files = found.filter((v) => v.rule === 'no-circular');
    expect(files.length).toBeGreaterThan(0);
    for (const v of files) expect(v.detail?.split(' -> ').sort()).toEqual(['web/src/a/A.tsx', 'web/src/b/B.tsx', 'web/src/c/C.tsx']);
    // The same circle is a circle of the folders a, b and c.
    expect(lines(found.filter((v) => v.rule !== 'no-circular'))).toEqual(['no-circular-modules: web/src/a -> web/src/b']);
  });

  it('finds a circle of run-time imports even when the files also take types from each other the other way', async () => {
    const r = repo({
      'core/chat/a.ts': "import { b } from './b.ts';\nimport type { C } from './c.ts';\nexport type A = C;\nexport const a = () => b;\n",
      'core/chat/b.ts': "import { c } from './c.ts';\nimport type { A } from './a.ts';\nexport type B = A;\nexport const b = () => c;\n",
      'core/chat/c.ts': "import { a } from './a.ts';\nimport type { B } from './b.ts';\nexport type C = B;\nexport const c = () => a;\n",
    });
    expect(await checkArchitecture(r)).toEqual([
      { rule: 'no-circular', from: 'core/chat/a.ts', to: 'core/chat/b.ts', detail: 'core/chat/b.ts -> core/chat/c.ts -> core/chat/a.ts' },
    ]);
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

describe('checkArchitecture: modules of core and folders of web do not import each other in a circle', () => {
  it('flags two core modules that import each other at run time, once, with a file import for each arrow', async () => {
    const r = repo({
      'core/approvals/continue.ts': "import { run } from '../chat/run.ts';\nexport const go = () => run;\n",
      'core/approvals/requests.ts': OK,
      'core/chat/run.ts': OK,
      'core/chat/connect.ts': "import { x } from '../approvals/requests.ts';\nexport const c = x;\n",
    });
    expect(await checkArchitecture(r)).toEqual([
      {
        rule: 'no-circular-modules',
        from: 'core/approvals',
        to: 'core/chat',
        detail: 'core/approvals/continue.ts -> core/chat/run.ts; core/chat/connect.ts -> core/approvals/requests.ts',
      },
    ]);
  });

  it('flags a circle of three core modules that no two of them make alone, with the shortest circle', async () => {
    const r = repo({
      'core/auth/users.ts': "import { shared } from '../projects/access.ts';\nexport const u = shared;\n",
      'core/auth/guards.ts': OK,
      'core/projects/access.ts': OK,
      'core/projects/trash.ts': "import { area } from '../storage/areas.ts';\nexport const t = area;\n",
      'core/storage/areas.ts': OK,
      'core/storage/routes.ts': "import { g } from '../auth/guards.ts';\nexport const s = g;\n",
    });
    expect(await checkArchitecture(r)).toEqual([
      {
        rule: 'no-circular-modules',
        from: 'core/auth',
        to: 'core/projects',
        detail: 'core/auth/users.ts -> core/projects/access.ts; core/projects/trash.ts -> core/storage/areas.ts; core/storage/routes.ts -> core/auth/guards.ts',
      },
    ]);
  });

  it('flags a circle of folders of web even when no file is in a circle', async () => {
    const r = repo({
      'web/src/layout/AppShell.tsx': "import { list } from '../projects/ProjectList.tsx';\nexport const shell = list;\n",
      'web/src/layout/use-shell.ts': OK,
      'web/src/projects/ProjectList.tsx': OK,
      'web/src/projects/ProjectPage.tsx': "import { use } from '../layout/use-shell.ts';\nexport const page = use;\n",
    });
    expect(await checkArchitecture(r)).toEqual([
      {
        rule: 'no-circular-modules',
        from: 'web/src/layout',
        to: 'web/src/projects',
        detail: 'web/src/layout/AppShell.tsx -> web/src/projects/ProjectList.tsx; web/src/projects/ProjectPage.tsx -> web/src/layout/use-shell.ts',
      },
    ]);
  });

  it('does not count imports of types only, or imports made by tests and test helpers', async () => {
    const r = repo({
      'core/http/http.ts': "import type { Access } from '../auth/access.ts';\nexport type Env = { access: Access };\n",
      'core/auth/access.ts': 'export type Access = { userId: string };\n',
      'core/auth/guards.ts': "import type { Env } from '../http/http.ts';\nexport type G = Env;\n",
      'core/auth/guards.test.ts': "import '../http/http.ts';\n",
      'core/memory/routes.ts': "import '../projects/access.ts';\n",
      'core/projects/access.ts': OK,
      'core/projects/access.test.ts': "import '../memory/routes.ts';\n",
      'core/mail/test-server.ts': "import '../projects/access.ts';\n",
      'core/projects/mail.ts': "import '../mail/test-server.ts';\n",
      'web/src/main.tsx': "import './app/App.tsx';\n",
      'web/src/app/App.tsx': "import '../projects/ProjectPage.tsx';\n",
      'web/src/projects/ProjectPage.tsx': OK,
      'web/src/projects/test-server.ts': "import '../test/fetch-mock.ts';\n",
      'web/src/test/fetch-mock.ts': OK,
      'web/src/test/render.tsx': "import '../app/App.tsx';\n",
      'web/src/app/App.test.tsx': "import '../test/render.tsx';\n",
    });
    expect(await checkArchitecture(r)).toEqual([]);
  });
});

describe('checkArchitecture: base folders of web', () => {
  it('flags ui, i18n or api importing code of another folder of web', async () => {
    const r = repo({
      'web/src/ui/Banner.tsx': "import { open } from '../chat/open.ts';\nexport const b = open;\n",
      'web/src/i18n/ru.ts': "import { at } from '../layout/clock.ts';\nexport const ru = at;\n",
      'web/src/api/client.ts': "import { s } from '../auth/session.ts';\nexport const c = s;\n",
      'web/src/chat/open.ts': OK,
      'web/src/layout/clock.ts': OK,
      'web/src/auth/session.ts': OK,
    });
    expect(lines(await checkArchitecture(r))).toEqual([
      'web-base-stays-base: web/src/api/client.ts -> web/src/auth/session.ts',
      'web-base-stays-base: web/src/i18n/ru.ts -> web/src/layout/clock.ts',
      'web-base-stays-base: web/src/ui/Banner.tsx -> web/src/chat/open.ts',
    ]);
  });

  it('lets base folders use each other, contracts and npm packages, take types of a folder and be tested with anything', async () => {
    const r = repo({
      'web/src/ui/Banner.tsx': "import { client } from '../api/client.ts';\nimport { ru } from '../i18n/ru.ts';\nimport { useState } from 'react';\nexport const b = [client, ru, useState];\n",
      'web/src/api/client.ts': "import { ru } from '../i18n/ru.ts';\nimport '../../../contracts/src/index.ts';\nexport const client = ru;\n",
      'web/src/i18n/ru.ts': "import type { MarkKind } from '../viewer/marks/types.ts';\nexport const ru: Record<MarkKind, string> = { pen: 'карандаш' };\n",
      'web/src/viewer/marks/types.ts': "export type MarkKind = 'pen';\n",
      'web/src/ui/Banner.test.tsx': "import '../chat/ChatPage.tsx';\n",
      'web/src/chat/ChatPage.tsx': OK,
      'contracts/src/index.ts': OK,
    });
    expect(await checkArchitecture(r)).toEqual([]);
  });
});
