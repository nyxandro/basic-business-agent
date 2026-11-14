// jsdom has no matchMedia: tests choose the system theme and the width of the window, and can
// switch the theme like the system would.
import { vi } from 'vitest';

type Listener = (event: { matches: boolean }) => void;

export const DESKTOP_WIDTH = 1280;
export const PHONE_WIDTH = 390;

export function stubSystemTheme(initial: 'light' | 'dark', width = DESKTOP_WIDTH) {
  let dark = initial === 'dark';
  const listeners = new Set<Listener>();
  const matches = (query: string): boolean => {
    const minWidth = /min-width:\s*(\d+)px/.exec(query);
    if (minWidth) return width >= Number(minWidth[1]);
    return query.includes('dark') ? dark : !dark;
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return matches(query);
      },
      media: query,
      addEventListener: (_: string, fn: Listener) => listeners.add(fn),
      removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
    })),
  );
  return {
    change(next: 'light' | 'dark') {
      dark = next === 'dark';
      for (const fn of listeners) fn({ matches: dark });
    },
  };
}
