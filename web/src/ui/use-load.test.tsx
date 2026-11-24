// The memory of screens (spec, section 8.22): a screen opened again shows what it loaded at once and
// asks the server anew; data without a key is fresh at every opening; each signed-in person has
// their own memory; a failure is shown, never covered by the remembered data, and not repeated.
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client.ts';
import { SessionProvider, useSession } from '../auth/session.tsx';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { newScreenMemory } from './screen-memory.ts';
import { useLoad } from './use-load.ts';

const Memory = ({ children }: { children: ReactNode }) => <QueryClientProvider client={newScreenMemory()}>{children}</QueryClientProvider>;

function Screen({ load, memoryKey }: { load: () => Promise<string>; memoryKey?: readonly unknown[] }) {
  const { state, reload } = useLoad(load, memoryKey);
  return (
    <p>
      {state.status === 'loading' ? 'ждём' : state.status === 'error' ? `ошибка ${state.error.code}` : state.data}
      <button type="button" onClick={reload}>
        заново
      </button>
    </p>
  );
}

// A screen that can be left and opened again, as a page is.
function Toggled({ load, memoryKey }: { load: () => Promise<string>; memoryKey?: readonly unknown[] }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen((o) => !o)}>
        туда-обратно
      </button>
      {open ? <Screen load={load} {...(memoryKey ? { memoryKey } : {})} /> : null}
    </>
  );
}
const Opened = (props: { load: () => Promise<string>; memoryKey?: readonly unknown[] }) => (
  <Memory>
    <Toggled {...props} />
  </Memory>
);

// Answers in order, each when the test lets it.
function server() {
  const answers: { resolve: (v: string) => void; reject: (e: unknown) => void }[] = [];
  const load = vi.fn(() => new Promise<string>((resolve, reject) => answers.push({ resolve, reject })));
  return { load, answers };
}

const toggle = () => act(() => screen.getByRole('button', { name: 'туда-обратно' }).click());

afterEach(() => vi.unstubAllGlobals());

