// The frame of signed-in screens (spec, sections 7 and 17.8): the side panel as a column from 860 px,
// a drawer below that; the screen of the route on the right. The agents of the person and the
// signal to reload «Недавние» reach the screens through the outlet context.
import type { AgentSummary, MyUsage } from '@bba/contracts';
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

// A section of the admin panel opened without its right lands here (spec, section 7).
function ForbiddenNotice() {
  const state = useLocation().state as { adminForbidden?: boolean } | null;
  if (!state?.adminForbidden) return null;
  return (
    <div className={styles.banner}>
      <Notice>
        <span>{ru.admin.forbidden}</span>
        <br />
        <span>{ru.common.errorCode}: APP_ADMIN_FORBIDDEN</span>
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
  const [searchOpen, setSearchOpen] = useState(false);
  const { state: agentsLoad, reload } = useLoad(fetchAgents);
  const { state: usageLoad } = useLoad(fetchMyUsage);
  // The layout sits above the chat route, so the agent comes from the address itself.
  const agentId = useMatch('/agents/:agentId')?.params.agentId;
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
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const openSearch = useCallback(() => {
    setMenuOpen(false);
    setSearchOpen(true);
  }, []);
  // Ctrl+K (⌘K on a Mac) opens the search from anywhere; the key code keeps it working in any layout.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSearch]);
  const newThread = () => {
    const target = agentId ?? lastAgent() ?? (agents.status === 'ready' ? agents.agents[0]?.id : undefined);
    closeMenu();
    if (target) void navigate(`/agents/${encodeURIComponent(target)}?thread=${crypto.randomUUID()}`);
  };

  const sidebar = { agents, usage, currentAgentId: agentId ?? null, currentThreadId: params.get('thread'), threadsKey, projectsKey, chatProjectId, onProjectsChanged: refreshProjects, onNewThread: newThread, onSearch: openSearch };
  const context: ShellContext = { agents: agents.status === 'ready' ? agents.agents : null, wide, openMenu, refreshThreads, refreshProjects, showChatProject };
  return (
    <NotificationsProvider>
      <div className={styles.shell}>
        {wide ? <Sidebar {...sidebar} onNavigate={closeMenu} /> : <MobileDrawer {...sidebar} open={menuOpen} onClose={closeMenu} />}
        <main className={styles.main}>
          <ForbiddenNotice />
          {/* A screen that fails to draw shows its message; the panel stays, the next screen starts clean. */}
          <ErrorBoundary key={pathname}>
            <Outlet context={context} />
          </ErrorBoundary>
        </main>
      </div>
      <SearchDialog open={searchOpen} wide={wide} onClose={() => setSearchOpen(false)} />
    </NotificationsProvider>
  );
}

// «/»: a new conversation with the last agent (spec, section 7); the superadmin of an installation
// without models goes to set them up first.
export function Home() {
  const me = useMe();
  const { agents } = useShell();
  if (!me.modelsConfigured && me.isSuperadmin) return <Navigate to={MODELS_PATH} replace />;
  if (!agents) return null;
  if (agents.length === 0) return <p className={styles.notice}>{ru.shell.noAgents}</p>;
  const remembered = lastAgent();
  const target = agents.find((a) => a.id === remembered) ?? agents[0]!;
  return <Navigate to={`/agents/${encodeURIComponent(target.id)}`} replace />;
}
