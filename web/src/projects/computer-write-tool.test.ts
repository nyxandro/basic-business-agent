// The agent's tool that writes into the folder of the person's computer (spec, section 8.25, «Запись в папку»): only for a
// folder given «Читать и записывать»; nothing is asked when a file is in the way without `replace`; the chat asks «Да»; on
// «Да» the server keeps a snapshot and the replaced version, the browser writes the file; «Нет» writes nothing.
import { describe, expect, it } from 'vitest';
import { mockServer, type MockCall } from '../test/fetch-mock.ts';
import { fakeFolder, folderOn, textAt, type Tree } from '../test/fake-folder.ts';
import { answerWrite, pendingWrite } from './computer-saves.ts';
import { computerTools } from './computer-tools.ts';
import type { ComputerFolder } from './computer-folder.ts';

type AnyTool = { name: string; reconnectBehavior?: string; handler: (args: Record<string, unknown>, context: { toolCall: { id: string }; signal?: AbortSignal }) => Promise<unknown> };
const tool = (f: ComputerFolder, name: string) => computerTools(f, 'thread-1').find((t) => t.name === name) as unknown as AnyTool | undefined;
const call = (id: string) => ({ toolCall: { id } });

// The server keeps a snapshot of each file and gives it back as «Скачать» does.
function server() {
  const saved: Record<string, string> = { 'КП Ёлка.docx': 'новое КП', 'Договор.docx': 'правленый договор' };
  return mockServer({
    'POST /app/api/threads/thread-1/computer-saves': (c: MockCall) => {
      const name = (c.form?.target ?? '').split('/').pop()!;
      return { status: 201, body: { id: 's1', name, bytes: 10, snapshot: `.computer-saved/u/s1/${name}`, previous: c.form?.previous ? `.computer-saved/u/s1/before/${name}` : null } };
    },
    'GET /app/api/threads/thread-1/file': (c: MockCall) => ({ raw: saved[c.query.path!.split('/').pop()!] ?? '' }),
  });
}

// The ask the chat shows for a call, once the tool has looked at the targets.
async function asked(id: string) {
  for (let i = 0; i < 50 && !pendingWrite(id); i++) await new Promise((r) => setTimeout(r, 0));
  return pendingWrite(id);
}

