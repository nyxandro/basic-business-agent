// CopilotChat's view slot: the same window, plus the draft kept in the browser, the attachments
// added to the message and a signal when a turn ends (the conversation list refreshes then).
import type { UploadedFile } from '@bba/contracts';
import { CopilotChatView, useAgent, type CopilotChatViewProps } from '@copilotkit/react-core';
import { useEffect, useRef } from 'react';
import { ru } from '../i18n/ru.ts';
import { AttachmentBar } from './AttachmentBar.tsx';
import { useChatExtras } from './chat-context.ts';
import { readDraft, writeDraft } from './drafts.ts';

// A new message instead of «Да»/«Нет» cancels the waiting action (spec, scenario 2): the server
// does it when a turn comes without an answer. The AG-UI client refuses such a turn while it holds
// the question, so the question is let go here; the server then marks the action cancelled.
function releaseWaitingQuestions(agent: { pendingInterrupts: unknown[] }): void {
  if (agent.pendingInterrupts.length > 0) agent.pendingInterrupts = [];
}

export function withAttachments(text: string, files: UploadedFile[]): string {
  if (files.length === 0) return text;
  return [text, '', `${ru.chat.attachmentsTitle}:`, ...files.map((f) => ru.chat.attachmentLine(f.name, f.path))].join('\n');
}

export function ChatViewSlot(props: CopilotChatViewProps) {
  const extras = useChatExtras();
  const { agent } = useAgent();
  const { inputValue, onInputChange, onSubmitMessage, isRunning } = props;
  const restored = useRef(false);
  const wasRunning = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (restored.current || !onInputChange) return;
    restored.current = true;
    const draft = readDraft(extras.agentId, extras.threadId);
    if (draft && !inputValue) onInputChange(draft);
  }, [extras.agentId, extras.threadId, inputValue, onInputChange]);

  useEffect(() => {
    if (wasRunning.current && !isRunning) extras.onRunFinished();
    wasRunning.current = Boolean(isRunning);
  }, [isRunning, extras]);

  const change = (value: string) => {
    writeDraft(extras.agentId, extras.threadId, value);
    onInputChange?.(value);
  };
  const submit = (value: string) => {
    releaseWaitingQuestions(agent);
    const text = withAttachments(value, extras.attachments);
    writeDraft(extras.agentId, extras.threadId, '');
    extras.clearAttachments();
    extras.onSubmitted();
    onSubmitMessage?.(text);
  };

  const empty = (props.messages ?? []).length === 0 && !props.isConnecting;
  return (
    <div className="chat-view">
      {empty ? <p className="chat-welcome">{ru.chat.welcome(extras.agentName)}</p> : null}
      <CopilotChatView {...props} onInputChange={change} onSubmitMessage={onSubmitMessage ? submit : undefined} onAddFile={() => fileInput.current?.click()} />
      <AttachmentBar inputRef={fileInput} />
    </div>
  );
}
