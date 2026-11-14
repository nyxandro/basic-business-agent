// The project of the open conversation for its chip. «Новый разговор в проекте» opens the chat with
// ?project=: the address loses the parameter at once (so a slow answer never navigates anywhere and
// a reload does not move the conversation back), and the conversation is put into that project
// before its first message. A move that fails is shown on the chip; the chip still works.
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { useShell } from '../layout/AppShell.tsx';
import { useLoad, type LoadState } from '../ui/use-load.ts';
import { fetchProject, fetchThreadProject, setThreadProject } from './api.ts';

export interface ProjectRef {
  id: string;
  name: string;
}

export type ThreadProjectState = LoadState<ProjectRef | null>;

export function useThreadProject(threadId: string): { state: ThreadProjectState; retry: () => void; changed: (project: ProjectRef | null) => void; moveError: ApiRequestError | null } {
  const [params, setParams] = useSearchParams();
  const { refreshProjects, showChatProject } = useShell();
  // Read once: the conversation is new, the parameter goes from the address right away.
  const [wanted] = useState(() => params.get('project'));
  const [moveError, setMoveError] = useState<ApiRequestError | null>(null);
  // A move made in the chip, kept per conversation so another conversation starts from its own.
  const [moved, setMoved] = useState<{ threadId: string; project: ProjectRef | null } | null>(null);

  useEffect(() => {
    if (wanted) setParams((p) => (p.delete('project'), p), { replace: true });
    // Only on arrival with the parameter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async (): Promise<ProjectRef | null> => {
    if (wanted) {
      try {
        await setThreadProject(threadId, wanted);
        refreshProjects();
      } catch (raw) {
        setMoveError(asApiError(raw));
      }
    }
    const { projectId } = await fetchThreadProject(threadId);
    if (!projectId) return null;
    const project = await fetchProject(projectId);
    return { id: project.id, name: project.name };
  }, [threadId, wanted, refreshProjects]);
  const { state, reload } = useLoad(load);

  const changed = useCallback(
    (project: ProjectRef | null) => {
      setMoved({ threadId, project });
      setMoveError(null);
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
  return { state: shown, retry: reload, changed, moveError };
}
