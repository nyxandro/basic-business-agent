// The package folder of a program server (docs/specs/[20.11.2026]-mcp-connections.md, step 9): installed once, then
// reused without the registry; the admin's arguments are not baked into it.
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { installProgram } from './install.ts';

const root = join(mkdtempSync(join(tmpdir(), 'bba-mcp-install-')), 'pkg');
afterAll(() => rm(root, { recursive: true, force: true }));

describe('a package installed before', () => {
  it('starts again without the registry, with the arguments of this server', async () => {
    await mkdir(root, { recursive: true });
    const stored = { command: '/usr/local/bin/node', args: ['--max-old-space-size=448', join(root, 'node_modules/x/bin.js')], root, extraPaths: [] };
    await writeFile(join(root, '.installed.json'), JSON.stringify(stored));
    const launch = await installProgram({ runner: 'npx', package: 'x@1.0.0', args: ['--base', 'http://1c.local'], env: {} }, root, join(root, '.cache'));
    expect(launch.args).toEqual([...stored.args, '--base', 'http://1c.local']);
    const other = await installProgram({ runner: 'npx', package: 'x@1.0.0', args: [], env: {} }, root, join(root, '.cache'));
    expect(other.args).toEqual(stored.args);
  });
});
