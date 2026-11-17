// The PDF of a Word, Excel or PowerPoint file for the viewer (spec, section 8.27; decisions of the owner
// 18.11): made on the first opening of a version of the file — never ahead — and then taken from the cache
// (core/preview/cache.ts) without reading the file again. At most two conversions run at once; the rest
// wait in a queue, and one waiting too long is told the server is busy. Two people opening one new
// document wait for one conversion. The route checks the right to the file before asking.
import { createWriteStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { CONVERTED_KINDS, previewKindOf, PREVIEW_MAX_BYTES, type PreviewKind } from '@bba/contracts';
import { isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import type { Limiter } from '../sandbox/limiter.ts';
import { logEvent } from '../server/log.ts';
import { areaKey, type Area } from '../storage/areas.ts';
import type { FileStorage } from '../storage/engine.ts';
import { previewKey, type PreviewCache } from './cache.ts';
import { convertToPdf, type RunCommand } from './convert.ts';
import { planSheets } from './sheets.ts';

// Conversions at once (step 114: ~450 MB of memory each, the app has 3 GB) and how long one may wait.
export const PREVIEW_MAX_CONCURRENT = 2;
export const PREVIEW_QUEUE_WAIT_MS = 60_000;
// The formats of Office that are zip archives: one beginning as an OLE container is encrypted.
const ZIPPED_OFFICE = new Set(['.docx', '.docm', '.dotx', '.xlsx', '.xlsm', '.pptx', '.ppsx']);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);
const PLANNED_SHEETS = new Set(['.xlsx', '.xlsm']);

export interface PreviewDeps {
  storage: Pick<FileStorage, 'stat' | 'openFile'>;
  cache: PreviewCache;
  run: RunCommand;
  limiter: Limiter;
  // Where the folders of conversions are made.
  workRoot: string;
}

export interface PreviewService {
  // The ready PDF of a file of the area (`rel` from the area: «files/…»). `missing` — what the person reads
  // when the file is gone, the same as for its download.
  pdf(area: Area, rel: string, missing: string): Promise<{ path: string; bytes: number }>;
}

async function startsWith(path: string, magic: Buffer): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const head = Buffer.alloc(magic.length);
    const { bytesRead } = await file.read(head, 0, magic.length, 0);
    return bytesRead === magic.length && head.equals(magic);
  } finally {
    await file.close();
  }
}

export function createPreviewService(deps: PreviewDeps): PreviewService {
  const running = new Map<string, Promise<string>>();

  async function make(area: Area, rel: string, ext: string, kind: PreviewKind, key: string, missing: string): Promise<string> {
    const started = Date.now();
    const dir = mkdtempSync(join(deps.workRoot, 'bba-preview-'));
    let bytes = 0;
    try {
      const file = await deps.storage.openFile(area, rel);
      if (!file) throw appError('APP_NOT_FOUND', 'the file to preview is gone', { userMessage: missing });
      bytes = file.bytes;
      const source = join(dir, `source${ext}`);
      await pipeline(file.stream, createWriteStream(source));
      if (ZIPPED_OFFICE.has(ext) && (await startsWith(source, OLE_MAGIC))) throw appError('APP_PREVIEW_PASSWORD', 'the document is encrypted');
      const plan = PLANNED_SHEETS.has(ext) ? planSheets(await readFile(source)) : null;
      const pdf = deps.cache.put(key, await convertToPdf(deps.run, { dir, ext, kind, plan }));
      logEvent('info', 'preview_converted', { ext, kind, bytes, ms: Date.now() - started, wholeSheets: plan?.singlePage ?? null });
      return pdf;
    } catch (error) {
      // What a person's file brings is expected; failures of the server the boundary logs (core/server/http.ts).
      if (isAppError(error) && error.status < 500) {
        logEvent('info', 'preview_failed', { code: error.code, ext, bytes, ms: Date.now() - started, reason: error.details?.reason ?? null });
      }
      throw error;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    async pdf(area, rel, missing) {
      const ext = extname(rel).toLowerCase();
      const kind = previewKindOf(basename(rel));
      if (!kind || !CONVERTED_KINDS.has(kind)) throw appError('APP_PREVIEW_UNSUPPORTED', `no conversion for ${ext || 'a file without extension'}`);
      const version = await deps.storage.stat(area, rel);
      if (!version) throw appError('APP_NOT_FOUND', 'the file to preview is gone', { userMessage: missing });
      if (version.bytes > PREVIEW_MAX_BYTES) throw appError('APP_PREVIEW_TOO_BIG', `the file is ${version.bytes} bytes`);
      const key = previewKey({ area: areaKey(area), rel, ...version });
      const ready = deps.cache.get(key);
      if (ready) {
        logEvent('info', 'preview_cache_hit', { ext, kind });
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

