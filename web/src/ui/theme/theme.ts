// The theme of the interface: the person's choice kept in this browser, otherwise the system's.
// The same rule runs before the first paint in index.html, so the page never flashes light.
export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'bba-theme';
export const DARK_QUERY = '(prefers-color-scheme: dark)';

// Storage can be blocked (private windows, site data off): the theme then follows the system.
export function readStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {
    console.warn('theme choice is not kept: browser storage is unavailable', error);
  }
}

export function systemTheme(): Theme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}
