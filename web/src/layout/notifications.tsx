// Counters in the menu (spec, scenario 4): questions of background tasks waiting for an answer.
// Refreshed when the person moves between screens, every minute, and after a decision.
import type { NotificationsResponse } from '@bba/contracts';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { fetchNotifications } from '../approvals/api.ts';

const REFRESH_MS = 60_000;

interface NotificationsValue {
  counts: NotificationsResponse | null;
  refresh: () => void;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<NotificationsResponse | null>(null);
  const [tick, setTick] = useState(0);
  const location = useLocation();
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let current = true;
    // A failed refresh keeps the last counters: they are a hint, the screens load their own data.
    fetchNotifications().then(
      (next) => {
        if (current) setCounts(next);
      },
      (error: unknown) => console.warn('notification counters not refreshed', error),
    );
    return () => {
      current = false;
    };
  }, [location.pathname, tick]);

  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const value = useMemo(() => ({ counts, refresh }), [counts, refresh]);
  return <NotificationsContext value={value}>{children}</NotificationsContext>;
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error('useNotifications must be used inside NotificationsProvider');
  return value;
}
