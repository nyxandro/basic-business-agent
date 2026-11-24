// «Папка на компьютере» and the chip of the input (spec, section 8.25, «Запись в папку»): the mode is chosen before the
// folder — «Только читать» or «Читать и записывать» with its warning; a browser that cannot write says so; the state of
// the folder is told in words with what to press: confirm the access, the browser forbade editing, the folder is gone.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { fakeFolder, stubFolderStore, stubPicker } from '../test/fake-folder.ts';
import { ToastProvider } from '../ui/Toast.tsx';
import { ComputerFolderCard } from './ComputerFolderCard.tsx';
import { ComputerFolderChip } from './ComputerFolderChip.tsx';

// The chip registers the agent's tools of the folder; CopilotKit is not what is tested here.
vi.mock('@copilotkit/react-core', () => ({ useFrontendTools: () => undefined }));

// The person signed in now: a folder is theirs (key `<person>:<project>`), never another's who used this browser.
const ME = 'u-igor';
const key = (projectId: string, userId = ME) => `${userId}:${projectId}`;

const card = (projectId: string, userId = ME) =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <ComputerFolderCard projectId={projectId} userId={userId} />
      </ToastProvider>
    </MemoryRouter>,
  );

const chip = (projectId: string, userId = ME) =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <ComputerFolderChip projectId={projectId} userId={userId} threadId="t1" />
      </ToastProvider>
    </MemoryRouter>,
  );

