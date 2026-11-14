import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { stubSystemTheme } from './match-media.ts';

// Every screen renders inside ThemeProvider, which asks the system for its theme.
beforeEach(() => {
  stubSystemTheme('light');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
