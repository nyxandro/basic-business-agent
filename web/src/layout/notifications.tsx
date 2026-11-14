// Counters in the menu (spec, scenario 4): questions of background tasks waiting for an answer.
// Refreshed when the person moves between screens, every minute, and after a decision. On a phone
// «Ждёт подтверждения» opens here as a sheet over any screen (mockup).
import type { NotificationsResponse } from '@bba/contracts';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { fetchNotifications } from '../approvals/api.ts';
import { ApprovalsSheet } from '../approvals/ApprovalsSheet.tsx';

const REFRESH_MS = 60_000;

interface NotificationsValue {
  counts: NotificationsResponse | null;
  refresh: () => void;
  openApprovals: () => void;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<NotificationsResponse | null>(null);
  const [tick, setTick] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
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

  const openApprovals = useCallback(() => setSheetOpen(true), []);
  const value = useMemo(() => ({ counts, refresh, openApprovals }), [counts, refresh, openApprovals]);
  return (
    <NotificationsContext value={value}>
      {children}
      <ApprovalsSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </NotificationsContext>
  );
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error('useNotifications must be used inside NotificationsProvider');
  return value;
}
