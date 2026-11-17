// Attaching files to a message (spec, section 8.9): several at once from the paperclip, or dragged
// from the computer onto the chat window. Files go up one at a time; a file that cannot go is named
// in the error, the others are attached.
import type { CopilotChatViewProps } from '@copilotkit/react-core';
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client.ts';
import { RequireAuth, SessionProvider } from '../auth/session.tsx';
import { apiError, ME, mockServer, type MockCall, type Reply } from '../test/fetch-mock.ts';
import { ToastProvider } from '../ui/Toast.tsx';
import { attachFailure, type WaitingFile } from './attach.ts';
import { Attachments } from './Attachments.tsx';
import { ChatExtrasContext, type ChatExtras } from './chat-context.ts';
import { UploadProgress } from './upload-progress.ts';
import { ChatView } from './ChatView.tsx';

vi.mock('@copilotkit/react-core', async (original) => ({
  ...(await original<typeof import('@copilotkit/react-core')>()),
  useAgent: () => ({ agent: { pendingInterrupts: [], subscribe: () => ({ unsubscribe: () => undefined }) } }),
  useRenderToolCall: () => () => null,
}));

const AGENT = { id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', starters: [], mark: { kind: 'icon' as const, icon: 'spark' as const }, actions: {}, systems: { tools: {}, prefixes: {} } };
const UPLOAD = 'POST /app/api/threads/t1/files';
const DROP_HINT = 'Отпустите, чтобы прикрепить';

function extras(): ChatExtras {
  return {
    agent: AGENT,
    agentId: 'sales',
    threadId: 't1',
    attachments: [],
    addAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    onSubmitted: vi.fn(),
    onRunFinished: vi.fn(),
    onThreadTitled: vi.fn(),
    onUploadError: vi.fn(),
    interrupt: null,
    failure: null,
    onFailure: vi.fn(),
    interruptedIds: [],
    keepInterrupted: vi.fn(),
    onTurnsFailed: vi.fn(),
    composerExtra: null,
    composerNotice: null,
  };
}

const file = (name: string, bytes = 10) => {
  const f = new File(['x'], name);
  Object.defineProperty(f, 'size', { value: bytes });
  return f;
};
const uploaded = (call: MockCall): Reply => ({ status: 201, body: { name: call.form!.file!, path: call.form!.file! } });

async function showChat(upload: (call: MockCall) => Reply | Promise<Reply> = uploaded, props: Partial<CopilotChatViewProps> = {}) {
  const server = mockServer({ 'GET /app/api/me': { body: ME }, [UPLOAD]: upload });
  const ex = extras();
  const view = render(
    <MemoryRouter>
      <SessionProvider>
        <ToastProvider>
          <RequireAuth>
            <ChatExtrasContext value={ex}>
              <ChatView messages={[{ id: 'u1', role: 'user', content: 'Привет' }]} isRunning={false} {...props} />
            </ChatExtrasContext>
          </RequireAuth>
        </ToastProvider>
      </SessionProvider>
    </MemoryRouter>,
  );
  await screen.findByText('Привет');
  const uploads = () => server.calls.filter((c) => `${c.method} ${c.path}` === UPLOAD).map((c) => c.form!.file);
  return { ex, uploads, unmount: view.unmount, window: view.container.querySelector('[data-chat-window]') as HTMLElement };
}

const picker = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;
const dragged = (files: File[], types = ['Files']) => ({ dataTransfer: { types, files, items: [], dropEffect: 'none' } });
const shownError = (ex: ChatExtras) => vi.mocked(ex.onUploadError).mock.lastCall?.[0] as ApiRequestError;
// The server answers each upload when the test says so.
function heldUploads() {
  const answers: (() => void)[] = [];
  const route = (call: MockCall) => new Promise<Reply>((resolve) => answers.push(() => resolve(uploaded(call))));
  const answerNext = async (count: number) => {
    await waitFor(() => expect(answers.length).toBeGreaterThanOrEqual(count));
    act(() => answers[count - 1]!());
  };
  return { answers, route, answerNext };
}

afterEach(() => vi.unstubAllGlobals());

describe('attaching several files (spec, section 8.9)', () => {
  it('lets the paperclip choose several files and attaches them all, one after another', async () => {
    const { ex, uploads } = await showChat();
    const input = picker();
    expect(input).toHaveAttribute('multiple');
    await userEvent.setup().upload(input, [file('Счёт.pdf'), file('Смета.xlsx'), file('Фото.png')]);
    await waitFor(() => expect(ex.addAttachment).toHaveBeenCalledTimes(3));
    expect(uploads()).toEqual(['Счёт.pdf', 'Смета.xlsx', 'Фото.png']);
    expect(vi.mocked(ex.addAttachment).mock.calls.map(([f]) => f.name)).toEqual(['Счёт.pdf', 'Смета.xlsx', 'Фото.png']);
    expect(ex.onUploadError).not.toHaveBeenCalled();
  });

  it('shows every file on its way up and does not send until all are attached', async () => {
    const held = heldUploads();
    const onSubmitMessage = vi.fn();
    const { ex } = await showChat(held.route, { inputValue: 'Прочитай файлы', onInputChange: vi.fn(), onSubmitMessage });
    const sendButton = screen.getByRole('button', { name: 'Отправить' });
    expect(sendButton).toBeEnabled();
    await userEvent.setup().upload(picker(), [file('Счёт.pdf'), file('Смета.xlsx')]);
    expect(await screen.findByText('Загружаю Счёт.pdf…')).toBeInTheDocument();
    expect(screen.getByText('Загружаю Смета.xlsx…')).toBeInTheDocument();
    // The ring of each fills as it goes: half of the first is sent, the second waits its turn.
    const rings = screen.getAllByRole('progressbar');
    expect(rings.map((ring) => ring.getAttribute('aria-valuenow'))).toEqual(['50', '0']);
    // One at a time: the second goes up when the first is in.
    expect(held.answers).toHaveLength(1);
    expect(sendButton).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Сообщение агенту'), { key: 'Enter' });
    expect(onSubmitMessage).not.toHaveBeenCalled();
    await held.answerNext(1);
    await waitFor(() => expect(held.answers).toHaveLength(2));
    // A row leaving fades out first (Motion), then is gone.
    await waitFor(() => expect(screen.queryByText('Загружаю Счёт.pdf…')).not.toBeInTheDocument());
    expect(sendButton).toBeDisabled();
    await held.answerNext(2);
    await waitFor(() => expect(ex.addAttachment).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Загружаю/)).not.toBeInTheDocument());
    expect(sendButton).toBeEnabled();
  });

  it('puts files given meanwhile after the waiting ones and names the failures of both together', async () => {
    const held = heldUploads();
    const { ex, uploads } = await showChat(held.route);
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(picker(), [file('a.exe'), file('b.pdf')]);
    expect(shownError(ex).message).toBe('Не прикреплён «a.exe». Такой формат агент пока не читает. Подойдут документы, таблицы и презентации (Word, Excel, PowerPoint, PDF, OpenDocument, RTF), текст и разметка (TXT, Markdown, CSV, JSON, XML, HTML, YAML), письма EML, архивы ZIP и картинки (PNG, JPG, WebP, GIF, TIFF, BMP).');
    await user.upload(picker(), [file('c.exe'), file('d.pdf')]);
    expect(shownError(ex).message).toContain('Не прикреплены «a.exe», «c.exe».');
    await held.answerNext(1);
    await held.answerNext(2);
    await waitFor(() => expect(ex.addAttachment).toHaveBeenCalledTimes(2));
    expect(uploads()).toEqual(['b.pdf', 'd.pdf']);
    // A new batch after the queue emptied names only its own failures.
    await user.upload(picker(), [file('e.exe')]);
    expect(shownError(ex).message).toContain('Не прикреплён «e.exe».');
  });

  it('does not send the waiting files into a conversation that was left', async () => {
    const held = heldUploads();
    const { ex, uploads, unmount } = await showChat(held.route);
    await userEvent.setup().upload(picker(), [file('Счёт.pdf'), file('Смета.xlsx')]);
    await waitFor(() => expect(held.answers).toHaveLength(1));
    unmount();
    act(() => held.answers[0]!());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uploads()).toEqual(['Счёт.pdf']);
    expect(ex.onUploadError).not.toHaveBeenCalled();
  });

  it('names the files that did not go and attaches the rest', async () => {
    const { ex, uploads } = await showChat((call) => (call.form!.file === 'Смета.xlsx' ? apiError('APP_INTERNAL', 'Сервер не ответил.', 500) : uploaded(call)));
    await userEvent.setup({ applyAccept: false }).upload(picker(), [file('Счёт.pdf'), file('Запись.mp4'), file('Видео.pdf', 21 * 1024 * 1024), file('Смета.xlsx'), file('Фото.png')]);
    await waitFor(() => expect(ex.addAttachment).toHaveBeenCalledTimes(2));
    // What cannot go is not sent at all.
    expect(uploads()).toEqual(['Счёт.pdf', 'Смета.xlsx', 'Фото.png']);
    const error = shownError(ex);
    expect(error.message).toContain('«Запись.mp4»');
    expect(error.message).toContain('«Видео.pdf»');
    expect(error.message).toContain('«Смета.xlsx»');
    expect(error.code).toBe('APP_UPLOAD_TYPE_UNSUPPORTED, APP_UPLOAD_TOO_LARGE, APP_INTERNAL');
  });

  it('stops the rest when the session is over and says so as it is', async () => {
    const { ex, uploads } = await showChat(() => apiError('APP_AUTH_SESSION_EXPIRED', 'Сессия закончилась. Войдите снова.', 401));
    await userEvent.setup().upload(picker(), [file('Счёт.pdf'), file('Смета.xlsx')]);
    await waitFor(() => expect(ex.onUploadError).toHaveBeenCalled());
    expect(uploads()).toEqual(['Счёт.pdf']);
    expect(shownError(ex).code).toBe('APP_AUTH_SESSION_EXPIRED');
    await waitFor(() => expect(screen.queryByText(/Загружаю/)).not.toBeInTheDocument());
  });
});

