// One conversation: CopilotChat bound to the agent and the thread, drawn by our ChatView, with our
// blocks, the confirmation card for AG-UI interrupts and readable errors.
import type { AgentSummary, UploadedFile } from '@bba/contracts';
import { CopilotChat, useInterrupt } from '@copilotkit/react-core';
import { useMemo, useState, type ReactNode } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { useGenuiRenderers } from '../genui/renderers.tsx';
import { copilotLabels } from '../i18n/copilot-labels.ts';
import { ApprovalCard, type ApprovalInterrupt } from './ApprovalCard.tsx';
import { chatErrorOf } from './chat-errors.ts';
import { ChatExtrasContext, type ChatExtras } from './chat-context.ts';
import { ChatView } from './ChatView.tsx';

const APPROVAL_REASON = 'mastra:tool_approval';

export function ChatPanel({ agent, threadId, onRunFinished, composerExtra }: { agent: AgentSummary; threadId: string; onRunFinished: () => void; composerExtra?: ReactNode }) {
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [error, setError] = useState<ApiRequestError | null>(null);

  useGenuiRenderers(agent);
  const interrupt = useInterrupt({
    agentId: agent.id,
    renderInChat: false,
    enabled: (event) => (event.value as { reason?: string } | undefined)?.reason === APPROVAL_REASON,
    render: ({ interrupt: value, resolve, cancel }) => (
      <ApprovalCard interrupt={(value ?? {}) as ApprovalInterrupt} agent={agent} onYes={() => void resolve({ approved: true })} onNo={() => void cancel()} />
    ),
  });

  const extras = useMemo<ChatExtras>(
    () => ({
      agent,
      agentId: agent.id,
      threadId,
      attachments,
      addAttachment: (file) => setAttachments((prev) => [...prev, file]),
      removeAttachment: (path) => setAttachments((prev) => prev.filter((f) => f.path !== path)),
      clearAttachments: () => setAttachments([]),
      onSubmitted: () => setError(null),
      onRunFinished,
      onUploadError: (raw) => setError(asApiError(raw)),
      interrupt: interrupt ?? null,
      error,
      composerExtra,
    }),
    [agent, threadId, attachments, onRunFinished, interrupt, error, composerExtra],
  );

  return (
    <ChatExtrasContext value={extras}>
      <CopilotChat agentId={agent.id} threadId={threadId} labels={copilotLabels} chatView={ChatView} onError={(event) => setError(chatErrorOf(event.error))} />
    </ChatExtrasContext>
  );
}