describe('«Папка на компьютере»', () => {
  it('connects a folder for reading and writing when the person chose it, with the warning about the computer', async () => {
    stubFolderStore();
    const picker = stubPicker(fakeFolder({}).handle);
    card('p-write');
    const user = userEvent.setup();
    const modes = screen.getByRole('radiogroup', { name: 'Что можно агенту' });
    expect(within(modes).getByRole('radio', { name: /Только читать/ })).toBeChecked();
    await user.click(within(modes).getByRole('radio', { name: /Читать и записывать/ }));
    expect(screen.getByText('Изменения файлов на компьютере могут быть необратимы — включайте на свой страх и риск.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Подключить папку' }));
    expect(picker.modes).toEqual(['readwrite']);
    expect(await screen.findByText('Чтение и запись · доступна агенту')).toBeInTheDocument();
  });

  // The folder is the person's, in this browser: a colleague of the project does not see it.
  it('says the folder is the person’s own and only in this browser', () => {
    stubFolderStore();
    stubPicker(fakeFolder({}).handle);
    card('p-own');
    expect(screen.getByText('Папка — только ваша и только в этом браузере: коллеги по проекту её не видят и могут подключить свою.')).toBeInTheDocument();
  });

  // A shared computer: another person signed in to the same browser opens the same shared project — the folder of the one
  // before is not theirs, and the browser's leave to read it is the site's, not the person's.
  it('never gives another person signed in to the same browser the folder of the one before', async () => {
    const kept = stubFolderStore();
    stubPicker(fakeFolder({}).handle);
    kept.set(key('p-shared', 'u-igor'), { name: 'Папка Игоря', handle: fakeFolder({}).handle, mode: 'readwrite' });
    const olga = card('p-shared', 'u-olga');
    expect(await screen.findByRole('button', { name: 'Подключить папку' })).toBeInTheDocument();
    expect(screen.queryByText('Папка Игоря')).not.toBeInTheDocument();
    olga.unmount();
    card('p-shared', 'u-igor');
    expect(await screen.findByText('Папка Игоря')).toBeInTheDocument();
  });

  it('a browser that cannot write offers reading only, and says where writing works', () => {
    stubFolderStore();
    stubPicker(fakeFolder({}).handle, { write: false });
    card('p-nowrite');
    expect(screen.getByRole('radio', { name: /Читать и записывать/ })).toBeDisabled();
    expect(screen.getByText('Запись в папку работает в Chrome, Edge и Яндекс Браузере.')).toBeInTheDocument();
  });

  it('turns writing on for a connected folder by the browser’s leave, and keeps reading when the browser refuses', async () => {
    const kept = stubFolderStore();
    const fake = fakeFolder({}, { access: { read: 'granted', readwrite: 'prompt' } });
    kept.set(key('p-switch'), { name: 'Тендер', handle: fake.handle, mode: 'read' });
    stubPicker(fake.handle);
    card('p-switch');
    const user = userEvent.setup();
    expect(await screen.findByText('Только чтение · доступна агенту')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Читать и записывать/ }));
    expect(fake.asked).toEqual(['readwrite']);
    expect(await screen.findByText('Чтение и запись · доступна агенту')).toBeInTheDocument();

    const refusing = fakeFolder({}, { request: 'denied' });
    kept.set(key('p-refuse'), { name: 'Тендер', handle: refusing.handle, mode: 'read' });
    card('p-refuse');
    const radios = await screen.findAllByRole('radio', { name: /Читать и записывать/ });
    await user.click(radios.at(-1)!);
    expect(await screen.findByText('Браузер не дал права изменять файлы — папка осталась только для чтения.')).toBeInTheDocument();
  });

  it('says what to do when the access must be confirmed, the browser forbade editing, or the folder is gone', async () => {
    const kept = stubFolderStore();
    stubPicker(null);
    kept.set(key('p-prompt'), { name: 'Тендер', handle: fakeFolder({}, { access: { readwrite: 'prompt' } }).handle, mode: 'readwrite' });
    kept.set(key('p-denied'), { name: 'Тендер', handle: fakeFolder({}, { access: { readwrite: 'denied' } }).handle, mode: 'readwrite' });
    kept.set(key('p-gone'), { name: 'Тендер', handle: fakeFolder({}, { gone: true }).handle, mode: 'read' });
    const prompt = card('p-prompt');
    expect(await screen.findByText('Нужно подтвердить доступ')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Разрешить доступ' })).toBeInTheDocument();
    prompt.unmount();
    const denied = card('p-denied');
    expect(await screen.findByText('Браузер запретил изменять файлы')).toBeInTheDocument();
    expect(screen.getByText(/Разрешить можно в настройках сайта/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Работать только на чтение' })).toBeInTheDocument();
    denied.unmount();
    card('p-gone');
    expect(await screen.findByText('Папка недоступна: её переместили, удалили или отключили диск')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Выбрать заново' })).toBeInTheDocument();
  });
});

describe('the chip of the folder in the input', () => {
  it('names the mode, switches it from its menu, and asks to confirm the access or choose a gone folder again', async () => {
    const kept = stubFolderStore();
    stubPicker(null);
    const fake = fakeFolder({});
    kept.set(key('c-write'), { name: 'Тендер', handle: fake.handle, mode: 'readwrite' });
    kept.set(key('c-prompt'), { name: 'Тендер', handle: fakeFolder({}, { access: { read: 'prompt' } }).handle, mode: 'read' });
    kept.set(key('c-gone'), { name: 'Тендер', handle: fakeFolder({}, { gone: true }).handle, mode: 'read' });
    const user = userEvent.setup();
    const write = chip('c-write');
    const button = await screen.findByRole('button', { name: 'Папка с компьютера: Тендер · чтение и запись' });
    await user.click(button);
    await user.click(screen.getByRole('menuitem', { name: 'Только читать' }));
    expect(await screen.findByRole('button', { name: 'Папка с компьютера: Тендер · только чтение' })).toBeInTheDocument();
    await waitFor(() => expect((kept.get(key('c-write')) as { mode: string }).mode).toBe('read'));
    write.unmount();
    const prompt = chip('c-prompt');
    expect(await screen.findByRole('button', { name: /Разрешить доступ/ })).toBeInTheDocument();
    prompt.unmount();
    chip('c-gone');
    expect(await screen.findByRole('button', { name: /Выбрать заново/ })).toBeInTheDocument();
  });

  // The browser forbade editing the folder: the chip offers to go on reading it.
  it('turns a folder whose editing the browser forbade to reading', async () => {
    const kept = stubFolderStore();
    stubPicker(null);
    kept.set(key('c-denied'), { name: 'Тендер', handle: fakeFolder({}, { access: { read: 'granted', readwrite: 'denied' } }).handle, mode: 'readwrite' });
    chip('c-denied');
    await userEvent.setup().click(await screen.findByRole('button', { name: /Только читать/ }));
    expect(await screen.findByRole('button', { name: 'Папка с компьютера: Тендер · только чтение' })).toBeInTheDocument();
  });
});
