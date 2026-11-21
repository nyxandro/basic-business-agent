// The bell (docs/specs/[20.11.2026]-notifications.md, scenario 3, F3): its counters — questions waiting for the person
// and unread notifications — and the panel under it. A visible tab tells the server «I am here» every 30 s and gets the
// counters back; a hidden one says so at once, and the server pushes to the browser instead. A notification that comes
// while the person is in the app is shown as a hint inside the page. On a phone the panel is a sheet from below.
import { PRESENCE_PING_MS, type NotificationsResponse } from '@bba/contracts';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { notificationTexts as t } from '../i18n/notifications.ts';
import { fetchCounts, markRead, sendPresence } from '../notifications/api.ts';
import { NotificationsPanel, type PanelTab } from '../notifications/NotificationsPanel.tsx';
import { refreshWorker } from '../notifications/push.ts';
import { Sheet } from '../ui/Modal.tsx';
import { useToast } from '../ui/Toast.tsx';
import { useMedia, WIDE_QUERY } from './use-media.ts';

interface NotificationsValue {
  counts: NotificationsResponse | null;
  refresh: () => void;
  panel: { open: boolean; tab: PanelTab };
  openPanel: (tab?: PanelTab) => void;
  closePanel: () => void;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

// Names this tab for the server's presence (a person may have several tabs and devices).
const newTabId = () => crypto.randomUUID().replaceAll('-', '');

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<NotificationsResponse | null>(null);
  const [panel, setPanel] = useState<{ open: boolean; tab: PanelTab }>({ open: false, tab: 'waiting' });
  const [tab] = useState(newTabId);
  const wide = useMedia(WIDE_QUERY);
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  // The newest notification already shown or already there when the page opened: only a newer one is a hint.
  const shown = useRef<string | null | undefined>(undefined);

  const apply = useCallback(
    (next: NotificationsResponse) => {
      setCounts(next);
      const latest = next.latest;
      if (shown.current === undefined) {
        shown.current = latest?.id ?? null;
        return;
      }
      if (!latest || latest.id === shown.current) return;
      shown.current = latest.id;
      toast(`${latest.title} · ${latest.body}`, {
        label: t.hintOpen,
        run: () => {
          markRead(latest.id).catch((error: unknown) => console.warn('notification not marked read', error));
          void navigate(latest.link);
        },
      });
    },
    [toast, navigate],
  );

  // A failed refresh keeps the last counters: they are a hint, the screens load their own data.
  const refresh = useCallback(() => {
    fetchCounts().then(apply, (error: unknown) => console.warn('notification counters not refreshed', error));
  }, [apply]);

  useEffect(() => {
    refresh();
  }, [location.pathname, refresh]);

  useEffect(() => {
    const ping = (visible: boolean) => sendPresence({ tab, visible }).then(visible ? apply : () => undefined, (error: unknown) => console.warn('presence not sent', error));
    const onVisibility = () => void ping(document.visibilityState === 'visible');
    if (document.visibilityState === 'visible') void ping(true);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void ping(true);
    }, PRESENCE_PING_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [tab, apply]);

  useEffect(() => refreshWorker(), []);

  const openPanel = useCallback((next?: PanelTab) => setPanel((p) => ({ open: true, tab: next ?? p.tab })), []);
  const closePanel = useCallback(() => {
    setPanel((p) => ({ ...p, open: false }));
    refresh();
  }, [refresh]);
  const value = useMemo(() => ({ counts, refresh, panel, openPanel, closePanel }), [counts, refresh, panel, openPanel, closePanel]);
  return (
    <NotificationsContext value={value}>
      {children}
      {/* On a computer the panel opens under the bell (layout/ChatHeader.tsx). */}
      {wide ? null : (
        <Sheet open={panel.open} onClose={closePanel} label={t.bell}>
          {panel.open ? <NotificationsPanel compact onClose={closePanel} /> : null}
        </Sheet>
      )}
    </NotificationsContext>
  );
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error('useNotifications must be used inside NotificationsProvider');
  return value;
}
