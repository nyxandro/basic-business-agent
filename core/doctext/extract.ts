// A document as text for the model (spec, section 8.29): the programs the skills of documents read with,
// run in the sandbox in the conversion's own folder, where the file is `source<ext>`. Word — pandoc (a
// whole document: its «Title» paragraph is metadata pandoc writes only so); PowerPoint — the pptx skill's own
// script (text, tables, chart data, notes); Excel — LibreOffice's CSV of each sheet with the values as Excel
// shows them (pandas of markitdown gives NaN, «Unnamed», 0.07 for 7 %); PDF — pdftotext keeping the layout
// (tables stay rows; two columns side by side are read across); old formats and OpenDocument — LibreOffice
// into the new format first. A letter and plain text are decoded on the server: nothing is run for them.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { simpleParser } from 'mailparser';
import type { RunCommand, RunResult } from '../preview/convert.ts';
import { sheetNames } from '../preview/sheets.ts';

export type DocKind = 'pdf' | 'word' | 'sheet' | 'slides' | 'text' | 'html' | 'email';

// The new format LibreOffice turns an old or OpenDocument file into, before it is read like that one.
type Via = 'docx' | 'xlsx' | 'pptx';

const FORMATS: Record<string, { kind: DocKind; via?: Via }> = {
  '.pdf': { kind: 'pdf' },
  '.docx': { kind: 'word' },
  '.doc': { kind: 'word', via: 'docx' },
  '.odt': { kind: 'word', via: 'docx' },
  '.rtf': { kind: 'word', via: 'docx' },
  '.xlsx': { kind: 'sheet' },
  '.xls': { kind: 'sheet', via: 'xlsx' },
  '.ods': { kind: 'sheet', via: 'xlsx' },
  '.pptx': { kind: 'slides' },
  '.ppt': { kind: 'slides', via: 'pptx' },
  '.odp': { kind: 'slides', via: 'pptx' },
  '.txt': { kind: 'text' },
  '.md': { kind: 'text' },
  '.markdown': { kind: 'text' },
  '.csv': { kind: 'text' },
  '.tsv': { kind: 'text' },
  '.json': { kind: 'text' },
  '.xml': { kind: 'text' },
  '.yaml': { kind: 'text' },
  '.yml': { kind: 'text' },
  '.log': { kind: 'text' },
  '.html': { kind: 'html' },
  '.htm': { kind: 'html' },
  '.eml': { kind: 'email' },
};

export function docFormatOf(ext: string): { kind: DocKind; via?: Via } | null {
  return FORMATS[ext.toLowerCase()] ?? null;
}

// LibreOffice runs for a workbook always (its values as shown) and for every format it converts first.
export function needsOffice(ext: string): boolean {
  const format = docFormatOf(ext);
  return format !== null && (format.kind === 'sheet' || format.via !== undefined);
}

// A program that took longer is a document that cannot be read (spec 8.29: 90 s, as the viewer's).
export const EXTRACT_TIMEOUT_MS = 90_000;
// A page with fewer letters is a picture or a scan; a PDF with fewer on average is a scan (measured 18.11:
// a scan gives 59 letters a page, the sparsest real PDF 248).
const EMPTY_PAGE_LETTERS = 30;
const SCAN_PAGE_LETTERS = 100;
// pdftotext keeps columns with runs of spaces: three are enough to see a column, more only cost tokens.
const SPACES_KEPT = 3;
// The locale Excel shows the values in at our customers: 1 200 000,00 ₽, 18.11.2026.
const SHEET_LOCALE = 'ru-RU';
// Tab-separated (a value with a comma stays one value), quoted by «"», UTF-8, values as shown, every sheet
// into its own file (LibreOffice 7.2+).
const CSV_FILTER = 'csv:Text - txt - csv (StarCalc):9,34,76,1,,0,false,true,true,false,false,-1';
const SOURCE = 'source';
const OUT = 'out';
// The killed exit of a program (bubblewrap passes on SIGKILL): the memory of the server ran out.
const KILLED_EXIT_CODE = 137;

// A document that gave no text, and why — for the journal, never for the person.
export type Refusal = { state: 'password' | 'failed' | 'busy'; reason: string };

export type Extracted = { state: 'ok'; text: string; pages: number | null; emptyPages: number[]; hiddenSheets: string[] } | { state: 'scan'; pages: number } | Refusal;

