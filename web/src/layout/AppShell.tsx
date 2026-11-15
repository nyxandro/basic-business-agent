// The frame of signed-in screens (spec, sections 7 and 17.8): the side panel as a column from 860 px,
// a drawer below that; the screen of the route on the right. The agents of the person and the
// signal to reload «Недавние» reach the screens through the outlet context.
import type { AgentSummary, MyUsage, SearchScope } from '@bba/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation, useMatch, useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { fetchAgents } from '../agents/api.ts';
import { useMe } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';
import { SearchDialog } from '../search/SearchDialog.tsx';
import { fetchMyUsage } from '../settings/api.ts';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { Notice } from '../ui/ErrorBanner.tsx';
import { useLoad } from '../ui/use-load.ts';
import { MODELS_PATH } from './EmptyInstallation.tsx';
import { MobileDrawer } from './MobileDrawer.tsx';
import { NotificationsProvider } from './notifications.tsx';
import { Sidebar, type AgentsState } from './Sidebar.tsx';
import styles from './shell.module.css';
import { useMedia, WIDE_QUERY } from './use-media.ts';

// The last agent the person talked to opens on «/» (kept in this browser only).
export const LAST_AGENT_KEY = 'bba-last-agent';

export interface ShellContext {
  agents: AgentSummary[] | null;
  wide: boolean;
  openMenu: () => void;
  // After a run the conversation may be new or retitled: «Недавние» loads again.
  refreshThreads: () => void;
  // A project was created, renamed, removed or got a conversation: «Проекты» load again.
  refreshProjects: () => void;
  // Bumped by `refreshProjects`: an open project page loads again (a name changed in «Проекты»).
  projectsKey: number;
  // The open conversation's project is marked in «Проекты» (mockup); null outside a project.
  showChatProject: (projectId: string | null) => void;
}

export const useShell = () => useOutletContext<ShellContext>();

export function rememberAgent(agentId: string): void {
  try {
    localStorage.setItem(LAST_AGENT_KEY, agentId);
  } catch (error) {
    console.warn('last agent not remembered', error);
  }
}

function lastAgent(): string | null {
  try {
    return localStorage.getItem(LAST_AGENT_KEY);
  } catch {
    return null;
  }
}

// A section of the admin panel opened without its right, or an agent the person does not have,
// lands on an open page with a line why (spec, section 7).
function ForbiddenNotice() {
  const state = useLocation().state as { adminForbidden?: boolean; agentUnavailable?: boolean } | null;
  const notice = state?.adminForbidden
    ? { text: ru.admin.forbidden, code: 'APP_ADMIN_FORBIDDEN' }
    : state?.agentUnavailable
      ? { text: ru.chat.noAgent, code: 'APP_AGENT_ACCESS_DENIED' }
      : null;
  if (!notice) return null;
  return (
    <div className={styles.banner}>
      <Notice>
        <span>{notice.text}</span>
        <br />
        <span>
          {ru.common.errorCode}: {notice.code}
        </span>
      </Notice>
    </div>
  );
}

