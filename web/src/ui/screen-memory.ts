// The memory of what screens loaded (spec, section 8.22; TanStack Query — decision of the owner 17.11).
// The session keeps one and empties it whenever the signed-in person changes (auth/session.tsx), so
// nobody sees what was loaded for someone else. A failure is not repeated by itself and a tab coming
// back to the front does not ask anew: repeats are only the person's own («Повторить»), as everywhere
// in the project.
import { QueryClient } from '@tanstack/react-query';

// How long what a screen loaded is kept after the last screen showing it is left.
export const SCREEN_MEMORY_MS = 5 * 60_000;

export function newScreenMemory(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        gcTime: SCREEN_MEMORY_MS,
        // Every answer is a new object, the same data too: screens tell «loaded again» by it (a change
        // made over the old list gives way to the list from the server — ProjectList, ProjectPage).
        structuralSharing: false,
      },
    },
  });
}
