// Turning Word, Excel and PowerPoint into PDF for the viewer (spec, section 8.27; decision of the owner
// 18.11): LibreOffice — the one the installation already has for the skills of documents (8.18) — runs in
// the sandbox: no network, nothing of the server's environment, the whole group of processes killed when it
// runs out of time. Its exit code says nothing (a file with a password or a cut archive exits with 0 and no
// PDF, step 114): only a PDF it wrote counts.
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PreviewKind } from '@bba/contracts';
import { LocalSandbox } from '@mastra/core/workspace';
import { appError } from '../errors/catalog.ts';
import { sandboxOptions } from '../sandbox/environment.ts';
import type { SheetPlan } from './sheets.ts';

// A conversion takes 1–2 s (step 114); this is for a huge presentation on a busy server.
export const CONVERT_TIMEOUT_MS = 90_000;
// «Whole sheet on one page» — only for a workbook whose sheets all fit (core/preview/sheets.ts).
export const SINGLE_SHEETS_FILTER = 'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}';

const SOURCE = 'source';
const OUT = 'out';
// LibreOffice makes its profile at the start; the sandbox's own /tmp, so no two conversions share one.
const PROFILE = '-env:UserInstallation=file:///tmp/lo-profile';
const PDF_MAGIC = '%PDF';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  killed?: boolean;
}

// One program in the sandbox, in `cwd` (the conversion's own folder, writable).
export type RunCommand = (cwd: string, program: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export function sandboxRunner({ venv, isolation }: { venv: string; isolation: 'bwrap' | 'seatbelt' }): RunCommand {
  return async (cwd, program, args, timeoutMs) => {
    const options = sandboxOptions(venv, cwd, [], isolation);
    // Without a display LibreOffice draws with its own headless backend.
    const sandbox = new LocalSandbox({ ...options, env: { ...options.env, SAL_USE_VCLPLUGIN: 'svp' } });
    const result = await sandbox.executeCommand!(program, args, { timeout: timeoutMs });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, killed: result.killed };
  };
}

function isPdf(path: string): boolean {
  if (!existsSync(path) || statSync(path).size === 0) return false;
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(PDF_MAGIC.length);
    readSync(fd, head, 0, head.length, 0);
    return head.toString('latin1') === PDF_MAGIC;
  } finally {
    closeSync(fd);
  }
}

function failed(reason: string, details: Record<string, unknown>) {
  return appError('APP_PREVIEW_FAILED', `document not converted: ${reason}`, { details: { reason, ...details } });
}

// The exit code of a program killed by SIGKILL: bubblewrap passes on so a program the system killed.
const KILLED_EXIT_CODE = 137;

function checkRun(result: RunResult, step: string): void {
  if (result.timedOut) throw appError('APP_PREVIEW_TIMEOUT', `${step} ran out of ${CONVERT_TIMEOUT_MS} ms`, { details: { reason: 'timeout', step } });
  // Killed by the system — most likely the memory of the container ran out.
  if (result.killed || result.exitCode === KILLED_EXIT_CODE) throw appError('APP_PREVIEW_BUSY', `${step} was killed`, { details: { reason: 'killed', step } });
}

async function soffice(run: RunCommand, dir: string, filter: string, ext: string): Promise<string> {
  const converted = await run(dir, 'soffice', [PROFILE, '--headless', '--convert-to', filter, '--outdir', OUT, `${SOURCE}${ext}`], CONVERT_TIMEOUT_MS);
  checkRun(converted, 'soffice');
  const pdf = join(dir, OUT, `${SOURCE}.pdf`);
  if (!isPdf(pdf)) throw failed('no_pdf', { exitCode: converted.exitCode });
  return pdf;
}

export interface ConvertInput {
  // The conversion's folder, with the file as `source<ext>`.
  dir: string;
  ext: string;
  kind: PreviewKind;
  // Of an `.xlsx`/`.xlsm`; null — the workbook prints in pages.
  plan: SheetPlan | null;
}

// The path of the PDF in `dir`.
export async function convertToPdf(run: RunCommand, { dir, ext, kind, plan }: ConvertInput): Promise<string> {
  const wholeSheets = kind === 'sheet' && plan?.singlePage === true;
  const pdf = await soffice(run, dir, wholeSheets ? SINGLE_SHEETS_FILTER : 'pdf', ext);
  if (!wholeSheets || plan.hiddenPages.length === 0) return pdf;

  // A page a sheet, hidden ones too, in the order of the sheets: the visible pages are listed (qpdf 11.3 of
  // the image has no exclusions in a range).
  const counted = await run(dir, 'qpdf', ['--show-npages', `${OUT}/${SOURCE}.pdf`], CONVERT_TIMEOUT_MS);
  checkRun(counted, 'qpdf');
  const pages = Number(counted.stdout.trim());
  if (counted.exitCode !== 0 || !Number.isInteger(pages) || pages < 1) throw failed('pages_not_counted', { exitCode: counted.exitCode });
  // Not a page a sheet: which page is which sheet is not known — the workbook in pages, as it prints.
  if (pages !== plan.sheets) return soffice(run, dir, 'pdf', ext);
  const hidden = new Set(plan.hiddenPages);
  const visible = Array.from({ length: pages }, (_, i) => i + 1).filter((page) => !hidden.has(page));
  if (visible.length === 0) throw failed('no_visible_sheet', { pages });
  const visiblePdf = join(dir, OUT, 'visible.pdf');
  // Exit code 3 is qpdf's «done with warnings».
  const cut = await run(dir, 'qpdf', [`${OUT}/${SOURCE}.pdf`, '--pages', '.', visible.join(','), '--', `${OUT}/visible.pdf`], CONVERT_TIMEOUT_MS);
  checkRun(cut, 'qpdf');
  if ((cut.exitCode !== 0 && cut.exitCode !== 3) || !isPdf(visiblePdf)) throw failed('hidden_pages_not_dropped', { exitCode: cut.exitCode });
  return visiblePdf;
}
