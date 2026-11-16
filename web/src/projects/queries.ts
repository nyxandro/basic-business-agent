// What a project's page loads, each under one key of the memory of screens (spec, section 8.22): the
// page and the loading while the pointer is over the project in the panel share them.
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { fetchProject, fetchProjectFiles, fetchProjectThreads, fetchTrash } from './api.ts';

export const projectKeys = {
  project: (id: string) => ['project', id] as const,
  threads: (id: string) => ['project', id, 'threads'] as const,
  files: (id: string) => ['project', id, 'files'] as const,
  trash: (id: string) => ['project', id, 'trash'] as const,
};

// A project loaded this recently is not loaded again by the pointer passing over it once more.
const LOADED_RECENTLY_MS = 10_000;

export function usePrefetchProject(): (id: string) => void {
  const memory = useQueryClient();
  return useCallback(
    (id: string) => {
      // A failure here is not shown: the page asks again when opened and shows its own.
      const staleTime = LOADED_RECENTLY_MS;
      void memory.prefetchQuery({ queryKey: projectKeys.project(id), queryFn: () => fetchProject(id), staleTime });
      void memory.prefetchQuery({ queryKey: projectKeys.threads(id), queryFn: () => fetchProjectThreads(id), staleTime });
      void memory.prefetchQuery({ queryKey: projectKeys.files(id), queryFn: () => fetchProjectFiles(id), staleTime });
      void memory.prefetchQuery({ queryKey: projectKeys.trash(id), queryFn: () => fetchTrash(id), staleTime });
    },
    [memory],
  );
}
