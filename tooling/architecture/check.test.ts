import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBoundaries } from './check.ts';

let root: string | undefined;

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

const OK = 'export const x = 1;\n';

describe('checkBoundaries', () => {
  it('flags core importing a plugin, with file, line and specifier', () => {
    const r = repo({
      'core/chat/run.ts': "import { a } from './util.ts';\nimport { send } from '../../plugins/mail/send.ts';\n",
      'core/chat/util.ts': OK,
      'plugins/mail/send.ts': OK,
    });
    expect(checkBoundaries(r)).toEqual([
      {
        file: 'core/chat/run.ts',
        line: 2,
        specifier: '../../plugins/mail/send.ts',
        reason: 'core/ must not import plugins/',
      },
    ]);
  });

  it('flags core importing the installation zone: agents, config, custom, workflows, skills', () => {
    const r = repo({
      'core/loader/load.ts': [
        "import '../../agents/sales/agent.ts';",
        "import '../../config/app.ts';",
        "import '../../custom/x.ts';",
        "import '../../workflows/w.ts';",
        "import '../../skills/s.ts';",
      ].join('\n'),
    });
    expect(checkBoundaries(r).map((v) => v.reason)).toEqual([
      'core/ must not import agents/',
      'core/ must not import config/',
      'core/ must not import custom/',
      'core/ must not import workflows/',
      'core/ must not import skills/',
    ]);
  });

  it('lets core import any core module, contracts and npm packages', () => {
    const r = repo({
      'core/chat/run.ts': "import '../auth/session.ts';\nimport { z } from 'zod';\nimport { apiErrorSchema } from '@bba/contracts';\n",
      'core/auth/session.ts': OK,
    });
    expect(checkBoundaries(r)).toEqual([]);
  });

  it('catches dynamic imports and re-exports', () => {
    const r = repo({
      'core/chat/run.ts': "export { send } from '../../plugins/mail/send.ts';\nconst m = await import('../../plugins/mail/other.ts');\n",
    });
    expect(checkBoundaries(r).map((v) => v.line)).toEqual([1, 2]);
  });

  it('lets a plugin import only the public part of core', () => {
    const r = repo({
      'plugins/mail/tools/send.ts': [
        "import { defineTool } from '../../../core/tools/public/index.ts';",
        "import { secret } from '../../../core/tools/internal/registry.ts';",
        "import { helper } from '../lib/helper.ts';",
      ].join('\n'),
      'plugins/mail/lib/helper.ts': OK,
    });
    expect(checkBoundaries(r)).toEqual([
      {
        file: 'plugins/mail/tools/send.ts',
        line: 2,
        specifier: '../../../core/tools/internal/registry.ts',
        reason: 'plugins/ may import core/ only through core/<module>/public/',
      },
    ]);
  });

  it('forbids a plugin importing another plugin it does not declare', () => {
    const r = repo({ 'plugins/mail/send.ts': "import '../bitrix24/public/index.ts';\n" });
    expect(checkBoundaries(r).map((v) => v.reason)).toEqual(['plugins/mail may not import plugins/bitrix24: it is not in dependsOn']);
  });

  it('lets a plugin import the public part of a plugin declared in dependsOn, and nothing else of it', () => {
    const r = repo({
      'plugins/mail/plugin.ts': "export default { name: 'mail', dependsOn: ['bitrix24'] };\n",
      'plugins/mail/send.ts': "import '../bitrix24/public/index.ts';\nimport '../bitrix24/internal/token.ts';\n",
    });
    expect(checkBoundaries(r).map((v) => `${v.line}: ${v.reason}`)).toEqual(['2: plugins/mail may import plugins/bitrix24 only through its public/ part']);
  });

  it('forbids a plugin importing the installation zone or web', () => {
    const r = repo({ 'plugins/mail/send.ts': "import '../../agents/sales/agent.ts';\nimport '../../web/src/App.tsx';\n" });
    expect(checkBoundaries(r).map((v) => v.reason)).toEqual([
      'plugins/ must not import agents/',
      'plugins/ must not import web/',
    ]);
  });

  it('lets the installation zone use public parts of core and plugins only', () => {
    const r = repo({
      'agents/sales/tools/report.ts': [
        "import '../../../core/tools/public/index.ts';",
        "import '../../../plugins/mail/public/index.ts';",
        "import '../../../core/tools/internal/registry.ts';",
        "import '../../../plugins/mail/tools/send.ts';",
        "import '../../../custom/pricing.ts';",
      ].join('\n'),
    });
    expect(checkBoundaries(r).map((v) => `${v.line}: ${v.reason}`)).toEqual([
      '3: agents/ may import core/ only through core/<module>/public/',
      '4: agents/ may import plugins/ only through plugins/<name>/public/',
    ]);
  });

  it('keeps web away from server code: only web, contracts and npm packages', () => {
    const r = repo({
      'web/src/App.tsx': [
        "import { useState } from 'react';",
        "import { apiErrorSchema } from '@bba/contracts';",
        "import { Chat } from './chat/Chat.tsx';",
        "import '../../core/auth/public/index.ts';",
      ].join('\n'),
      'web/src/chat/Chat.tsx': OK,
    });
    expect(checkBoundaries(r).map((v) => v.reason)).toEqual(['web/ must not import core/']);
  });

  it('keeps contracts self-contained', () => {
    const r = repo({ 'contracts/src/index.ts': "import '../../core/auth/public/index.ts';\nimport { z } from 'zod';\n" });
    expect(checkBoundaries(r).map((v) => v.reason)).toEqual(['contracts/ must not import core/']);
  });

  it('ignores node_modules, inbox and files outside the zones', () => {
    const r = repo({
      'node_modules/x/core/a.ts': "import '../../plugins/p.ts';\n",
      'inbox/notes.ts': "import '../core/x.ts';\n",
      'tooling/arch.ts': "import '../core/chat/run.ts';\n",
      'vitest.config.ts': "import '../core/x.ts';\n",
    });
    expect(checkBoundaries(r)).toEqual([]);
  });
});
