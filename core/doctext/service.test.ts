// The text of attached documents (spec, section 8.29): the real programs in the real sandbox, the way the
// skills would read them — Word by pandoc, PowerPoint by the skill's own script, Excel by LibreOffice as Excel
// shows the values, PDF by pdftotext with its pages. Every old format is checked by `pnpm preview:check`.
import { cpSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPreviewCache } from '../preview/cache.ts';
import { sandboxRunner, type RunCommand } from '../preview/convert.ts';
import { PREVIEW_MAX_CONCURRENT, PREVIEW_MAX_UNPACKED_BYTES, PREVIEW_QUEUE_WAIT_MS } from '../preview/service.ts';
import { createLimiter, MAX_CONCURRENT_COMMANDS, QUEUE_TIMEOUT_MS } from '../sandbox/limiter.ts';
import { assertIsolationAvailable } from '../sandbox/workspace.ts';
import { SYSTEM_SKILLS_DIR } from '../skills-admin/system.ts';
import { createDocTextService, DOC_TEXT_CACHE_SUFFIX, type DocText, type DocTextService } from './service.ts';

const VENV = fileURLToPath(new URL('../../.venv-skills', import.meta.url));
const OWN = fileURLToPath(new URL('./fixtures', import.meta.url));
const VIEWER = fileURLToPath(new URL('../preview/fixtures', import.meta.url));
const PPTX_SCRIPTS = join(SYSTEM_SKILLS_DIR, 'pptx', 'scripts');
const EXTRACTION_MS = 120_000;

let root: string;
let folder: string;
let runs: string[];
let service: DocTextService;

function make(run: RunCommand, limits?: { office?: number; wait?: number }): DocTextService {
  return createDocTextService({
    run,
    officeLimiter: createLimiter(limits?.office ?? PREVIEW_MAX_CONCURRENT, limits?.wait ?? PREVIEW_QUEUE_WAIT_MS),
    commandLimiter: createLimiter(MAX_CONCURRENT_COMMANDS, QUEUE_TIMEOUT_MS),
    cache: createPreviewCache({ dir: join(root, `cache-${runs.length}-${Math.random()}`), suffix: DOC_TEXT_CACHE_SUFFIX, maxBytes: 100_000_000, maxAgeMs: 60_000 }),
    workRoot: root,
    pptxScripts: PPTX_SCRIPTS,
    timezone: 'Europe/Moscow',
    maxUnpackedBytes: PREVIEW_MAX_UNPACKED_BYTES,
  });
}

