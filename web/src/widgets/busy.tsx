// A press of a widget while the agent is still answering (spec, section 8.31): CopilotKit does not send it and answers
// the component with «agent_busy», with nothing on the screen — in e2e 20.11 a button pressed right after the screen
// appeared did nothing at all, and with a live model the agent writes its words after the screen for seconds. Our
// components that send (buttons, a form, the actions of a card) hand the block of the widget a way to press again, and
// the block presses again once the answer is done (WidgetCall.tsx).
import { createContext, useContext } from 'react';

// The code of CopilotKit's answer (@copilotkit/react-core, use-generative-ui-root: GenerativeUIError «agent_busy»).
export const BUSY_CODE = 'agent_busy';

type Outcome = { ok: boolean; error?: { code?: unknown } } | undefined;

// The block of the widget: «a press was dropped, here is how to make it again». Outside a block (a test of one
// component) there is nobody to tell.
export const BusyPress = createContext<((again: () => void) => void) | null>(null);

// The handler of an event prop (it takes one object of arguments), the same, telling the block of a dropped press.
export function useBusyGuard<H>(handler: H | undefined): H | undefined {
  const report = useContext(BusyPress);
  if (typeof handler !== 'function') return handler;
  const call = handler as (args: unknown) => Promise<Outcome> | Outcome;
  const guarded = async (args: unknown): Promise<Outcome> => {
    const outcome = await call(args);
    if (outcome && !outcome.ok && outcome.error?.code === BUSY_CODE) report?.(() => void guarded(args));
    return outcome;
  };
  return guarded as unknown as H;
}
