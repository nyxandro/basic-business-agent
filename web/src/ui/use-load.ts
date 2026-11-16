// Loading of one piece of data for a screen: loading, data or error, and a repeat (spec, section 8.22).
// Data with a key is remembered (screen-memory.ts): opened again, the screen shows it at once and asks
// the server anew, and its answer replaces what is shown; two screens of the same data ask once. The key
// names the data and everything the loader depends on — ['project', id]. Data without a key (a check of
// a file, a link to set a password) is loaded anew at every opening; its loader must be stable
// (useCallback): a new loader starts a new load.
import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';

export type LoadState<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: ApiRequestError };

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
  const query = useQuery({
    queryKey: key ?? ['screen', screen, turn],
    queryFn: load,
    // What only this screen loads, for this opening: nothing to remember.
    ...(key ? {} : { gcTime: 0 }),
  });
  // A repeat keeps showing what is there until the answer comes (no flicker after a save).
  const state = useMemo<LoadState<T>>(() => {
    if (query.status === 'pending') return LOADING;
    if (query.status === 'error') return { status: 'error', error: asApiError(query.error) };
    return { status: 'ready', data: query.data };
  }, [query.status, query.data, query.error]);
  const { refetch } = query;
  return { state, reload: () => void refetch() };
}