describe('dragging files onto the chat window (spec, section 8.9)', () => {
  it('shows where to drop while files are over the window and attaches all dropped', async () => {
    const { ex, uploads, window: chat } = await showChat();
    expect(screen.queryByText(DROP_HINT)).not.toBeInTheDocument();
    fireEvent.dragEnter(chat, dragged([]));
    const zone = await screen.findByText(DROP_HINT);
    fireEvent.dragOver(zone, dragged([]));
    fireEvent.drop(zone, dragged([file('Счёт.pdf'), file('Договор.docx')]));
    expect(screen.queryByText(DROP_HINT)).not.toBeInTheDocument();
    await waitFor(() => expect(ex.addAttachment).toHaveBeenCalledTimes(2));
    expect(uploads()).toEqual(['Счёт.pdf', 'Договор.docx']);
  });

  it('hides the hint when the files leave the window', async () => {
    const { window: chat } = await showChat();
    fireEvent.dragEnter(chat, dragged([]));
    fireEvent.dragLeave(await screen.findByText(DROP_HINT), dragged([]));
    expect(screen.queryByText(DROP_HINT)).not.toBeInTheDocument();
  });

  it('does nothing for a dragged text or link', async () => {
    const { window: chat } = await showChat();
    fireEvent.dragEnter(chat, dragged([], ['text/plain']));
    expect(screen.queryByText(DROP_HINT)).not.toBeInTheDocument();
  });

  it('does nothing for a picture dragged from the page itself', async () => {
    const { window: chat } = await showChat();
    // The window learns of drags started on the page once the chat is drawn.
    await waitFor(() => {
      fireEvent.dragStart(chat, dragged([]));
      fireEvent.dragEnter(chat, dragged([file('картинка.png')]));
      const hint = screen.queryByText(DROP_HINT);
      if (hint) fireEvent.dragLeave(hint, dragged([]));
      expect(hint).toBeNull();
    });
    fireEvent.dragEnd(chat, dragged([]));
    fireEvent.dragEnter(chat, dragged([file('картинка.png')]));
    expect(await screen.findByText(DROP_HINT)).toBeInTheDocument();
  });

  it('does not let a file dropped beside the window open in the browser', async () => {
    await showChat();
    // The guard is put on the window after the chat is drawn.
    await waitFor(() => {
      const besideFiles = createEvent.drop(document.body, dragged([file('Счёт.pdf')]));
      fireEvent(document.body, besideFiles);
      expect(besideFiles.defaultPrevented).toBe(true);
    });
    // A dragged text keeps its usual way.
    const besideText = createEvent.drop(document.body, dragged([], ['text/plain']));
    fireEvent(document.body, besideText);
    expect(besideText.defaultPrevented).toBe(false);
  });

  it('refuses a dropped folder by name and attaches the files beside it', async () => {
    const { ex, uploads, window: chat } = await showChat();
    fireEvent.dragEnter(chat, dragged([]));
    const zone = await screen.findByText(DROP_HINT);
    const folder = file('Сметы');
    const items = [
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => folder },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => null },
    ];
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [folder, file('Счёт.pdf')], items } });
    await waitFor(() => expect(ex.addAttachment).toHaveBeenCalledTimes(1));
    expect(uploads()).toEqual(['Счёт.pdf']);
    expect(shownError(ex).message).toContain('«Сметы»');
    expect(shownError(ex).message).toContain('Папку прикрепить нельзя');
  });
});

