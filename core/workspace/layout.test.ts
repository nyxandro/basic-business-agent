import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextRoot, deleteUserWorkspace, existingInside, listFiles, openFileInside, removeFileInside, removeProjectFolder, resolveInside, saveFile } from './layout.ts';

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
    // A path through a file, and a link to itself, are no file either (not a failure of the server).
    symlinkSync('петля.png', join(root, 'петля.png'));
    expect(existingInside(root, 'КП.docx/стр-1.png')).toBeNull();
    expect(existingInside(root, 'петля.png')).toBeNull();
    for (const path of ['leak.docx', 'папка/env', '/proc/self/environ']) {
      expect(() => existingInside(root, path), path).toThrow(expect.objectContaining({ code: 'APP_VALIDATION_FAILED' }));
    }
  });

  // Opened once and checked as opened (a link swapped in between cannot take the read outside);
  // without waiting, so a pipe put in place of a file cannot hang the server.
  it('opens only a regular file of the folder for reading', () => {
    const root = contextRoot(ws, 'olga', null);
    writeFileSync(join(root, 'КП.docx'), 'DOCX');
    mkdirSync(join(root, 'черновики'));
    execFileSync('mkfifo', [join(root, 'труба.docx')]);
    const file = openFileInside(root, 'КП.docx')!;
    try {
      expect(file.size).toBe(4);
      expect(readFileSync(file.fd, 'utf8')).toBe('DOCX');
    } finally {
      closeSync(file.fd);
    }
    expect(openFileInside(root, 'черновики')).toBeNull();
    expect(openFileInside(root, 'труба.docx')).toBeNull();
    expect(openFileInside(root, 'нет.docx')).toBeNull();
    writeFileSync(join(ws, 'server-env'), 'KEY=1');
    symlinkSync(join(ws, 'server-env'), join(root, 'leak.docx'));
    expect(() => openFileInside(root, 'leak.docx')).toThrow(expect.objectContaining({ code: 'APP_VALIDATION_FAILED' }));
  });

  // Deleting goes by the folder that was checked: a folder of the path turned into a link to
  // someone else's files deletes nothing there.
  it('removes a file of the folder, a link itself, and nothing outside', () => {
    const root = contextRoot(ws, 'olga', null);
    const other = contextRoot(ws, 'igor', null);
    writeFileSync(join(other, 'отчёт.pdf'), 'IGOR');
    writeFileSync(join(root, 'смета.xlsx'), 'X');
    symlinkSync(join(other, 'отчёт.pdf'), join(root, 'ссылка.pdf'));
    symlinkSync(other, join(root, 'чужая'));
    expect(removeFileInside(root, 'смета.xlsx')).toBe(true);
    expect(existsSync(join(root, 'смета.xlsx'))).toBe(false);
    expect(removeFileInside(root, 'ссылка.pdf')).toBe(true);
    expect(readFileSync(join(other, 'отчёт.pdf'), 'utf8')).toBe('IGOR');
    expect(() => removeFileInside(root, 'чужая/отчёт.pdf')).toThrow(expect.objectContaining({ code: 'APP_VALIDATION_FAILED' }));
    expect(readFileSync(join(other, 'отчёт.pdf'), 'utf8')).toBe('IGOR');
    expect(removeFileInside(root, 'нет.pdf')).toBe(false);
    mkdirSync(join(root, 'папка'));
    expect(removeFileInside(root, 'папка')).toBe(false);
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
