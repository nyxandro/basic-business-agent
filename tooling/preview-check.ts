// `pnpm preview:check` (spec, section 8.27): every format of the viewer through the real LibreOffice in
// the real sandbox — the fixtures of core/preview/fixtures, fictional. Not part of `pnpm test`: a dozen
// conversions there would run out of time under the load of the whole parallel run.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAppError } from '../core/errors/app-error.ts';
import { createPreviewCache, PREVIEW_CACHE_SUFFIX } from '../core/preview/cache.ts';
import { sandboxRunner } from '../core/preview/convert.ts';
import { createPreviewService, PREVIEW_MAX_CONCURRENT, PREVIEW_MAX_UNPACKED_BYTES, PREVIEW_QUEUE_WAIT_MS } from '../core/preview/service.ts';
import { sandboxPath } from '../core/sandbox/environment.ts';
import { createLimiter, MAX_CONCURRENT_COMMANDS, QUEUE_TIMEOUT_MS } from '../core/sandbox/limiter.ts';
import { createDocTextService, DOC_TEXT_CACHE_SUFFIX } from '../core/doctext/service.ts';
import { SYSTEM_SKILLS_DIR } from '../core/skills-admin/system.ts';
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
    cache: createPreviewCache({ dir: join(root, 'cache'), suffix: PREVIEW_CACHE_SUFFIX, maxBytes: 1_000_000_000, maxAgeMs: 60_000 }),
    run: sandboxRunner({ venv: VENV, isolation: assertIsolationAvailable(), readOnlyPaths: [] }),
    limiter: createLimiter(PREVIEW_MAX_CONCURRENT, PREVIEW_QUEUE_WAIT_MS),
    workRoot: root,
    maxUnpackedBytes: PREVIEW_MAX_UNPACKED_BYTES,
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

// The text of attached documents (spec, section 8.29): every format the same way, through the real sandbox.
const TEXT_FIXTURES = fileURLToPath(new URL('../core/doctext/fixtures', import.meta.url));
const PPTX_SCRIPTS = join(SYSTEM_SKILLS_DIR, 'pptx', 'scripts');
const TEXT_EXPECTED: { file: string; has?: string; hasNot?: string; state?: string }[] = [
  ...['kp.docx', 'kp.doc', 'kp.odt', 'kp.rtf'].map((file) => ({ file, has: 'Поставка материалов для кровли' })),
  { file: 'kp.docx', has: 'Коммерческое предложение' },
  ...['sheets.xlsx', 'sheets.xls', 'sheets.ods'].map((file) => ({ file, has: 'Итог', hasNot: 'СКРЫТО' })),
  { file: 'big.xlsx', has: 'П2000' },
  ...['deck.pptx', 'deck.ppt', 'deck.odp'].map((file) => ({ file, has: 'Слайд 3' })),
  { file: 'broken.docx', state: 'failed' },
  { file: 'secret.docx', state: 'password' },
  { file: 'formats.xlsx', has: '1 200 000,00 ₽', hasNot: 'СКРЫТО' },
  // pandoc 3 writes a table with merged cells as HTML, pandoc 2.17 of the image as a table with empty cells: both keep the values.
  { file: 'merged.docx', has: 'Итого со скидкой 7 %', hasNot: '<colgroup>' },
  { file: 'mixed.pdf', has: '— стр. 4: без текста' },
  { file: 'scan.pdf', state: 'scan' },
  { file: 'letter.eml', has: 'Тема: Счёт на оплату' },
  { file: 'prices-1251.csv', has: 'Профнастил С8;650' },
  { file: 'page.html', has: 'Прайс-лист', hasNot: 'alert(1)' },
];
const textRoot = mkdtempSync(join(tmpdir(), 'bba-doctext-check-'));
try {
  const folder = join(textRoot, 'files');
  cpSync(FIXTURES, folder, { recursive: true });
  cpSync(TEXT_FIXTURES, folder, { recursive: true });
  const docText = createDocTextService({
    run: sandboxRunner({ venv: VENV, isolation: assertIsolationAvailable(), readOnlyPaths: [PPTX_SCRIPTS] }),
    officeLimiter: createLimiter(PREVIEW_MAX_CONCURRENT, PREVIEW_QUEUE_WAIT_MS),
    commandLimiter: createLimiter(MAX_CONCURRENT_COMMANDS, QUEUE_TIMEOUT_MS),
    cache: createPreviewCache({ dir: join(textRoot, 'cache'), suffix: DOC_TEXT_CACHE_SUFFIX, maxBytes: 1_000_000_000, maxAgeMs: 60_000 }),
    workRoot: textRoot,
    pptxScripts: PPTX_SCRIPTS,
    timezone: 'Europe/Moscow',
    maxUnpackedBytes: PREVIEW_MAX_UNPACKED_BYTES,
  });
  for (const want of TEXT_EXPECTED) {
    const started = Date.now();
    const doc = await docText.text(folder, want.file);
    const text = doc?.state === 'ok' ? doc.text.replace(/\u00a0|\u202f/g, ' ') : '';
    const problems = [
      want.state ? (doc?.state === want.state ? '' : `${doc?.state ?? 'no text'}, expected ${want.state}`) : doc?.state === 'ok' ? '' : `${doc?.state ?? 'no text'}, expected a text`,
      want.has && !text.includes(want.has) ? `no «${want.has}»` : '',
      want.hasNot && text.includes(want.hasNot) ? `has «${want.hasNot}»` : '',
    ].filter(Boolean);
    if (problems.length > 0) failures++;
    console.log(`text ${want.file.padEnd(16)} ${problems.length === 0 ? `ok    ${doc?.state === 'ok' ? `${doc.chars} chars` : doc?.state}` : `FAIL  ${problems.join('; ')}`} (${Date.now() - started} ms)`);
  }
} finally {
  rmSync(textRoot, { recursive: true, force: true });
}
const total = EXPECTED.length + TEXT_EXPECTED.length;
if (failures > 0) {
  console.error(`${failures} of ${total} checks failed`);
  process.exit(1);
}
console.log(`all ${total} checks ok`);
