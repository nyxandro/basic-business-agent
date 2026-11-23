// The text of a document of the run's folder, for the model (spec, section 8.29). Made on the first request
// for a version of the file — never ahead — in the sandbox, and kept a week in the server's temporary folder,
// as the viewer's PDF (core/preview). A refusal (a password, a broken file, a scan, 90 s without a text) is kept too:
// a file a program hangs on must not hold every next call of the model. A busy server is not kept.
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { extname, join } from 'node:path';
import { isAppError } from '../errors/app-error.ts';
import type { PreviewCache } from '../preview/cache.ts';
import { isEncryptedOffice, unpackedBytesOf, ZIPPED_FORMATS, ZIPPED_OFFICE } from '../preview/checks.ts';
import type { RunCommand } from '../preview/convert.ts';
import { PREVIEW_MAX_BYTES } from '@bba/contracts';
import type { Limiter } from '../sandbox/limiter.ts';
import { logEvent } from '../log/log.ts';
import { copyOpened } from '../workspace/held-folder.ts';
import { openFileInside } from '../workspace/layout.ts';
import { docFormatOf, extractText, needsOffice, type DocKind, type Extracted } from './extract.ts';

// Changes when the way a text is made changes: the old ones are not used and age out.
export const DOC_TEXT_FORMAT_VERSION = 1;
export const DOC_TEXT_CACHE_DIR = 'bba-texts';
export const DOC_TEXT_CACHE_SUFFIX = '.json';
export const DOC_TEXT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DOC_TEXT_CACHE_MAX_BYTES = 256 * 1024 * 1024;
// Kept of a text: far more than a message ever shows (core/doctext/excerpt.ts), the length counted in full.
export const DOC_TEXT_KEPT_CHARS = 64_000;
const WORK_PREFIX = 'bba-doctext-';

export type DocText =
  | { state: 'ok'; kind: DocKind; text: string; chars: number; pages: number | null; emptyPages: number[]; hiddenSheets: string[] }
  | { state: 'scan'; kind: 'pdf'; pages: number }
  | { state: 'password' | 'failed' | 'slow' | 'too_big' | 'missing' | 'busy'; kind: DocKind };

export interface DocTextDeps {
  run: RunCommand;
  // LibreOffice's runs, shared with the viewer: ~450 MB each (core/preview/service.ts).
  officeLimiter: Limiter;
  // The commands of the sandbox of the installation (spec, section 8.7).
  commandLimiter: Limiter;
  cache: PreviewCache;
  // Where the folders of extraction are made.
  workRoot: string;
  pptxScripts: string;
  timezone: string;
  maxUnpackedBytes: number;
}

export interface DocTextService {
  // The text of `path` in the folder `root` (the run's working folder); null — not a document.
  text(root: string, path: string): Promise<DocText | null>;
  // The whole text of a document given as bytes, not cut and not kept (the knowledge base reads its documents once,
  // docs/specs/[20.11.2026]-knowledge-base.md); null — not a document.
  full(bytes: Uint8Array, ext: string): Promise<Extracted | null>;
}

// The folders of extraction a stopped server left hold copies of people's documents: removed at the start.
export function cleanDocTextWork(workRoot: string): void {
  for (const name of readdirSync(workRoot)) {
    if (name.startsWith(WORK_PREFIX)) rmSync(join(workRoot, name), { recursive: true, force: true });
  }
}

