// A press of a widget while the agent is still answering (spec, section 8.31): CopilotKit does not send it and answers
// the component with «agent_busy», with nothing on the screen — in e2e 20.11 a button pressed right after the screen
// appeared did nothing at all. Our components that send (buttons, a form, the actions of a card) tell the block of the
// widget, and the block says to press again when the answer is done (WidgetCall.tsx). The press is not sent later by
// itself: the answer may end with a «Да» question a new message would cancel, or with «Стоп» (review 20.11).
// A second press of the same control while its first one is going is not made at all: a double click would come back
// «busy» from the run the first click started.
import { createContext, useContext, useRef } from 'react';

// The code of CopilotKit's answer (@copilotkit/react-core, use-generative-ui-root: GenerativeUIError «agent_busy»).
export const BUSY_CODE = 'agent_busy';

type Outcome = { ok: boolean; error?: { code?: unknown } } | undefined;

// The block of the widget: «a press was not sent». Outside a block (a test of one component) there is nobody to tell.
export const BusyPress = createContext<(() => void) | null>(null);

// The handler of an event prop (it takes one object of arguments), the same, telling the block of a press not sent.
// CopilotKit's handler resolves when the run the press started is over.
export function useBusyGuard<H>(handler: H | undefined): H | undefined {
  const report = useContext(BusyPress);
  const going = useRef(false);
  if (typeof handler !== 'function') return handler;
  const call = handler as (args: unknown) => Promise<Outcome> | Outcome;
  const guarded = async (args: unknown): Promise<Outcome> => {
    if (going.current) return undefined;
    going.current = true;
    try {
      const outcome = await call(args);
      if (outcome && !outcome.ok && outcome.error?.code === BUSY_CODE) report?.();
      return outcome;
    } finally {
      going.current = false;
    }
  };
  return guarded as unknown as H;
}
