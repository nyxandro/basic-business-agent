// What the bell knows (layout/notifications.tsx keeps it): its counters, the marks of the person's conversations,
// whether its panel is open and the panel itself. Kept apart from the provider: the header with the bell
// (shell/ChatHeader.tsx), the panel and the cards inside it read this value, and none of them may import the frame.
import type { NotificationsResponse, ThreadState } from '@bba/contracts';
import { createContext, useContext, type ComponentType } from 'react';

// The tab the panel opens on: the questions waiting for the person, or the list of notifications.
export type PanelTab = 'waiting' | 'list';

export interface NotificationsValue {
  counts: NotificationsResponse | null;
  // The marks of the person's conversations in the lists (threads/ThreadState.tsx).
  threadStates: Readonly<Record<string, ThreadState>>;
  refresh: () => void;
  panel: { open: boolean; tab: PanelTab };
  openPanel: (tab?: PanelTab) => void;
  closePanel: () => void;
  // The panel of the bell, given by the frame (layout/NotificationsPanel.tsx): it shows the cards of «Да», which stand
  // above the header that opens it on a computer.
  Panel: ComponentType<{ compact: boolean; onClose: () => void }>;
}

export const NotificationsContext = createContext<NotificationsValue | null>(null);

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error('useNotifications must be used inside NotificationsProvider');
  return value;
}
