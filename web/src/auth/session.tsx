// Who is signed in: GET /app/api/me. 401 means "not signed in"; other failures are shown with a repeat.
import type { MeResponse } from '@bba/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { newScreenMemory } from '../ui/screen-memory.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { SIGN_OUT_EVENT } from '../notifications/presence.ts';
import { dropPushOnSignOut } from '../notifications/push.ts';
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

const personOf = (session: SessionState) => (session.status === 'signed-in' ? session.me.user.id : null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  // What screens loaded (spec, section 8.22), for the signed-in person only: emptied before another
  // person — or nobody — is shown anything.
  const [memory] = useState(newScreenMemory);
  const person = useRef<string | null>(null);
  const apply = useCallback(
    (next: SessionState) => {
      if (next.status !== 'error' && personOf(next) !== person.current) {
        memory.clear();
        person.current = personOf(next);
      }
      setSession(next);
    },
    [memory],
  );

  const refresh = useCallback(async () => {
    const next = await loadSession();
    apply(next);
    return next;
  }, [apply]);

  const signOut = useCallback(async () => {
    // A shared computer: the next person here gets none of this person's notifications (notifications spec, section 10);
    // and this tab stops telling the server the person is here.
    window.dispatchEvent(new Event(SIGN_OUT_EVENT));
    await dropPushOnSignOut();
    await callSignOut();
    apply({ status: 'signed-out' });
  }, [apply]);

  useEffect(() => {
    let current = true;
    void loadSession().then((next) => {
      if (current) apply(next);
    });
    return () => {
      current = false;
    };
  }, [apply]);

  const value = useMemo(() => ({ session, refresh, signOut }), [session, refresh, signOut]);
  return (
    <SessionContext value={value}>
      <QueryClientProvider client={memory}>{children}</QueryClientProvider>
    </SessionContext>
  );
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
  if (session.status === 'loading') return <DelayedBar />;
  if (session.status === 'error') return <ErrorBanner error={session.error} onRetry={() => void refresh()} />;
  if (session.status === 'signed-out') {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return children;
}
