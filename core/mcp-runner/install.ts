// Getting the package of a program server into its own folder (docs/specs/[20.11.2026]-mcp-connections.md, section 8):
// once, when the admin checks the server; later starts need no package registry. Installing runs nothing of the
// package: npm without its install scripts, pip from ready wheels only — the code of the package runs only later,
// in the sandbox. The version is exact (the admin's form refuses any other), so the folder never changes.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ProgramSpec } from './protocol.ts';
import type { Launch } from './sandbox.ts';

const run = promisify(execFile);
// About 512 MB per program (section 8): the heap of Node, the address space of Python (Node reserves more address
// space than it uses, so it is limited by its heap instead).
const NODE_HEAP_MB = 448;
const PYTHON_ADDRESS_SPACE = 512 * 1024 * 1024;
const PRLIMIT = '/usr/bin/prlimit';
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const READY = '.installed.json';
const OUTPUT_LIMIT = 8 * 1024 * 1024;

// A package that could not be installed: the admin gets the reason in plain words, the log gets the tool's tail.
export class PackageFailed extends Error {
  readonly reason: 'not_found' | 'no_wheel' | 'no_bin' | 'network';
  readonly tail: string;
  constructor(reason: PackageFailed['reason'], tail: string) {
    super(`package install failed: ${reason}`);
    this.name = 'PackageFailed';
    this.reason = reason;
    this.tail = tail;
  }
}

const nameOf = (spec: ProgramSpec) => (spec.runner === 'npx' ? spec.package.replace(/@[^@/]+$/, '') : spec.package.split('==')[0]!);

function reasonOf(output: string): PackageFailed['reason'] {
  if (/E404|404 Not Found|No matching version|ETARGET|No matching distribution|Could not find a version/i.test(output)) return /wheel|binary/i.test(output) ? 'no_wheel' : 'not_found';
  return 'network';
}

async function installNpm(spec: ProgramSpec, root: string, cache: string): Promise<Launch> {
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--prefix', root, spec.package], {
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: OUTPUT_LIMIT,
    // eslint-disable-next-line no-restricted-properties -- npm gets the environment of the runner as it is, plus its cache: nothing is read from it here
    env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' },
  });
  const name = nameOf(spec);
  const dir = join(root, 'node_modules', name);
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
  const bins = typeof manifest.bin === 'string' ? { [name]: manifest.bin } : (manifest.bin ?? {});
  const bin = bins[name.replace(/^@[^/]+\//, '')] ?? Object.values(bins)[0];
  if (!bin) throw new PackageFailed('no_bin', `${name} has no bin`);
  return { command: process.execPath, args: [`--max-old-space-size=${NODE_HEAP_MB}`, join(dir, bin)], root, extraPaths: [dirname(dirname(process.execPath))] };
}

async function installPip(spec: ProgramSpec, root: string): Promise<Launch> {
  const venv = join(root, 'venv');
  await run('python3', ['-m', 'venv', venv], { timeout: INSTALL_TIMEOUT_MS });
  await run(join(venv, 'bin', 'pip'), ['install', '--only-binary=:all:', '--no-cache-dir', '--disable-pip-version-check', spec.package], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT });
  const command = join(venv, 'bin', nameOf(spec));
  if (!existsSync(command)) throw new PackageFailed('no_bin', `${nameOf(spec)} has no command`);
  return { command: PRLIMIT, args: [`--as=${PYTHON_ADDRESS_SPACE}`, command], root, extraPaths: [] };
}

// The folder of a package is reused while it is complete; a failed install leaves nothing behind. The folder keeps
// how the package starts; the admin's arguments are added at every start (two servers may share a package).
export async function installProgram(spec: ProgramSpec, root: string, cache: string): Promise<Launch> {
  const ready = join(root, READY);
  const withArgs = (launch: Launch): Launch => ({ ...launch, args: [...launch.args, ...spec.args] });
  if (existsSync(ready)) return withArgs(JSON.parse(await readFile(ready, 'utf8')) as Launch);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    const launch = spec.runner === 'npx' ? await installNpm(spec, root, cache) : await installPip(spec, root);
    await writeFile(ready, JSON.stringify(launch));
    return withArgs(launch);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if (error instanceof PackageFailed) throw error;
    const output = `${(error as { stderr?: string }).stderr ?? ''}${(error as { stdout?: string }).stdout ?? ''}`;
    throw new PackageFailed(reasonOf(output), output.slice(-2000));
  }
}
