// pnpm customer:new <name> [--plugins mail,bitrix24] [--target <folder>] (spec, scenario 1, step 24):
// a git copy of the open repository for one customer. The history stays shared, so improvements of
// the open core come into the copy by a merge from "upstream"; plugins the customer does not need
// leave the copy in its first commit. Only committed files are copied: materials of customers
// (inbox/) and secrets (.env) never travel.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
const OPEN_BRANCH = 'main';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface CopyInput {
  source: string;
  target: string;
  name: string;
  keepPlugins: string[];
}

export interface CopyResult {
  target: string;
  keptPlugins: string[];
  removedPlugins: string[];
}

function fail(message: string): never {
  throw new Error(`APP_CONFIG_INVALID: ${message}`);
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// Plugins committed in the open repository (an untracked folder is not part of the copy anyway).
export function committedPlugins(source: string): string[] {
  const listed = git(source, 'ls-tree', '-d', '--name-only', 'HEAD', 'plugins/');
  return listed ? listed.split('\n').map((p) => p.replace(/^plugins\//, '')) : [];
}

export function createCustomerCopy(input: CopyInput): CopyResult {
  const { source, target, name } = input;
  if (!NAME.test(name)) fail(`customer name "${name}": use 2–41 lowercase Latin letters, digits and dashes, starting with a letter`);
  if (existsSync(target)) fail(`${target}: the folder exists already`);
  const plugins = committedPlugins(source);
  const unknown = input.keepPlugins.filter((p) => !plugins.includes(p));
  if (unknown.length > 0) fail(`plugins ${unknown.join(', ')}: there are no such plugins in plugins/ (there are: ${plugins.join(', ') || 'none'})`);
  const upstream = git(source, 'remote', 'get-url', 'origin');

  // Only the main branch of the open repository, without its tags and without objects of other
  // branches (--no-local copies through git transport); git creates missing parent folders itself.
  git(source, 'clone', '--quiet', '--no-local', '--single-branch', '--branch', OPEN_BRANCH, '--no-tags', source, target);
  git(target, 'remote', 'remove', 'origin');
  git(target, 'remote', 'add', 'upstream', upstream);
  const removed = plugins.filter((p) => !input.keepPlugins.includes(p));
  for (const plugin of removed) git(target, 'rm', '-r', '--quiet', `plugins/${plugin}`);
  const kept = plugins.filter((p) => input.keepPlugins.includes(p));
  git(target, 'commit', '--quiet', '--allow-empty', '-m', `Копия для заказчика ${name}: плагины — ${kept.join(', ') || 'без плагинов'}`);
  return { target, keptPlugins: kept, removedPlugins: removed };
}

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const value = args[i + 1];
  // An empty value is a valid answer ("--plugins ''": keep no plugins).
  if (value === undefined || value.startsWith('--')) fail(`${flag} needs a value`);
  return value;
}

async function askPlugins(available: string[]): Promise<string[]> {
  if (!process.stdin.isTTY) fail('choose plugins with --plugins a,b (or --plugins "" for none) when not run in a terminal');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Плагины открытого репозитория: ${available.join(', ')}\nКакие оставить (через запятую, пусто — никаких)? `);
    return answer.split(',').map((p) => p.trim()).filter(Boolean);
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const name = args[0];
  if (!name || name.startsWith('--')) fail('usage: pnpm customer:new <name> [--plugins a,b] [--target <folder>]');
  const target = resolve(argValue(args, '--target') ?? resolve(ROOT, '..', name));
  const listed = argValue(args, '--plugins');
  const keepPlugins = listed !== null ? listed.split(',').map((p) => p.trim()).filter(Boolean) : await askPlugins(committedPlugins(ROOT));
  const result = createCustomerCopy({ source: ROOT, target, name, keepPlugins });
  console.log(`Копия создана: ${result.target}`);
  console.log(`Оставлены плагины: ${result.keptPlugins.join(', ') || 'нет'}; удалены: ${result.removedPlugins.join(', ') || 'нет'}`);
  console.log(
    [
      'Дальше:',
      `  cd ${result.target}`,
      '  git remote add origin <адрес закрытого репозитория заказчика>',
      '  создайте агентов в agents/, заполните config/ и .env (cp .env.example .env);',
      '  уберите удалённые плагины из config/plugins.ts и agents/*/agent.ts — иначе запуск остановится с APP_CONFIG_INVALID и назовёт файл и поле;',
      `  улучшения открытого ядра: git fetch upstream && git merge upstream/${OPEN_BRANCH}`,
    ].join('\n'),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
