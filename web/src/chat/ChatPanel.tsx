// One conversation: CopilotChat bound to the agent and the thread, drawn by our ChatView, with our
// blocks, the confirmation card for AG-UI interrupts and readable errors.
import type { AgentSummary, FailedTurns, UploadedFile } from '@bba/contracts';
import { CopilotChat, useInterrupt } from '@copilotkit/react-core';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ApiRequestError, asApiError } from '../api/client.ts';
import { useGenuiRenderers } from './renderers.tsx';
import { copilotLabels } from '../i18n/copilot-labels.ts';
import { ApprovalCard, type ApprovalInterrupt } from './ApprovalCard.tsx';
import { chatFailureOf, type ChatFailure } from './chat-errors.ts';
import { ChatExtrasContext, type ChatExtras } from '../answer/chat-context.ts';
import { ChatView } from './ChatView.tsx';

const APPROVAL_REASON = 'mastra:tool_approval';

export function ChatPanel({
  agent,
  threadId,
  onRunFinished,
  onThreadTitled,
  composerExtra,
  composerNotice,
  draft = false,
}: {
  agent: AgentSummary;
  threadId: string;
  draft?: boolean;
  onRunFinished: () => void;
  onThreadTitled: () => void;
  composerExtra?: ReactNode;
  composerNotice?: ReactNode;
}) {
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [failure, setFailure] = useState<ChatFailure | null>(null);
  const [interruptedIds, setInterruptedIds] = useState<readonly string[]>([]);
  // The broken answers of an opened conversation, as the server tells: the last one as right after it broke.
  const onTurnsFailed = useCallback((value: FailedTurns) => {
    setInterruptedIds(value.interruptedMessageIds);
    const last = value.last;
    setFailure(last ? { error: new ApiRequestError({ code: last.code, message: last.message, status: 0 }), broken: true, verdict: { answerAgain: last.answerAgain, actionDone: last.actionDone } } : null);
  }, []);

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
      draft,
      attachments,
      addAttachment: (file) => setAttachments((prev) => [...prev, file]),
      removeAttachment: (path) => setAttachments((prev) => prev.filter((f) => f.path !== path)),
      clearAttachments: () => setAttachments([]),
      onSubmitted: () => setFailure(null),
      onRunFinished,
      onThreadTitled,
      onUploadError: (raw) => setFailure({ error: asApiError(raw), broken: false }),
      interrupt: interrupt ?? null,
      failure,
      onFailure: setFailure,
      interruptedIds,
      keepInterrupted: (ids) => setInterruptedIds((prev) => [...prev, ...ids]),
      onTurnsFailed,
      composerExtra,
      composerNotice,
    }),
    [agent, threadId, draft, attachments, onRunFinished, onThreadTitled, interrupt, failure, interruptedIds, onTurnsFailed, composerExtra, composerNotice],
  );

  return (
    <ChatExtrasContext value={extras}>
      <CopilotChat agentId={agent.id} threadId={threadId} labels={copilotLabels} chatView={ChatView} onError={(event) => setFailure(chatFailureOf(event.error))} />
    </ChatExtrasContext>
  );
}
