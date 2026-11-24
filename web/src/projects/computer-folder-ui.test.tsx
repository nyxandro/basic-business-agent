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

const card = (projectId: string) =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <ComputerFolderCard projectId={projectId} />
      </ToastProvider>
    </MemoryRouter>,
  );

const chip = (projectId: string) =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <ComputerFolderChip projectId={projectId} threadId="t1" />
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
    kept.set('p-switch', { name: 'Тендер', handle: fake.handle, mode: 'read' });
    stubPicker(fake.handle);
    card('p-switch');
    const user = userEvent.setup();
    expect(await screen.findByText('Только чтение · доступна агенту')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Читать и записывать/ }));
    expect(fake.asked).toEqual(['readwrite']);
    expect(await screen.findByText('Чтение и запись · доступна агенту')).toBeInTheDocument();

    const refusing = fakeFolder({}, { request: 'denied' });
    kept.set('p-refuse', { name: 'Тендер', handle: refusing.handle, mode: 'read' });
    card('p-refuse');
    const radios = await screen.findAllByRole('radio', { name: /Читать и записывать/ });
    await user.click(radios.at(-1)!);
    expect(await screen.findByText('Браузер не дал права изменять файлы — папка осталась только для чтения.')).toBeInTheDocument();
  });

  it('says what to do when the access must be confirmed, the browser forbade editing, or the folder is gone', async () => {
    const kept = stubFolderStore();
    stubPicker(null);
    kept.set('p-prompt', { name: 'Тендер', handle: fakeFolder({}, { access: { readwrite: 'prompt' } }).handle, mode: 'readwrite' });
    kept.set('p-denied', { name: 'Тендер', handle: fakeFolder({}, { access: { readwrite: 'denied' } }).handle, mode: 'readwrite' });
    kept.set('p-gone', { name: 'Тендер', handle: fakeFolder({}, { gone: true }).handle, mode: 'read' });
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
    kept.set('c-write', { name: 'Тендер', handle: fake.handle, mode: 'readwrite' });
    kept.set('c-prompt', { name: 'Тендер', handle: fakeFolder({}, { access: { read: 'prompt' } }).handle, mode: 'read' });
    kept.set('c-gone', { name: 'Тендер', handle: fakeFolder({}, { gone: true }).handle, mode: 'read' });
    const user = userEvent.setup();
    const write = chip('c-write');
    const button = await screen.findByRole('button', { name: 'Папка с компьютера: Тендер · чтение и запись' });
    await user.click(button);
    await user.click(screen.getByRole('menuitem', { name: 'Только читать' }));
    expect(await screen.findByRole('button', { name: 'Папка с компьютера: Тендер · только чтение' })).toBeInTheDocument();
    await waitFor(() => expect((kept.get('c-write') as { mode: string }).mode).toBe('read'));
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
    kept.set('c-denied', { name: 'Тендер', handle: fakeFolder({}, { access: { read: 'granted', readwrite: 'denied' } }).handle, mode: 'readwrite' });
    chip('c-denied');
    await userEvent.setup().click(await screen.findByRole('button', { name: /Только читать/ }));
    expect(await screen.findByRole('button', { name: 'Папка с компьютера: Тендер · только чтение' })).toBeInTheDocument();
  });
});
