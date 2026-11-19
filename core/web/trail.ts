// The trail of one search of the internet (spec, section 8.30; decision of the owner 20.11 — the live block of the
// search): every query and every page of the researcher as a step. A step is kept for the result of web_research
// (the block is the same after a reload) and, in a chat, told to the person's browser at once.
import { createHash, randomUUID } from 'node:crypto';
import type { WebStep } from '@bba/contracts';

// A key of the researcher's own context (never of a run of an agent).
export const WEB_TRAIL_KEY = 'bba.webTrail';

export type WebProgress = (toolCallId: string, step: WebStep) => void;

export interface WebTrail {
  record(step: WebStep): void;
  step(id: string): WebStep | undefined;
  steps(): WebStep[];
  // The pages read, each address once: the sources of the answer.
  sources(): { title: string; address: string }[];
  searches(): number;
}

export function newTrail(toolCallId: string | null, progress: WebProgress | null): WebTrail {
  const steps = new Map<string, WebStep>();
  return {
    record(step) {
      steps.set(step.id, step);
      // A step that cannot reach the browser (a background task, no call id) is only kept.
      if (toolCallId && progress) progress(toolCallId, step);
    },
    step: (id) => steps.get(id),
    steps: () => [...steps.values()],
    sources: () => {
      // Two links may lead to the same page.
      const read = new Map<string, string>();
      for (const s of steps.values()) if (s.kind === 'page' && s.state === 'done' && !read.has(s.address)) read.set(s.address, s.title ?? s.host);
      return [...read].map(([address, title]) => ({ title, address }));
    },
    searches: () => [...steps.values()].filter((s) => s.kind === 'search').length,
  };
}

export function trailIn(ctx: { get(key: string): unknown } | undefined): WebTrail | null {
  const value = ctx?.get(WEB_TRAIL_KEY);
  return value && typeof value === 'object' && 'record' in value ? (value as WebTrail) : null;
}

export const stepId = (): string => randomUUID().slice(0, 8);

// A page is one step however many times it is read: a long page is read in parts (web_fetch with offset).
export const pageStepId = (address: string): string => `page-${createHash('sha256').update(address).digest('hex').slice(0, 12)}`;
