// How full a conversation is (spec, section 8.34; decisions of the owner 25.11): a ring in the header of the chat —
// only the ring, the numbers in a window on a click; amber from 70%, red from 90%, then «Новый разговор» in the window.
// Nothing at all when the server has nothing to show.
import { CHAT_EVENTS, type ThreadContextFill } from '@bba/contracts';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { WithMemory } from '../test/memory.tsx';
import { renderApp } from '../test/render.tsx';
import { ContextFillButton } from './ContextFill.tsx';
import { contextFillSubscriber, useContextFill } from './context-fill.ts';

const fill = (tokens: number, limit = 128_000, hidden = false): ThreadContextFill => ({ tokens, limit, hidden });
const show = (value: ThreadContextFill | null, onNew = vi.fn()) => render(<ContextFillButton fill={value} onNewConversation={onNew} />);
const ring = () => screen.getByRole('button', { name: /^Длина разговора/ });

afterEach(() => vi.restoreAllMocks());

describe('the ring of how full a conversation is', () => {
  it('is not there when the server has nothing to show', () => {
    show(null);
    expect(screen.queryByRole('button', { name: /Длина разговора/ })).not.toBeInTheDocument();
  });

  it('shows only the ring; the numbers open in a window on a click', async () => {
    show(fill(52_469));
    expect(ring()).toHaveAccessibleName('Длина разговора: 41%');
    expect(ring()).toHaveAttribute('data-level', 'ok');
    expect(screen.queryByText('41%')).not.toBeInTheDocument();

    await userEvent.setup().click(ring());
    const panel = screen.getByRole('dialog', { name: 'Длина разговора' });
    expect(within(panel).getByText('41%')).toBeInTheDocument();
    expect(within(panel).getByText('52 тыс. из 128 тыс. токенов')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Новый разговор' })).not.toBeInTheDocument();
    expect(within(panel).queryByText('Начало разговора агент уже не видит')).not.toBeInTheDocument();
  });

  it('turns amber from 70% and offers a new conversation; red from 90%', async () => {
    const onNew = vi.fn();
    const { rerender } = show(fill(89_600), onNew);
    expect(ring()).toHaveAccessibleName('Длина разговора: 70%');
    expect(ring()).toHaveAttribute('data-level', 'high');
    const user = userEvent.setup();
    await user.click(ring());
    const panel = screen.getByRole('dialog', { name: 'Длина разговора' });
    expect(within(panel).getByText('Скоро разговор не поместится в модель. Начните новый — важное о вас агент помнит.')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Новый разговор' }));
    expect(onNew).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: 'Длина разговора' })).not.toBeInTheDocument();

    rerender(<ContextFillButton fill={fill(115_200)} onNewConversation={onNew} />);
    expect(ring()).toHaveAccessibleName('Длина разговора: 90%');
    expect(ring()).toHaveAttribute('data-level', 'full');
  });

  it('takes its colour from the percent it shows: «70%» is amber even at 69.6%', () => {
    show(fill(89_100));
    expect(ring()).toHaveAccessibleName('Длина разговора: 70%');
    expect(ring()).toHaveAttribute('data-level', 'high');
  });

  it('tells a screen reader the numbers with the ring itself', () => {
    const { rerender } = show(fill(52_469));
    expect(ring()).toHaveAccessibleDescription('52 тыс. из 128 тыс. токенов');
    rerender(<ContextFillButton fill={fill(52_469, 128_000, true)} onNewConversation={vi.fn()} />);
    expect(ring()).toHaveAccessibleDescription('52 тыс. из 128 тыс. токенов. Начало разговора агент уже не видит');
  });

  it('does not come back open after it went away', async () => {
    const { rerender } = show(fill(52_469));
    await userEvent.setup().click(ring());
    expect(screen.getByRole('dialog', { name: 'Длина разговора' })).toBeInTheDocument();
    rerender(<ContextFillButton fill={null} onNewConversation={vi.fn()} />);
    rerender(<ContextFillButton fill={fill(60_000)} onNewConversation={vi.fn()} />);
    expect(screen.queryByRole('dialog', { name: 'Длина разговора' })).not.toBeInTheDocument();
  });

  it('never says more than 100%, nor 0% of a conversation that has something', () => {
    const { rerender } = show(fill(140_000));
    expect(ring()).toHaveAccessibleName('Длина разговора: 100%');
    rerender(<ContextFillButton fill={fill(300, 1_050_000)} onNewConversation={vi.fn()} />);
    expect(ring()).toHaveAccessibleName('Длина разговора: 1%');
  });

  it('writes what rounds to a thousand thousands as a million', async () => {
    show(fill(999_600, 1_000_000));
    await userEvent.setup().click(ring());
    expect(within(screen.getByRole('dialog', { name: 'Длина разговора' })).getByText('1 млн из 1 млн токенов')).toBeInTheDocument();
  });

  it('says that the agent no longer sees the beginning; writes a million as a million', async () => {
    show(fill(262_000, 1_050_000, true));
    await userEvent.setup().click(ring());
    const panel = screen.getByRole('dialog', { name: 'Длина разговора' });
    expect(within(panel).getByText('Начало разговора агент уже не видит')).toBeInTheDocument();
    expect(within(panel).getByText('262 тыс. из 1,05 млн токенов')).toBeInTheDocument();
  });
});

