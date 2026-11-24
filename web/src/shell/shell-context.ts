// What a screen takes from the frame it is shown in (layout/AppShell.tsx): the agents of the person, the menu, the
// signals to reload «Недавние» and «Проекты» — through the outlet context of the frame's route — and the last agent
// the person talked to. The frame gives them; screens never import the frame itself.
import type { AgentSummary } from '@bba/contracts';
import { useOutletContext } from 'react-router';

// The last agent the person talked to opens on «/» (kept in this browser only).
export const LAST_AGENT_KEY = 'bba-last-agent';

export interface ShellContext {
  agents: AgentSummary[] | null;
  wide: boolean;
  openMenu: () => void;
  // After a run the conversation may be new or retitled: «Недавние» loads again.
  refreshThreads: () => void;
  // A name given by hand in the header of the conversation: «Недавние» show it at once.
  nameThread: (threadId: string, title: string) => void;
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

export function lastAgent(): string | null {
  try {
    return localStorage.getItem(LAST_AGENT_KEY);
  } catch {
    return null;
  }
}
