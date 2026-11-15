import type { AgentSummary, FailedTurns, UploadedFile } from '@bba/contracts';
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import type { ChatFailure } from './chat-errors.ts';

// What the chat window slot needs from the page: CopilotChat renders the slot itself, so the
// values travel through context instead of props.
export interface ChatExtras {
  agent: AgentSummary;
  agentId: string;
  threadId: string;
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
  // Answers that broke earlier in the conversation, by message id («Ответ прервался» under them).
  interruptedIds: readonly string[];
  keepInterrupted: (ids: readonly string[]) => void;
  // The broken answers of a conversation that was opened, as the server tells.
  onTurnsFailed: (value: FailedTurns) => void;
  // What the page adds to the input's toolbar (the chip of the conversation's project).
  composerExtra: ReactNode;
}

export const ChatExtrasContext = createContext<ChatExtras | null>(null);

export function useChatExtras(): ChatExtras {
  const value = useContext(ChatExtrasContext);
  if (!value) throw new Error('useChatExtras must be used inside ChatExtrasContext');
  return value;
}