describe('the memory of screens (spec, section 8.22)', () => {
  it('shows a remembered screen at once and asks the server anew, then shows the answer', async () => {
    const { load, answers } = server();
    render(<Opened load={load} memoryKey={['project', 'p1']} />);
    expect(screen.getByText('ждём')).toBeInTheDocument();
    await act(async () => {
      answers[0]!.resolve('Тендер');
      await Promise.resolve();
    });
    expect(await screen.findByText('Тендер')).toBeInTheDocument();
    toggle();
    toggle();
    // At once, without «ждём».
    expect(screen.getByText('Тендер')).toBeInTheDocument();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await act(async () => {
      answers[1]!.resolve('Тендер 2026');
      await Promise.resolve();
    });
    expect(await screen.findByText('Тендер 2026')).toBeInTheDocument();
  });

  it('loads data without a key anew at every opening', async () => {
    const { load, answers } = server();
    render(<Opened load={load} />);
    await act(async () => {
      answers[0]!.resolve('Файл на месте');
      await Promise.resolve();
    });
    expect(await screen.findByText('Файл на месте')).toBeInTheDocument();
    toggle();
    toggle();
    expect(screen.getByText('ждём')).toBeInTheDocument();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('starts the memory anew when the person signs out and another signs in', async () => {
    const { load, answers } = server();
    const s = mockServer({ 'GET /app/api/me': { body: ME }, 'POST /app/api/auth/sign-out': { body: {} } });
    function Signed() {
      const { session, signOut, refresh } = useSession();
      return (
        <>
          <button type="button" onClick={() => void signOut()}>
            выйти
          </button>
          <button type="button" onClick={() => void refresh()}>
            войти
          </button>
          {session.status === 'signed-in' ? <Toggled load={load} memoryKey={['me', 'memory']} /> : null}
        </>
      );
    }
    render(
      <SessionProvider>
        <Signed />
      </SessionProvider>,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(async () => {
      answers[0]!.resolve('Заметки Ольги');
      await Promise.resolve();
    });
    expect(await screen.findByText('Заметки Ольги')).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: 'выйти' }).click());
    await waitFor(() => expect(screen.queryByText('Заметки Ольги')).not.toBeInTheDocument());
    s.set('GET /app/api/me', { body: { ...ME, user: { id: 'u2', email: 'petr@example.com', name: 'Пётр' } } });
    act(() => screen.getByRole('button', { name: 'войти' }).click());
    // Пётр's screen asks for his own; nothing of Ольга's is shown meanwhile.
    expect(await screen.findByText('ждём')).toBeInTheDocument();
    expect(screen.queryByText('Заметки Ольги')).not.toBeInTheDocument();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('shows a failure of the quiet asking anew, once, and keeps the repeat', async () => {
    const { load, answers } = server();
    render(<Opened load={load} memoryKey={['approvals']} />);
    await act(async () => {
      answers[0]!.resolve('Два вопроса');
      await Promise.resolve();
    });
    await screen.findByText('Два вопроса');
    toggle();
    toggle();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await act(async () => {
      answers[1]!.reject(new ApiRequestError({ code: 'APP_SERVER_UNAVAILABLE', message: 'Сервер не отвечает', status: 0 }));
      await Promise.resolve();
    });
    expect(await screen.findByText('ошибка APP_SERVER_UNAVAILABLE')).toBeInTheDocument();
    // Not repeated by itself.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(load).toHaveBeenCalledTimes(2);
  });

  // A screen that reads its data again by itself (a ticket's conversation) keeps what it showed, and what is being
  // written there, under the error.
  it('gives the failure of a repeat with what was shown before it, and nothing with a failed first load', async () => {
    const { load, answers } = server();
    function Kept() {
      const { state, reload } = useLoad(load);
      return (
        <p>
          {state.status === 'error' ? `ошибка ${state.error.code}; было: ${state.stale ?? 'ничего'}` : state.status}
          <button type="button" onClick={reload}>
            заново
          </button>
        </p>
      );
    }
    render(
      <Memory>
        <Kept />
      </Memory>,
    );
    await act(async () => {
      answers[0]!.reject(new ApiRequestError({ code: 'APP_SERVER_UNAVAILABLE', message: 'Сервер не отвечает', status: 0 }));
      await Promise.resolve();
    });
    expect(await screen.findByText('ошибка APP_SERVER_UNAVAILABLE; было: ничего')).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: 'заново' }).click());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await act(async () => {
      answers[1]!.resolve('Переписка');
      await Promise.resolve();
    });
    expect(await screen.findByText('ready')).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: 'заново' }).click());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    await act(async () => {
      answers[2]!.reject(new ApiRequestError({ code: 'APP_SERVER_UNAVAILABLE', message: 'Сервер не отвечает', status: 0 }));
      await Promise.resolve();
    });
    expect(await screen.findByText('ошибка APP_SERVER_UNAVAILABLE; было: Переписка')).toBeInTheDocument();
  });

  it('asks anew when told to while the first load is on its way, and shows only the newer answer', async () => {
    const { load, answers } = server();
    render(
      <Memory>
        <Screen load={load} memoryKey={['threads', 'recent']} />
      </Memory>,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    // A conversation was made meanwhile: the list on its way does not have it.
    act(() => screen.getByRole('button', { name: 'заново' }).click());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await act(async () => {
      answers[0]!.resolve('без нового разговора');
      answers[1]!.resolve('с новым разговором');
      await Promise.resolve();
    });
    expect(await screen.findByText('с новым разговором')).toBeInTheDocument();
    expect(screen.queryByText('без нового разговора')).not.toBeInTheDocument();
  });

  it('keeps what is shown while asked again by «заново», and asks once for two screens of the same data', async () => {
    const { load, answers } = server();
    render(
      <Memory>
        <Screen load={load} memoryKey={['agents']} />
        <Screen load={load} memoryKey={['agents']} />
      </Memory>,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(async () => {
      answers[0]!.resolve('Продажи');
      await Promise.resolve();
    });
    expect(await screen.findAllByText('Продажи')).toHaveLength(2);
    act(() => screen.getAllByRole('button', { name: 'заново' })[0]!.click());
    expect(screen.getAllByText('Продажи')).toHaveLength(2);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await act(async () => {
      answers[1]!.resolve('Продажи и склад');
      await Promise.resolve();
    });
    expect(await screen.findAllByText('Продажи и склад')).toHaveLength(2);
  });
});
