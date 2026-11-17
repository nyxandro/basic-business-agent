import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertToPdf, SINGLE_SHEETS_FILTER, type RunCommand, type RunResult } from './convert.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bba-preview-convert-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const OK: RunResult = { exitCode: 0, stdout: '', stderr: '' };

// A sandbox that answers each command with what the test says, writing the files LibreOffice or qpdf would.
function fakeRun(answers: ((program: string, args: string[]) => RunResult)[]): { run: RunCommand; calls: { program: string; args: string[] }[] } {
  const calls: { program: string; args: string[] }[] = [];
  const run: RunCommand = (cwd, program, args) => {
    calls.push({ program, args });
    const answer = answers[calls.length - 1];
    if (!answer) throw new Error(`unexpected command ${program}`);
    expect(cwd).toBe(dir);
    return Promise.resolve(answer(program, args));
  };
  return { run, calls };
}

function writes(rel: string, content: string): (program: string, args: string[]) => RunResult {
  return () => {
    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(join(dir, rel), content);
    return OK;
  };
}

describe('turning a document into PDF (spec, section 8.27)', () => {
  it('runs LibreOffice with a profile of its own and gives the PDF it wrote', async () => {
    const { run, calls } = fakeRun([writes('out/source.pdf', '%PDF-1.7 page')]);
    expect(await convertToPdf(run, { dir, ext: '.docx', kind: 'document', plan: null })).toBe(join(dir, 'out/source.pdf'));
    expect(calls).toEqual([{ program: 'soffice', args: ['-env:UserInstallation=file:///tmp/lo-profile', '--headless', '--convert-to', 'pdf', '--outdir', 'out', 'source.docx'] }]);
  });

  it('a small workbook goes whole sheet a page, the pages of its hidden sheets dropped', async () => {
    const { run, calls } = fakeRun([writes('out/source.pdf', '%PDF whole sheets'), () => ({ ...OK, stdout: '5\n' }), writes('out/visible.pdf', '%PDF visible')]);
    const pdf = await convertToPdf(run, { dir, ext: '.xlsx', kind: 'sheet', plan: { singlePage: true, hiddenPages: [2, 5] } });
    expect(pdf).toBe(join(dir, 'out/visible.pdf'));
    expect(calls[0]!.args).toContain(SINGLE_SHEETS_FILTER);
    expect(calls.slice(1)).toEqual([
      { program: 'qpdf', args: ['--show-npages', 'out/source.pdf'] },
      { program: 'qpdf', args: ['out/source.pdf', '--pages', '.', '1,3,4', '--', 'out/visible.pdf'] },
    ]);
  });

  it('a big workbook, an old one or one without a plan prints in pages', async () => {
    for (const plan of [{ singlePage: false, hiddenPages: [2] }, null]) {
      const { run, calls } = fakeRun([writes('out/source.pdf', '%PDF pages')]);
      await convertToPdf(run, { dir, ext: '.xls', kind: 'sheet', plan });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[3]).toBe('pdf');
    }
  });

  it('says so when LibreOffice ran out of time, was killed, or wrote no PDF — whatever its exit code', async () => {
    const cases: [RunResult, string][] = [
      [{ ...OK, exitCode: 124, timedOut: true }, 'APP_PREVIEW_TIMEOUT'],
      [{ ...OK, exitCode: 137, killed: true }, 'APP_PREVIEW_BUSY'],
      // A file with a password or a cut archive: exit code 0 and no PDF (step 114).
      [OK, 'APP_PREVIEW_FAILED'],
    ];
    for (const [result, code] of cases) {
      const { run } = fakeRun([() => result]);
      await expect(convertToPdf(run, { dir, ext: '.docx', kind: 'document', plan: null })).rejects.toMatchObject({ code });
    }
    const { run } = fakeRun([writes('out/source.pdf', 'not a pdf')]);
    await expect(convertToPdf(run, { dir, ext: '.docx', kind: 'document', plan: null })).rejects.toMatchObject({ code: 'APP_PREVIEW_FAILED' });
  });

  it('fails rather than show hidden sheets when their pages cannot be dropped', async () => {
    const { run } = fakeRun([writes('out/source.pdf', '%PDF whole'), () => ({ ...OK, exitCode: 2, stderr: 'damaged' })]);
    await expect(convertToPdf(run, { dir, ext: '.xlsx', kind: 'sheet', plan: { singlePage: true, hiddenPages: [2] } })).rejects.toMatchObject({ code: 'APP_PREVIEW_FAILED' });
  });
});
