// The side panel (spec, section 7; mockup «Чат с агентом»): agents, recent conversations,
// «Ждёт подтверждения» with its counter, «Админка», the limit, the person and the gear.
import type { AgentSummary, MyUsage } from '@bba/contracts';
import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { availableSections } from '../admin/sections.ts';
import type { ApiRequestError } from '../api/client.ts';
import { useMe } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { Avatar, initials } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { MenuAnchor } from '../ui/Menu.tsx';
import { LimitMeter } from './LimitMeter.tsx';
import { useNotifications } from './notifications.tsx';
import { RecentThreads } from './RecentThreads.tsx';
import { SettingsMenu } from './SettingsMenu.tsx';
import styles from './shell.module.css';

export type AgentsState = { status: 'loading' } | { status: 'ready'; agents: AgentSummary[] } | { status: 'error'; error: ApiRequestError; retry: () => void };

export interface SidebarProps {
  agents: AgentsState;
  usage: MyUsage | null;
  currentAgentId: string | null;
  currentThreadId: string | null;
  // Bumped after a run: the recent list loads again.
  threadsKey: number;
  onNewThread: () => void;
  // A phone closes the drawer after a choice.
  onNavigate: () => void;
  // The phone's drawer adds its «Закрыть меню» here.
  topRight?: ReactNode;
}

function ApprovalsLink({ onNavigate }: { onNavigate: () => void }) {
  const waiting = useNotifications().counts?.pendingApprovals ?? 0;
  return (
    <NavLink to="/approvals" onClick={onNavigate} className={cx(styles.approvals, waiting > 0 && styles.approvalsWaiting)}>
      <Icon name="inbox" />
      <span className={styles.approvalsText}>
        <span>{ru.shell.approvals}</span>
        {waiting > 0 ? <span className={styles.approvalsHint}>{ru.shell.approvalsHint(waiting)}</span> : null}
      </span>
      {waiting > 0 ? (
        <span className={styles.badge} aria-label={ru.shell.approvalsHint(waiting)}>
          {waiting}
        </span>
      ) : null}
    </NavLink>
  );
}

function AgentList({ agents, currentAgentId, onNavigate }: Pick<SidebarProps, 'agents' | 'currentAgentId' | 'onNavigate'>) {
  if (agents.status === 'loading') return <Skeleton rows={2} />;
  if (agents.status === 'error') return <ErrorBanner title={ru.agents.loadFailed} error={agents.error} onRetry={agents.retry} />;
  if (agents.agents.length === 0) return <p className={styles.empty}>{ru.shell.noAgents}</p>;
  return agents.agents.map((a) => (
    <Link key={a.id} to={`/agents/${encodeURIComponent(a.id)}`} onClick={onNavigate} className={cx(styles.item, a.id === currentAgentId && styles.itemCurrent)} aria-current={a.id === currentAgentId ? 'page' : undefined}>
      <span className={styles.agentMark} aria-hidden="true">
        {initials(a.name)}
      </span>
      <span className={styles.itemText}>{a.name}</span>
    </Link>
  ));
}

export function Sidebar(props: SidebarProps) {
  const me = useMe();
  const hasAdmin = availableSections(me).length > 0;
  return (
    <div className={styles.side}>
      <div className={styles.brand}>
        <span className={styles.brandMark}>
          <Icon name="spark" />
        </span>
        <span>{ru.shell.brand}</span>
        {props.topRight}
      </div>
      <div className={styles.topRow}>
        <IconButton icon="plus" label={ru.shell.newThread} variant="outline" onClick={props.onNewThread} />
      </div>

      <div className={styles.sectionLabel}>{ru.shell.agents}</div>
      <AgentList agents={props.agents} currentAgentId={props.currentAgentId} onNavigate={props.onNavigate} />

      <div className={styles.sectionLabel}>{ru.shell.recent}</div>
      <RecentThreads key={props.threadsKey} currentThreadId={props.currentThreadId} onNavigate={props.onNavigate} />

      <div className={styles.spacer} />
      <ApprovalsLink onNavigate={props.onNavigate} />
      {hasAdmin ? (
        <Link to="/admin" onClick={props.onNavigate} className={styles.footLink}>
          <Icon name="shield" />
          {ru.shell.admin}
        </Link>
      ) : null}
      <LimitMeter usage={props.usage} />
      <MenuAnchor className={styles.user}>
        <Avatar name={me.user.name} />
        <div className={styles.userText}>
          <div className={styles.userName}>{me.user.name}</div>
          {me.departmentNames.length > 0 ? <div className={styles.userDept}>{me.departmentNames.join(', ')}</div> : null}
        </div>
        <SettingsMenu usage={props.usage} onNavigate={props.onNavigate} />
      </MenuAnchor>
    </div>
  );
}
