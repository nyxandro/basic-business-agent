// The live steps of searches of the internet (spec, section 8.30; decision of the owner 20.11): the server tells each
// query and page of the researcher in the chat stream, tied to its call of web_research; the block of that call
// (WebSearch.tsx) reads them here while the call runs. Kept for the life of the chat window only — the result of the
// call keeps the steps for good.
import { CHAT_EVENTS, webProgressSchema, type WebStep } from '@bba/contracts';
import { createContext, useCallback, useContext, useState, useSyncExternalStore } from 'react';

export interface WebProgressStore {
  apply(toolCallId: string, step: WebStep, now: number): void;
  stepsOf(toolCallId: string): WebStep[] | undefined;
  // When the chat first saw the call — its block or its first step: the clock of the block counts from it, and a
  // block drawn anew (the feed re-renders) keeps it.
  startOf(toolCallId: string, now: number): number;
  subscribe(listener: () => void): () => void;
}

export function createWebProgressStore(): WebProgressStore {
  const calls = new Map<string, WebStep[]>();
  const starts = new Map<string, number>();
  const listeners = new Set<() => void>();
  const startOf = (toolCallId: string, now: number) => {
    const known = starts.get(toolCallId);
    if (known !== undefined) return known;
    starts.set(toolCallId, now);
    return now;
  };
  return {
    apply(toolCallId, step, now) {
      startOf(toolCallId, now);
      const steps = calls.get(toolCallId) ?? [];
      const at = steps.findIndex((s) => s.id === step.id);
      // A new array for every change: the block sees «changed» by the reference.
      calls.set(toolCallId, at < 0 ? [...steps, step] : steps.map((s, i) => (i === at ? step : s)));
      for (const listener of listeners) listener();
    },
    stepsOf: (toolCallId) => calls.get(toolCallId),
    startOf,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

interface CustomEventParams {
  event: { name: string; value: unknown };
}

// An AG-UI subscriber of the chat's agent; it never changes the messages.
export function webProgressSubscriber(store: WebProgressStore) {
  return {
    onCustomEvent({ event }: CustomEventParams): undefined {
      if (event.name !== CHAT_EVENTS.webProgress) return undefined;
      const parsed = webProgressSchema.safeParse(event.value);
      if (!parsed.success) {
        console.error('malformed chat event', event.name, parsed.error);
        return undefined;
      }
      store.apply(parsed.data.toolCallId, parsed.data.step, Date.now());
      return undefined;
    },
  };
}

export const WebProgressContext = createContext<WebProgressStore | null>(null);

// The live steps of one call; nothing outside a chat window (a past conversation shows the steps of its result).
export function useWebCall(toolCallId: string): { steps: WebStep[] | undefined; startedAt: number } {
  const store = useContext(WebProgressContext);
  const subscribe = useCallback((listener: () => void) => (store ? store.subscribe(listener) : () => undefined), [store]);
  const steps = useSyncExternalStore(subscribe, () => store?.stepsOf(toolCallId));
  const [startedAt] = useState(() => (store ? store.startOf(toolCallId, Date.now()) : Date.now()));
  return { steps, startedAt };
}