describe('the agent’s tool that writes into the folder of the computer', () => {
  it('exists only for a folder given «Читать и записывать»; every tool of the folder runs again after a reload', () => {
    expect(tool(folderOn(fakeFolder({}), 'read'), 'computer_folder_write')).toBeUndefined();
    const tools = computerTools(folderOn(fakeFolder({})), 'thread-1') as unknown as AnyTool[];
    expect(tools.map((t) => t.name)).toEqual(['computer_folder_list', 'computer_folder_find', 'computer_folder_read', 'computer_folder_write']);
    expect(tools.every((t) => t.reconnectBehavior === 'resume-pending')).toBe(true);
  });

  it('asks «Да» with what goes where, and on «Да» writes a new file and replaces one, keeping its earlier version on the server', async () => {
    const s = server();
    const tree: Tree = { 'Договоры': { 'Договор.docx': new File(['старый договор'], 'Договор.docx', { lastModified: Date.UTC(2026, 10, 20) }) } };
    const write = tool(folderOn(fakeFolder(tree)), 'computer_folder_write')!;
    const result = write.handler({ files: [{ file: 'КП Ёлка.docx', to: 'КП/2026/КП Ёлка.docx' }, { file: '.computer/u/Договоры/Договор.docx', to: 'Договоры/Договор.docx', replace: true }] }, call('c1'));
    expect(await asked('c1')).toEqual({
      folder: 'Тендер',
      items: [
        { file: 'КП Ёлка.docx', to: 'КП/2026/КП Ёлка.docx', exists: null, changedSinceRead: false },
        { file: '.computer/u/Договоры/Договор.docx', to: 'Договоры/Договор.docx', exists: { bytes: 27, lastModified: Date.UTC(2026, 10, 20) }, changedSinceRead: false },
      ],
    });
    expect(s.calls.filter((c) => c.method === 'POST')).toEqual([]);
    answerWrite('c1', true);
    expect(await result).toEqual({
      folder: 'Тендер',
      items: [
        { to: 'КП/2026/КП Ёлка.docx', written: true, name: 'КП Ёлка.docx', bytes: 10, snapshot: '.computer-saved/u/s1/КП Ёлка.docx', previous: null, replaced: false },
        { to: 'Договоры/Договор.docx', written: true, name: 'Договор.docx', bytes: 10, snapshot: '.computer-saved/u/s1/Договор.docx', previous: '.computer-saved/u/s1/before/Договор.docx', replaced: true },
      ],
    });
    expect(await textAt(tree, 'КП', '2026', 'КП Ёлка.docx')).toBe('новое КП');
    expect(await textAt(tree, 'Договоры', 'Договор.docx')).toBe('правленый договор');
    // The earlier version went to the server before the file was replaced.
    expect(s.calls.filter((c) => c.method === 'POST').map((c) => c.form)).toEqual([
      { source: 'КП Ёлка.docx', target: 'КП/2026/КП Ёлка.docx' },
      { source: '.computer/u/Договоры/Договор.docx', target: 'Договоры/Договор.docx', previous: 'Договор.docx' },
    ]);
    expect(pendingWrite('c1')).toBeNull();
  });

  it('on «Нет» writes nothing and tells the agent not to try again unasked', async () => {
    const s = server();
    const tree: Tree = {};
    const result = tool(folderOn(fakeFolder(tree)), 'computer_folder_write')!.handler({ files: [{ file: 'КП Ёлка.docx', to: 'КП Ёлка.docx' }] }, call('c2'));
    await asked('c2');
    answerWrite('c2', false);
    expect(await result).toEqual({ declined: true, message: 'Сотрудник отказался записывать файлы на компьютер. Не записывай их снова, пока он сам не попросит.' });
    expect(tree).toEqual({});
    expect(s.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('asks nothing when a file is in the way without `replace` or two files go to one place', async () => {
    server();
    const tree: Tree = { 'КП Ёлка.docx': new File(['x'], 'КП Ёлка.docx') };
    const write = tool(folderOn(fakeFolder(tree)), 'computer_folder_write')!;
    expect(await write.handler({ files: [{ file: 'КП Ёлка.docx', to: '/КП Ёлка.docx' }] }, call('c3'))).toEqual({
      error: 'Файл «КП Ёлка.docx» уже есть в папке «Тендер». Чтобы заменить его, повтори с replace: true; чтобы сохранить рядом — выбери другое имя.',
    });
    expect(await write.handler({ files: [{ file: 'a.docx', to: 'Новый.docx' }, { file: 'b.docx', to: './Новый.docx' }] }, call('c4'))).toEqual({ error: 'Два файла не записать в одно место: «Новый.docx».' });
    expect(await write.handler({ files: [{ file: 'a.docx', to: '../a.docx' }] }, call('c5'))).toEqual({ error: 'Путь «../a.docx» ведёт за пределы папки.' });
    expect(pendingWrite('c3') ?? pendingWrite('c4') ?? pendingWrite('c5')).toBeNull();
  });

  it('marks a file the person changed after the agent read it, and says which file failed and why', async () => {
    server();
    const tree: Tree = { 'Договор.docx': new File(['до правки'], 'Договор.docx', { lastModified: Date.UTC(2026, 10, 20) }) };
    const fake = fakeFolder(tree, { fail: 'NoModificationAllowedError' });
    const folder = folderOn(fake);
    await tool(folder, 'computer_folder_read')!.handler({ path: 'Договор.docx' }, call('r1'));
    // The person saves the file in Word after the agent read it.
    tree['Договор.docx'] = new File(['правка человека'], 'Договор.docx', { lastModified: Date.UTC(2026, 10, 21) });
    const result = tool(folder, 'computer_folder_write')!.handler({ files: [{ file: 'Договор.docx', to: 'Договор.docx', replace: true }] }, call('c6'));
    expect((await asked('c6'))?.items[0]?.changedSinceRead).toBe(true);
    answerWrite('c6', true);
    expect(await result).toEqual({
      folder: 'Тендер',
      items: [{ to: 'Договор.docx', written: false, error: 'Не удалось записать «Договор.docx»: файл занят другой программой (например, открыт в Word). Закройте его и попробуйте снова.' }],
    });
  });

  it('a stop of the answer while «Да» is awaited writes nothing', async () => {
    server();
    const stop = new AbortController();
    const result = tool(folderOn(fakeFolder({})), 'computer_folder_write')!.handler({ files: [{ file: 'a.docx', to: 'a.docx' }] }, { toolCall: { id: 'c7' }, signal: stop.signal });
    await asked('c7');
    stop.abort();
    expect(await result).toEqual({ error: 'Запись не сделана: ответ остановили.' });
    expect(pendingWrite('c7')).toBeNull();
  });
});