// What a program's run says beyond its output: out of time — the document cannot be read; killed — the server
// is busy, not the file broken.
function outcome(result: RunResult, step: string): Refusal | null {
  if (result.timedOut) return { state: 'failed', reason: `${step}_timeout` };
  if (result.killed || result.exitCode === KILLED_EXIT_CODE) return { state: 'busy', reason: `${step}_killed` };
  return null;
}

// LibreOffice with its own profile in the conversion's folder, showing values in the customers' locale.
function profile(dir: string): string {
  const user = join(dir, 'lo-profile', 'user');
  mkdirSync(user, { recursive: true });
  writeFileSync(
    join(user, 'registrymodifications.xcu'),
    `<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><item oor:path="/org.openoffice.Setup/L10N"><prop oor:name="ooSetupSystemLocale" oor:op="fuse"><value>${SHEET_LOCALE}</value></prop></item></oor:items>`,
  );
  return `-env:UserInstallation=file://${join(dir, 'lo-profile')}`;
}

async function soffice(run: RunCommand, dir: string, filter: string, file: string): Promise<Refusal | null> {
  const result = await run(dir, 'soffice', [profile(dir), '--headless', '--convert-to', filter, '--outdir', OUT, file], EXTRACT_TIMEOUT_MS);
  return outcome(result, 'soffice');
}

