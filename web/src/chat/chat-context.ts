import type { UploadedFile } from '@bba/contracts';
import { createContext, useContext } from 'react';

// What the chat window slot needs from the page: CopilotChat renders the slot itself, so the
// values travel through context instead of props.
export interface ChatExtras {
  agentId: string;
  agentName: string;
  threadId: string;
  attachments: UploadedFile[];
  addAttachment: (file: UploadedFile) => void;
  removeAttachment: (path: string) => void;
  clearAttachments: () => void;
  onSubmitted: () => void;
  onRunFinished: () => void;
  onUploadError: (error: unknown) => void;
}

export const ChatExtrasContext = createContext<ChatExtras | null>(null);

export function useChatExtras(): ChatExtras {
  const value = useContext(ChatExtrasContext);
  if (!value) throw new Error('useChatExtras must be used inside ChatExtrasContext');
  return value;
}
