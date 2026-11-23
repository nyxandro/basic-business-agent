// The header of the chat (mockup): the agent's name opens the list of agents to switch to; on a
// phone «Меню» opens the drawer. The «…» holds the actions with the conversation. The bell stands at
// the right of every header, on a computer and on a phone (decision of the owner 21.11, F3).
import type { AgentSummary } from '@bba/contracts';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { notificationTexts } from '../i18n/notifications.ts';
import { ru } from '../i18n/ru.ts';
import { NotificationsPanel } from '../notifications/NotificationsPanel.tsx';
import { cx, IconButton } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Menu, MenuAnchor, MenuItem } from '../ui/Menu.tsx';
import { useNotifications } from './notifications-context.ts';
import { useMedia, WIDE_QUERY } from './use-media.ts';
import styles from './shell.module.css';

const PANEL_WIDTH_PX = 420;

// Always there: the count is the questions waiting for the person plus unread notifications; with anything new it is red
// and swings now and then (owner, 22.11). On a computer the panel hangs under it; on a phone it opens as a sheet
// (layout/notifications.tsx).
function Bell() {
  const { counts, panel, openPanel, closePanel } = useNotifications();
  const wide = useMedia(WIDE_QUERY);
  const waiting = counts?.pendingApprovals ?? 0;
  const unread = counts?.unread ?? 0;
  const total = waiting + unread;
  // Nothing new — just «Уведомления»: a word like «Нет» in the name would also answer to the search of a «Нет» button.
  const label = total > 0 ? `${notificationTexts.bell}: ${notificationTexts.bellCount(waiting, unread)}` : notificationTexts.bell;
  const button = (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      aria-expanded={panel.open}
      onClick={() => (panel.open ? closePanel() : openPanel(waiting > 0 ? 'waiting' : 'list'))}
      className={cx(styles.headerTitle, styles.bell, total > 0 && styles.bellAlert)}
    >
      <Icon name="bell" />
      {total > 0 ? <span className={styles.bellCount}>{total}</span> : null}
    </button>
  );
  if (!wide) return button;
  return (
    <MenuAnchor>
      {button}
      <Menu open={panel.open} onClose={closePanel} label={notificationTexts.bell} role="dialog" placement="bottom-end" width={PANEL_WIDTH_PX}>
        <NotificationsPanel compact={false} onClose={closePanel} />
      </Menu>
    </MenuAnchor>
  );
}

// The header of a screen other than the chat: on a phone «Меню», the title and the bell; on a computer the title and
// the bell (the mockup keeps a header over every screen).
export function ChatHeaderBar({ title, onOpenMenu }: { title: string; onOpenMenu: () => void }) {
  const wide = useMedia(WIDE_QUERY);
  return (
    <header className={cx(styles.header, !wide && styles.headerMobile)}>
      {wide ? null : <IconButton icon="menu" label={ru.shell.menu} onClick={onOpenMenu} />}
      <span className={cx(styles.headerTitle, wide && styles.headerPageTitle)}>{title}</span>
      <span className={styles.headerFill} />
      <Bell />
    </header>
  );
}

export function ChatHeader({ agent, agents, wide, onOpenMenu, actions }: { agent: AgentSummary; agents: AgentSummary[]; wide: boolean; onOpenMenu: () => void; actions?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <header className={cx(styles.header, !wide && styles.headerMobile)}>
      {wide ? null : <IconButton icon="menu" label={ru.shell.menu} onClick={onOpenMenu} />}
      <MenuAnchor>
        <button type="button" className={styles.headerTitle} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label={`${agent.name}. ${ru.shell.switchAgent}`}>
          {agent.name}
          <Icon name="down" size={15} />
        </button>
        <Menu open={open} onClose={() => setOpen(false)} label={ru.shell.switchAgent} placement="bottom-start">
          {agents.map((a) => (
            <MenuItem key={a.id} checked={a.id === agent.id} onSelect={() => (setOpen(false), void navigate(`/agents/${encodeURIComponent(a.id)}`))}>
              {a.name}
            </MenuItem>
          ))}
        </Menu>
      </MenuAnchor>
      <span className={styles.headerFill} />
      {actions}
      <Bell />
    </header>
  );
}