// A file LibreOffice wrote: its exit code says nothing (0 for a file with a password, step 114).
function written(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

function squeeze(page: string): string {
  return page
    .split('\n')
    .map((line) => line.replace(new RegExp(` {${SPACES_KEPT + 1},}`, 'g'), ' '.repeat(SPACES_KEPT)).trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const letters = (text: string) => text.replace(/\s/g, '').length;

async function pdf(run: RunCommand, dir: string): Promise<Extracted> {
  const result = await run(dir, 'pdftotext', ['-layout', `${SOURCE}.pdf`, '-'], EXTRACT_TIMEOUT_MS);
  const bad = outcome(result, 'pdftotext');
  if (bad) return bad;
  if (result.exitCode !== 0) return /password/i.test(result.stderr) ? { state: 'password', reason: 'pdf_password' } : { state: 'failed', reason: 'pdftotext_exit' };
  const pages = result.stdout.split('\f');
  // pdftotext ends every page, the last too, with a form feed.
  if (pages.length > 1 && pages.at(-1)!.trim() === '') pages.pop();
  const cleaned = pages.map(squeeze);
  const total = cleaned.reduce((sum, page) => sum + letters(page), 0);
  if (cleaned.length === 0 || total / cleaned.length < SCAN_PAGE_LETTERS) return { state: 'scan', pages: cleaned.length };
  const emptyPages = cleaned.flatMap((page, i) => (letters(page) < EMPTY_PAGE_LETTERS ? [i + 1] : []));
  const text = cleaned.map((page, i) => (emptyPages.includes(i + 1) ? `— стр. ${i + 1}: без текста (картинка или скан) —` : `— стр. ${i + 1} —\n${page}`)).join('\n\n');
  return { state: 'ok', text, pages: cleaned.length, emptyPages, hiddenSheets: [] };
}

// pandoc writes a table with merged cells as HTML: its column widths only cost tokens, and a tag a line
// makes it three times longer than it is.
function compactTables(markdown: string): string {
  return markdown.replace(/<table>[\s\S]*?<\/table>/g, (table) =>
    table
      .replace(/<colgroup>[\s\S]*?<\/colgroup>/g, '')
      .replace(/>\s+</g, '><')
      .trim(),
  );
}

async function word(run: RunCommand, dir: string, file: string): Promise<Extracted> {
  const result = await run(dir, 'pandoc', ['-s', '-t', 'gfm', '--wrap=none', file], EXTRACT_TIMEOUT_MS);
  const bad = outcome(result, 'pandoc');
  if (bad) return bad;
  if (result.exitCode !== 0) return { state: 'failed', reason: 'pandoc_exit' };
  return { state: 'ok', text: compactTables(result.stdout).trim(), pages: null, emptyPages: [], hiddenSheets: [] };
}

async function sheet(run: RunCommand, dir: string, file: string): Promise<Extracted> {
  const names = sheetNames(readFileSync(join(dir, file)));
  if (!names) return { state: 'failed', reason: 'workbook_unreadable' };
  const bad = await soffice(run, dir, CSV_FILTER, file);
  if (bad) return bad;
  const csvFiles = existsSync(join(dir, OUT)) ? readdirSync(join(dir, OUT)).filter((name) => name.endsWith('.csv')) : [];
  if (csvFiles.length === 0) return { state: 'failed', reason: 'no_csv' };
  // LibreOffice names the file of each sheet «<file>-<sheet>.csv»; a workbook of one sheet may get «<file>.csv».
  const base = basename(file).replace(/\.[^.]+$/, '');
  const visible = names.filter((s) => !s.hidden).map((s) => s.name);
  const blocks: string[] = [];
  for (const sheetName of visible) {
    const csv = [`${base}-${sheetName}.csv`, ...(names.length === 1 ? [`${base}.csv`] : [])].find((name) => csvFiles.includes(name));
    if (!csv) continue;
    const rows = readFileSync(join(dir, OUT, csv), 'utf8')
      .split('\n')
      .map((row) => row.replace(/\t+$/, '').trimEnd());
    blocks.push(`## ${sheetName}\n${rows.join('\n').replace(/\n{3,}/g, '\n\n').trim()}`);
  }
  return { state: 'ok', text: blocks.join('\n\n'), pages: null, emptyPages: [], hiddenSheets: names.filter((s) => s.hidden).map((s) => s.name) };
}

async function slides(run: RunCommand, dir: string, file: string, pptxScripts: string): Promise<Extracted> {
  const result = await run(dir, 'python3', [join(pptxScripts, 'slide_text.py'), file], EXTRACT_TIMEOUT_MS);
  const bad = outcome(result, 'slide_text');
  if (bad) return bad;
  if (result.exitCode !== 0) return { state: 'failed', reason: 'slide_text_exit' };
  return { state: 'ok', text: result.stdout.trim(), pages: null, emptyPages: [], hiddenSheets: [] };
}

async function html(run: RunCommand, dir: string, file: string): Promise<Extracted> {
  const result = await run(dir, 'markitdown', [file], EXTRACT_TIMEOUT_MS);
  const bad = outcome(result, 'markitdown');
  if (bad) return bad;
  if (result.exitCode !== 0) return { state: 'failed', reason: 'markitdown_exit' };
  return { state: 'ok', text: result.stdout.trim(), pages: null, emptyPages: [], hiddenSheets: [] };
}

// UTF-8, or Windows-1251 as old accounting exports are; never a guess past these two.
function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

function dateIn(timezone: string, date: Date): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date).replace(',', '');
}

async function email(path: string, timezone: string): Promise<Extracted> {
  const mail = await simpleParser(readFileSync(path));
  const lines = [
    mail.from?.text ? `От: ${mail.from.text}` : '',
    mail.to ? `Кому: ${[mail.to].flat().map((a) => a.text).join(', ')}` : '',
    mail.subject ? `Тема: ${mail.subject}` : '',
    mail.date ? `Дата: ${dateIn(timezone, mail.date)}` : '',
  ].filter(Boolean);
  const attachments = mail.attachments.map((a) => a.filename).filter((name): name is string => Boolean(name));
  const body = (mail.text ?? '').trim();
  return {
    state: 'ok',
    text: [lines.join('\n'), body, attachments.length > 0 ? `Вложения письма: ${attachments.join(', ')}` : ''].filter(Boolean).join('\n\n'),
    pages: null,
    emptyPages: [],
    hiddenSheets: [],
  };
}

export interface ExtractInput {
  // The conversion's folder, with the document as `source<ext>`.
  dir: string;
  ext: string;
  // The pptx skill's scripts, mounted read-only into the sandbox.
  pptxScripts: string;
  // The installation's time zone, for the date of a letter.
  timezone: string;
}

export async function extractText(run: RunCommand, { dir, ext, pptxScripts, timezone }: ExtractInput): Promise<Extracted> {
  const format = docFormatOf(ext);
  if (!format) throw new Error(`no text for ${ext}: the caller asks only for documents`);
  let file = `${SOURCE}${ext.toLowerCase()}`;
  if (format.via) {
    const bad = await soffice(run, dir, format.via, file);
    if (bad) return bad;
    file = `${OUT}/${SOURCE}.${format.via}`;
    if (!written(join(dir, file))) return { state: 'failed', reason: 'no_conversion' };
  }
  switch (format.kind) {
    case 'pdf':
      return pdf(run, dir);
    case 'word':
      return word(run, dir, file);
    case 'sheet':
      return sheet(run, dir, file);
    case 'slides':
      return slides(run, dir, file, pptxScripts);
    case 'html':
      return html(run, dir, file);
    case 'text':
      return { state: 'ok', text: decodeText(readFileSync(join(dir, file))).trim(), pages: null, emptyPages: [], hiddenSheets: [] };
    case 'email':
      return email(join(dir, file), timezone);
  }
}
