// Ready PDFs of the viewer (spec, section 8.27; decision of the owner 18.11: «на неделю, потом сносить»).
// A PDF is made once per version of a file and kept in a folder of the server's temporary disk — not on a
// volume: lost with the container, it is simply made again. A PDF not opened for a week goes; over the size
// limit the ones opened longest ago go first. A key names the file and its version, so a changed file is
// never shown from an old PDF; the right to see the file is checked before the cache is asked.
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { logEvent } from '../server/log.ts';

// Changes when the way a PDF is made changes: the old ones are not used and age out.
export const PREVIEW_FORMAT_VERSION = 1;
export const PREVIEW_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Besides the week: a dozen big presentations a day must not fill the disk.
export const PREVIEW_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
const PURGE_EVERY_MS = 60 * 60 * 1000;
// The folder of the ready PDFs in the server's temporary folder.
export const PREVIEW_CACHE_DIR = 'bba-previews';
// A piece older than this is what a stopped server left: a conversion is never this long.
const PIECE_MAX_AGE_MS = 60 * 60 * 1000;
const PDF = '.pdf';

export interface PreviewFileVersion {
  area: string;
  rel: string;
  bytes: number;
  modifiedMs: number;
}

export function previewKey(file: PreviewFileVersion): string {
  return createHash('sha256').update([PREVIEW_FORMAT_VERSION, file.area, file.rel, file.bytes, file.modifiedMs].join('\0')).digest('hex');
}

export interface PreviewCache {
  // The ready PDF of the key, its time of use renewed; null when there is none.
  get(key: string): string | null;
  // Keeps a copy of the PDF at `from` under the key, whole or not at all.
  put(key: string, from: string): string;
  purge(now: number): { removed: number; bytes: number };
}

export function createPreviewCache({ dir, maxBytes, maxAgeMs }: { dir: string; maxBytes: number; maxAgeMs: number }): PreviewCache {
  mkdirSync(dir, { recursive: true });
  const pathOf = (key: string) => join(dir, `${key}${PDF}`);
  return {
    get(key) {
      const path = pathOf(key);
      if (!existsSync(path)) return null;
      const now = new Date();
      utimesSync(path, now, now);
      return path;
    },
    put(key, from) {
      const piece = join(dir, `.${key}.${randomUUID()}.part`);
      try {
        copyFileSync(from, piece);
        renameSync(piece, pathOf(key));
      } finally {
        rmSync(piece, { force: true });
      }
      return pathOf(key);
    },
    purge(now) {
      let removed = 0;
      let freed = 0;
      const kept: { path: string; bytes: number; usedMs: number }[] = [];
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const file = statSync(path, { throwIfNoEntry: false });
        if (!file?.isFile()) continue;
        const piece = !name.endsWith(PDF);
        if ((piece && now - file.mtimeMs > PIECE_MAX_AGE_MS) || (!piece && now - file.mtimeMs > maxAgeMs)) {
          rmSync(path, { force: true });
          removed++;
          freed += file.size;
        } else if (!piece) {
          kept.push({ path, bytes: file.size, usedMs: file.mtimeMs });
        }
      }
      let total = kept.reduce((sum, f) => sum + f.bytes, 0);
      for (const file of kept.sort((a, b) => a.usedMs - b.usedMs)) {
        if (total <= maxBytes) break;
        rmSync(file.path, { force: true });
        total -= file.bytes;
        removed++;
        freed += file.bytes;
      }
      return { removed, bytes: freed };
    },
  };
}

// Cleans the folder at the start (a container restarted keeps its temporary disk) and every hour.
export function startPreviewPurge(cache: PreviewCache): () => void {
  const pass = () => {
    try {
      const { removed, bytes } = cache.purge(Date.now());
      if (removed > 0) logEvent('info', 'preview_cache_purged', { removed, bytes });
    } catch (error) {
      logEvent('error', 'preview_cache_purge_failed', { error });
    }
  };
  pass();
  const timer = setInterval(pass, PURGE_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
