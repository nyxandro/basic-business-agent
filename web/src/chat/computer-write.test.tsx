// A write of the agent onto the person's computer in the chat (spec, section 8.25, «Запись в папку»): the card asks «Да»
// with what goes where — a new file or one replaced, and a file the person changed after the agent read it; done, each
// file is a block to open with where it lies now, and «Вернуть прежнюю версию» puts the replaced version back.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ChatExtrasContext, type ChatExtras } from '../answer/chat-context.ts';
import { askToWrite, setThreadFolder } from '../projects/computer-saves.ts';
import { fakeFolder, folderOn, textAt, type Tree } from '../test/fake-folder.ts';
import { mockServer } from '../test/fetch-mock.ts';
import { ToastProvider } from '../ui/Toast.tsx';
import { ComputerWriteCall } from './ComputerWriteCall.tsx';

const AGENT = { systems: { tools: { computer_folder_write: 'Компьютер' }, prefixes: {} }, actions: { computer_folder_write: { title: 'Запись файлов в папку на компьютере', fields: {}, readOnly: false } } };
type Call = Parameters<typeof ComputerWriteCall>[0]['call'];
const running = (id: string): Call => ({ toolCallId: id, status: 'executing', parameters: { files: [] }, result: undefined });
const complete = (id: string, result: unknown): Call => ({ toolCallId: id, status: 'complete', parameters: { files: [] }, result: JSON.stringify(result) });

function show(call: Call) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ChatExtrasContext value={{ threadId: 't1', draft: false } as ChatExtras}>
          <ComputerWriteCall call={call} agent={AGENT} />
        </ChatExtrasContext>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const WRITTEN = {
  folder: 'Тендер',
  items: [
    { to: 'КП/2026/КП Ёлка.docx', written: true, name: 'КП Ёлка.docx', bytes: 2048, snapshot: '.computer-saved/u/s1/КП Ёлка.docx', previous: null, replaced: false },
    { to: 'Договоры/Договор.docx', written: true, name: 'Договор.docx', bytes: 4096, snapshot: '.computer-saved/u/s1/Договор.docx', previous: '.computer-saved/u/s1/before/Договор.docx', replaced: true },
    { to: 'Акт.docx', written: false, error: 'Не удалось записать «Акт.docx»: файл занят другой программой (например, открыт в Word). Закройте его и попробуйте снова.' },
  ],
};

