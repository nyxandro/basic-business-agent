// Loading of one piece of data for a screen: loading, data or error, and a repeat.
// The loader must be stable (useCallback): a new loader starts a new load.
import { useEffect, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';

export type LoadState<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: ApiRequestError };

interface Settled<T> {
  load: () => Promise<T>;
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
        if (current) setSettled({ load, state: { status: 'ready', data } });
      },
      (error: unknown) => {
        if (current) setSettled({ load, state: { status: 'error', error: asApiError(error) } });
      },
    );
    return () => {
      current = false;
    };
  }, [load, attempt]);

  // A repeat of the same loader keeps showing the last result until the new one comes (no
  // flicker after a save, forms with fresh links stay); a new loader starts from «loading».
  const state = settled && settled.load === load ? settled.state : LOADING;
  return { state, reload: () => setAttempt((n) => n + 1) };
}
