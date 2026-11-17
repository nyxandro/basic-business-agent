import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPreviewCache, previewKey } from './cache.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
let dir: string;
let work: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bba-preview-cache-'));
  work = mkdtempSync(join(tmpdir(), 'bba-preview-work-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function pdf(name: string, bytes: number): string {
  const path = join(work, name);
  writeFileSync(path, Buffer.alloc(bytes, 1));
  return path;
}

const aged = (path: string, ms: number) => utimesSync(path, new Date(ms), new Date(ms));

describe('ready PDFs of the viewer (spec, section 8.27)', () => {
  it('a key changes with the file: its place, size or time of change', () => {
    const base = { area: 'users/olga', rel: 'files/КП.docx', bytes: 10, modifiedMs: 1_700_000_000_000 };
    expect(previewKey(base)).toBe(previewKey({ ...base }));
    for (const other of [{ area: 'users/petr' }, { rel: 'files/КП2.docx' }, { bytes: 11 }, { modifiedMs: 1_700_000_000_001 }]) {
      expect(previewKey({ ...base, ...other })).not.toBe(previewKey(base));
    }
  });

  it('keeps a PDF under its key and gives it back; a key never put has none', () => {
    const cache = createPreviewCache({ dir, maxBytes: 1_000_000, maxAgeMs: 7 * DAY_MS });
    expect(cache.get('a')).toBeNull();
    const kept = cache.put('a', pdf('a.pdf', 5));
    expect(cache.get('a')).toBe(kept);
    expect(readFileSync(kept).length).toBe(5);
    // Only the whole file is ever under the key: nothing half-written is left in the folder.
    expect(readdirSync(dir)).toEqual(['a.pdf']);
  });

  it('removes what was not opened for a week, and the oldest ones over the size limit', () => {
    const cache = createPreviewCache({ dir, maxBytes: 250, maxAgeMs: 7 * DAY_MS });
    const now = Date.now();
    aged(cache.put('old', pdf('o.pdf', 10)), now - 8 * DAY_MS);
    aged(cache.put('first', pdf('1.pdf', 100)), now - 3 * DAY_MS);
    aged(cache.put('second', pdf('2.pdf', 100)), now - 2 * DAY_MS);
    aged(cache.put('third', pdf('3.pdf', 100)), now - DAY_MS);
    expect(cache.purge(now)).toEqual({ removed: 2, bytes: 110 });
    expect(readdirSync(dir).sort()).toEqual(['second.pdf', 'third.pdf']);
  });

  it('a PDF opened again counts as fresh', () => {
    const cache = createPreviewCache({ dir, maxBytes: 150, maxAgeMs: 7 * DAY_MS });
    const now = Date.now();
    aged(cache.put('used', pdf('u.pdf', 100)), now - 3 * DAY_MS);
    aged(cache.put('newer', pdf('n.pdf', 100)), now - 2 * DAY_MS);
    cache.get('used');
    cache.purge(now);
    expect(readdirSync(dir)).toEqual(['used.pdf']);
  });

  it('cleans up pieces a stopped server left half-written', () => {
    const cache = createPreviewCache({ dir, maxBytes: 1_000, maxAgeMs: 7 * DAY_MS });
    const piece = join(dir, '.x.123.part');
    writeFileSync(piece, 'half');
    aged(piece, Date.now() - 2 * 60 * 60 * 1000);
    cache.purge(Date.now());
    expect(readdirSync(dir)).toEqual([]);
  });
});
