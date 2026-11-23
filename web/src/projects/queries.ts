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

// How long the pointer rests on a project before its data starts to load: passing over the list loads nothing.
export const POINTER_REST_MS = 150;
// A project loaded this recently is not loaded again by the pointer passing over it once more.
const LOADED_RECENTLY_MS = 10_000;

export function usePrefetchProject(): (id: string) => void {
  const memory = useQueryClient();
  return useCallback(
    (id: string) => {
      // A failure here is only noted in the console: the page asks again when opened and shows its own.
      const staleTime = LOADED_RECENTLY_MS;
      const noted = (error: unknown) => console.warn('project not loaded ahead', error);
      memory.query({ queryKey: projectKeys.project(id), queryFn: () => fetchProject(id), staleTime }).catch(noted);
      memory.query({ queryKey: projectKeys.threads(id), queryFn: () => fetchProjectThreads(id), staleTime }).catch(noted);
      memory.query({ queryKey: projectKeys.files(id), queryFn: () => fetchProjectFiles(id), staleTime }).catch(noted);
      memory.query({ queryKey: projectKeys.trash(id), queryFn: () => fetchTrash(id), staleTime }).catch(noted);
    },
    [memory],
  );
}
