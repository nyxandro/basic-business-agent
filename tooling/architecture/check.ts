// Import boundaries of the repository (spec, section 17.2):
// - core/ does not import plugins/, web/ or the installation zone;
// - a plugin uses core/ only through core/<module>/public/, and another plugin only through its
//   public/ part when the passport declares it in `dependsOn`;
// - the installation zone uses core/ and plugins/ only through their public/ folders;
// - web/ imports only web/, the contracts package and npm packages;
// - contracts/ imports nothing from the repository.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export interface Violation {
  file: string;
  line: number;
  specifier: string;
  reason: string;
}

type Zone =
  | { kind: 'core' }
  | { kind: 'plugin'; name: string }
  | { kind: 'install'; dir: string }
  | { kind: 'web' }
  | { kind: 'contracts' }
  | { kind: 'other' };

interface Target {
  zone: Zone;
  top: string;
  isPublic: boolean;
}

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'inbox', 'docs']);
const INSTALL_ZONE_DIRS = new Set(['agents', 'config', 'custom', 'workflows', 'skills']);
const CONTRACTS_PACKAGE = '@bba/contracts';
const PUBLIC_DIR = 'public';

function zoneOf(path: string): Zone {
  const [top, second] = path.split('/');
  if (top === 'core') return { kind: 'core' };
  if (top === 'plugins' && second) return { kind: 'plugin', name: second };
  if (top !== undefined && INSTALL_ZONE_DIRS.has(top)) return { kind: 'install', dir: top };
  if (top === 'web') return { kind: 'web' };
  if (top === 'contracts') return { kind: 'contracts' };
  return { kind: 'other' };
}

function targetOf(path: string): Target {
  const parts = path.split('/');
  return { zone: zoneOf(path), top: parts[0] ?? '', isPublic: parts[2] === PUBLIC_DIR };
}

// Plugins named in `dependsOn: [...]` of plugins/<name>/plugin.ts (a literal list, read as text).
function declaredDependencies(root: string, plugin: string): Set<string> {
  const file = join(root, 'plugins', plugin, 'plugin.ts');
  if (!existsSync(file)) return new Set();
  const list = /dependsOn:\s*\[([^\]]*)\]/.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
  return new Set([...list.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!));
}

function reasonFor(source: Zone, target: Target, deps: (plugin: string) => Set<string>): string | null {
  const { zone, top, isPublic } = target;
  if (zone.kind === 'other') return null;
  switch (source.kind) {
    case 'core':
      return zone.kind === 'core' || zone.kind === 'contracts' ? null : `core/ must not import ${top}/`;
    case 'plugin':
      if (zone.kind === 'contracts') return null;
      if (zone.kind === 'core') return isPublic ? null : 'plugins/ may import core/ only through core/<module>/public/';
      if (zone.kind === 'plugin') {
        if (zone.name === source.name) return null;
        if (!deps(source.name).has(zone.name)) return `plugins/${source.name} may not import plugins/${zone.name}: it is not in dependsOn`;
        return isPublic ? null : `plugins/${source.name} may import plugins/${zone.name} only through its public/ part`;
      }
      return `plugins/ must not import ${top}/`;
    case 'install':
      if (zone.kind === 'contracts' || zone.kind === 'install') return null;
      if (zone.kind === 'core') return isPublic ? null : `${source.dir}/ may import core/ only through core/<module>/public/`;
      if (zone.kind === 'plugin') return isPublic ? null : `${source.dir}/ may import plugins/ only through plugins/<name>/public/`;
      return `${source.dir}/ must not import ${top}/`;
    case 'web':
      return zone.kind === 'web' || zone.kind === 'contracts' ? null : `web/ must not import ${top}/`;
    case 'contracts':
      return zone.kind === 'contracts' ? null : `contracts/ must not import ${top}/`;
    case 'other':
      return null;
  }
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function resolveTarget(root: string, fileAbs: string, specifier: string): Target | null {
  if (specifier === CONTRACTS_PACKAGE || specifier.startsWith(`${CONTRACTS_PACKAGE}/`)) {
    return { zone: { kind: 'contracts' }, top: 'contracts', isPublic: true };
  }
  if (!specifier.startsWith('.')) return null; // npm package or Node built-in
  const rel = toPosix(relative(root, resolve(dirname(fileAbs), specifier)));
  if (rel.startsWith('..')) return null;
  return targetOf(rel);
}

function* sourceFiles(root: string, dir = root): Generator<string> {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* sourceFiles(root, full);
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
      yield full;
    }
  }
}

function lineAt(text: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function checkBoundaries(root: string): Violation[] {
  const violations: Violation[] = [];
  const depsCache = new Map<string, Set<string>>();
  const deps = (plugin: string): Set<string> => {
    if (!depsCache.has(plugin)) depsCache.set(plugin, declaredDependencies(root, plugin));
    return depsCache.get(plugin)!;
  };
  for (const fileAbs of sourceFiles(root)) {
    const file = toPosix(relative(root, fileAbs));
    const source = zoneOf(file);
    if (source.kind === 'other') continue;
    const text = readFileSync(fileAbs, 'utf8');
    const { importedFiles } = ts.preProcessFile(text, true, true);
    for (const imported of importedFiles) {
      const target = resolveTarget(root, fileAbs, imported.fileName);
      if (!target) continue;
      const reason = reasonFor(source, target, deps);
      if (reason) violations.push({ file, line: lineAt(text, imported.pos), specifier: imported.fileName, reason });
    }
  }
  return violations;
}
