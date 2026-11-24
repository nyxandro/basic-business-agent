import type { AgentSummary, FailedTurns, UploadedFile } from '@bba/contracts';
import type { useAgent } from '@copilotkit/react-core';
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import type { ChatFailure } from '../chat/chat-errors.ts';

// What the chat window slot needs from the page: CopilotChat renders the slot itself, so the
// values travel through context instead of props.
export interface ChatExtras {
  agent: AgentSummary;
  agentId: string;
  threadId: string;
  // The check of a prompt's draft in the admin panel: no complaint, no sample — its conversation is not an employee's.
  draft: boolean;
  attachments: UploadedFile[];
  addAttachment: (file: UploadedFile) => void;
  removeAttachment: (path: string) => void;
  clearAttachments: () => void;
  onSubmitted: () => void;
  onRunFinished: () => void;
  // The conversation got its name while the agent answered (spec, section 8.16).
  onThreadTitled: () => void;
  onUploadError: (error: unknown) => void;
  // The confirmation card of a waiting action, placed under the feed.
  interrupt: ReactElement | null;
  // The last failure of a run or an upload, shown above the input; a broken answer can be answered
  // again (spec, section 9.1).
  failure: ChatFailure | null;
  onFailure: (failure: ChatFailure) => void;
  // No connection to the server's runtime now (chat/runtime-recovery.ts): nothing can be sent until it is back.
  offline: boolean;
  // Answers that broke earlier in the conversation, by message id («Ответ прервался» under them).
  interruptedIds: readonly string[];
  keepInterrupted: (ids: readonly string[]) => void;
  // The broken answers of a conversation that was opened, as the server tells.
  onTurnsFailed: (value: FailedTurns) => void;
  // What the page adds to the input's toolbar (the chip of the conversation's project).
  composerExtra: ReactNode;
  // Above the input: why the conversation's project is gone (spec, section 8.20).
  composerNotice: ReactNode;
  // Stops the run of the agent, the browser's tools of its last call too: «Стоп» of a write onto the computer that waits
  // for «Да» once the model is done (spec, section 8.25) — CopilotChat offers no «Стоп» then.
  stopRun: (agent: ReturnType<typeof useAgent>['agent']) => void;
}

export const ChatExtrasContext = createContext<ChatExtras | null>(null);

export function useChatExtras(): ChatExtras {
  const value = useContext(ChatExtrasContext);
  if (!value) throw new Error('useChatExtras must be used inside ChatExtrasContext');
  return value;
}