describe('the event of the chat stream', () => {
  const event = (value: unknown) => ({ event: { name: CHAT_EVENTS.contextFill, value } });

  it('passes on what the server told for this conversation only', () => {
    const onFill = vi.fn();
    const subscriber = contextFillSubscriber('t1', onFill);
    subscriber.onCustomEvent(event({ threadId: 't2', context: fill(10) }));
    subscriber.onCustomEvent(event({ threadId: 't1', context: fill(20) }));
    subscriber.onCustomEvent(event({ threadId: 't1', context: null }));
    subscriber.onCustomEvent({ event: { name: CHAT_EVENTS.threadTitled, value: { threadId: 't1', title: 'x' } } });
    expect(onFill.mock.calls).toEqual([[fill(20)], [null]]);
  });

  it('says a malformed event in the console and passes nothing on', () => {
    const onFill = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    contextFillSubscriber('t1', onFill).onCustomEvent(event({ threadId: 't1', context: { tokens: -1 } }));
    expect(onFill).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });
});

describe('what the chat shows', () => {
  it('shows what the server said, then what the stream told, until the server is asked again after the answer', async () => {
    const s = mockServer({ 'GET /app/api/threads/t1/context': { body: { context: fill(1000) } } });
    const { result } = renderHook(() => useContextFill('t1'), { wrapper: WithMemory });
    await waitFor(() => expect(result.current.fill).toEqual(fill(1000)));
    act(() => result.current.onLive(fill(2000)));
    expect(result.current.fill).toEqual(fill(2000));
    act(() => result.current.onLive(null));
    expect(result.current.fill).toBeNull();

    s.set('GET /app/api/threads/t1/context', { body: { context: fill(3000, 128_000, true) } });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.fill).toEqual(fill(3000, 128_000, true)));
  });

  it('keeps what it showed when asking again fails', async () => {
    const s = mockServer({ 'GET /app/api/threads/t1/context': { body: { context: fill(1000) } } });
    const { result } = renderHook(() => useContextFill('t1'), { wrapper: WithMemory });
    await waitFor(() => expect(result.current.fill).toEqual(fill(1000)));
    s.set('GET /app/api/threads/t1/context', { status: 503, body: { error: { code: 'APP_DB_UNAVAILABLE', message: 'База недоступна' } } });
    act(() => result.current.reload());
    await waitFor(() => expect(s.calls.filter((c) => c.path === '/app/api/threads/t1/context')).toHaveLength(2));
    expect(result.current.fill).toEqual(fill(1000));
  });
});

describe('in the header of a conversation', () => {
  const AGENTS = [{ id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', actions: {}, systems: { tools: {}, prefixes: {} }, mark: { kind: 'icon', icon: 'spark' } }];

  function server(context: ThreadContextFill | null, projectId: string | null = null) {
    return mockServer({
      'GET /app/api/threads/t1/project': { body: { projectId, lost: null } },
      'GET /app/api/projects/p1': { body: { id: 'p1', name: 'Тендер Северный', instructions: '', threadCount: 2, createdAt: '2026-11-10T08:00:00Z' } },
      'GET /app/api/me': { body: ME },
      'GET /app/api/agents': { body: { agents: AGENTS } },
      'GET /app/api/threads': { body: { threads: [], next: null } },
      'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: null, resetsOn: '2026-12-01' }, daily: null } },
      'GET /app/api/projects': { body: { projects: [], archivedCount: 0 } },
      'GET /app/api/threads/t1/context': { body: { context } },
      'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' } } } },
    });
  }

  it('stands next to the actions with the conversation, as the server tells', async () => {
    server(fill(64_000));
    renderApp('/agents/sales?thread=t1');
    const button = await screen.findByRole('button', { name: 'Длина разговора: 50%' });
    const header = button.closest('header')!;
    const actions = within(header).getByRole('button', { name: 'Действия с разговором' });
    expect(button.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens a new conversation with the same agent in the same project', async () => {
    const s = server(fill(100_000), 'p1');
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Длина разговора: 78%' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Длина разговора' })).getByRole('button', { name: 'Новый разговор' }));
    // The new conversation is put into the project before its first message (use-thread-project.ts).
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/project'))).toBeDefined());
    const put = s.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/project'))!;
    expect(put.path).not.toBe('/app/api/threads/t1/project');
    expect(put.body).toEqual({ projectId: 'p1' });
    expect(screen.getByRole('button', { name: /Продажи\. Выбрать агента/ })).toBeInTheDocument();
  });

  it('is not there when the server has nothing to show', async () => {
    const s = server(null);
    renderApp('/agents/sales?thread=t1');
    await expect.poll(() => s.calls.some((c) => c.path === '/app/api/threads/t1/context')).toBe(true);
    await screen.findByRole('button', { name: 'Действия с разговором' });
    expect(screen.queryByRole('button', { name: /Длина разговора/ })).not.toBeInTheDocument();
  });
});
