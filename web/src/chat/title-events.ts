// The name the conversation got while the agent answered (spec, section 8.16): the server tells it in
// the chat stream, and «Недавние» load again to show it.
import { CHAT_EVENTS, threadTitledSchema } from '@bba/contracts';

interface CustomEventParams {
  event: { name: string; value: unknown };
}

// An AG-UI subscriber of the chat's agent; it never changes the messages.
export function titleSubscriber(threadId: string, onTitled: () => void) {
  return {
    onCustomEvent({ event }: CustomEventParams): undefined {
      if (event.name !== CHAT_EVENTS.threadTitled) return undefined;
      const parsed = threadTitledSchema.safeParse(event.value);
      if (!parsed.success) {
        console.error('malformed chat event', event.name, parsed.error);
        return undefined;
      }
      if (parsed.data.threadId === threadId) onTitled();
      return undefined;
    },
  };
}