// The version of a file: its size, its times of change and its inode. `ctime` is set by the system on every write
// and cannot be carried over by a copy or an unpacked archive, as the time of change can (`cp -p`, unzip).
function keyOf(root: string, path: string, stat: Stats): string {
  return createHash('sha256').update([DOC_TEXT_FORMAT_VERSION, root, path, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join('\0')).digest('hex');
}

function asDocText(kind: DocKind, done: Extracted): DocText {
  if (done.state === 'ok') return { state: 'ok', kind, text: done.text.slice(0, DOC_TEXT_KEPT_CHARS), chars: done.text.length, pages: done.pages, emptyPages: done.emptyPages, hiddenSheets: done.hiddenSheets };
  if (done.state === 'scan') return { state: 'scan', kind: 'pdf', pages: done.pages };
  return { state: done.state, kind };
}

export function createDocTextService(deps: DocTextDeps): DocTextService {
  const running = new Map<string, Promise<DocText>>();

  function remembered(key: string): DocText | null {
    const path = deps.cache.get(key);
    return path ? (JSON.parse(readFileSync(path, 'utf8')) as DocText) : null;
  }

  function remember(key: string, doc: DocText, dir: string): void {
    const file = join(dir, `text${DOC_TEXT_CACHE_SUFFIX}`);
    writeFileSync(file, JSON.stringify(doc));
    deps.cache.put(key, file);
  }

  async function make(fd: number, ext: string, kind: DocKind, key: string, bytes: number): Promise<DocText> {
    const started = Date.now();
    const dir = mkdtempSync(join(deps.workRoot, WORK_PREFIX));
    try {
      const source = join(dir, `source${ext}`);
      copyOpened(fd, source);
      let done: Extracted;
      if (ZIPPED_OFFICE.has(ext) && (await isEncryptedOffice(source))) done = { state: 'password', reason: 'ole_container' };
      else {
        const unpacked = ZIPPED_FORMATS.has(ext) ? unpackedBytesOf(readFileSync(source)) : null;
        if (unpacked !== null && unpacked > deps.maxUnpackedBytes) done = { state: 'failed', reason: 'unpacked_too_big' };
        else {
          const limiter = needsOffice(ext) ? deps.officeLimiter : deps.commandLimiter;
          done = await limiter.run(() => extractText(deps.run, { dir, ext, pptxScripts: deps.pptxScripts, timezone: deps.timezone }));
        }
      }
      const doc = asDocText(kind, done);
      if (done.state === 'ok') logEvent('info', 'doctext_extracted', { ext, kind, bytes, chars: done.text.length, ms: Date.now() - started });
      else logEvent('info', 'doctext_failed', { ext, kind, bytes, state: done.state, reason: done.state === 'scan' ? 'scan' : done.reason, ms: Date.now() - started });
      if (done.state !== 'busy') remember(key, doc, dir);
      return doc;
    } catch (error) {
      // The queue of the sandbox is full: the next request tries again.
      if (isAppError(error) && error.code === 'APP_SANDBOX_BUSY') {
        logEvent('info', 'doctext_failed', { ext, kind, bytes, state: 'busy', reason: 'queue', ms: Date.now() - started });
        return { state: 'busy', kind };
      }
      throw error;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    async full(bytes, ext) {
      const format = docFormatOf(ext.toLowerCase());
      if (!format) return null;
      const dir = mkdtempSync(join(deps.workRoot, WORK_PREFIX));
      try {
        const source = join(dir, `source${ext.toLowerCase()}`);
        writeFileSync(source, bytes);
        if (ZIPPED_OFFICE.has(ext.toLowerCase()) && (await isEncryptedOffice(source))) return { state: 'password', reason: 'ole_container' };
        const unpacked = ZIPPED_FORMATS.has(ext.toLowerCase()) ? unpackedBytesOf(readFileSync(source)) : null;
        if (unpacked !== null && unpacked > deps.maxUnpackedBytes) return { state: 'failed', reason: 'unpacked_too_big' };
        const limiter = needsOffice(ext.toLowerCase()) ? deps.officeLimiter : deps.commandLimiter;
        return await limiter.run(() => extractText(deps.run, { dir, ext: ext.toLowerCase(), pptxScripts: deps.pptxScripts, timezone: deps.timezone }));
      } catch (error) {
        if (isAppError(error) && error.code === 'APP_SANDBOX_BUSY') return { state: 'busy', reason: 'queue' };
        throw error;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    async text(root, path) {
      const ext = extname(path).toLowerCase();
      const format = docFormatOf(ext);
      if (!format) return null;
      const { kind } = format;
      let opened: { fd: number; size: number } | null;
      try {
        opened = openFileInside(root, path);
      } catch (error) {
        // A path out of the folder is no file of it.
        if (isAppError(error)) return { state: 'missing', kind };
        throw error;
      }
      if (!opened) return { state: 'missing', kind };
      const { fd } = opened;
      try {
        const stat = fstatSync(fd);
        if (stat.size > PREVIEW_MAX_BYTES) return { state: 'too_big', kind };
        const key = keyOf(root, path, stat);
        const ready = remembered(key);
        if (ready) {
          logEvent('info', 'doctext_cache_hit', { ext, kind });
          return ready;
        }
        let made = running.get(key);
        if (!made) {
          made = make(fd, ext, kind, key, stat.size).finally(() => running.delete(key));
          running.set(key, made);
        }
        return await made;
      } finally {
        closeSync(fd);
      }
    },
  };
}
