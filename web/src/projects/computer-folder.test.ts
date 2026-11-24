// The folder of the person's computer (spec, section 8.25): what the agent's tools of the browser see in it,
// found by name, a text read at once and a document copied into the working folder; no way out of the folder;
// no access — the agent is told what the person should do.
import { describe, expect, it } from 'vitest';
import { mockServer } from '../test/fetch-mock.ts';
import { adoptFiles, fileAt, findFiles, listEntries, partsOf, type ComputerFolder, type DirectoryHandle } from './computer-folder.ts';
import { computerTools } from './computer-tools.ts';

type Tree = { [name: string]: Tree | string };

// A folder of the File System Access API made of a plain object: a string is a file with that text. Read only: a write
// is the business of computer-write.test.ts.
const unwritable = () => Promise.reject(new DOMException('read only', 'NotAllowedError'));
function handleOf(name: string, tree: Tree, access: PermissionState = 'granted'): DirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *values() {
      for (const [n, v] of Object.entries(tree)) yield await Promise.resolve(typeof v === 'string' ? { kind: 'file' as const, name: n, getFile: () => Promise.resolve(new File([v], n, { lastModified: Date.UTC(2026, 10, 1) })), createWritable: unwritable } : handleOf(n, v, access));
    },
    getDirectoryHandle: (n: string) => (typeof tree[n] === 'object' ? Promise.resolve(handleOf(n, tree[n], access)) : Promise.reject(new DOMException('no', 'NotFoundError'))),
    getFileHandle: (n: string) =>
      typeof tree[n] === 'string' ? Promise.resolve({ kind: 'file' as const, name: n, getFile: () => Promise.resolve(new File([tree[n] as string], n)), createWritable: unwritable }) : Promise.reject(new DOMException('no', 'NotFoundError')),
    queryPermission: () => Promise.resolve(access),
    requestPermission: () => Promise.resolve('granted'),
  };
}

const TREE: Tree = {
  'Договоры': { '2026': { 'Договор Стройресурс.docx': 'docx-bytes', 'заметки.txt': 'Оплата до 20 ноября' } },
  'Сметы': { 'смета ЖК Северный.xlsx': 'xlsx-bytes' },
  node_modules: { 'договор.js': 'x' },
  'readme.md': '# Папка тендера',
};

const folder = (access: PermissionState = 'granted'): ComputerFolder => ({ kind: 'handle', name: 'Тендер', handle: handleOf('Тендер', TREE, access), mode: 'read' });
type AnyTool = { name: string; description: string; handler: (args: Record<string, unknown>) => Promise<unknown> };
const tool = (f: ComputerFolder, name: string) => computerTools(f, 'thread-1').find((t) => t.name === name) as unknown as AnyTool;

