import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertSandboxEnvironment, findSandboxGaps, nodePackages, PYTHON_MODULES, pythonLibraries, sandboxContents } from './environment.ts';

const empty = mkdtempSync(join(tmpdir(), 'bba-env-'));
afterAll(() => rmSync(empty, { recursive: true, force: true }));

describe('sandbox environment', () => {
  it('names every program, library and package an empty machine lacks', () => {
    const gaps = findSandboxGaps(empty, [empty]);
    expect(gaps.programs).toEqual(expect.arrayContaining(['soffice', 'pandoc', 'pdftoppm', 'qpdf', 'tesseract']));
    expect(gaps.python).toEqual(pythonLibraries());
    expect(gaps.node).toEqual(nodePackages());
    expect(() => assertSandboxEnvironment(empty, [empty])).toThrow(expect.objectContaining({ code: 'APP_SANDBOX_UNAVAILABLE', message: expect.stringMatching(/soffice.*pandas.*docx.*apt-packages\.txt.*pnpm skills:setup/s) }));
  });

  it('knows the module of every Python library it installs, and no other', () => {
    const listed = readFileSync(new URL('./requirements.txt', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'));
    expect(pythonLibraries()).toHaveLength(listed.length);
    expect(Object.keys(PYTHON_MODULES).sort()).toEqual([...pythonLibraries()].sort());
  });

  it('lists what the sandbox has for the admin panel', () => {
    const contents = sandboxContents();
    expect(contents.programs).toEqual(['LibreOffice', 'pandoc', 'poppler', 'qpdf', 'tesseract']);
    expect(contents.python).toContain('python-pptx');
    expect(contents.python).toContain('markitdown');
    expect(contents.node).toEqual(['docx', 'pdf-lib', 'pptxgenjs', 'react', 'react-dom', 'react-icons', 'sharp']);
  });
});
