// The bell (docs/specs/[20.11.2026]-notifications.md, scenario 3, F3): its counters — questions waiting for the person
// and unread notifications — and the panel under it. A visible tab tells the server «I am here» every 30 s and gets the
// counters back; a hidden one says so at once, and the server pushes to the browser instead. A notification that comes
// while the person is in the app is shown as a hint inside the page. On a phone the panel is a sheet from below.
import type { NotificationsResponse } from '@bba/contracts';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router';
import { notificationTexts as t } from '../i18n/notifications.ts';
import { fetchCounts, markRead } from '../notifications/api.ts';
import { usePresence } from '../notifications/presence.ts';
import { NotificationsPanel, type PanelTab } from '../notifications/NotificationsPanel.tsx';
import { keepOwnSubscription, OPEN_MESSAGE } from '../notifications/push.ts';
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

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<NotificationsResponse | null>(null);
  const [panel, setPanel] = useState<{ open: boolean; tab: PanelTab }>({ open: false, tab: 'waiting' });
  const wide = useMedia(WIDE_QUERY);
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  // When the newest notification shown (or there when the page opened) was made: only a later one is a hint — reading
  // the newest makes an older one the newest, and that one is not news.
  const shownAt = useRef<number | undefined>(undefined);

  const apply = useCallback(
    (next: NotificationsResponse) => {
      setCounts(next);
      const latest = next.latest;
      const at = latest ? Date.parse(latest.createdAt) : 0;
      if (shownAt.current === undefined) {
        shownAt.current = at;
        return;
      }
      if (!latest || at <= shownAt.current) return;
      shownAt.current = at;
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

  // The conversation on the screen: /agents/:agentId?thread=… (chat/ChatPage.tsx).
  const onChat = useMatch('/agents/:agentId') !== null;
  const [params] = useSearchParams();
  usePresence(onChat ? params.get('thread') : null, apply);

  // The browser's handler is kept fresh, and a subscription of this browser left by another person is dropped.
  useEffect(() => keepOwnSubscription(), []);

  // A click on a notification while a tab of the app is open: the handler asks the tab to go there itself (a reload
  // would lose what was typed).
  useEffect(() => {
    const container = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
    if (!container) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; link?: unknown } | null;
      if (data?.type === OPEN_MESSAGE && typeof data.link === 'string' && data.link.startsWith('/')) void navigate(data.link);
    };
    container.addEventListener('message', onMessage);
    return () => container.removeEventListener('message', onMessage);
  }, [navigate]);

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