describe('the folder of the computer', () => {
  it('lists a folder, folders first, by name', async () => {
    expect(await listEntries(folder(), '')).toEqual({
      entries: [
        { path: 'Договоры', kind: 'folder' },
        { path: 'Сметы', kind: 'folder' },
        { path: 'node_modules', kind: 'folder' },
        { path: 'readme.md', kind: 'file', bytes: 27, modified: '2026-11-01T00:00:00.000Z' },
      ],
      more: false,
    });
    expect((await listEntries(folder(), 'Договоры/2026')).entries.map((e) => e.path)).toEqual(['Договоры/2026/Договор Стройресурс.docx', 'Договоры/2026/заметки.txt']);
    await expect(listEntries(folder(), 'Нет такой')).rejects.toThrow('Папки «Нет такой» нет.');
  });

  it('finds files by every word of the query, past the folders of programs', async () => {
    expect((await findFiles(folder(), 'договор стройресурс')).files.map((f) => f.path)).toEqual(['Договоры/2026/Договор Стройресурс.docx']);
    expect((await findFiles(folder(), 'северныи')).files).toEqual([]);
    expect((await findFiles(folder(), 'северный')).files.map((f) => f.path)).toEqual(['Сметы/смета ЖК Северный.xlsx']);
    expect((await findFiles(folder(), 'договор')).files.some((f) => f.path.startsWith('node_modules'))).toBe(false);
  });

  // A name from a Mac or an archive writes «й», «ё» as a letter and a mark; the model writes them joined. The browser
  // compares names byte for byte: the folder finds the entry either way (seen live 25.11: «Файла … нет» for a file listed).
  it('finds a file and a folder whose names write letters as a letter and a mark, by the name the model writes', async () => {
    const mac = (name: string) => name.normalize('NFD');
    const tree: Tree = { [mac('Отчёты')]: { [mac('ПРИМЕР_СV_Системный_аналитик.docx')]: 'резюме' } };
    const f: ComputerFolder = { kind: 'handle', name: 'Тендер', handle: handleOf('Тендер', tree), mode: 'read' };
    expect(await (await fileAt(f, 'Отчёты/ПРИМЕР_СV_Системный_аналитик.docx')).text()).toBe('резюме');
    expect((await listEntries(f, 'Отчёты')).entries).toHaveLength(1);
    expect((await findFiles(f, 'системный')).files).toHaveLength(1);
  });

  // The agent searched «CV» in Latin letters for a name with the Cyrillic «С» (seen live 25.11).
  it('finds by letters that look alike in Latin and Cyrillic', async () => {
    const tree: Tree = { 'ПРИМЕР_СV_Иванов.docx': 'резюме', 'Отчет_PECO.xlsx': 'x' };
    const f: ComputerFolder = { kind: 'handle', name: 'Тендер', handle: handleOf('Тендер', tree), mode: 'read' };
    expect((await findFiles(f, 'CV')).files.map((e) => e.path)).toEqual(['ПРИМЕР_СV_Иванов.docx']);
    expect((await findFiles(f, 'ресо')).files.map((e) => e.path)).toEqual(['Отчет_PECO.xlsx']);
  });

  it('names the files like the one asked when it is not there', async () => {
    await expect(fileAt(folder(), 'Договоры/2026/Договор.docx')).rejects.toThrow('Файла «Договоры/2026/Договор.docx» нет. Похожие в этой папке: «Договоры/2026/Договор Стройресурс.docx».');
    await expect(fileAt(folder(), 'Сметы/Акт.pdf')).rejects.toThrow('Файла «Сметы/Акт.pdf» нет. Посмотри список этой папки (computer_folder_list).');
  });

  it('does not lead out of the folder', () => {
    expect(() => partsOf('../../etc/passwd')).toThrow('ведёт за пределы папки');
    expect(partsOf('/Договоры//2026/./')).toEqual(['Договоры', '2026']);
  });

  it('keeps the files of a folder chosen in Firefox for the tab', async () => {
    const list = [new File(['a'], 'a.txt'), new File(['b'], 'b.pdf')];
    Object.defineProperty(list[0], 'webkitRelativePath', { value: 'Тендер/a.txt' });
    Object.defineProperty(list[1], 'webkitRelativePath', { value: 'Тендер/Сметы/b.pdf' });
    const fileList = Object.assign(list, { item: (i: number) => list[i] ?? null }) as unknown as FileList;
    const f = adoptFiles('p-firefox', fileList)!;
    expect(f.name).toBe('Тендер');
    expect((await listEntries(f, '')).entries.map((e) => `${e.kind}:${e.path}`)).toEqual(['folder:Сметы', 'file:a.txt']);
    expect((await findFiles(f, 'b')).files.map((e) => e.path)).toEqual(['Сметы/b.pdf']);
  });
});

describe('the agent’s tools of the folder', () => {
  it('a text comes back as it is; a document is copied into the working folder of the conversation', async () => {
    const s = mockServer({ 'POST /app/api/threads/thread-1/computer-file': (call) => ({ status: 201, body: { path: `.computer/${call.form?.path ?? ''}`, bytes: 10 } }) });
    const read = tool(folder(), 'computer_folder_read');
    expect(await read.handler({ path: 'Договоры/2026/заметки.txt' })).toEqual({ path: 'Договоры/2026/заметки.txt', bytes: 33, text: 'Оплата до 20 ноября' });
    expect(await read.handler({ path: 'Договоры/2026/Договор Стройресурс.docx' })).toEqual({
      path: '.computer/Договоры/2026/Договор Стройресурс.docx',
      bytes: 10,
      note: 'Файл скопирован в рабочую папку: .computer/Договоры/2026/Договор Стройресурс.docx. Прочитай его скиллом по этому пути.',
    });
    expect(s.calls.filter((c) => c.method === 'POST').map((c) => c.form)).toEqual([{ path: 'Договоры/2026/Договор Стройресурс.docx', file: 'Договор Стройресурс.docx' }]);
    expect(await read.handler({ path: 'Договоры/нет.docx' })).toEqual({ error: 'Файла «Договоры/нет.docx» нет. Посмотри список этой папки (computer_folder_list).' });
    expect(await read.handler({ path: 'Нет/нет.docx' })).toEqual({ error: 'Папки «Нет» нет.' });
  });

  it('without access the agent is told what the person should do', async () => {
    const list = tool(folder('prompt'), 'computer_folder_list');
    expect(await list.handler({})).toEqual({ error: 'Нет доступа к папке «Тендер»: попросите сотрудника нажать «Разрешить доступ» у папки над полем ввода.' });
  });

  it('names the folder in the descriptions of the tools', () => {
    expect(computerTools(folder(), 'thread-1').map((t) => t.name)).toEqual(['computer_folder_list', 'computer_folder_find', 'computer_folder_read']);
    expect(tool(folder(), 'computer_folder_find').description).toContain('«Тендер»');
  });
});
