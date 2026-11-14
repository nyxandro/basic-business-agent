// One conversation: CopilotChat bound to the agent and the thread, with our blocks, the
// confirmation card for AG-UI interrupts, the agent's starter questions and readable errors.
import type { AgentSummary, UploadedFile } from '@bba/contracts';
import { CopilotChat, useConfigureSuggestions, useInterrupt } from '@copilotkit/react-core';
import { useMemo, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { useGenuiRenderers } from '../genui/renderers.tsx';
import { copilotLabels } from '../i18n/copilot-labels.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { ApprovalCard, type ApprovalInterrupt } from './ApprovalCard.tsx';
import { chatErrorOf } from './chat-errors.ts';
import { ChatExtrasContext, type ChatExtras } from './chat-context.ts';
import { ChatViewSlot } from './ChatViewSlot.tsx';

const APPROVAL_REASON = 'mastra:tool_approval';

export function ChatPanel({ agent, threadId, onRunFinished }: { agent: AgentSummary; threadId: string; onRunFinished: () => void }) {
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [error, setError] = useState<ApiRequestError | null>(null);

  useGenuiRenderers(agent.systems);
  useConfigureSuggestions({ suggestions: agent.starters.map((s) => ({ title: s, message: s })), available: 'before-first-message', consumerAgentId: agent.id }, [agent]);
  useInterrupt({
    agentId: agent.id,
    enabled: (event) => (event.value as { reason?: string } | undefined)?.reason === APPROVAL_REASON,
    render: ({ interrupt, resolve, cancel }) => (
      <ApprovalCard interrupt={(interrupt ?? {}) as ApprovalInterrupt} systems={agent.systems} onYes={() => void resolve({ approved: true })} onNo={() => void cancel()} />
    ),
  });

  const extras = useMemo<ChatExtras>(
    () => ({
      agentId: agent.id,
      agentName: agent.name,
      threadId,
      attachments,
      addAttachment: (file) => setAttachments((prev) => [...prev, file]),
      removeAttachment: (path) => setAttachments((prev) => prev.filter((f) => f.path !== path)),
      clearAttachments: () => setAttachments([]),
      onSubmitted: () => setError(null),
      onRunFinished,
      onUploadError: (raw) => setError(asApiError(raw)),
    }),
    [agent, threadId, attachments, onRunFinished],
  );

  return (
    <ChatExtrasContext value={extras}>
      <div className="chat-panel">
        {error ? <ErrorBanner error={error} /> : null}
        <CopilotChat agentId={agent.id} threadId={threadId} labels={copilotLabels} chatView={ChatViewSlot} onError={(event) => setError(chatErrorOf(event.error))} />
      </div>
    </ChatExtrasContext>
  );
}
