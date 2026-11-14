import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { stubSystemTheme } from './match-media.ts';

// jsdom has no ResizeObserver; the chat window of CopilotKit watches its size with one.
class NoResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// Every screen renders inside ThemeProvider, which asks the system for its theme.
beforeEach(() => {
  stubSystemTheme('light');
  vi.stubGlobal('ResizeObserver', NoResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
