// The real LibreOffice in the real sandbox (spec, section 8.27): only three conversions here — a full
// parallel `pnpm test` already runs out of time under load (AGENTS.md); every format is checked by
// `pnpm preview:check` (tooling/preview-check.ts).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLimiter } from '../sandbox/limiter.ts';
import { assertIsolationAvailable } from '../sandbox/workspace.ts';
import { areaDir, userArea } from '../storage/areas.ts';
import { createFileStorage } from '../storage/engine.ts';
import { createPreviewCache } from './cache.ts';
import { sandboxRunner } from './convert.ts';
import { createPreviewService, PREVIEW_MAX_CONCURRENT, PREVIEW_QUEUE_WAIT_MS, type PreviewService } from './service.ts';

const VENV = fileURLToPath(new URL('../../.venv-skills', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const CONVERSION_MS = 120_000;
const OLGA = userArea('olga');

let root: string;
let preview: PreviewService;

const pages = (pdf: string) => Number(execFileSync(join(VENV, 'bin', 'qpdf'), ['--show-npages', pdf]).toString().trim());
const text = (pdf: string) => execFileSync('pdftotext', [pdf, '-']).toString();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'bba-preview-real-'));
  cpSync(FIXTURES, areaDir(join(root, 'workspace'), OLGA), { recursive: true });
  // The disk without a bucket: no database is asked.
  const storage = createFileStorage({ db: null as never, box: null as never, workspaceRoot: join(root, 'workspace'), keepCopyMs: 0 });
  preview = createPreviewService({
    storage,
    cache: createPreviewCache({ dir: join(root, 'cache'), maxBytes: 100_000_000, maxAgeMs: 60_000 }),
    run: sandboxRunner({ venv: VENV, isolation: assertIsolationAvailable() }),
    limiter: createLimiter(PREVIEW_MAX_CONCURRENT, PREVIEW_QUEUE_WAIT_MS),
    workRoot: root,
  });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('LibreOffice in the sandbox turns documents into PDF', () => {
  it('a Word document of two pages', { timeout: CONVERSION_MS }, async () => {
    const { path } = await preview.pdf(OLGA, 'kp.docx', '-');
    expect(pages(path)).toBe(2);
    expect(text(path)).toContain('Коммерческое предложение');
  });

  it('a workbook: each visible sheet a page, the hidden one dropped', { timeout: CONVERSION_MS }, async () => {
    const { path } = await preview.pdf(OLGA, 'sheets.xlsx', '-');
    expect(pages(path)).toBe(2);
    expect(text(path)).not.toContain('СКРЫТО');
    expect(text(path)).toContain('Итог');
  });

  it('a damaged document is said so', { timeout: CONVERSION_MS }, async () => {
    await expect(preview.pdf(OLGA, 'broken.docx', '-')).rejects.toMatchObject({ code: 'APP_PREVIEW_FAILED' });
  });
});
