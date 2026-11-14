import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCustomerCopy } from './customer-new.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A small open repository: two plugins, the demo config, and local files that are never committed.
function openRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'bba-open-'));
  dirs.push(root);
  const files: Record<string, string> = {
    'package.json': '{"name":"basic-business-agent"}\n',
    'plugins/mail/plugin.ts': 'export default {};\n',
    'plugins/bitrix24/plugin.ts': 'export default {};\n',
    'plugins/example-notes/plugin.ts': 'export default {};\n',
    'config/plugins.ts': 'export default {};\n',
    '.gitignore': 'inbox/\n.env\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'open core');
  git(root, 'remote', 'add', 'origin', 'https://example.com/open/basic-business-agent.git');
  // Materials of another customer and secrets sit in the working copy, never in git.
  mkdirSync(join(root, 'inbox'), { recursive: true });
  writeFileSync(join(root, 'inbox', 'brief.pdf'), 'материалы заказчика');
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
  return root;
}

describe('customer copy', () => {
  it('copies the open repository with its history and keeps only the chosen plugins', () => {
    const source = openRepo();
    const target = join(mkdtempSync(join(tmpdir(), 'bba-copies-')), 'alfa-stroy');
    dirs.push(join(target, '..'));
    const result = createCustomerCopy({ source, target, name: 'alfa-stroy', keepPlugins: ['mail'] });

    expect(result.removedPlugins.sort()).toEqual(['bitrix24', 'example-notes']);
    expect(existsSync(join(target, 'plugins/mail/plugin.ts'))).toBe(true);
    expect(existsSync(join(target, 'plugins/bitrix24'))).toBe(false);
    // Shared history: the open core's commit is the parent of the copy's first commit.
    expect(git(target, 'rev-parse', 'HEAD~1')).toBe(git(source, 'rev-parse', 'HEAD'));
    expect(git(target, 'log', '-1', '--format=%s')).toContain('alfa-stroy');
    // Improvements come from the open repository as "upstream"; the customer's own remote comes later.
    expect(git(target, 'remote')).toBe('upstream');
    expect(git(target, 'remote', 'get-url', 'upstream')).toBe('https://example.com/open/basic-business-agent.git');
  });

  it('carries no files of other customers and no secrets', () => {
    const source = openRepo();
    // A target in folders that do not exist yet.
    const target = join(mkdtempSync(join(tmpdir(), 'bba-copies-')), 'customers', 'beta');
    dirs.push(join(target, '..', '..'));
    createCustomerCopy({ source, target, name: 'beta', keepPlugins: [] });
    expect(existsSync(join(target, 'inbox'))).toBe(false);
    expect(existsSync(join(target, '.env'))).toBe(false);
    expect(readFileSync(join(target, '.gitignore'), 'utf8')).toContain('inbox/');
  });

  it('refuses an unknown plugin, a bad name and an existing folder before copying anything', () => {
    const source = openRepo();
    const parent = mkdtempSync(join(tmpdir(), 'bba-copies-'));
    dirs.push(parent);
    expect(() => createCustomerCopy({ source, target: join(parent, 'gamma'), name: 'gamma', keepPlugins: ['crm'] })).toThrow(/APP_CONFIG_INVALID.*crm/);
    expect(() => createCustomerCopy({ source, target: join(parent, 'Альфа'), name: 'Альфа', keepPlugins: [] })).toThrow(/APP_CONFIG_INVALID/);
    mkdirSync(join(parent, 'taken'));
    expect(() => createCustomerCopy({ source, target: join(parent, 'taken'), name: 'taken', keepPlugins: [] })).toThrow(/APP_CONFIG_INVALID.*exists/);
    expect(existsSync(join(parent, 'gamma'))).toBe(false);
  });
});
