// Loading of one piece of data for a screen: loading, data or error, and a repeat.
// The loader must be stable (useCallback): a new loader starts a new load.
import { useEffect, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';

export type LoadState<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: ApiRequestError };

interface Settled<T> {
  load: () => Promise<T>;
  attempt: number;
  state: LoadState<T>;
}

const LOADING = { status: 'loading' } as const;

export function useLoad<T>(load: () => Promise<T>): { state: LoadState<T>; reload: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);

  useEffect(() => {
    let current = true;
    load().then(
      (data) => {
        if (current) setSettled({ load, attempt, state: { status: 'ready', data } });
      },
      (error: unknown) => {
        if (current) setSettled({ load, attempt, state: { status: 'error', error: asApiError(error) } });
      },
    );
    return () => {
      current = false;
    };
  }, [load, attempt]);

  // A result of an older loader or attempt is not shown: the screen is loading again.
  const state = settled && settled.load === load && settled.attempt === attempt ? settled.state : LOADING;
  return { state, reload: () => setAttempt((n) => n + 1) };
}
