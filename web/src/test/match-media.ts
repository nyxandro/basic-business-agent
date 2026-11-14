// jsdom has no matchMedia: tests choose the system theme and can switch it like the system would.
import { vi } from 'vitest';

type Listener = (event: { matches: boolean }) => void;

export function stubSystemTheme(initial: 'light' | 'dark') {
  let dark = initial === 'dark';
  const listeners = new Set<Listener>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return query.includes('dark') ? dark : !dark;
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
