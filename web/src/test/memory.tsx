// The memory of screens for a component tested without the session around it (spec, section 8.22):
// a fresh one for each render, so tests do not see each other's data.
import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { newScreenMemory } from '../ui/screen-memory.ts';

export function WithMemory({ children }: { children: ReactNode }) {
  const [memory] = useState(newScreenMemory);
  return <QueryClientProvider client={memory}>{children}</QueryClientProvider>;
}
