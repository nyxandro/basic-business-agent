// What a call without its result is now (decision of the owner 20.11: every call of the agent is in the chat the moment
// it is made, like Codex and Claude Code — core/chat/copilot.ts, `streamServerToolCalls`). A call of the browser's own
// tools runs here and answers itself; a call of the server is under way only while its answer is being written. When
// the answer has ended without the result, the call waits for «Да» — the question is open under that answer; a call
// of a sub-agent or one queued behind the action in the same step waits with it — or was stopped: «Стоп», a broken
// answer, a new message instead of «Да».
import { COMPUTER_TOOLS } from '@bba/contracts';
import { createContext, useContext } from 'react';

// What the turn a call is in does now: its answer is being written; it ended with the question «Да» open under it; it
// ended. Not the chat's «answering»: a call an earlier answer left unfinished is not under way while the next is written.
export type TurnState = 'answering' | 'asking' | 'ended';

export const TurnStateContext = createContext<TurnState>('ended');

const BROWSER_TOOLS: ReadonlySet<string> = new Set(Object.values(COMPUTER_TOOLS));

export type Unfinished = 'running' | 'waiting' | 'stopped';

export function useUnfinished(): (call: { name: string }) => Unfinished {
  const turn = useContext(TurnStateContext);
  return (call) => {
    if (turn === 'answering' || BROWSER_TOOLS.has(call.name)) return 'running';
    return turn === 'asking' ? 'waiting' : 'stopped';
  };
}
