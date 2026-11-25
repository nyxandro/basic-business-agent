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
import { Avatar } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { MenuAnchor } from '../ui/Menu.tsx';
import { ScrollArea } from '../ui/ScrollArea.tsx';
import { LimitMeter } from './LimitMeter.tsx';
import { useNotifications } from '../notifications/notifications-context.ts';
import { ProjectList } from '../projects/ProjectList.tsx';
import { RecentThreads } from './RecentThreads.tsx';
import { SettingsMenu } from './SettingsMenu.tsx';
import styles from '../shell/shell.module.css';

export type AgentsState = { status: 'loading' } | { status: 'ready'; agents: AgentSummary[] } | { status: 'error'; error: ApiRequestError; retry: () => void };

export interface SidebarProps {
  agents: AgentsState;
  usage: MyUsage | null;
  currentAgentId: string | null;
  currentThreadId: string | null;
  // Bumped after a run: the recent list loads again.
  threadsKey: number;
  // Names given by hand in this tab — in «Разговоры» or in the header of the conversation — over a
  // list loaded before the server had them.
  threadNames: Readonly<Record<string, string>>;
  onThreadNamed: (threadId: string, title: string) => void;
  // Bumped when a project changes: «Проекты» load again.
  projectsKey: number;
  // A pin from the window of «Поиск» that did not get saved: the panel tells it, the window may be closed.
  projectsFailure: ApiRequestError | null;
  chatProjectId: string | null;
  onProjectsChanged: () => void;
  onNewThread: () => void;
  onSearch: () => void;
  // «Ещё» under «Разговоры»: all conversations in the window of «Поиск».
  onShowAllThreads: () => void;
  onShowAllProjects: () => void;
  // A phone closes the drawer after a choice.
  onNavigate: () => void;
  // The phone's drawer adds its «Закрыть меню» here and opens «Ждёт подтверждения» as a sheet.
  topRight?: ReactNode;
  approvalsAsSheet?: boolean;
  // On a computer the head and the foot stay and only the lists scroll (owner 25.11); the phone's drawer scrolls whole:
  // a fixed foot would leave the lists half of a small screen.
  scrollWhole?: boolean;
}

// On a computer a link to the page; in the phone's drawer it opens the bell's sheet on «Ждут решения» (mockup).
// Shown only while something waits for the person's decision.
function ApprovalsLink({ onNavigate, asSheet }: { onNavigate: () => void; asSheet: boolean }) {
  const { counts, openPanel } = useNotifications();
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
          openPanel('waiting');
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

// The agent's own mark — its icon or picture, the spark when none was set (spec, section 8.17) — always, whatever
// «Показывать значок агента в чате»: that switch is about the chat (request of the owner 17.11).
function SideMark({ mark }: { mark: AgentSummary['mark'] }) {
  return (
    <span className={cx(styles.agentMark, mark.kind === 'image' && styles.agentMarkPicture)} aria-hidden="true" data-side-mark={mark.kind} {...(mark.kind === 'icon' ? { 'data-icon': mark.icon } : {})}>
      {/* alt="" — decorative: a picture that did not load leaves an empty circle, not a broken-image sign. */}
      {mark.kind === 'image' ? <img src={mark.url} alt="" className={styles.agentMarkImg} draggable={false} /> : <Icon name={mark.icon} size={14} />}
    </span>
  );
}

function AgentList({ agents, currentAgentId, onNavigate }: Pick<SidebarProps, 'agents' | 'currentAgentId' | 'onNavigate'>) {
  if (agents.status === 'loading') return <DelayedBar />;
  if (agents.status === 'error') return <ErrorBanner title={ru.agents.loadFailed} error={agents.error} onRetry={agents.retry} />;
  if (agents.agents.length === 0) return <p className={styles.empty}>{ru.shell.noAgents}</p>;
  return agents.agents.map((a) => (
    <Link key={a.id} to={`/agents/${encodeURIComponent(a.id)}`} onClick={onNavigate} className={cx(styles.item, a.id === currentAgentId && styles.itemCurrent)} aria-current={a.id === currentAgentId ? 'page' : undefined}>
      <SideMark mark={a.mark} />
      <span className={styles.itemText}>{a.name}</span>
    </Link>
  ));
}

export function Sidebar(props: SidebarProps) {
  const me = useMe();
  const { threadStates } = useNotifications();
  const hasAdmin = availableSections(me).length > 0;
  // In the scrolling area of a computer a row's menu lies over the page: the area would cut the menu of a lower row.
  const floatingMenus = !props.scrollWhole;
  const lists = (
    <>
      <div className={styles.sectionLabel}>{ru.shell.agents}</div>
      <AgentList agents={props.agents} currentAgentId={props.currentAgentId} onNavigate={props.onNavigate} />

      <ProjectList refreshKey={props.projectsKey} failure={props.projectsFailure} chatProjectId={props.chatProjectId} floatingMenus={floatingMenus} onNavigate={props.onNavigate} onChanged={props.onProjectsChanged} onShowAll={props.onShowAllProjects} />

      {/* «+» by the title, as by «Проекты» (owner 25.11). */}
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>{ru.shell.threads}</span>
        <IconButton icon="plus" size="sm" label={ru.shell.newThread} onClick={props.onNewThread} />
      </div>
      <RecentThreads refreshKey={props.threadsKey} names={props.threadNames} states={threadStates} currentThreadId={props.currentThreadId} onNavigate={props.onNavigate} onShowAll={props.onShowAllThreads} onRenamed={props.onThreadNamed} onDeleted={props.onProjectsChanged} floatingMenus={floatingMenus} />
    </>
  );
  // The panel itself scrolls only when the window is too low even for the head, the foot and a bit of the lists.
  return (
    <div className={cx(styles.side, 'scroll-thin')}>
      <div className={styles.brand}>
        <span className={styles.brandMark}>
          <Icon name="spark" />
        </span>
        {/* Under the product — the organisation from «Профиль организации», as under «Админка» (owner 25.11). */}
        <div className={styles.brandText}>
          <div>{ru.shell.brand}</div>
          <div className={styles.brandOrg}>{me.organisation.name}</div>
        </div>
        {props.topRight}
      </div>
      <button type="button" className={styles.searchButton} onClick={props.onSearch}>
        <Icon name="search" size={15} />
        {ru.search.open}
      </button>

      {props.scrollWhole ? (
        <div className={cx(styles.lists, styles.listsWhole)}>{lists}</div>
      ) : (
        <ScrollArea className={styles.listsArea} contentClassName={cx(styles.lists, styles.listsInArea)}>
          {lists}
        </ScrollArea>
      )}

      <div className={styles.foot}>
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
    </div>
  );
}