describe('the error of files that did not go', () => {
  const failed = (name: string, code: string, message: string) => ({ name, error: new ApiRequestError({ code, message, status: 0 }) });

  it('names one file and says why', () => {
    const error = attachFailure([failed('Запись.mp4', 'APP_UPLOAD_TYPE_UNSUPPORTED', 'Такой формат агент пока не читает.')]);
    expect(error.message).toBe('Не прикреплён «Запись.mp4». Такой формат агент пока не читает.');
    expect(error.code).toBe('APP_UPLOAD_TYPE_UNSUPPORTED');
  });

  it('names several files with one reason once', () => {
    const error = attachFailure([failed('a.mp4', 'APP_UPLOAD_TYPE_UNSUPPORTED', 'Такой формат агент пока не читает.'), failed('b.exe', 'APP_UPLOAD_TYPE_UNSUPPORTED', 'Такой формат агент пока не читает.')]);
    expect(error.message).toBe('Не прикреплены «a.mp4», «b.exe». Такой формат агент пока не читает.');
    expect(error.code).toBe('APP_UPLOAD_TYPE_UNSUPPORTED');
  });

  it('gives each reason its files when the reasons differ', () => {
    const error = attachFailure([
      failed('a.mp4', 'APP_UPLOAD_TYPE_UNSUPPORTED', 'Такой формат агент пока не читает.'),
      failed('big.pdf', 'APP_UPLOAD_TOO_LARGE', 'Файл больше 20 МБ.'),
      failed('b.exe', 'APP_UPLOAD_TYPE_UNSUPPORTED', 'Такой формат агент пока не читает.'),
    ]);
    expect(error.message).toBe('Не прикреплены 3 файла. «a.mp4», «b.exe» — Такой формат агент пока не читает. «big.pdf» — Файл больше 20 МБ.');
    expect(error.code).toBe('APP_UPLOAD_TYPE_UNSUPPORTED, APP_UPLOAD_TOO_LARGE');
  });
});

