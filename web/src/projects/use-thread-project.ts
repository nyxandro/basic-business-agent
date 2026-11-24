// The project of the open conversation for its chip, and why it is gone when the person lost it
// (spec, section 8.20). «Новый разговор в проекте» opens the chat with ?project=: the address loses
// the parameter at once (so a slow answer never navigates anywhere and a reload does not move the
// conversation back), and the conversation is put into that project before its first message. A move
// that fails is shown on the chip; the chip still works. The project is read again whenever
// «Проекты» are — after an answer of the agent, on coming back to the tab — so a project closed
// meanwhile shows its notice above the input.
import type { ThreadProjectResponse } from '@bba/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { useShell } from '../shell/shell-context.ts';
import { useLoad, type LoadState } from '../ui/use-load.ts';
import { fetchProject, fetchThreadProject, setThreadProject } from './api.ts';

export interface ProjectRef {
  id: string;
  name: string;
  shared: boolean;
}

export type ThreadProjectState = LoadState<ProjectRef | null>;
export type LostProject = NonNullable<ThreadProjectResponse['lost']>;

export interface ThreadProject {
  state: ThreadProjectState;
  retry: () => void;
  changed: (project: ProjectRef | null) => void;
  moveError: ApiRequestError | null;
  // The conversation's project is gone for the person (closed, archived, removed).
  lost: LostProject | null;
}

export function useThreadProject(threadId: string): ThreadProject {
  const [params, setParams] = useSearchParams();
  const { refreshProjects, showChatProject, projectsKey } = useShell();
  // Read once: the conversation is new, the parameter goes from the address right away.
  const [wanted] = useState(() => params.get('project'));
  // The project of the address is put once, not on every reading again.
  const pending = useRef(wanted);
  const [moveError, setMoveError] = useState<ApiRequestError | null>(null);
  // A move made in the chip, kept per conversation so another conversation starts from its own.
  const [moved, setMoved] = useState<{ threadId: string; project: ProjectRef | null } | null>(null);
  const [lost, setLost] = useState<{ threadId: string; lost: LostProject | null }>({ threadId, lost: null });

  useEffect(() => {
    if (wanted) setParams((p) => (p.delete('project'), p), { replace: true });
    // Only on arrival with the parameter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async (): Promise<ProjectRef | null> => {
    const target = pending.current;
    if (target) {
      pending.current = null;
      try {
        await setThreadProject(threadId, target);
        refreshProjects();
      } catch (raw) {
        setMoveError(asApiError(raw));
      }
    }
    const { projectId, lost: gone } = await fetchThreadProject(threadId);
    setLost({ threadId, lost: gone });
    if (!projectId) return null;
    const project = await fetchProject(projectId);
    return { id: project.id, name: project.name, shared: project.shared };
  }, [threadId, refreshProjects]);
  const { state, reload } = useLoad(load);

  // «Проекты» were read again (an answer ended, the person came back to the tab, a project changed):
  // so is the project of the conversation, without the chip's own move standing over it.
  const [seenKey, setSeenKey] = useState(projectsKey);
  if (seenKey !== projectsKey) {
    setSeenKey(projectsKey);
    setMoved(null);
    reload();
  }

  const changed = useCallback(
    (project: ProjectRef | null) => {
      setMoved({ threadId, project });
      setMoveError(null);
      setLost({ threadId, lost: null });
      refreshProjects();
    },
    [threadId, refreshProjects],
  );
  const shown: ThreadProjectState = moved?.threadId === threadId && state.status === 'ready' ? { status: 'ready', data: moved.project } : state;
  const shownId = shown.status === 'ready' ? (shown.data?.id ?? null) : null;
  useEffect(() => {
    showChatProject(shownId);
    return () => showChatProject(null);
  }, [shownId, showChatProject]);
  return { state: shown, retry: reload, changed, moveError, lost: lost.threadId === threadId ? lost.lost : null };
}
