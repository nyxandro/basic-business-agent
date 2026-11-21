// A search of the internet in the chat (spec, section 8.30; decisions of the owner 20.11 and 21.11): while it goes, the
// live line of the answer says what the researcher does now — the query, the site — with a clock, and unfolds the list
// so far; done, the search comes into the answer as one line with the counts and the time, and after a reload shows the
// same list from the result of the call.
import { CHAT_EVENTS, WEB_RESEARCH_TOOL, type WebStep } from '@bba/contracts';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnStateContext } from './call-progress.ts';
import { LiveLine } from './LiveLine.tsx';
import { createWebProgressStore, WebProgressContext, webProgressSubscriber, type WebProgressStore } from './web-progress.ts';
import { WebSearch } from './WebSearch.tsx';

const CALL_ID = 'call-web-1';
const QUERY: WebStep = { kind: 'search', id: 's1', query: 'профнастил С21 цена Екатеринбург', state: 'running' };
const QUERY_DONE: WebStep = { ...QUERY, state: 'done', found: 8 };
const PAGE: WebStep = { kind: 'page', id: 'p1', address: 'https://metall.example/profnastil/s21', host: 'metall.example', state: 'running' };
const PAGE_DONE: WebStep = { ...PAGE, state: 'done', title: 'Профнастил С21 — цены' };
const PAGE_BLOCKED: WebStep = { kind: 'page', id: 'p2', address: 'https://shop.example/c21', host: 'shop.example', state: 'failed', code: 'APP_WEB_FETCH_BLOCKED_BY_SITE' };
const SOURCE = { title: 'Профнастил С21 — цены', address: 'https://metall.example/profnastil/s21' };

type CallOf = Parameters<typeof WebSearch>[0]['call'];
const running: CallOf = { toolCallId: CALL_ID, status: 'executing', parameters: { task: 'Найди цены' }, result: undefined };
const complete = (result: unknown): CallOf => ({ ...running, status: 'complete', result: JSON.stringify(result) });

// The block as the chat draws it: in a turn that is being written now or not.
const inChat = (call: CallOf, store: WebProgressStore | null, answering: boolean): ReactElement => {
  const block = (
    <TurnStateContext value={answering ? 'answering' : 'ended'}>
      <WebSearch call={call} />
    </TurnStateContext>
  );
  return store ? <WebProgressContext value={store}>{block}</WebProgressContext> : block;
};

const show = (call: CallOf, store: WebProgressStore | null, answering: boolean) => render(inChat(call, store, answering));

// The live line of the answer while the search goes.
const AGENT = { systems: { tools: {}, prefixes: {} }, actions: {} };
const SEARCH_CALL = { id: CALL_ID, type: 'function' as const, function: { name: WEB_RESEARCH_TOOL, arguments: '{"task":"Найди цены"}' } };
const showLive = (store: WebProgressStore) =>
  render(
    <WebProgressContext value={store}>
      <LiveLine call={SEARCH_CALL} agent={AGENT} />
    </WebProgressContext>,
  );

afterEach(() => {
  vi.useRealTimers();
});

