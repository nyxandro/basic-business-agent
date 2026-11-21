// The letterhead as agents write on it (docs/specs/[20.11.2026]-org-letterhead.md): when the admin uploads it,
// blank.py makes its copy without text in a one-off sandbox (no network, nothing of the server's environment),
// and LibreOffice makes the PDF of that copy — «Так начнётся документ агента». Agents get the copy ready, laid out
// on disk (core/org-docs/files.ts): nothing of this runs during an answer.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BlankInfo } from '@bba/contracts';
import { isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { convertToPdf, type RunCommand } from '../preview/convert.ts';
import { isEncryptedOffice, unpackedBytesOf } from '../preview/checks.ts';
import type { Limiter } from '../sandbox/limiter.ts';

// The scripts of the module, read-only to the one-off sandboxes that run them.
export const ORG_SCRIPTS_DIR = fileURLToPath(new URL('./scripts', import.meta.url));
// blank.py reads and writes one small document.
const BLANK_TIMEOUT_MS = 30_000;
// A letterhead of 5 MB unpacks into far less; more is a crafted archive that would hold the sandbox.
export const BLANK_MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
// The folders of the one-off works of the module (a letterhead prepared, a document signed).
export const ORG_WORK_PREFIX = 'bba-org-work-';
// blank.py exits with this code when the file is not a Word document.
const NOT_A_DOCUMENT = 2;

export interface PreparedBlank {
  prepared: Buffer;
  preview: Buffer;
  info: BlankInfo;
}

export interface BlankDeps {
  // A runner of the sandbox that reads ORG_SCRIPTS_DIR.
  run: RunCommand;
  // The queue of LibreOffice shared with the viewer (two at once in the installation).
  limiter: Limiter;
  // Where the folder of the work is made.
  workRoot: string;
}

// The folders of the works a stopped server left (a signed document among them): removed at the start.
export function cleanOrgWork(workRoot: string): void {
  for (const name of readdirSync(workRoot)) if (name.startsWith(ORG_WORK_PREFIX)) rmSync(join(workRoot, name), { recursive: true, force: true });
}

const broken = (message: string, cause?: unknown) => appError('APP_ORG_BLANK_BROKEN', message, cause === undefined ? {} : { cause });

function infoOf(stdout: string): BlankInfo {
  const line = stdout.trim().split('\n').at(-1) ?? '';
  const parsed = JSON.parse(line) as Partial<BlankInfo>;
  if (typeof parsed.mark !== 'boolean' || typeof parsed.header !== 'boolean' || typeof parsed.bodyDrawing !== 'boolean') throw new Error(`blank.py printed no summary: ${line.slice(0, 200)}`);
  return { mark: parsed.mark, header: parsed.header, bodyDrawing: parsed.bodyDrawing };
}

export async function prepareBlank(deps: BlankDeps, original: Uint8Array): Promise<PreparedBlank> {
  const unpacked = unpackedBytesOf(original);
  if (unpacked === null) throw broken('the letterhead is not a zip archive');
  if (unpacked > BLANK_MAX_UNPACKED_BYTES) throw broken(`the letterhead unpacks into ${unpacked} bytes`);
  return deps.limiter.run(async () => {
    const dir = mkdtempSync(join(deps.workRoot, ORG_WORK_PREFIX));
    try {
      writeFileSync(join(dir, 'original.docx'), original);
      if (await isEncryptedOffice(join(dir, 'original.docx'))) throw broken('the letterhead is encrypted');
      // The copy is named as convertToPdf expects its source.
      const result = await deps.run(dir, 'python3', [join(ORG_SCRIPTS_DIR, 'blank.py'), 'original.docx', 'source.docx'], BLANK_TIMEOUT_MS);
      if (result.timedOut) throw new Error(`blank.py ran out of ${BLANK_TIMEOUT_MS} ms`);
      if (result.exitCode === NOT_A_DOCUMENT) throw broken(`blank.py: ${result.stdout.trim().slice(0, 300)}`);
      if (result.exitCode !== 0) throw new Error(`blank.py failed with ${result.exitCode}: ${result.stderr.slice(-500)}`);
      const info = infoOf(result.stdout);
      let pdf: string;
      try {
        pdf = await convertToPdf(deps.run, { dir, ext: '.docx', kind: 'document', plan: null });
      } catch (error) {
        // LibreOffice refused the copy a Python library could open: the file is broken in a way the person can fix.
        if (isAppError(error) && error.code === 'APP_PREVIEW_FAILED') throw broken('LibreOffice made no PDF of the prepared letterhead', error);
        throw error;
      }
      return { prepared: readFileSync(join(dir, 'source.docx')), preview: readFileSync(pdf), info };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
