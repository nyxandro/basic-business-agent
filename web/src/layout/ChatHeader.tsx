// The header of the chat (mockup): the agent's name opens the list of agents to switch to; on a
// phone «Меню» opens the drawer and the bell opens «Ждёт подтверждения». The «…» holds the
// actions with the conversation.
import type { AgentSummary } from '@bba/contracts';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ru } from '../i18n/ru.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Menu, MenuAnchor, MenuItem } from '../ui/Menu.tsx';
import { useNotifications } from './notifications.tsx';
import styles from './shell.module.css';

// On a phone the bell opens «Ждёт подтверждения» as a sheet over the current screen.
function Bell() {
  const { counts, openApprovals } = useNotifications();
  const waiting = counts?.pendingApprovals ?? 0;
  const label = waiting > 0 ? `${ru.shell.approvals}: ${waiting}` : ru.shell.approvals;
  return (
    <button type="button" aria-label={label} title={label} onClick={openApprovals} className={cx(styles.headerTitle, styles.bell, waiting > 0 && styles.bellRinging)}>
      <Icon name="bell" />
      {waiting > 0 ? <span className={styles.bellCount}>{waiting}</span> : null}
    </button>
  );
}

// The header of a screen other than the chat on a phone: «Меню», the title and the bell.
export function ChatHeaderBar({ title, onOpenMenu }: { title: string; onOpenMenu: () => void }) {
  return (
    <header className={cx(styles.header, styles.headerMobile)}>
      <IconButton icon="menu" label={ru.shell.menu} onClick={onOpenMenu} />
      <span className={styles.headerTitle}>{title}</span>
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
      {wide ? null : <Bell />}
    </header>
  );
}
