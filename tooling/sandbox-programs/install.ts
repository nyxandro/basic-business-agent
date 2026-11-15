// `pnpm skills:setup`, last step: the programs of the sandbox (core/sandbox/apt-packages.txt) on a
// development machine without root (spec, section 8.18). What `apt install` would add is downloaded
// with `apt-get download` (needs no root) and unpacked into .venv-skills/system; .venv-skills/bin gets
// a launcher for each program that shows it its libraries, fonts and data. The sandbox mounts
// .venv-skills read-only and has its bin first in PATH. A machine where `sudo apt install` already put
// everything gets nothing here; the Docker image installs the same list with apt as root.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const LIST = join(REPO, 'core/sandbox/apt-packages.txt');
const VENV = join(REPO, '.venv-skills');
const ROOT = join(VENV, 'system');
const BIN = join(VENV, 'bin');
// The launchers this step wrote, removed before the next run.
const MANIFEST = join(ROOT, 'launchers.txt');

export function listedPackages(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// `apt-get -s install` prints «Inst <package> …» for every package it would add.
export function packagesOfSimulation(output: string): string[] {
  return output
    .split('\n')
    .filter((l) => l.startsWith('Inst '))
    .map((l) => l.split(' ')[1]!);
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export interface LauncherEnv {
  libraryDirs: string[];
  fontsConf: string | null;
  tessdata: string | null;
  pandocData: string | null;
}

export function launcherScript(program: string, env: LauncherEnv): string {
  const lines = ['#!/bin/sh', '# Written by pnpm skills:setup (tooling/sandbox-programs/install.ts): a program of the sandbox unpacked without root.'];
  if (env.libraryDirs.length > 0) lines.push(`export LD_LIBRARY_PATH=${quote(env.libraryDirs.join(':'))}"\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"`);
  if (env.fontsConf) lines.push(`export FONTCONFIG_FILE=${quote(env.fontsConf)}`);
  if (env.tessdata) lines.push(`export TESSDATA_PREFIX=${quote(env.tessdata)}`);
  // Cabal's own variable: where pandoc finds its templates and reference documents.
  if (env.pandocData) lines.push(`export pandoc_datadir=${quote(env.pandocData)}`);
  lines.push(`exec ${quote(program)} "$@"`, '');
  return lines.join('\n');
}

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LANG: 'C' } });
}

function removePrevious(): void {
  if (existsSync(MANIFEST)) for (const name of readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean)) rmSync(join(BIN, name), { force: true });
  rmSync(ROOT, { recursive: true, force: true });
}

function walk(dir: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    visit(path);
    if (entry.isDirectory()) walk(path, visit);
  }
}

// Links of the packages that point to /etc or /usr point into the unpacked tree when it has the file.
function relinkInside(root: string): void {
  walk(root, (path) => {
    if (!lstatSync(path).isSymbolicLink()) return;
    const target = readlinkSync(path);
    if (!target.startsWith('/') || !existsSync(join(root, target))) return;
    unlinkSync(path);
    symlinkSync(relative(dirname(path), join(root, target)), path);
  });
}

// What the installation script of libreoffice-common does: the configuration goes to /etc, where a
// link of the package points. Before the links are turned inward, so this one finds its file.
function installLibreOfficeRegistry(root: string): void {
  const source = join(root, 'usr/lib/libreoffice/share/.registry/main.xcd');
  if (!existsSync(source)) return;
  mkdirSync(join(root, 'etc/libreoffice/registry'), { recursive: true });
  copyFileSync(source, join(root, 'etc/libreoffice/registry/main.xcd'));
}

// The paths Debian wrote into LibreOffice as absolute: the base folder, the system settings file, the
// data of language guessing.
function adaptLibreOffice(root: string): void {
  const program = join(root, 'usr/lib/libreoffice/program');
  if (!existsSync(program)) return;
  const rootUrl = pathToFileURL(root).href;
  const replace = (file: string, from: string, to: string) => {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(from)) throw new Error(`${file}: «${from}» not found — the LibreOffice package changed, check tooling/sandbox-programs/install.ts`);
    writeFileSync(file, text.replaceAll(from, to));
  };
  replace(join(program, 'fundamentalrc'), 'BRAND_BASE_DIR=file:///usr/lib/libreoffice', 'BRAND_BASE_DIR=${ORIGIN}/..');
  replace(join(program, 'sofficerc'), 'file:///etc/libreoffice', `${rootUrl}/etc/libreoffice`);
  replace(join(root, 'etc/libreoffice/registry/main.xcd'), 'file:///usr/share/libexttextcat', `${rootUrl}/usr/share/libexttextcat`);
}

