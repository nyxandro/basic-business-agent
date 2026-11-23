// What the bell knows (layout/notifications.tsx keeps it): its counters, the marks of the person's conversations and
// whether its panel is open. Kept apart from the provider, which draws the panel: the panel and the cards inside it read
// this value, and importing the provider would close a circle of imports.
import type { NotificationsResponse, ThreadState } from '@bba/contracts';
import { createContext, useContext } from 'react';
import type { PanelTab } from '../notifications/NotificationsPanel.tsx';

export interface NotificationsValue {
  counts: NotificationsResponse | null;
  // The marks of the person's conversations in the lists (layout/ThreadState.tsx).
  threadStates: Readonly<Record<string, ThreadState>>;
  refresh: () => void;
  panel: { open: boolean; tab: PanelTab };
  openPanel: (tab?: PanelTab) => void;
  closePanel: () => void;
}

export const NotificationsContext = createContext<NotificationsValue | null>(null);

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error('useNotifications must be used inside NotificationsProvider');
  return value;
}
