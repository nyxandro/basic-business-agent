// Writing into the folder of the person's computer (spec, section 8.25, «Запись в папку»): what is at a target, a file
// written with the folders on its way, the browser's permission asked for the mode, a gone folder told apart, the
// errors of the browser said in words a person understands.
import { describe, expect, it } from 'vitest';
import { fakeFolder, folderOn, textAt, type Tree } from '../test/fake-folder.ts';
import { accessOf } from './computer-folder.ts';
import { ensureWritable, targetOf, writeFileAt } from './computer-write.ts';

describe('writing into the folder of the computer', () => {
  it('writes a new file with the folders on its way, and replaces one that is there', async () => {
    const tree: Tree = { 'Договоры': { 'Договор.docx': new File(['старый'], 'Договор.docx', { lastModified: Date.UTC(2026, 10, 20) }) } };
    const folder = folderOn(fakeFolder(tree));
    await writeFileAt(folder, 'КП/2026/КП Ёлка.docx', new Blob(['новое КП']));
    expect(await textAt(tree, 'КП', '2026', 'КП Ёлка.docx')).toBe('новое КП');
    await writeFileAt(folder, 'Договоры/Договор.docx', new Blob(['правка']));
    expect(await textAt(tree, 'Договоры', 'Договор.docx')).toBe('правка');
  });

  it('tells what is at a target: nothing, a file with its time and size, or a folder in the way', async () => {
    const tree: Tree = { 'Договоры': { 'Договор.docx': new File(['старый'], 'Договор.docx', { lastModified: Date.UTC(2026, 10, 20) }) } };
    const folder = folderOn(fakeFolder(tree));
    expect(await targetOf(folder, 'Договоры/Новый.docx')).toEqual({ path: 'Договоры/Новый.docx', exists: null });
    expect(await targetOf(folder, 'Нет/Новый.docx')).toEqual({ path: 'Нет/Новый.docx', exists: null });
    expect(await targetOf(folder, '/Договоры//Договор.docx')).toEqual({ path: 'Договоры/Договор.docx', exists: { bytes: 12, lastModified: Date.UTC(2026, 10, 20) } });
    await expect(targetOf(folder, 'Договоры')).rejects.toThrow('«Договоры» — папка, а не файл');
    await expect(targetOf(folder, '../секрет.txt')).rejects.toThrow('ведёт за пределы папки');
    await expect(targetOf(folder, '')).rejects.toThrow('Укажите путь файла');
  });

  it('says in plain words why a write failed', async () => {
    const tree: Tree = { 'Договор.docx': new File(['x'], 'Договор.docx') };
    await expect(writeFileAt(folderOn(fakeFolder(tree, { fail: 'NoModificationAllowedError' })), 'Договор.docx', new Blob(['y']))).rejects.toThrow('занят другой программой');
    await expect(writeFileAt(folderOn(fakeFolder(tree, { fail: 'QuotaExceededError' })), 'Договор.docx', new Blob(['y']))).rejects.toThrow('не хватает места');
    await expect(writeFileAt(folderOn(fakeFolder(tree, { fail: 'NotAllowedError' })), 'Договор.docx', new Blob(['y']))).rejects.toThrow('не дал записать');
  });

  it('asks the browser for the right to write by a click, and says what to do when it refuses', async () => {
    const asks = fakeFolder({}, { access: { readwrite: 'prompt' } });
    await ensureWritable(folderOn(asks));
    expect(asks.asked).toEqual(['readwrite']);
    await expect(ensureWritable(folderOn(fakeFolder({}, { access: { readwrite: 'prompt' }, request: 'denied' })))).rejects.toThrow('Браузер запретил');
    await expect(ensureWritable(folderOn(fakeFolder({}, { access: { readwrite: 'denied' } })))).rejects.toThrow('Браузер запретил');
    await expect(ensureWritable(folderOn(fakeFolder({}), 'read'))).rejects.toThrow('только для чтения');
  });
});

describe('the access to the folder', () => {
  it('is the browser’s answer for the folder’s mode, and «missing» when the folder is gone from the computer', async () => {
    const fake = fakeFolder({}, { access: { read: 'granted', readwrite: 'prompt' } });
    expect(await accessOf(folderOn(fake, 'read'))).toBe('granted');
    expect(await accessOf(folderOn(fake, 'readwrite'))).toBe('prompt');
    expect(await accessOf(folderOn(fakeFolder({}, { gone: true }), 'read'))).toBe('missing');
  });
});
