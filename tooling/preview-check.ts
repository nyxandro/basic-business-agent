// `pnpm preview:check` (spec, section 8.27): every format of the viewer through the real LibreOffice in
// the real sandbox — the fixtures of core/preview/fixtures, fictional. Not part of `pnpm test`: a dozen
// conversions there would run out of time under the load of the whole parallel run.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAppError } from '../core/errors/app-error.ts';
import { createPreviewCache } from '../core/preview/cache.ts';
import { sandboxRunner } from '../core/preview/convert.ts';
import { createPreviewService, PREVIEW_MAX_CONCURRENT, PREVIEW_QUEUE_WAIT_MS } from '../core/preview/service.ts';
import { sandboxPath } from '../core/sandbox/environment.ts';
import { createLimiter } from '../core/sandbox/limiter.ts';
import { assertIsolationAvailable } from '../core/sandbox/workspace.ts';
import { areaDir, userArea } from '../core/storage/areas.ts';
import { createFileStorage } from '../core/storage/engine.ts';

const VENV = fileURLToPath(new URL('../.venv-skills', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../core/preview/fixtures', import.meta.url));
const AREA = userArea('check');

// What each fixture must give: its pages and a word on them, or the code of the refusal.
const EXPECTED: { file: string; pages?: number; minPages?: number; has?: string; hasNot?: string; code?: string }[] = [
  { file: 'kp.docx', pages: 2, has: 'Коммерческое предложение' },
  { file: 'kp.doc', pages: 2, has: 'Коммерческое предложение' },
  { file: 'kp.odt', pages: 2, has: 'Коммерческое предложение' },
  { file: 'kp.rtf', pages: 2, has: 'Коммерческое предложение' },
  // Whole sheets, the hidden one dropped.
  { file: 'sheets.xlsx', pages: 2, has: 'Итог', hasNot: 'СКРЫТО' },
  // In pages as printed: LibreOffice leaves hidden sheets out by itself.
  { file: 'sheets.xls', pages: 2, has: 'Итог', hasNot: 'СКРЫТО' },
  { file: 'sheets.ods', pages: 2, has: 'Итог', hasNot: 'СКРЫТО' },
  // 2 000 rows: in pages, the last row there.
  { file: 'big.xlsx', minPages: 2, has: 'П2000' },
  { file: 'deck.pptx', pages: 3, has: 'Слайд 3' },
  { file: 'deck.ppt', pages: 3, has: 'Слайд 3' },
  { file: 'deck.odp', pages: 3, has: 'Слайд 3' },
  { file: 'broken.docx', code: 'APP_PREVIEW_FAILED' },
  { file: 'secret.docx', code: 'APP_PREVIEW_PASSWORD' },
];

const root = mkdtempSync(join(tmpdir(), 'bba-preview-check-'));
let failures = 0;
try {
  cpSync(FIXTURES, areaDir(join(root, 'workspace'), AREA), { recursive: true });
  const preview = createPreviewService({
    storage: createFileStorage({ db: null as never, box: null as never, workspaceRoot: join(root, 'workspace'), keepCopyMs: 0 }),
    cache: createPreviewCache({ dir: join(root, 'cache'), maxBytes: 1_000_000_000, maxAgeMs: 60_000 }),
    run: sandboxRunner({ venv: VENV, isolation: assertIsolationAvailable() }),
    limiter: createLimiter(PREVIEW_MAX_CONCURRENT, PREVIEW_QUEUE_WAIT_MS),
    workRoot: root,
  });
  for (const want of EXPECTED) {
    const started = Date.now();
    let line: string;
    try {
      const { path } = await preview.pdf(AREA, want.file, '-');
      const pages = Number(execFileSync('qpdf', ['--show-npages', path], { env: { ...process.env, PATH: sandboxPath(VENV) } }).toString().trim());
      const text = execFileSync('pdftotext', [path, '-']).toString();
      const problems = [
        want.code ? `expected ${want.code}` : '',
        want.pages !== undefined && pages !== want.pages ? `${pages} pages, expected ${want.pages}` : '',
        want.minPages !== undefined && pages < want.minPages ? `${pages} pages, expected at least ${want.minPages}` : '',
        want.has && !text.includes(want.has) ? `no «${want.has}»` : '',
        want.hasNot && text.includes(want.hasNot) ? `has «${want.hasNot}»` : '',
      ].filter(Boolean);
      line = problems.length === 0 ? `ok    ${pages} pages` : `FAIL  ${problems.join('; ')}`;
    } catch (error) {
      const code = isAppError(error) ? error.code : String(error);
      line = want.code === code ? `ok    ${code}` : `FAIL  ${code}${want.code ? `, expected ${want.code}` : ''}`;
    }
    if (line.startsWith('FAIL')) failures++;
    console.log(`${want.file.padEnd(12)} ${line} (${Date.now() - started} ms)`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`${failures} of ${EXPECTED.length} formats failed`);
  process.exit(1);
}
console.log(`all ${EXPECTED.length} formats ok`);
