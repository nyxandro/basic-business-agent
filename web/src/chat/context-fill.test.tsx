// How full a conversation is (spec, section 8.34; decisions of the owner 25.11): a ring in the header of the chat —
// only the ring, the numbers in a window on a click; amber from 70%, red from 90%, then «Новый разговор» in the window.
// Nothing at all when the server has nothing to show.
import { CHAT_EVENTS, type ThreadContextFill } from '@bba/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';
import { ContextFillButton } from './ContextFill.tsx';
import { contextFillSubscriber } from './context-fill.ts';

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

  it('never says more than 100%, nor 0% of a conversation that has something', () => {
    const { rerender } = show(fill(140_000));
    expect(ring()).toHaveAccessibleName('Длина разговора: 100%');
    rerender(<ContextFillButton fill={fill(300, 1_050_000)} onNewConversation={vi.fn()} />);
    expect(ring()).toHaveAccessibleName('Длина разговора: 1%');
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

describe('in the header of a conversation', () => {
  const AGENTS = [{ id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', actions: {}, systems: { tools: {}, prefixes: {} }, mark: { kind: 'icon', icon: 'spark' } }];

  function server(context: ThreadContextFill | null) {
    return mockServer({
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

  it('is not there when the server has nothing to show', async () => {
    const s = server(null);
    renderApp('/agents/sales?thread=t1');
    await expect.poll(() => s.calls.some((c) => c.path === '/app/api/threads/t1/context')).toBe(true);
    await screen.findByRole('button', { name: 'Действия с разговором' });
    expect(screen.queryByRole('button', { name: /Длина разговора/ })).not.toBeInTheDocument();
  });
});
