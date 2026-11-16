// The answer to what the person typed: nothing below two letters (spec, section 8.13), a short pause
// after the last key, and only the answer to the latest query is shown — an older one that comes
// later is dropped.
import type { SearchResponse, SearchScope } from '@bba/contracts';
import { useEffect, useRef, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { searchAll } from './api.ts';

export const MIN_QUERY_LENGTH = 2;
// Typing pause before a query goes: one query per word instead of one per key.
const TYPING_PAUSE_MS = 250;

export type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: SearchResponse }
  | { status: 'error'; error: ApiRequestError };

export function useSearch(q: string, scope: SearchScope): { state: SearchState; retry: () => void } {
  const [answer, setAnswer] = useState<{ key: string; state: SearchState } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  const text = q.trim();
  const short = text.length < MIN_QUERY_LENGTH;
  const key = `${text}\n${scope}\n${attempt}`;

  useEffect(() => {
    if (short) return;
    const id = ++latest.current;
    const timer = setTimeout(() => {
      searchAll(text, scope).then(
        (data) => id === latest.current && setAnswer({ key, state: { status: 'ready', data } }),
        (raw: unknown) => id === latest.current && setAnswer({ key, state: { status: 'error', error: asApiError(raw) } }),
      );
    }, TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [key, short, text, scope]);

  const state: SearchState = short ? { status: 'idle' } : answer?.key === key ? answer.state : { status: 'loading' };
  return { state, retry: () => setAttempt((n) => n + 1) };
}
