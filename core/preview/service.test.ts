import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLimiter } from '../sandbox/limiter.ts';
import { userArea } from '../storage/areas.ts';
import { createPreviewCache } from './cache.ts';
import type { RunCommand } from './convert.ts';
import { cleanWorkRoot, createPreviewService } from './service.ts';

const OLGA = userArea('olga');
const DAY_MS = 24 * 60 * 60 * 1000;
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0];

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bba-preview-service-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// The files of Ольга's folder as the storage gives them; `opened` counts the reads of a whole file.
function storageOf(files: Record<string, { bytes: number[]; modifiedMs?: number; size?: number }>) {
  const opened: string[] = [];
  return {
    opened,
    storage: {
      stat: (_area: unknown, rel: string) => Promise.resolve(files[rel] ? { bytes: files[rel].size ?? files[rel].bytes.length, modifiedMs: files[rel].modifiedMs ?? 1 } : null),
      openFile: (_area: unknown, rel: string) => {
        opened.push(rel);
        const file = files[rel];
        return Promise.resolve(file ? { stream: Readable.from([Buffer.from(file.bytes)]), bytes: file.bytes.length } : null);
      },
    },
  };
}

// LibreOffice that writes a PDF after `waitMs`, counting its runs.
function libreOffice(waitMs = 0) {
  const runs: string[] = [];
  const run: RunCommand = async (cwd, program, args) => {
    runs.push(args.at(-1)!);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    mkdirSync(join(cwd, 'out'), { recursive: true });
    writeFileSync(join(cwd, 'out', 'source.pdf'), `%PDF from ${program}`);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { run, runs };
}

function service(files: Parameters<typeof storageOf>[0], run: RunCommand, { max = 2, waitMs = 60_000, maxUnpackedBytes = 1_000_000 } = {}) {
  const { storage, opened } = storageOf(files);
  const cache = createPreviewCache({ dir: join(root, 'cache'), maxBytes: 1_000_000, maxAgeMs: 7 * DAY_MS });
  const preview = createPreviewService({ storage, cache, run, limiter: createLimiter(max, waitMs), workRoot: root, maxUnpackedBytes });
  return { preview, opened };
}

describe('the PDF of a document for the viewer (spec, section 8.27)', () => {
  it('makes it once: the same version of the file comes from the cache without reading the file', async () => {
    const lo = libreOffice();
    const { preview, opened } = service({ 'files/КП.docx': { bytes: [...ZIP, 1, 2] } }, lo.run);
    const first = await preview.pdf(OLGA, 'files/КП.docx', 'Файл не найден.');
    expect(readFileSync(first.path, 'latin1')).toBe('%PDF from soffice');
    const again = await preview.pdf(OLGA, 'files/КП.docx', 'Файл не найден.');
    expect(again).toEqual(first);
    expect(lo.runs).toEqual(['source.docx']);
    expect(opened).toEqual(['files/КП.docx']);
    // The folder of the conversion is gone.
    expect(readdirSync(root).filter((name) => name.startsWith('bba-preview-'))).toEqual([]);
  });

  it('a changed file is made again', async () => {
    const lo = libreOffice();
    const files = { 'files/КП.docx': { bytes: [...ZIP, 1], modifiedMs: 1 } };
    const { preview } = service(files, lo.run);
    await preview.pdf(OLGA, 'files/КП.docx', 'Файл не найден.');
    files['files/КП.docx'] = { bytes: [...ZIP, 1, 2], modifiedMs: 2 };
    await preview.pdf(OLGA, 'files/КП.docx', 'Файл не найден.');
    expect(lo.runs).toHaveLength(2);
  });

  it('two people opening one new document wait for one conversion', async () => {
    const lo = libreOffice(30);
    const { preview } = service({ 'files/КП.docx': { bytes: [...ZIP] } }, lo.run);
    const [a, b] = await Promise.all([preview.pdf(OLGA, 'files/КП.docx', '-'), preview.pdf(OLGA, 'files/КП.docx', '-')]);
    expect(a).toEqual(b);
    expect(lo.runs).toHaveLength(1);
  });

  it('runs at most the set number of conversions; one waiting too long is told the server is busy', async () => {
    const lo = libreOffice(80);
    const files = { 'files/a.docx': { bytes: [...ZIP, 1] }, 'files/b.docx': { bytes: [...ZIP, 2] } };
    const { preview } = service(files, lo.run, { max: 1, waitMs: 20 });
    const first = preview.pdf(OLGA, 'files/a.docx', '-');
    await expect(preview.pdf(OLGA, 'files/b.docx', '-')).rejects.toMatchObject({ code: 'APP_PREVIEW_BUSY', status: 503 });
    await first;
  });

  it('says what is wrong before running LibreOffice: another kind, too big, gone, a password', async () => {
    const lo = libreOffice();
    const { preview } = service(
      {
        'files/a.zip': { bytes: [1] },
        'files/скан.pdf': { bytes: [1] },
        'files/big.pptx': { bytes: [...ZIP], size: 50 * 1024 * 1024 + 1 },
        'files/secret.docx': { bytes: [...OLE, 0, 0] },
      },
      lo.run,
    );
    await expect(preview.pdf(OLGA, 'files/a.zip', '-')).rejects.toMatchObject({ code: 'APP_PREVIEW_UNSUPPORTED' });
    // A PDF the browser shows as it is.
    await expect(preview.pdf(OLGA, 'files/скан.pdf', '-')).rejects.toMatchObject({ code: 'APP_PREVIEW_UNSUPPORTED' });
    await expect(preview.pdf(OLGA, 'files/big.pptx', '-')).rejects.toMatchObject({ code: 'APP_PREVIEW_TOO_BIG' });
    await expect(preview.pdf(OLGA, 'files/нет.docx', 'Файл «нет.docx» удалён.')).rejects.toMatchObject({ code: 'APP_NOT_FOUND', userMessage: 'Файл «нет.docx» удалён.' });
    await expect(preview.pdf(OLGA, 'files/secret.docx', '-')).rejects.toMatchObject({ code: 'APP_PREVIEW_PASSWORD' });
    expect(lo.runs).toEqual([]);
  });

  // By the independent review of 18.11: a small archive that unpacks into gigabytes would hold LibreOffice and
  // the memory of the container — refused by the sizes its archive tells, before anything is unpacked.
  it('refuses an archive of Office that unpacks into more than the limit, without running LibreOffice', async () => {
    const lo = libreOffice();
    const bomb = zipSync({ 'xl/worksheets/sheet1.xml': strToU8(' '.repeat(5_000)) });
    const { preview } = service({ 'files/бомба.xlsx': { bytes: [...bomb] }, 'files/обычный.xlsx': { bytes: [...zipSync({ 'xl/workbook.xml': strToU8('<x/>') })] } }, lo.run, { maxUnpackedBytes: 1_000 });
    await expect(preview.pdf(OLGA, 'files/бомба.xlsx', '-')).rejects.toMatchObject({ code: 'APP_PREVIEW_FAILED', details: { reason: 'unpacked_too_big' } });
    await preview.pdf(OLGA, 'files/обычный.xlsx', '-');
    expect(lo.runs).toEqual(['source.xlsx']);
  });

  it('clears the folders of conversions a stopped server left', () => {
    mkdirSync(join(root, 'bba-preview-left'));
    mkdirSync(join(root, 'other'));
    cleanWorkRoot(root);
    expect(existsSync(join(root, 'bba-preview-left'))).toBe(false);
    expect(existsSync(join(root, 'other'))).toBe(true);
  });

  it('an old Word file in its own binary format is converted, not taken for one with a password', async () => {
    const lo = libreOffice();
    const { preview } = service({ 'files/старый.doc': { bytes: [...OLE, 1] } }, lo.run);
    await preview.pdf(OLGA, 'files/старый.doc', '-');
    expect(lo.runs).toEqual(['source.doc']);
  });

  it('a failed conversion leaves no folder and nothing in the cache; the next attempt runs again', async () => {
    let fail = true;
    const runs: number[] = [];
    const run: RunCommand = (cwd) => {
      runs.push(1);
      if (!fail) {
        mkdirSync(join(cwd, 'out'), { recursive: true });
        writeFileSync(join(cwd, 'out', 'source.pdf'), '%PDF ok');
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    };
    const { preview } = service({ 'files/КП.docx': { bytes: [...ZIP] } }, run);
    await expect(preview.pdf(OLGA, 'files/КП.docx', '-')).rejects.toMatchObject({ code: 'APP_PREVIEW_FAILED' });
    expect(readdirSync(root).filter((name) => name.startsWith('bba-preview-'))).toEqual([]);
    fail = false;
    await preview.pdf(OLGA, 'files/КП.docx', '-');
    expect(runs).toHaveLength(2);
  });
});
