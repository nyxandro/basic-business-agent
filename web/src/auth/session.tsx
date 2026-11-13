// Who is signed in: GET /app/api/me. 401 means "not signed in"; other failures are shown with a repeat.
import type { MeResponse } from '@bba/contracts';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { fetchMe, signOut as callSignOut } from './api.ts';

const HTTP_UNAUTHORIZED = 401;

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-in'; me: MeResponse }
  | { status: 'signed-out' }
  | { status: 'error'; error: ApiRequestError };

interface SessionValue {
  session: SessionState;
  refresh: () => Promise<SessionState>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

async function loadSession(): Promise<SessionState> {
  try {
    return { status: 'signed-in', me: await fetchMe() };
  } catch (raw) {
    const error = asApiError(raw);
    return error.status === HTTP_UNAUTHORIZED ? { status: 'signed-out' } : { status: 'error', error };
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    const next = await loadSession();
    setSession(next);
    return next;
  }, []);

  const signOut = useCallback(async () => {
    await callSignOut();
    setSession({ status: 'signed-out' });
  }, []);

  useEffect(() => {
    let current = true;
    void loadSession().then((next) => {
      if (current) setSession(next);
    });
    return () => {
      current = false;
    };
  }, []);

  const value = useMemo(() => ({ session, refresh, signOut }), [session, refresh, signOut]);
  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

export function useMe(): MeResponse {
  const { session } = useSession();
  if (session.status !== 'signed-in') throw new Error('useMe must be used inside RequireAuth');
  return session.me;
}

// Screens behind sign-in: a person without a session goes to /login and comes back after it.
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, refresh } = useSession();
  const location = useLocation();
  if (session.status === 'loading') return <Skeleton rows={3} />;
  if (session.status === 'error') return <ErrorBanner error={session.error} onRetry={() => void refresh()} />;
  if (session.status === 'signed-out') {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return children;
}
