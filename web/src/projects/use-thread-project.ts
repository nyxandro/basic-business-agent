// The project of the open conversation for its chip. «Новый разговор в проекте» opens the chat with
// ?project=: the conversation is put into that project before its first message, then the address
// loses the parameter so a reload does not move it back.
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useShell } from '../layout/AppShell.tsx';
import { useLoad, type LoadState } from '../ui/use-load.ts';
import { fetchProject, fetchThreadProject, setThreadProject } from './api.ts';

export interface ProjectRef {
  id: string;
  name: string;
}

export type ThreadProjectState = LoadState<ProjectRef | null>;

export function useThreadProject(threadId: string): { state: ThreadProjectState; retry: () => void; changed: (project: ProjectRef | null) => void } {
  const [params, setParams] = useSearchParams();
  const { refreshProjects, showChatProject } = useShell();
  const wanted = params.get('project');
  // A move made in the chip, kept per conversation so another conversation starts from its own.
  const [moved, setMoved] = useState<{ threadId: string; project: ProjectRef | null } | null>(null);

  const load = useCallback(async (): Promise<ProjectRef | null> => {
    if (wanted) {
      await setThreadProject(threadId, wanted);
      setParams((p) => (p.delete('project'), p), { replace: true });
      refreshProjects();
    }
    const { projectId } = await fetchThreadProject(threadId);
    if (!projectId) return null;
    const project = await fetchProject(projectId);
    return { id: project.id, name: project.name };
    // `wanted` is read once per conversation: removing it from the address must not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
  const { state, reload } = useLoad(load);

  const changed = useCallback(
    (project: ProjectRef | null) => {
      setMoved({ threadId, project });
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
  return { state: shown, retry: reload, changed };
}