export function AppShell() {
  const wide = useMedia(WIDE_QUERY);
  const [menuOpen, setMenuOpen] = useState(false);
  const [threadsKey, setThreadsKey] = useState(0);
  const [projectsKey, setProjectsKey] = useState(0);
  const [chatProjectId, showChatProject] = useState<string | null>(null);
  // `opened` gives the window a new key each time it opens: it starts afresh, on the scope asked for.
  const [search, setSearch] = useState<{ open: boolean; scope: SearchScope; opened: number }>({ open: false, scope: 'all', opened: 0 });
  const { state: agentsLoad, reload } = useLoad(fetchAgents);
  const { state: usageLoad } = useLoad(fetchMyUsage);
  // The layout sits above the chat route, so the agent and the project page come from the address itself.
  const agentId = useMatch('/agents/:agentId')?.params.agentId;
  const projectPageId = useMatch('/projects/:projectId')?.params.projectId;
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const agents: AgentsState =
    agentsLoad.status === 'ready' ? { status: 'ready', agents: agentsLoad.data.agents } : agentsLoad.status === 'error' ? { status: 'error', error: agentsLoad.error, retry: reload } : { status: 'loading' };
  const usage: MyUsage | null = usageLoad.status === 'ready' ? usageLoad.data : null;
  const refreshThreads = useCallback(() => {
    setThreadsKey((n) => n + 1);
    setProjectsKey((n) => n + 1);
  }, []);
  const refreshProjects = useCallback(() => setProjectsKey((n) => n + 1), []);
  // Back to the tab: a project opened or closed to the person meanwhile shows at once (spec, 8.20).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshProjects();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshProjects]);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const openSearch = useCallback((scope: SearchScope) => {
    setMenuOpen(false);
    setSearch((s) => (s.open ? s : { open: true, scope, opened: s.opened + 1 }));
  }, []);
  // Ctrl+K (⌘K on a Mac) opens the search from anywhere; the key code keeps it working in any layout.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault();
        openSearch('all');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSearch]);
  const newThread = () => {
    // Only an agent the person has: the remembered one may be of another installation at the same
    // address, or the admin may have taken it away.
    const available = agents.status === 'ready' ? agents.agents : [];
    const target = [agentId, lastAgent()].find((id) => id && available.some((a) => a.id === id)) ?? available[0]?.id;
    // Inside a project — its page or one of its conversations, the project marked in «Проекты» — the
    // new conversation goes into it (decision of the owner 15.11).
    const project = projectPageId ?? chatProjectId;
    closeMenu();
    if (target) void navigate(`/agents/${encodeURIComponent(target)}?thread=${crypto.randomUUID()}${project ? `&project=${encodeURIComponent(project)}` : ''}`);
  };

  const sidebar = { agents, usage, currentAgentId: agentId ?? null, currentThreadId: params.get('thread'), threadsKey, projectsKey, chatProjectId, onProjectsChanged: refreshProjects, onNewThread: newThread, onSearch: () => openSearch('all'), onShowAllThreads: () => openSearch('threads') };
  const context: ShellContext = { agents: agents.status === 'ready' ? agents.agents : null, wide, openMenu, refreshThreads, refreshProjects, projectsKey, showChatProject };
  return (
    <NotificationsProvider>
      <div className={styles.shell}>
        {wide ? <Sidebar {...sidebar} onNavigate={closeMenu} /> : <MobileDrawer {...sidebar} open={menuOpen} onClose={closeMenu} />}
        <main className={styles.main}>
          <ForbiddenNotice />
          {/* A screen that fails to draw shows its message; the panel stays, the next screen or
              conversation starts clean. */}
          <ErrorBoundary key={`${pathname}?${params.get('thread') ?? ''}`}>
            <Outlet context={context} />
          </ErrorBoundary>
        </main>
      </div>
      <SearchDialog key={search.opened} open={search.open} startScope={search.scope} wide={wide} onClose={() => setSearch((s) => ({ ...s, open: false }))} />
    </NotificationsProvider>
  );
}

// «/»: a new conversation with the last agent (spec, section 7); the superadmin of an installation
// without models goes to set them up first.
export function Home() {
  const me = useMe();
  const { agents } = useShell();
  // A notice brought here («Этот раздел вам недоступен») travels on to the chat.
  const state = useLocation().state as unknown;
  if (!me.modelsConfigured && me.isSuperadmin) return <Navigate to={MODELS_PATH} replace />;
  if (!agents) return null;
  if (agents.length === 0) return <p className={styles.notice}>{ru.shell.noAgents}</p>;
  const remembered = lastAgent();
  const target = agents.find((a) => a.id === remembered) ?? agents[0]!;
  return <Navigate to={`/agents/${encodeURIComponent(target.id)}`} replace state={state} />;
}
