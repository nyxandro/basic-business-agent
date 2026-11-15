// What the sandbox gives the scripts of skills (spec, sections 8.7 and 8.18): programs of the
// machine (core/sandbox/apt-packages.txt), Python libraries (requirements.txt, in .venv-skills) and
// Node packages (node/package.json, in .venv-skills/node). The system skills of documents expect all
// of them installed and cannot install anything themselves (no network), so the server does not start
// without them: otherwise the first document of an employee would break.
import type { SkillsSandbox } from '@bba/contracts';
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appError } from '../errors/catalog.ts';

const REQUIREMENTS = new URL('./requirements.txt', import.meta.url);
const NODE_MANIFEST = new URL('./node/package.json', import.meta.url);

// Programs as the admin panel names them, with the commands the skills run.
const PROGRAMS: { title: string; commands: string[] }[] = [
  { title: 'LibreOffice', commands: ['soffice'] },
  { title: 'pandoc', commands: ['pandoc'] },
  { title: 'poppler', commands: ['pdftoppm', 'pdftotext', 'pdfimages'] },
  { title: 'qpdf', commands: ['qpdf'] },
  { title: 'tesseract', commands: ['tesseract'] },
];

// The module each library of requirements.txt is imported as.
export const PYTHON_MODULES: Record<string, string> = {
  pypdf: 'pypdf',
  pypdfium2: 'pypdfium2',
  pillow: 'PIL',
  'python-docx': 'docx',
  openpyxl: 'openpyxl',
  lxml: 'lxml',
  defusedxml: 'defusedxml',
  'python-pptx': 'pptx',
  pandas: 'pandas',
  pdfplumber: 'pdfplumber',
  reportlab: 'reportlab',
  pdf2image: 'pdf2image',
  pytesseract: 'pytesseract',
  markitdown: 'markitdown',
};

// Scanned pages of Russian documents; English for mixed text.
const OCR_LANGUAGES = ['rus', 'eng'];

// Folders of the machine the programs read besides /usr and the few files Mastra's sandbox mounts
// itself: font configuration (fontconfig) and LibreOffice's own configuration (Debian keeps its
// sofficerc there). Without them LibreOffice in the sandbox has no fonts or does not start.
export const SANDBOX_SYSTEM_PATHS = ['/etc/fonts', '/etc/libreoffice'];

const SYSTEM_BIN_DIRS = ['/usr/local/bin', '/usr/bin', '/bin'];

// PATH of a sandbox command: the Python of the skills, the Node the server runs on (Mastra's sandbox
// mounts its folder) and the system.
export function sandboxPath(venv: string): string {
  return [join(venv, 'bin'), dirname(process.execPath), ...SYSTEM_BIN_DIRS].join(':');
}

export function nodeModulesDir(venv: string): string {
  return join(venv, 'node', 'node_modules');
}

export function pythonLibraries(): string[] {
  return readFileSync(REQUIREMENTS, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/[[=<>~! ]/)[0]!);
}

export function nodePackages(): string[] {
  const manifest = JSON.parse(readFileSync(NODE_MANIFEST, 'utf8')) as { dependencies: Record<string, string> };
  return Object.keys(manifest.dependencies).sort();
}

export function sandboxContents(): SkillsSandbox {
  return { programs: PROGRAMS.map((p) => p.title), python: pythonLibraries(), node: nodePackages() };
}

export interface SandboxGaps {
  programs: string[];
  python: string[];
  node: string[];
  ocrLanguages: string[];
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function moduleOf(library: string): string {
  const module = PYTHON_MODULES[library];
  if (!module) throw new Error(`core/sandbox/requirements.txt lists ${library}, but PYTHON_MODULES has no module for it`);
  return module;
}

function missingModules(python: string, libraries: string[]): string[] {
  const modules = libraries.map(moduleOf);
  if (!executable(python)) return libraries;
  // find_spec looks the module up without importing it: the check costs no import of pandas.
  const code = 'import importlib.util,sys\nfor n in sys.argv[1:]:\n  print(n if importlib.util.find_spec(n) is None else "")';
  const out = execFileSync(python, ['-I', '-c', code, ...modules], { encoding: 'utf8' }).split('\n');
  return libraries.filter((_, i) => out[i] !== '');
}

function missingOcrLanguages(tesseract: string | undefined): string[] {
  if (!tesseract) return OCR_LANGUAGES;
  const listed = execFileSync(tesseract, ['--list-langs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').map((l) => l.trim());
  return OCR_LANGUAGES.filter((l) => !listed.includes(l));
}

// `binDirs`: where the sandbox looks for programs besides the Python of the skills (tests narrow it).
export function findSandboxGaps(venv: string, binDirs: string[] = SYSTEM_BIN_DIRS): SandboxGaps {
  const where = (command: string) => [join(venv, 'bin'), ...binDirs].map((d) => join(d, command)).find(executable);
  const commands = PROGRAMS.flatMap((p) => p.commands);
  return {
    programs: commands.filter((c) => !where(c)),
    python: missingModules(join(venv, 'bin', 'python'), pythonLibraries()),
    node: nodePackages().filter((p) => !existsSync(join(nodeModulesDir(venv), p, 'package.json'))),
    ocrLanguages: missingOcrLanguages(where('tesseract')),
  };
}

export function assertSandboxEnvironment(venv: string, binDirs?: string[]): void {
  const gaps = findSandboxGaps(venv, binDirs);
  const parts = [
    gaps.programs.length ? `programs: ${gaps.programs.join(', ')}` : '',
    gaps.ocrLanguages.length ? `tesseract languages: ${gaps.ocrLanguages.join(', ')}` : '',
    gaps.python.length ? `python libraries: ${gaps.python.join(', ')}` : '',
    gaps.node.length ? `node packages: ${gaps.node.join(', ')}` : '',
  ].filter(Boolean);
  if (parts.length === 0) return;
  throw appError(
    'APP_SANDBOX_UNAVAILABLE',
    `the sandbox of skills lacks ${parts.join('; ')}. Install the programs of core/sandbox/apt-packages.txt ` +
      `(Ubuntu: sudo apt install -y --no-install-recommends $(grep -v '^#' core/sandbox/apt-packages.txt)) and run pnpm skills:setup`,
  );
}
