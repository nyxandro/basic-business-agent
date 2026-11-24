// The instant channel (docs/specs/[20.11.2026]-notifications.md, «Мгновенный канал»; decision of the owner 22.11): the server
// says «changed» and the page reads its news again — at once, not at the next check. Only a visible tab keeps it open: a
// browser allows few connections to one site over plain http, and a hidden tab needs no news at once (it reads them when
// shown again). Used by the bell of the app (layout/notifications.tsx) and by the admin panel (the counter and the tickets
// of «Поддержка»). `onNews` is also called on each (re)connection: news may have come while there was none.
import { PRESENCE_PING_MS } from '@bba/contracts';
import { createContext, useContext, useEffect, useEffectEvent, useRef } from 'react';

const LIVE_PATH = '/app/api/me/events';
// A server restarting answers the browser's own reconnection with an error page, and the browser then gives up for good:
// the channel is opened again after this long while the tab is visible — the cadence of the presence ping, which reads
// the news meanwhile.
const LIVE_REOPEN_MS = PRESENCE_PING_MS;

export function useLiveChannel(onNews: () => void, enabled = true): void {
  const tell = useEffectEvent(onNews);
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let reopen: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      if (source) return;
      const next = new EventSource(LIVE_PATH);
      next.addEventListener('ready', () => tell());
      next.addEventListener('changed', () => tell());
      next.addEventListener('error', () => {
        if (next.readyState !== EventSource.CLOSED || source !== next) return;
        source = null;
        console.warn('the instant channel was closed by the server; it opens again in', LIVE_REOPEN_MS, 'ms');
        reopen ??= setTimeout(() => {
          reopen = null;
          if (document.visibilityState === 'visible') open();
        }, LIVE_REOPEN_MS);
      });
      source = next;
    };
    const close = () => {
      if (reopen) clearTimeout(reopen);
      reopen = null;
      source?.close();
      source = null;
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? open() : close());
    if (document.visibilityState === 'visible') open();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      close();
    };
  }, [enabled]);
}

// How many times the server has said there is news since the frame opened its channel: a screen that shows changing data
// (a ticket's conversation, the list of tickets) reads it again when this grows. The frame that keeps the channel gives
// it — the bell of the app (layout/notifications.tsx) or the admin panel (admin/AdminLayout.tsx) — so a screen needs no
// connection of its own.
export const LiveNewsContext = createContext(0);

// Calls `onNews` (reads the screen's data again) on the news heard after the screen opened — the news heard before it is
// in what the screen loads at its opening anyway. A channel that connects after the screen opened (a new tab) says
// «ready» once more and the screen reads again: a change between its first load and the connection is not lost.
export function useOnLiveNews(onNews: () => void): void {
  const news = useContext(LiveNewsContext);
  const seen = useRef(news);
  const tell = useEffectEvent(onNews);
  useEffect(() => {
    if (news === seen.current) return;
    seen.current = news;
    tell();
  }, [news]);
}
