// The `.skill` file (spec, section 8.15): a zip archive with one top-level folder named after the
// skill and SKILL.md in it. Everything is checked before anything is written to disk:
// - sizes: ≤ 10 MB archive, ≤ 50 MB unpacked by the archive's table of contents, ≤ 500 files;
// - paths: no "..", absolute paths, backslashes or drive letters; no links or special files;
// - integrity: each unpacked file has the size and checksum the table of contents names.
// The table of contents is read here because the zip library does not show file types (a link
// would pass as a file); the library then unpacks into buffers of the declared sizes, so an
// archive lying about its sizes cannot fill the memory, and the checksum catches the lie.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { parse as parseYaml } from 'yaml';
import { appError } from '../errors/catalog.ts';

export const ARCHIVE_MAX_BYTES = 10 * 1024 * 1024;
export const UNPACKED_MAX_BYTES = 50 * 1024 * 1024;
export const FILES_MAX = 500;
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;
const DESCRIPTION_MAX = 1024;
const SCRIPT_EXTENSIONS = /\.(py|sh|bash|js|mjs|cjs|ts|rb|pl)$/i;
// A packed skill does not change with the time it was packed: the same sources, the same file.
const PACK_TIME = new Date('2026-01-01T00:00:00Z');

const SIG_END = 0x06054b50;
const SIG_ENTRY = 0x02014b50;
const END_MIN = 22;
const ENTRY_MIN = 46;
const COMMENT_MAX = 0xffff;
const HOST_UNIX = 3;
const TYPE_MASK = 0o170000;
const TYPE_FILE = 0o100000;
const TYPE_DIR = 0o040000;
const FLAG_ENCRYPTED = 0x1;

export interface SkillPackage {
  name: string;
  // For people: the first heading of SKILL.md.
  title: string;
  description: string;
  hasScripts: boolean;
  sha256: string;
  sizeBytes: number;
  // Paths inside the skill folder, without the top-level folder.
  files: Map<string, Uint8Array>;
}

interface Entry {
  name: string;
  size: number;
  crc: number;
  directory: boolean;
}

export function invalidSkill(reason: string, cause?: unknown) {
  return appError('APP_SKILL_INVALID', `skill archive refused: ${reason}`, { userMessage: `Файл скилла не подходит: ${reason}.`, ...(cause !== undefined ? { cause } : {}) });
}

function checkPath(name: string): void {
  const path = name.endsWith('/') ? name.slice(0, -1) : name;
  const segments = path.split('/');
  if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name) || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw invalidSkill(`путь «${name}» ведёт за пределы папки скилла`);
  }
}

// The central directory: names, declared sizes, checksums and the file type of each entry.
function readEntries(zip: Uint8Array): Entry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - END_MIN; i >= Math.max(0, zip.length - END_MIN - COMMENT_MAX); i--) {
    if (view.getUint32(i, true) === SIG_END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw invalidSkill('это не zip-архив');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + ENTRY_MIN > zip.length || view.getUint32(at, true) !== SIG_ENTRY) throw invalidSkill('архив повреждён');
    const host = view.getUint16(at + 4, true) >> 8;
    const flags = view.getUint16(at + 8, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const mode = view.getUint32(at + 38, true) >>> 16;
    if (at + ENTRY_MIN + nameLength > zip.length) throw invalidSkill('архив повреждён');
    let name: string;
    try {
      name = decoder.decode(zip.subarray(at + ENTRY_MIN, at + ENTRY_MIN + nameLength));
    } catch (error) {
      throw invalidSkill('имена файлов не в UTF-8', error);
    }
    if (flags & FLAG_ENCRYPTED) throw invalidSkill('архив зашифрован');
    checkPath(name);
    const type = host === HOST_UNIX ? mode & TYPE_MASK : 0;
    if (type !== 0 && type !== TYPE_FILE && type !== TYPE_DIR) throw invalidSkill(`«${name}» — ссылка или особый файл, а не обычный файл`);
    entries.push({ name, size, crc, directory: name.endsWith('/') || type === TYPE_DIR });
    at += ENTRY_MIN + nameLength + extraLength + commentLength;
  }
  return entries;
}

function frontmatter(text: string): { name: unknown; description: unknown; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw invalidSkill('в SKILL.md нет заголовка с name и description');
  let fields: unknown;
  try {
    fields = parseYaml(match[1]!);
  } catch (error) {
    throw invalidSkill('заголовок SKILL.md не читается', error);
  }
  const record = (fields ?? {}) as Record<string, unknown>;
  return { name: record.name, description: record.description, body: match[2]! };
}