describe('a write onto the computer in the chat', () => {
  it('asks «Да» with what goes where, and the answer goes to the waiting tool', async () => {
    mockServer({});
    const answer = askToWrite('w1', {
      threadId: 't1',
      folder: 'Тендер',
      items: [
        { file: 'out/КП Ёлка v2.docx', to: 'КП/2026/КП Ёлка.docx', replace: false, exists: null, changedSinceRead: false },
        { file: '.computer/u/Договор.docx', to: 'Договоры/Договор.docx', replace: true, exists: { bytes: 27, lastModified: Date.UTC(2026, 10, 20, 9, 5) }, changedSinceRead: true },
      ],
    });
    show(running('w1'));
    const card = screen.getByRole('group', { name: 'Сохранить на компьютер в папку «Тендер»?' });
    expect(within(card).getByText('КП/2026/КП Ёлка.docx')).toBeInTheDocument();
    // Which file of the agent goes there, when its name differs.
    expect(within(card).getByText('из «КП Ёлка v2.docx»')).toBeInTheDocument();
    expect(within(card).getByText('новый файл')).toBeInTheDocument();
    expect(within(card).getByText(/^заменит файл от 20 ноября/)).toBeInTheDocument();
    expect(within(card).getByText('Файл изменили после того, как агент его прочитал, — эти изменения пропадут.')).toBeInTheDocument();
    expect(within(card).getByText('Прежняя версия заменённого файла сохранится на сервере на 30 дней.')).toBeInTheDocument();
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Да, сохранить' }));
    expect(await answer).toBe('yes');
    expect(screen.queryByRole('group', { name: /Сохранить на компьютер/ })).not.toBeInTheDocument();
  });

  it('«Нет» answers no', async () => {
    mockServer({});
    const answer = askToWrite('w2', { threadId: 't1', folder: 'Тендер', items: [{ file: 'a.docx', to: 'a.docx', replace: false, exists: null, changedSinceRead: false }] });
    show(running('w2'));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Нет' }));
    expect(await answer).toBe('no');
  });

  it('shows each file written as a block with where it lies now, and what failed', () => {
    mockServer({});
    show(complete('w3', WRITTEN));
    expect(screen.getByText('КП Ёлка.docx')).toBeInTheDocument();
    expect(screen.getByText('Записано на компьютер: КП/2026/КП Ёлка.docx')).toBeInTheDocument();
    expect(screen.getByText('Записано на компьютер: Договоры/Договор.docx · прежний файл заменён')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Скачать Договор.docx' })).toHaveAttribute('href', '/app/api/threads/t1/file?path=.computer-saved%2Fu%2Fs1%2F%D0%94%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80.docx');
    expect(screen.getAllByRole('button', { name: 'Вернуть прежнюю версию' })).toHaveLength(1);
    expect(screen.getByText('Не записано: Акт.docx — Не удалось записать «Акт.docx»: файл занят другой программой (например, открыт в Word). Закройте его и попробуйте снова.')).toBeInTheDocument();
  });

  it('«Вернуть прежнюю версию» asks first, then writes the kept version back onto the computer', async () => {
    mockServer({ 'GET /app/api/threads/t1/file': { raw: 'старый договор' } });
    const tree: Tree = { 'Договоры': { 'Договор.docx': new File(['правка агента'], 'Договор.docx') } };
    act(() => setThreadFolder('t1', folderOn(fakeFolder(tree))));
    show(complete('w4', WRITTEN));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Вернуть прежнюю версию' }));
    expect(screen.getByText('Заменить «Договоры/Договор.docx» на компьютере прежней версией? Правки, сделанные после записи агента, пропадут.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(await textAt(tree, 'Договоры', 'Договор.docx')).toBe('правка агента');
    await user.click(screen.getByRole('button', { name: 'Вернуть прежнюю версию' }));
    await user.click(screen.getByRole('button', { name: 'Вернуть' }));
    await waitFor(async () => expect(await textAt(tree, 'Договоры', 'Договор.docx')).toBe('старый договор'));
    expect(await screen.findByText('Прежняя версия возвращена на компьютер.')).toBeInTheDocument();
    act(() => setThreadFolder('t1', null));
  });

  it('does not put the version back into another folder, and says when the kept version is gone after 30 days', async () => {
    const s = mockServer({ 'GET /app/api/threads/t1/file': { status: 404, body: { error: { code: 'APP_FILE_DELETED', message: 'Файл «Договор.docx» удалён из рабочей папки — скачать его нельзя.' } } } });
    const other: Tree = { 'Договоры': { 'Договор.docx': new File(['чужой'], 'Договор.docx') } };
    act(() => setThreadFolder('t1', { ...folderOn(fakeFolder(other)), name: 'Другая папка' }));
    const view = show(complete('w7', WRITTEN));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Вернуть прежнюю версию' }));
    expect(await screen.findByText('К проекту теперь подключена другая папка — «Другая папка»: прежнюю версию в неё не вернуть.')).toBeInTheDocument();
    expect(s.calls.filter((c) => c.path === '/app/api/threads/t1/file')).toEqual([]);
    view.unmount();
    act(() => setThreadFolder('t1', folderOn(fakeFolder(other))));
    show(complete('w8', WRITTEN));
    await user.click(screen.getByRole('button', { name: 'Вернуть прежнюю версию' }));
    await user.click(screen.getByRole('button', { name: 'Вернуть' }));
    expect(await screen.findByText('Прежняя версия хранилась на сервере 30 дней и уже удалена.')).toBeInTheDocument();
    expect(await textAt(other, 'Договоры', 'Договор.docx')).toBe('чужой');
    act(() => setThreadFolder('t1', null));
  });

  it('without the folder in this browser says how to put the version back', async () => {
    mockServer({});
    show(complete('w5', WRITTEN));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Вернуть прежнюю версию' }));
    expect(await screen.findByText('Чтобы вернуть прежнюю версию, откройте этот разговор там, где подключена папка проекта.')).toBeInTheDocument();
  });

  it('says the person refused, and what stopped the write', () => {
    mockServer({});
    show(complete('w6', { declined: true, message: 'нет' }));
    expect(screen.getByText('Вы отказались сохранять файлы на компьютер.')).toBeInTheDocument();
  });
});
