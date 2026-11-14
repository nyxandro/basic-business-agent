import type { AgentSummary, UploadedFile } from '@bba/contracts';
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import type { ApiRequestError } from '../api/client.ts';

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
  onUploadError: (error: unknown) => void;
  // The confirmation card of a waiting action, placed under the feed.
  interrupt: ReactElement | null;
  // The last failure of a run or an upload, shown above the input.
  error: ApiRequestError | null;
  // What the page adds to the input's toolbar (the chip of the conversation's project).
  composerExtra: ReactNode;
}

export const ChatExtrasContext = createContext<ChatExtras | null>(null);

export function useChatExtras(): ChatExtras {
  const value = useContext(ChatExtrasContext);
  if (!value) throw new Error('useChatExtras must be used inside ChatExtrasContext');
  return value;
}