export function readSkillArchive(zip: Uint8Array): SkillPackage {
  if (zip.length > ARCHIVE_MAX_BYTES) throw invalidSkill(`файл больше ${ARCHIVE_MAX_BYTES / 1024 / 1024} МБ`);
  const entries = readEntries(zip);
  const files = entries.filter((e) => !e.directory);
  if (files.length > FILES_MAX) throw invalidSkill(`в архиве больше ${FILES_MAX} файлов`);
  if (files.reduce((sum, e) => sum + e.size, 0) > UNPACKED_MAX_BYTES) throw invalidSkill(`в распакованном виде больше ${UNPACKED_MAX_BYTES / 1024 / 1024} МБ`);
  const tops = new Set(entries.map((e) => e.name.split('/')[0]!));
  if (tops.size !== 1 || files.some((e) => !e.name.includes('/'))) throw invalidSkill('в архиве должна быть ровно одна папка скилла');
  const top = [...tops][0]!;

  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(zip, { filter: (f) => !f.name.endsWith('/') });
  } catch (error) {
    throw invalidSkill('архив повреждён', error);
  }
  const content = new Map<string, Uint8Array>();
  for (const e of files) {
    const data = unpacked[e.name];
    if (!data || data.length !== e.size || crc32(data) !== e.crc) throw invalidSkill(`файл «${e.name}» повреждён`);
    content.set(e.name.slice(top.length + 1), data);
  }

  const skillMd = content.get('SKILL.md');
  if (!skillMd) throw invalidSkill(`в папке «${top}» нет SKILL.md`);
  const meta = frontmatter(new TextDecoder().decode(skillMd));
  if (typeof meta.name !== 'string' || !SKILL_NAME.test(meta.name)) throw invalidSkill('name в SKILL.md — от 2 до 64 строчных латинских букв, цифр и дефисов');
  if (meta.name !== top) throw invalidSkill(`папка «${top}» должна называться как скилл — «${meta.name}»`);
  if (typeof meta.description !== 'string' || meta.description.trim() === '' || meta.description.length > DESCRIPTION_MAX) {
    throw invalidSkill(`description в SKILL.md — от 1 до ${DESCRIPTION_MAX} символов`);
  }
  const heading = /^#\s+(.+?)\s*$/m.exec(meta.body)?.[1];
  return {
    name: meta.name,
    title: heading ?? meta.name,
    description: meta.description.trim(),
    hasScripts: [...content.keys()].some((p) => p.startsWith('scripts/') || SCRIPT_EXTENSIONS.test(p)),
    sha256: createHash('sha256').update(zip).digest('hex'),
    sizeBytes: zip.length,
    files: content,
  };
}

// A copy of a skill is shared by everyone who has it, and the file tools of the agents reach it (the
// sandbox mounts it read-only, but those tools run in the server): its files and folders are made
// read-only, so no agent can change the skill for the others. Only the server removes a copy.
const READ_ONLY_FILE = 0o444;
const READ_ONLY_FOLDER = 0o555;
const WRITABLE_FOLDER = 0o755;

function chmodFolders(dir: string, mode: number): void {
  chmodSync(dir, mode);
  for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) chmodFolders(join(dir, entry.name), mode);
}

// Makes an existing copy read-only: copies unpacked before 15.11 were left writable.
export function lockSkillFolder(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) if (entry.isFile()) chmodSync(join(entry.parentPath, entry.name), READ_ONLY_FILE);
  chmodFolders(dir, READ_ONLY_FOLDER);
}

// Removes a copy of a skill (or anything under the folder of copies) with its read-only folders.
export function removeSkillFolder(dir: string): void {
  if (!existsSync(dir)) return;
  if (statSync(dir).isDirectory()) chmodFolders(dir, WRITABLE_FOLDER);
  rmSync(dir, { recursive: true, force: true });
}

// Writes the files into `dir` through a temporary folder next to it: a half-written copy is never seen.
export function writeSkillFiles(files: ReadonlyMap<string, Uint8Array>, dir: string): void {
  const temp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  removeSkillFolder(temp);
  for (const [path, data] of files) {
    const full = join(temp, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data, { mode: READ_ONLY_FILE });
  }
  chmodFolders(temp, READ_ONLY_FOLDER);
  mkdirSync(dirname(dir), { recursive: true });
  removeSkillFolder(dir);
  renameSync(temp, dir);
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((p) => statSync(join(dir, p)).isFile() && !p.split(sep).some((s) => s.startsWith('.') || s === '__pycache__'))
    .sort();
}

// `pnpm skills:pack`: the folder of a skill into a `.skill` file, the same bytes for the same sources.
export function packSkill(dir: string): Uint8Array {
  const name = dir.split(sep).filter(Boolean).at(-1)!;
  const tree: Zippable = {};
  for (const path of listFiles(dir)) {
    tree[`${name}/${relative(dir, join(dir, path)).split(sep).join('/')}`] = [readFileSync(join(dir, path)), { mtime: PACK_TIME, os: HOST_UNIX, attrs: (TYPE_FILE | 0o644) << 16 }];
  }
  return zipSync(tree, { level: 9 });
}