describe('a search in the chat', () => {
  it('is not in the answer while it goes: the live line says it', () => {
    const { container } = show(running, createWebProgressStore(), true);
    expect(container).toBeEmptyDOMElement();
  });

  it('says what the researcher does now and lists the queries and the sites as they come', () => {
    const store = createWebProgressStore();
    const view = showLive(store);
    expect(screen.getByRole('status')).toHaveTextContent('Начинаю поиск в интернете…');

    act(() => store.apply(CALL_ID, QUERY, Date.now()));
    expect(screen.getByRole('status')).toHaveTextContent('Ищу: «профнастил С21 цена Екатеринбург»');
    // Folded while it works: the line says what it does; the list is a click away (decision of the owner 20.11).
    expect(screen.queryByRole('region', { name: 'Запросы' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Ищу/ }));
    const queries = screen.getByRole('region', { name: 'Запросы' });
    expect(within(queries).getByText('профнастил С21 цена Екатеринбург')).toBeInTheDocument();

    act(() => {
      store.apply(CALL_ID, QUERY_DONE, Date.now());
      store.apply(CALL_ID, PAGE, Date.now());
    });
    expect(screen.getByRole('status')).toHaveTextContent('Читаю metall.example…');
    expect(within(queries).getByText('8 результатов')).toBeInTheDocument();
    const sites = screen.getByRole('region', { name: 'Сайты' });
    expect(within(sites).getByText('metall.example')).toBeInTheDocument();
    expect(within(sites).getByText('читаю…')).toBeInTheDocument();
    // No spinner anywhere in the block, its line included: it measures nothing (decision of the owner 20.11).
    expect(view.container.querySelector('[class*="spin"]')).toBeNull();
    // A site is a link once it was read, not while it is read.
    expect(within(sites).queryByRole('link')).toBeNull();

    act(() => {
      store.apply(CALL_ID, PAGE_DONE, Date.now());
      store.apply(CALL_ID, PAGE_BLOCKED, Date.now());
    });
    expect(screen.getByRole('status')).toHaveTextContent('Разбираю найденное…');
    const link = within(sites).getByRole('link', { name: /metall\.example.*Профнастил С21 — цены/ });
    expect(link).toHaveAttribute('href', 'https://metall.example/profnastil/s21');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(sites).getByText('сайт не пустил')).toBeInTheDocument();
    // Steps of another call do not come into this block.
    act(() => store.apply('call-web-2', { ...QUERY, id: 's9', query: 'чужой запрос' }, Date.now()));
    expect(view.container).not.toHaveTextContent('чужой запрос');
  });

  it('counts the time from the moment the block appeared, without a jump back when the first step comes', () => {
    vi.useFakeTimers({ now: new Date('2026-11-20T10:00:00Z') });
    const store = createWebProgressStore();
    const view = showLive(store);
    expect(screen.getByText('0:00')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(screen.getByText('0:12')).toBeInTheDocument();
    act(() => store.apply(CALL_ID, QUERY, Date.now()));
    expect(screen.getByText('0:12')).toBeInTheDocument();
    // A line drawn anew keeps its clock.
    view.unmount();
    showLive(store);
    act(() => {
      vi.advanceTimersByTime(53_000);
    });
    expect(screen.getByText('1:05')).toBeInTheDocument();
  });

  it('has nothing to unfold before the first step, and stays folded when the steps come', () => {
    const store = createWebProgressStore();
    showLive(store);
    expect(screen.queryByRole('button')).toBeNull();
    act(() => store.apply(CALL_ID, QUERY, Date.now()));
    expect(screen.getByRole('button', { name: /Ищу/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Запросы' })).toBeNull();
  });

  it('comes into the answer as the counts and the time when done, and unfolds the same list on a click', () => {
    const store = createWebProgressStore();
    act(() => store.apply(CALL_ID, QUERY, Date.now()));
    show(complete({ answer: 'От 520 ₽ за м²', sources: [SOURCE], steps: [QUERY_DONE, PAGE_DONE, PAGE_BLOCKED], ms: 72_000 }), store, true);
    const line = screen.getByRole('button', { name: 'Поиск в интернете · 1 запрос · 1 источник · 1 мин 12 с' });
    expect(line).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(line);
    expect(line).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: /metall\.example/ })).toHaveAttribute('href', 'https://metall.example/profnastil/s21');
  });

  it('after a reload shows the list from the result of the call', () => {
    show(complete({ answer: 'Курс 81,20 ₽', sources: [], steps: [{ ...QUERY_DONE, query: 'курс доллара ЦБ' }], ms: 9_000 }), null, false);
    const line = screen.getByRole('button', { name: 'Поиск в интернете · 1 запрос · 0 источников · 9 с' });
    fireEvent.click(line);
    expect(screen.getByText('курс доллара ЦБ')).toBeInTheDocument();
  });

  it('shows a search kept before the steps were kept by its sources', () => {
    show(complete({ answer: 'От 520 ₽', sources: [SOURCE, { title: 'Прайс', address: 'https://price.example/list' }] }), null, false);
    const line = screen.getByRole('button', { name: 'Поиск в интернете · 2 источника' });
    fireEvent.click(line);
    expect(screen.getByRole('link', { name: /price\.example.*Прайс/ })).toHaveAttribute('href', 'https://price.example/list');
    expect(screen.queryByRole('region', { name: 'Запросы' })).toBeNull();
  });

  it('names the code when the search failed and keeps what it did', () => {
    show(complete({ error: true, code: 'APP_WEB_RESEARCH_FAILED', message: 'Поиск в интернете не получился', steps: [QUERY_DONE, PAGE_BLOCKED], ms: 30_000 }), null, false);
    const line = screen.getByRole('button', { name: 'Поиск в интернете не получился · APP_WEB_RESEARCH_FAILED' });
    expect(line.className).toMatch(/toolFailed/);
    fireEvent.click(line);
    expect(screen.getByText('shop.example')).toBeInTheDocument();
  });

  it('shows no step under way in a finished search', () => {
    show(complete({ answer: 'От 520 ₽', sources: [], steps: [QUERY_DONE, PAGE], ms: 20_000 }), null, false);
    fireEvent.click(screen.getByRole('button', { name: /Поиск в интернете · 1 запрос/ }));
    expect(screen.queryByText('читаю…')).toBeNull();
    expect(screen.getByText('не открылась')).toBeInTheDocument();
  });

  it('comes into the answer stopped when its answer ended without the result: «Стоп» or a broken answer', () => {
    const store = createWebProgressStore();
    store.apply(CALL_ID, QUERY_DONE, Date.now());
    store.apply(CALL_ID, PAGE, Date.now());
    show(running, store, false);
    const line = screen.getByRole('button', { name: 'Поиск в интернете прерван' });
    // The person's own choice, not a failure.
    expect(line.className).not.toMatch(/toolFailed/);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(line);
    // The page under way when it stopped is not read any more.
    expect(screen.queryByText('читаю…')).toBeNull();
    expect(screen.getByText('metall.example')).toBeInTheDocument();
  });

  it('a call left without a result in a past conversation is stopped too, with nothing to unfold', () => {
    show(running, null, false);
    expect(screen.getByRole('button', { name: 'Поиск в интернете прерван' })).toBeDisabled();
  });
});

describe('the steps of the chat stream', () => {
  it('takes the steps of searches from the events of the agent and nothing else', () => {
    const store = createWebProgressStore();
    const subscriber = webProgressSubscriber(store);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    subscriber.onCustomEvent({ event: { name: CHAT_EVENTS.webProgress, value: { toolCallId: CALL_ID, step: QUERY } } });
    subscriber.onCustomEvent({ event: { name: CHAT_EVENTS.webProgress, value: { toolCallId: CALL_ID, step: QUERY_DONE } } });
    subscriber.onCustomEvent({ event: { name: 'bba.something_else', value: { toolCallId: CALL_ID, step: PAGE } } });
    subscriber.onCustomEvent({ event: { name: CHAT_EVENTS.webProgress, value: { toolCallId: CALL_ID, step: { kind: 'page' } } } });
    // The same step with its new state takes its place.
    expect(store.stepsOf(CALL_ID)).toEqual([QUERY_DONE]);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