const ok = (doc: DocText | null) => {
  if (doc?.state !== 'ok') throw new Error(`expected a text, got ${JSON.stringify(doc)}`);
  return doc;
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'bba-doctext-real-'));
  folder = join(root, 'files');
  cpSync(OWN, folder, { recursive: true });
  for (const name of ['kp.docx', 'sheets.xls', 'deck.pptx', 'secret.docx', 'broken.docx']) cpSync(join(VIEWER, name), join(folder, name));
  runs = [];
  const real = sandboxRunner({ venv: VENV, isolation: assertIsolationAvailable(), readOnlyPaths: [PPTX_SCRIPTS] });
  service = make((cwd, program, args, timeoutMs) => {
    runs.push(program);
    return real(cwd, program, args, timeoutMs);
  });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the text of an attached document (spec, section 8.29)', () => {
  it('keeps the title of a Word document and writes a table with merged cells compactly', { timeout: EXTRACTION_MS }, async () => {
    const kp = ok(await service.text(folder, 'kp.docx'));
    expect(kp).toMatchObject({ kind: 'word', pages: null });
    expect(kp.text).toContain('Коммерческое предложение ООО «Пример»');
    expect(kp.text).toContain('Поставка материалов для кровли');
    const merged = ok(await service.text(folder, 'merged.docx'));
    expect(merged.text).toContain('<td colspan="3">Итого со скидкой 7 %</td>');
    expect(merged.text).not.toContain('<colgroup>');
  });

  it('gives the values of a workbook as Excel shows them, without the hidden sheet', { timeout: EXTRACTION_MS }, async () => {
    const book = ok(await service.text(folder, 'formats.xlsx'));
    expect(book).toMatchObject({ kind: 'sheet', hiddenSheets: ['Служебный'] });
    expect(book.text).toContain('## Расчёт');
    expect(book.text).toContain('## Сроки');
    expect(book.text).toMatch(/Кровля\t7%\t18\.11\.2026\t1\s200\s000,00 ₽/);
    // A formula the file keeps without its value is counted.
    expect(book.text).toMatch(/Итого\t\t\t2\s050\s000,50 ₽/);
    expect(book.text).not.toContain('СКРЫТО');
    expect(book.text).not.toMatch(/NaN|Unnamed/);
  });

  it('reads an old workbook through LibreOffice, without its hidden sheet', { timeout: EXTRACTION_MS }, async () => {
    const book = ok(await service.text(folder, 'sheets.xls'));
    expect(book.text).toContain('Итог');
    expect(book.text).not.toContain('СКРЫТО');
  });

  it('reads a presentation with the skill’s own script', { timeout: EXTRACTION_MS }, async () => {
    const deck = ok(await service.text(folder, 'deck.pptx'));
    expect(deck.kind).toBe('slides');
    expect(deck.text).toContain('Слайд 3');
  });

  it('marks the pages of a PDF and those without text; a PDF with no text at all is a scan', { timeout: EXTRACTION_MS }, async () => {
    const mixed = ok(await service.text(folder, 'mixed.pdf'));
    expect(mixed).toMatchObject({ kind: 'pdf', pages: 4, emptyPages: [4] });
    expect(mixed.text).toContain('— стр. 2 —');
    expect(mixed.text).toContain('— стр. 4: без текста (картинка или скан) —');
    expect(mixed.text).not.toMatch(/ {4,}/);
    expect(await service.text(folder, 'scan.pdf')).toEqual({ state: 'scan', kind: 'pdf', pages: 2 });
  });

  it('says a document has a password or is broken, and remembers it for that version of the file', { timeout: EXTRACTION_MS }, async () => {
    expect(await service.text(folder, 'secret.docx')).toEqual({ state: 'password', kind: 'word' });
    expect(await service.text(folder, 'broken.docx')).toEqual({ state: 'failed', kind: 'word' });
    const before = runs.length;
    expect(await service.text(folder, 'broken.docx')).toEqual({ state: 'failed', kind: 'word' });
    expect(runs.length).toBe(before);
  });

  it('decodes a letter, a text file in Windows-1251 and a web page', { timeout: EXTRACTION_MS }, async () => {
    const letter = ok(await service.text(folder, 'letter.eml'));
    expect(letter.kind).toBe('email');
    expect(letter.text).toContain('Тема: Счёт на оплату');
    expect(letter.text).toContain('От: "Иван Петров" <ivan@example.com>');
    expect(letter.text).toContain('Дата: 17.11.2026 10:00');
    expect(letter.text).toContain('Добрый день! Во вложении счёт на оплату аванса 30 %.');
    expect(letter.text).toContain('Вложения письма: Счёт.pdf');
    expect(ok(await service.text(folder, 'prices-1251.csv')).text).toContain('Профнастил С8;650');
    const page = ok(await service.text(folder, 'page.html'));
    expect(page.text).toContain('Прайс-лист (образец)');
    expect(page.text).not.toContain('alert(1)');
  });

  it('makes the text once per version of the file; a changed file is read again', { timeout: EXTRACTION_MS }, async () => {
    writeFileSync(join(folder, 'note.txt'), 'Срок — 45 дней.');
    expect(ok(await service.text(folder, 'note.txt')).text).toBe('Срок — 45 дней.');
    const before = runs.length;
    ok(await service.text(folder, 'kp.docx'));
    ok(await service.text(folder, 'kp.docx'));
    expect(runs.length).toBe(before);
    writeFileSync(join(folder, 'note.txt'), 'Срок — 60 дней.');
    expect(ok(await service.text(folder, 'note.txt')).text).toBe('Срок — 60 дней.');
  });

  it('runs no program for a file too big, gone, outside the folder or not a document', async () => {
    writeFileSync(join(folder, 'huge.pdf'), '');
    truncateSync(join(folder, 'huge.pdf'), 51 * 1024 * 1024);
    const before = runs.length;
    expect(await service.text(folder, 'huge.pdf')).toEqual({ state: 'too_big', kind: 'pdf' });
    expect(await service.text(folder, 'gone.docx')).toEqual({ state: 'missing', kind: 'word' });
    expect(await service.text(folder, '../outside.docx')).toEqual({ state: 'missing', kind: 'word' });
    expect(await service.text(folder, 'photo.png')).toBeNull();
    expect(runs.length).toBe(before);
  });

  it('a busy server is not remembered: the next attempt runs', async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const holding = new Promise<void>((resolve) => (started = resolve));
    let calls = 0;
    const busy = make(async () => {
      calls++;
      started();
      await held;
      return { exitCode: 0, stdout: '', stderr: '' };
    }, { office: 1, wait: 50 });
    // LibreOffice wrote nothing: the workbook gives no text.
    const first = busy.text(folder, 'formats.xlsx');
    await holding;
    expect(await busy.text(folder, 'sheets.xls')).toEqual({ state: 'busy', kind: 'sheet' });
    release();
    expect(await first).toEqual({ state: 'failed', kind: 'sheet' });
    const before = calls;
    expect(await busy.text(folder, 'sheets.xls')).toEqual({ state: 'failed', kind: 'sheet' });
    expect(calls).toBeGreaterThan(before);
  });
});
