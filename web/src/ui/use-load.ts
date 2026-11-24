// Loading of one piece of data for a screen: loading, data or error, and a repeat (spec, section 8.22).
// Data with a key is remembered (screen-memory.ts): opened again, the screen shows it at once and asks
// the server anew, and its answer replaces what is shown; two screens of the same data ask once. The key
// names the data and everything the loader depends on — ['project', id]. Data without a key (a check of
// a file, a link to set a password) is loaded anew at every opening; its loader must be stable
// (useCallback): a new loader starts a new load.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';

// `stale` — what the screen showed before a repeat that failed (absent when the first load failed): a screen that reads
// its data again by itself may keep showing it, with the error, so what is being written there is not lost.
export type LoadState<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: ApiRequestError; stale?: T };

const LOADING = { status: 'loading' } as const;

// The place of a keyless loader among the loaders this screen was given: a new loader, a new load.
function useLoaderTurn(load: () => Promise<unknown>): number {
  const [turn, setTurn] = useState({ load, n: 0 });
  if (turn.load !== load) {
    const next = { load, n: turn.n + 1 };
    setTurn(next);
    return next.n;
  }
  return turn.n;
}

export function useLoad<T>(load: () => Promise<T>, key?: readonly unknown[]): { state: LoadState<T>; reload: () => void } {
  const screen = useId();
  const turn = useLoaderTurn(load);
  const queryKey = key ?? ['screen', screen, turn];
  const query = useQuery({
    queryKey,
    queryFn: load,
    // What only this screen loads, for this opening: nothing to remember.
    ...(key ? {} : { gcTime: 0 }),
  });
  // A repeat keeps showing what is there until the answer comes (no flicker after a save).
  const state = useMemo<LoadState<T>>(() => {
    if (query.status === 'pending') return LOADING;
    // A failed repeat keeps the last data in the memory of screens (TanStack Query).
    if (query.status === 'error') return { status: 'error', error: asApiError(query.error), ...(query.data === undefined ? {} : { stale: query.data }) };
    return { status: 'ready', data: query.data };
  }, [query.status, query.data, query.error]);
  // «Заново» asks after the drawing (screens ask it while drawing, on a new refreshKey). An answer already
  // on its way may predate what made the screen ask: it is dropped for a new one.
  const memory = useQueryClient();
  const latest = useRef({ memory, queryKey, refetch: query.refetch });
  useLayoutEffect(() => {
    latest.current = { memory, queryKey, refetch: query.refetch };
  });
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (asked === 0) return;
    const { memory: m, queryKey: k, refetch } = latest.current;
    void m.cancelQueries({ queryKey: k, exact: true }).then(() => refetch());
  }, [asked]);
  return { state, reload: () => setAsked((n) => n + 1) };
}
