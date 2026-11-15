import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { stubSystemTheme } from './match-media.ts';

// Screens of the admin panel load their code and several lists before they draw; on a busy machine
// that takes longer than the default second of findBy… and waitFor.
configure({ asyncUtilTimeout: 3000 });

// jsdom has no ResizeObserver; the chat window of CopilotKit watches its size with one.
class NoResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// jsdom does not scroll elements and has no scrollTo on them; the chat feed keeps its bottom with it.
Object.defineProperty(Element.prototype, 'scrollTo', {
  configurable: true,
  value(this: Element, options?: ScrollToOptions) {
    if (options?.top !== undefined) this.scrollTop = options.top;
  },
});

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
