// What a call without its result is now (decision of the owner 20.11: every call of the agent is in the chat the moment
// it is made, like Codex and Claude Code — core/chat/copilot.ts, `streamServerToolCalls`). A call of the browser's own
// tools runs here and answers itself; a call of the server is under way only while its answer is being written. When
// the answer has ended without the result, the call waits for «Да» — the question is open under that answer; a call
// of a sub-agent or one queued behind the action in the same step waits with it — or was stopped: «Стоп», a broken
// answer, a new message instead of «Да».
import { COMPUTER_TOOLS } from '@bba/contracts';
import type { Message } from '@copilotkit/react-core';
import { createContext, useContext } from 'react';
import { toolMessageOf } from './messages.ts';
import type { ToolCall } from '../chat/turn-items.ts';

// What the turn a call is in does now: its answer is being written; it ended with the question «Да» open under it; it
// ended. Not the chat's «answering»: a call an earlier answer left unfinished is not under way while the next is written.
export type TurnState = 'answering' | 'asking' | 'ended';

export const TurnStateContext = createContext<TurnState>('ended');

const BROWSER_TOOLS: ReadonlySet<string> = new Set(Object.values(COMPUTER_TOOLS));

// A tool of the browser itself runs after the run that called it has ended, and the next run goes on with its answer:
// the call is under way while the chat is not running.
export const answersInBrowser = (name: string): boolean => BROWSER_TOOLS.has(name);

export type Unfinished = 'running' | 'waiting' | 'stopped';

// The calls the answer being written works on now (decision of the owner 21.11: the live line under the answer says
// the last of them): after the person's last message, without a result, and with no words of the agent after the
// message that carries them — words come only from a later step. Where a call stands says nothing more: the adapter
// of Mastra puts a call of the next step on the message of the words before it, above the result of the step before.
export function callsUnderWay(messages: readonly Message[]): ToolCall[] {
  const start = messages.findLastIndex((m) => m.role === 'user') + 1;
  const answer = messages.slice(start);
  const under: ToolCall[] = [];
  answer.forEach((m, i) => {
    if (m.role !== 'assistant' || !m.toolCalls?.length) return;
    if (answer.slice(i + 1).some((later) => later.role === 'assistant' && typeof later.content === 'string' && later.content !== '')) return;
    for (const call of m.toolCalls) if (!toolMessageOf(messages, call.id)) under.push(call);
  });
  return under;
}

export function useUnfinished(): (call: { name: string }) => Unfinished {
  const turn = useContext(TurnStateContext);
  return (call) => {
    if (turn === 'answering' || answersInBrowser(call.name)) return 'running';
    return turn === 'asking' ? 'waiting' : 'stopped';
  };
}