describe('the name of an attached file (decision of the owner 17.11)', () => {
  it('keeps the end of a long name — its last short word and the extension — so two alike names are told apart', () => {
    const ex = { ...extras(), attachments: [{ name: 'ПРИМЕР_CV_Фамилия_Имя_Отчество (2).txt', path: 'a', bytes: 1 }, { name: 'ПРИМЕР_CV_Фамилия_Имя_Отчество.txt', path: 'b', bytes: 1 }, { name: 'Смета.xlsx', path: 'c', bytes: 1 }] };
    render(
      <ChatExtrasContext value={ex}>
        <Attachments uploading={[]} progress={new UploadProgress()} voice={null} />
      </ChatExtrasContext>,
    );
    const ends = ['ПРИМЕР_CV_Фамилия_Имя_Отчество (2).txt', 'ПРИМЕР_CV_Фамилия_Имя_Отчество.txt', 'Смета.xlsx'].map((name) => {
      const chip = screen.getByTitle(name);
      expect(chip).toHaveTextContent(name);
      return chip.lastElementChild!.textContent;
    });
    expect(ends).toEqual([' (2).txt', '_Отчество.txt', 'Смета.xlsx']);
  });
});

describe('many files in one card (decision of the owner 17.11)', () => {
  const NAMES = ['Резюме 1.docx', 'Резюме 2.docx', 'Резюме 3.docx', 'Резюме 4.docx', 'Счёт.pdf', 'Акт.pdf', 'Фото.png'];
  const show = (names: string[], uploading: WaitingFile[] = [], progress = new UploadProgress()) => {
    const ex = { ...extras(), attachments: names.map((name) => ({ name, path: `p/${name}`, bytes: 2048 })) };
    render(
      <ChatExtrasContext value={ex}>
        <Attachments uploading={uploading} progress={progress} voice={null} />
      </ChatExtrasContext>,
    );
    return ex;
  };

  it('gathers more than six files into one card with their count and kinds', () => {
    show(NAMES);
    const card = screen.getByRole('button', { name: /7 файлов/ });
    expect(card).toHaveAttribute('aria-expanded', 'false');
    expect(card).toHaveTextContent('4 Word · 2 PDF · 1 PNG');
    // The chips of the files are not drawn one by one.
    expect(screen.queryByRole('button', { name: 'Убрать Счёт.pdf' })).not.toBeInTheDocument();
  });

  it('keeps six files as chips', () => {
    show(NAMES.slice(0, 6));
    expect(screen.queryByRole('button', { name: /файлов/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Убрать Счёт.pdf' })).toBeInTheDocument();
  });

  it('opens into the list of the files, each taken away by its cross, all at once by «Убрать все»', async () => {
    const ex = show(NAMES);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /7 файлов/ }));
    expect(screen.getByRole('button', { name: /7 файлов/ })).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: 'Прикреплённые файлы' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    expect(within(list).getAllByText('2 КБ')).toHaveLength(7);
    await user.click(within(list).getByRole('button', { name: 'Убрать Счёт.pdf' }));
    expect(ex.removeAttachment).toHaveBeenCalledWith('p/Счёт.pdf');
    await user.click(screen.getByRole('button', { name: 'Убрать все' }));
    expect(ex.clearAttachments).toHaveBeenCalledOnce();
  });

  it('says how many are still on their way up and how far the whole batch is, as bytes go (the owner, 17.11)', () => {
    const progress = new UploadProgress();
    progress.begin();
    progress.add(1, 1000);
    progress.add(2, 1000);
    progress.add(3, 2000);
    show(NAMES.slice(0, 5), [{ id: 1, name: 'Смета.xlsx' }, { id: 2, name: 'План.pptx' }, { id: 3, name: 'Договор.docx' }], progress);
    const card = screen.getByRole('button', { name: /8 файлов/ });
    expect(card).toHaveTextContent('Загружаю ещё 3 · 0%');
    act(() => progress.sent(1, 1000));
    expect(card).toHaveTextContent('Загружаю ещё 3 · 25%');
    expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  });
});
