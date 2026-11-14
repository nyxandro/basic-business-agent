// Whether a CSS media query holds now, following the window as it changes.
import { useSyncExternalStore } from 'react';

// From this width the side panel is a column; below it, a drawer (spec, section 17.8).
export const WIDE_QUERY = '(min-width: 860px)';

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
  );
}