function writeFontsConf(root: string): string | null {
  if (!existsSync(join(root, 'usr/share/fonts'))) return null;
  const file = join(root, 'fonts.conf');
  writeFileSync(
    file,
    [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
      '<fontconfig>',
      '  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>',
      `  <dir>${join(root, 'usr/share/fonts')}</dir>`,
      `  <include ignore_missing="yes">${join(root, 'etc/fonts/conf.d')}</include>`,
      '  <cachedir>/tmp/.cache/fontconfig</cachedir>',
      '</fontconfig>',
      '',
    ].join('\n'),
  );
  return file;
}

function firstExisting(paths: string[]): string | null {
  return paths.find((p) => existsSync(p)) ?? null;
}

function writeLaunchers(root: string): string[] {
  const libs = [join(root, 'usr/lib/libreoffice/program'), ...['usr/lib', 'lib'].flatMap((d) => (existsSync(join(root, d)) ? readdirSync(join(root, d)).filter((n) => n.endsWith('-linux-gnu')).map((n) => join(root, d, n)) : []))];
  const tessRoot = join(root, 'usr/share/tesseract-ocr');
  const env: LauncherEnv = {
    libraryDirs: libs.filter((d) => existsSync(d)),
    fontsConf: writeFontsConf(root),
    tessdata: existsSync(tessRoot) ? firstExisting(readdirSync(tessRoot).map((v) => join(tessRoot, v, 'tessdata'))) : null,
    pandocData: firstExisting([join(root, 'usr/share/pandoc')]),
  };
  const programs = join(root, 'usr/bin');
  if (!existsSync(programs)) return [];
  const names = readdirSync(programs).filter((n) => statSync(join(programs, n)).isFile());
  for (const name of names) {
    const launcher = join(BIN, name);
    if (existsSync(launcher)) throw new Error(`${launcher} exists already (a program of the Python environment?) — the launcher of ${name} would replace it`);
    writeFileSync(launcher, launcherScript(join(programs, name), env));
    chmodSync(launcher, 0o755);
  }
  writeFileSync(MANIFEST, `${names.join('\n')}\n`);
  return names;
}

function main(): void {
  if (!existsSync(BIN)) throw new Error('.venv-skills/bin is missing: run pnpm skills:setup, which creates the Python environment first');
  removePrevious();
  try {
    run('apt-get', ['--version']);
  } catch {
    console.log('sandbox programs: no apt on this machine — install the programs of core/sandbox/apt-packages.txt yourself; the server names what is missing');
    return;
  }
  const packages = packagesOfSimulation(run('apt-get', ['-s', 'install', '--no-install-recommends', ...listedPackages(readFileSync(LIST, 'utf8'))]));
  if (packages.length === 0) {
    console.log('sandbox programs: all installed in the system');
    return;
  }
  mkdirSync(ROOT, { recursive: true });
  const debs = mkdtempSync(join(VENV, 'debs-'));
  try {
    run('apt-get', ['download', ...packages], debs);
    for (const deb of readdirSync(debs).filter((f) => f.endsWith('.deb'))) run('dpkg-deb', ['-x', join(debs, deb), ROOT]);
    const unpacked = readdirSync(debs).filter((f) => f.endsWith('.deb')).length;
    if (unpacked !== packages.length) throw new Error(`apt-get download gave ${unpacked} of ${packages.length} packages: run pnpm skills:setup again`);
  } finally {
    rmSync(debs, { recursive: true, force: true });
  }
  installLibreOfficeRegistry(ROOT);
  relinkInside(ROOT);
  adaptLibreOffice(ROOT);
  const launchers = writeLaunchers(ROOT);
  console.log(`sandbox programs: ${packages.length} packages unpacked into .venv-skills/system without root, launchers: ${launchers.join(', ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
