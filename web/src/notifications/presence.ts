// «The person is in the app» for the server (docs/specs/[20.11.2026]-notifications.md, section 8): a visible tab says so
// every 30 s and gets the bell's counters back; a tab that hides or closes says «hidden» at once, and the server pushes
// to the browser instead of showing the news inside the page. Used by the app's frame and by the admin's, each with its
// own id of the tab: moving between them never mixes up their marks.
import { PRESENCE_PING_MS, type NotificationsResponse } from '@bba/contracts';
import { useEffect, useEffectEvent, useState } from 'react';
import { sendHidden, sendPresence } from './api.ts';

const newTabId = () => crypto.randomUUID().replaceAll('-', '');
// Told by the session before signing out (auth/session.tsx): the tab is not the person's any more.
export const SIGN_OUT_EVENT = 'bba-sign-out';

export function usePresence(onCounts?: (counts: NotificationsResponse) => void): void {
  const [tab] = useState(newTabId);
  const told = useEffectEvent((counts: NotificationsResponse) => onCounts?.(counts));
  useEffect(() => {
    const ping = () => sendPresence({ tab, visible: true }).then(told, (error: unknown) => console.warn('presence not sent', error));
    const onVisibility = () => (document.visibilityState === 'visible' ? void ping() : sendHidden(tab));
    const onHide = () => sendHidden(tab);
    if (document.visibilityState === 'visible') void ping();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void ping();
    }, PRESENCE_PING_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    window.addEventListener(SIGN_OUT_EVENT, onHide);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener(SIGN_OUT_EVENT, onHide);
    };
  }, [tab]);
}
