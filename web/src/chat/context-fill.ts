// How full a conversation is (spec, section 8.34): the server tells it in the chat stream after every call of the
// model, so the ring grows while the agent answers; when a conversation opens and after an answer the chat asks for it.
import { CHAT_EVENTS, contextFillEventSchema, type ThreadContextFill } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { fetchThreadContext } from '../threads/api.ts';
import { useLoad } from '../ui/use-load.ts';

interface CustomEventParams {
  event: { name: string; value: unknown };
}

// An AG-UI subscriber of the chat's agent; it never changes the messages.
export function contextFillSubscriber(threadId: string, onFill: (context: ThreadContextFill | null) => void) {
  return {
    onCustomEvent({ event }: CustomEventParams): undefined {
      if (event.name !== CHAT_EVENTS.contextFill) return undefined;
      const parsed = contextFillEventSchema.safeParse(event.value);
      if (!parsed.success) {
        console.error('malformed chat event', event.name, parsed.error);
        return undefined;
      }
      if (parsed.data.threadId === threadId) onFill(parsed.data.context);
      return undefined;
    },
  };
}

// What the server said when asked, and over it what the stream told since. A new answer of the server — after the
// agent finished — replaces both: the event was told against the answer it came after.
export function useContextFill(threadId: string): { fill: ThreadContextFill | null; onLive: (context: ThreadContextFill | null) => void; reload: () => void } {
  const load = useCallback(() => fetchThreadContext(threadId), [threadId]);
  const { state, reload } = useLoad(load, ['thread-context', threadId]);
  const loaded = state.status === 'ready' ? state.data : null;
  const [live, setLive] = useState<{ over: object | null; context: ThreadContextFill | null } | null>(null);
  const onLive = useCallback((context: ThreadContextFill | null) => setLive({ over: loaded, context }), [loaded]);
  // The indicator is not worth a banner: a failed load shows nothing, the next answer asks again.
  const fill = live && live.over === loaded ? live.context : (loaded?.context ?? null);
  return { fill, onLive, reload };
}
