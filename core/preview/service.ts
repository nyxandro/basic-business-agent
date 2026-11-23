// The folders of conversions a stopped server left hold copies of people's documents: removed at the start.
export function cleanWorkRoot(workRoot: string): void {
  for (const name of readdirSync(workRoot)) {
    if (name.startsWith(WORK_PREFIX)) rmSync(join(workRoot, name), { recursive: true, force: true });
  }
}


// The PDF of a Word, Excel or PowerPoint file for the viewer (spec, section 8.27; decisions of the owner
// 18.11): made on the first opening of a version of the file — never ahead — and then taken from the cache
// (core/preview/cache.ts) without reading the file again. At most two conversions run at once; the rest
// wait in a queue, and one waiting too long is told the server is busy. Two people opening one new
// document wait for one conversion. The route checks the right to the file before asking.
import { createWriteStream, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { CONVERTED_KINDS, previewKindOf, PREVIEW_MAX_BYTES, type PreviewKind } from '@bba/contracts';
import { isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import type { Limiter } from '../sandbox/limiter.ts';
import { logEvent } from '../log/log.ts';
import { areaKey, type Area } from '../storage/areas.ts';
import type { FileStorage } from '../storage/engine.ts';
import { previewKey, type PreviewCache } from './cache.ts';
import { isEncryptedOffice, unpackedBytesOf, ZIPPED_FORMATS, ZIPPED_OFFICE } from './checks.ts';
import { convertToPdf, type RunCommand } from './convert.ts';
import { planSheets } from './sheets.ts';

function failed(reason: string, details: Record<string, unknown>) {
  return appError('APP_PREVIEW_FAILED', `document not shown: ${reason}`, { details: { reason, ...details } });
}

// Conversions at once (step 114: ~450 MB of memory each, the app has 3 GB) and how long one may wait.
export const PREVIEW_MAX_CONCURRENT = 2;
export const PREVIEW_QUEUE_WAIT_MS = 60_000;
const PLANNED_SHEETS = new Set(['.xlsx', '.xlsm']);
// A document unpacking into more than this would hold LibreOffice and the 3 GB of the container (a crafted
// archive of 1 MB can hold gigabytes); real documents up to 50 MB unpack into far less.
export const PREVIEW_MAX_UNPACKED_BYTES = 300 * 1024 * 1024;
const WORK_PREFIX = 'bba-preview-';

export interface PreviewDeps {
  storage: Pick<FileStorage, 'stat' | 'openFile'>;
  cache: PreviewCache;
  run: RunCommand;
  limiter: Limiter;
  // Where the folders of conversions are made.
  workRoot: string;
  maxUnpackedBytes: number;
}

export interface PreviewService {
  // The ready PDF of a file of the area (`rel` from the area: «files/…»). `missing` — what the person reads
  // when the file is gone, the same as for its download.
  // `partial`: a part of a PDF already shown is asked (PDF.js reads in parts) — not logged again.
  pdf(area: Area, rel: string, missing: string, partial?: boolean): Promise<{ path: string; bytes: number }>;
}

export function createPreviewService(deps: PreviewDeps): PreviewService {
  const running = new Map<string, Promise<string>>();

  async function make(area: Area, rel: string, ext: string, kind: PreviewKind, key: string, missing: string): Promise<string> {
    const started = Date.now();
    const dir = mkdtempSync(join(deps.workRoot, WORK_PREFIX));
    let bytes = 0;
    try {
      const file = await deps.storage.openFile(area, rel);
      if (!file) throw appError('APP_NOT_FOUND', 'the file to preview is gone', { userMessage: missing });
      bytes = file.bytes;
      const source = join(dir, `source${ext}`);
      await pipeline(file.stream, createWriteStream(source));
      if (ZIPPED_OFFICE.has(ext) && (await isEncryptedOffice(source))) throw appError('APP_PREVIEW_PASSWORD', 'the document is encrypted');
      const archive = ZIPPED_FORMATS.has(ext) ? await readFile(source) : null;
      const unpacked = archive ? unpackedBytesOf(archive) : null;
      if (unpacked !== null && unpacked > deps.maxUnpackedBytes) throw failed('unpacked_too_big', { unpacked });
      const plan = archive && PLANNED_SHEETS.has(ext) ? planSheets(archive) : null;
      const pdf = deps.cache.put(key, await convertToPdf(deps.run, { dir, ext, kind, plan }));
      logEvent('info', 'preview_converted', { ext, kind, bytes, ms: Date.now() - started, wholeSheets: plan?.singlePage ?? null });
      return pdf;
    } catch (error) {
      // What a person's file brings is expected; failures of the server the boundary logs (core/http/http.ts).
      if (isAppError(error) && error.status < 500) {
        logEvent('info', 'preview_failed', { code: error.code, ext, bytes, ms: Date.now() - started, reason: error.details?.reason ?? null });
      }
      throw error;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    async pdf(area, rel, missing, partial = false) {
      const ext = extname(rel).toLowerCase();
      const kind = previewKindOf(basename(rel));
      if (!kind || !CONVERTED_KINDS.has(kind)) throw appError('APP_PREVIEW_UNSUPPORTED', `no conversion for ${ext || 'a file without extension'}`);
      const version = await deps.storage.stat(area, rel);
      if (!version) throw appError('APP_NOT_FOUND', 'the file to preview is gone', { userMessage: missing });
      if (version.bytes > PREVIEW_MAX_BYTES) throw appError('APP_PREVIEW_TOO_BIG', `the file is ${version.bytes} bytes`);
      const key = previewKey({ area: areaKey(area), rel, ...version });
      const ready = deps.cache.get(key);
      if (ready) {
        if (!partial) logEvent('info', 'preview_cache_hit', { ext, kind });
        return { path: ready, bytes: statSync(ready).size };
      }
      let made = running.get(key);
      if (!made) {
        made = deps.limiter
          .run(() => make(area, rel, ext, kind, key, missing))
          .catch((error: unknown) => {
            if (isAppError(error) && error.code === 'APP_SANDBOX_BUSY') throw appError('APP_PREVIEW_BUSY', 'the queue of conversions is full', { cause: error, details: { reason: 'queue' } });
            throw error;
          })
          .finally(() => running.delete(key));
        running.set(key, made);
      }
      const path = await made;
      return { path, bytes: statSync(path).size };
    },
  };
}

