import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextRoot, deleteUserWorkspace, existingInside, listFiles, removeProjectFolder, resolveInside, saveFile } from './layout.ts';

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'bba-layout-'));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe('workspace layout', () => {
  it('gives a conversation outside projects the files folder and a project conversation its project files folder', () => {
    expect(contextRoot(ws, 'olga', null)).toBe(join(ws, 'olga', 'files'));
    expect(existsSync(join(ws, 'olga', 'files'))).toBe(true);
    const projectId = '0b8e2a9a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
    expect(contextRoot(ws, 'olga', projectId)).toBe(join(ws, 'olga', 'projects', projectId, 'files'));
    expect(existsSync(join(ws, 'olga', 'projects', projectId, 'files'))).toBe(true);
  });

  it('refuses ids that would lead outside the workspace', () => {
    expect(() => contextRoot(ws, '../igor', null)).toThrow();
    expect(() => contextRoot(ws, 'olga', '../../igor')).toThrow();
  });

  it('keeps both files with the same name and leaves no half-written file', () => {
    const root = contextRoot(ws, 'olga', null);
    const first = saveFile(root, 'смета.xlsx', new TextEncoder().encode('one'));
    const second = saveFile(root, 'смета.xlsx', new TextEncoder().encode('two'));
    expect(first).toEqual({ name: 'смета.xlsx', path: 'смета.xlsx', bytes: 3 });
    expect(second.name).toBe('смета (2).xlsx');
    expect(readFileSync(join(root, 'смета (2).xlsx'), 'utf8')).toBe('two');
    expect(readdirSync(root).sort()).toEqual(['смета (2).xlsx', 'смета.xlsx']);
  });

  it('cleans a file name of path parts and refuses types the skills do not read or files over 20 MB', () => {
    const root = contextRoot(ws, 'olga', null);
    expect(saveFile(root, '../../etc/договор.pdf', new Uint8Array([1])).name).toBe('договор.pdf');
    expect(() => saveFile(root, 'script.sh', new Uint8Array([1]))).toThrow(/APP_UPLOAD_TYPE_UNSUPPORTED|extension/);
    expect(() => saveFile(root, 'big.pdf', new Uint8Array(20 * 1024 * 1024 + 1))).toThrow(/bytes/);
  });

  it('lists the files of a folder without hidden working folders, nested ones with their path', () => {
    const root = contextRoot(ws, 'olga', null);
    saveFile(root, 'договор.pdf', new Uint8Array([1, 2]));
    saveFile(join(root, '.renders'), 'scan-p1.png', new Uint8Array([1]));
    saveFile(join(root, 'выгрузки'), 'итог.csv', new Uint8Array([1, 2, 3]));
    expect(listFiles(root)).toEqual([
      { path: 'выгрузки/итог.csv', bytes: 3 },
      { path: 'договор.pdf', bytes: 2 },
    ]);
  });

  // The instructions of the document skills pass absolute paths of the pages they drew (section 8.18).
  it('takes a path from the folder or an absolute one inside it, and nothing outside', () => {
    const root = contextRoot(ws, 'olga', null);
    expect(resolveInside(root, 'слайды/slide-1.jpg')).toBe(join(root, 'слайды/slide-1.jpg'));
    expect(resolveInside(root, join(root, 'слайды/slide-1.jpg'))).toBe(join(root, 'слайды/slide-1.jpg'));
    for (const outside of ['../igor/files/x.pdf', join(ws, 'igor', 'files', 'x.pdf'), '/etc/passwd', `${root}/../x`, root, '']) {
      expect(() => resolveInside(root, outside), outside).toThrow(expect.objectContaining({ code: 'APP_VALIDATION_FAILED' }));
    }
  });

  // The server reads these files outside the sandbox: a link the agent made in its folder must not
  // take it to a file of the server (ln -s /proc/self/environ x.docx).
  it('follows links only inside the folder; a missing file or a broken link is no file', () => {
    const root = contextRoot(ws, 'olga', null);
    writeFileSync(join(root, 'КП.docx'), 'DOCX');
    mkdirSync(join(ws, 'secret'));
    writeFileSync(join(ws, 'secret', 'env'), 'KEY=1');
    symlinkSync(join(root, 'КП.docx'), join(root, 'копия.docx'));
    symlinkSync(join(ws, 'secret', 'env'), join(root, 'leak.docx'));
    symlinkSync(join(ws, 'secret'), join(root, 'папка'));
    symlinkSync(join(root, 'нет.docx'), join(root, 'битая.docx'));
    expect(existingInside(root, 'КП.docx')).toBe(join(root, 'КП.docx'));
    expect(existingInside(root, 'копия.docx')).toBe(join(root, 'КП.docx'));
    expect(existingInside(root, 'нет.docx')).toBeNull();
    expect(existingInside(root, 'битая.docx')).toBeNull();
    for (const path of ['leak.docx', 'папка/env', '/proc/self/environ']) {
      expect(() => existingInside(root, path), path).toThrow(expect.objectContaining({ code: 'APP_VALIDATION_FAILED' }));
    }
  });

  it('removes a project folder and the whole workspace of a person', () => {
    const projectId = '0b8e2a9a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
    saveFile(contextRoot(ws, 'olga', projectId), 'смета.xlsx', new Uint8Array([1]));
    removeProjectFolder(ws, 'olga', projectId);
    expect(existsSync(join(ws, 'olga', 'projects', projectId))).toBe(false);
    deleteUserWorkspace(ws, 'olga');
    expect(existsSync(join(ws, 'olga'))).toBe(false);
  });
});
