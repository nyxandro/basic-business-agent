import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, ME, mockServer, type Reply } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const AGENTS = [{ id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', starters: [], actions: {}, systems: { tools: {}, prefixes: {} } }];
const THREADS = {
  threads: [{ id: 't2', title: 'Другой разговор', kind: 'chat', unread: false, updatedAt: '2026-11-14T08:00:00Z', agentId: 'sales', projectId: null }],
  next: null,
};

// A browser microphone: MediaRecorder hands over one piece of webm when stopped.
class FakeRecorder {
  static started = 0;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    FakeRecorder.started += 1;
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const stopTrack = vi.fn();

function stubMicrophone({ secure = true, allowed = true } = {}) {
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(() => (allowed ? Promise.resolve({ getTracks: () => [{ stop: stopTrack }] }) : Promise.reject(new DOMException('denied', 'NotAllowedError')))) },
  });
}

function server(transcribe: Reply | (() => Reply | Promise<Reply>), me: object = { ...ME, voiceAvailable: true }) {
  return mockServer({
    'GET /app/api/me': { body: me },
    'GET /app/api/agents': { body: { agents: AGENTS } },
    'GET /app/api/threads': { body: THREADS },
    'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: 3000, resetsOn: '2026-12-01' }, daily: null } },
    'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' } } } },
    'GET /app/api/projects': { body: { projects: [] } },
    'GET /app/api/threads/t1/project': { body: { projectId: null } },
    'GET /app/api/threads/t2/project': { body: { projectId: null } },
    'POST /app/api/voice/transcribe': transcribe,
  });
}

const transcriptions = (s: ReturnType<typeof server>) => s.calls.filter((c) => c.path === '/app/api/voice/transcribe');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  FakeRecorder.started = 0;
  stopTrack.mockClear();
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

async function record(seconds: number) {
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  await user.click(await screen.findByRole('button', { name: 'Голосовой ввод' }));
  expect(await screen.findByRole('button', { name: 'Готово' })).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(seconds * 1000);
  });
  return user;
}

describe('voice input', () => {
  it('records, shows «Распознаю…» and adds the text to the input', async () => {
    stubMicrophone();
    let answer: (r: Reply) => void = () => undefined;
    const s = server(() => new Promise<Reply>((resolve) => (answer = resolve)));
    renderApp('/agents/sales?thread=t1');
    const user = await record(3);
    expect(screen.getByText('0:03')).toBeInTheDocument();
    expect(screen.getByText('Голос распознаёт внешний сервис. Не диктуйте паспортные данные и номера карт.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Готово' }));
    expect(await screen.findByText('Распознаю…')).toBeInTheDocument();
    expect(stopTrack).toHaveBeenCalled();
    answer({ body: { text: 'Подготовь сводку по сделкам' } });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Сообщение агенту' })).toHaveValue('Подготовь сводку по сделкам'));
    expect(transcriptions(s)).toHaveLength(1);
  });

  it('sends the same recording again on «Повторить распознавание»', async () => {
    stubMicrophone();
    const s = server(apiError('APP_VOICE_FAILED', 'Не удалось распознать запись. Попробуйте ещё раз или напишите текстом.', 502));
    renderApp('/agents/sales?thread=t1');
    const user = await record(2);
    await user.click(screen.getByRole('button', { name: 'Готово' }));
    expect(await screen.findByText('Не удалось распознать запись. Попробуйте ещё раз или напишите текстом.')).toBeInTheDocument();
    s.set('POST /app/api/voice/transcribe', { body: { text: 'Со второго раза' } });
    await user.click(screen.getByRole('button', { name: 'Повторить распознавание' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Сообщение агенту' })).toHaveValue('Со второго раза'));
    expect(transcriptions(s)).toHaveLength(2);
    expect(FakeRecorder.started).toBe(1);
  });

  it('stops by itself at 120 seconds and recognises what was said', async () => {
    stubMicrophone();
    const s = server({ body: { text: 'Длинная речь' } });
    renderApp('/agents/sales?thread=t1');
    await record(120);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Сообщение агенту' })).toHaveValue('Длинная речь'));
    expect(screen.queryByRole('button', { name: 'Готово' })).not.toBeInTheDocument();
    expect(transcriptions(s)).toHaveLength(1);
  });

  it('puts the text into the draft of the conversation where the recording began', async () => {
    stubMicrophone();
    let answer: (r: Reply) => void = () => undefined;
    server(() => new Promise<Reply>((resolve) => (answer = resolve)));
    renderApp('/agents/sales?thread=t1');
    const user = await record(2);
    await user.click(screen.getByRole('button', { name: 'Готово' }));
    await screen.findByText('Распознаю…');
    await user.click(screen.getByRole('link', { name: /Другой разговор/ }));
    answer({ body: { text: 'Текст первого разговора' } });
    await waitFor(() => expect(localStorage.getItem('bba:draft:sales:t1')).toBe('Текст первого разговора'));
    expect(screen.getByRole('textbox', { name: 'Сообщение агенту' })).toHaveValue('');
  });

  it('refuses a recording shorter than half a second without the server', async () => {
    stubMicrophone();
    const s = server({ body: { text: 'не должно прийти' } });
    renderApp('/agents/sales?thread=t1');
    const user = await record(0);
    await user.click(screen.getByRole('button', { name: 'Готово' }));
    expect(await screen.findByText('Запись слишком короткая. Скажите ещё раз.')).toBeInTheDocument();
    expect(transcriptions(s)).toHaveLength(0);
  });

  it('cancels a recording without sending it', async () => {
    stubMicrophone();
    const s = server({ body: { text: 'не должно прийти' } });
    renderApp('/agents/sales?thread=t1');
    const user = await record(3);
    await user.click(screen.getByRole('button', { name: 'Отменить запись' }));
    expect(screen.getByRole('textbox', { name: 'Сообщение агенту' })).toHaveValue('');
    expect(transcriptions(s)).toHaveLength(0);
    expect(stopTrack).toHaveBeenCalled();
  });

  it('says the microphone is not allowed', async () => {
    stubMicrophone({ allowed: false });
    server({ body: { text: '' } });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(await screen.findByRole('button', { name: 'Голосовой ввод' }));
    expect(await screen.findByText('Нет доступа к микрофону. Разрешите его в настройках браузера.')).toBeInTheDocument();
  });

  it('disables the microphone without https and hides it without a recognition model', async () => {
    stubMicrophone({ secure: false });
    server({ body: { text: '' } });
    const first = renderApp('/agents/sales?thread=t1');
    expect(await screen.findByRole('button', { name: 'Голосовой ввод' })).toBeDisabled();
    first.unmount();
    stubMicrophone();
    server({ body: { text: '' } }, ME);
    renderApp('/agents/sales?thread=t1');
    await screen.findByRole('textbox', { name: 'Сообщение агенту' });
    expect(screen.queryByRole('button', { name: 'Голосовой ввод' })).not.toBeInTheDocument();
  });
});
