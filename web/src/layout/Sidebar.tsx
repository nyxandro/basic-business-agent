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
import { DelayedBar } from '../ui/Loading.tsx';
import { MenuAnchor } from '../ui/Menu.tsx';
import { LimitMeter } from './LimitMeter.tsx';
import { useNotifications } from './notifications.tsx';
import { ProjectList } from '../projects/ProjectList.tsx';
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
  // Names given by hand in this tab — in «Недавние» or in the header of the conversation — over a
  // list loaded before the server had them.
  threadNames: Readonly<Record<string, string>>;
  onThreadNamed: (threadId: string, title: string) => void;
  // Bumped when a project changes: «Проекты» load again.
  projectsKey: number;
  chatProjectId: string | null;
  onProjectsChanged: () => void;
  onNewThread: () => void;
  onSearch: () => void;
  // «Ещё» under «Недавние»: all conversations in the window of «Поиск».
  onShowAllThreads: () => void;
  // A phone closes the drawer after a choice.
  onNavigate: () => void;
  // The phone's drawer adds its «Закрыть меню» here and opens «Ждёт подтверждения» as a sheet.
  topRight?: ReactNode;
  approvalsAsSheet?: boolean;
}

// On a computer a link to the page; in the phone's drawer it opens the sheet (mockup). Shown only
// while something waits for the person's decision.
function ApprovalsLink({ onNavigate, asSheet }: { onNavigate: () => void; asSheet: boolean }) {
  const { counts, openApprovals } = useNotifications();
  const waiting = counts?.pendingApprovals ?? 0;
  if (waiting === 0) return null;
  const body = (
    <>
      <Icon name="inbox" />
      <span className={styles.approvalsText}>
        <span>{ru.shell.approvals}</span>
        <span className={styles.approvalsHint}>{ru.shell.approvalsHint(waiting)}</span>
      </span>
      <span className={styles.badge} aria-label={ru.shell.approvalsHint(waiting)}>
        {waiting}
      </span>
    </>
  );
  const className = cx(styles.approvals, styles.approvalsWaiting);
  if (asSheet) {
    return (
      <button
        type="button"
        className={className}
        onClick={() => {
          onNavigate();
          openApprovals();
        }}
      >
        {body}
      </button>
    );
  }
  return (
    <NavLink to="/approvals" onClick={onNavigate} className={className}>
      {body}
    </NavLink>
  );
}

function AgentList({ agents, currentAgentId, onNavigate }: Pick<SidebarProps, 'agents' | 'currentAgentId' | 'onNavigate'>) {
  if (agents.status === 'loading') return <DelayedBar />;
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
        <button type="button" className={styles.searchButton} onClick={props.onSearch}>
          <Icon name="search" size={15} />
          {ru.search.open}
        </button>
        <IconButton icon="plus" label={ru.shell.newThread} onClick={props.onNewThread} />
      </div>

      <div className={styles.sectionLabel}>{ru.shell.agents}</div>
      <AgentList agents={props.agents} currentAgentId={props.currentAgentId} onNavigate={props.onNavigate} />

      <ProjectList refreshKey={props.projectsKey} chatProjectId={props.chatProjectId} onNavigate={props.onNavigate} onChanged={props.onProjectsChanged} />

      <div className={styles.sectionLabel}>{ru.shell.recent}</div>
      <RecentThreads refreshKey={props.threadsKey} names={props.threadNames} currentThreadId={props.currentThreadId} onNavigate={props.onNavigate} onShowAll={props.onShowAllThreads} onRenamed={props.onThreadNamed} onDeleted={props.onProjectsChanged} />

      <div className={styles.spacer} />
      <ApprovalsLink onNavigate={props.onNavigate} asSheet={props.approvalsAsSheet ?? false} />
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
