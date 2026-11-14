// The conversation window, put into CopilotChat's chat view slot: CopilotChat keeps the agent, the
// thread, sending and stopping; this draws everything the person sees (mockup «Чат с агентом»):
// the welcome, the feed, «Думает…», the confirmation card, the error and the input.
// It also keeps the draft in the browser and tells the page when a turn ends.
import type { AssistantMessage as AgentMessage, CopilotChatViewProps, Message } from '@copilotkit/react-core';
import { useAgent } from '@copilotkit/react-core';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { AgentMark, AssistantTurn } from './AssistantMessage.tsx';
import { useChatExtras } from './chat-context.ts';
import styles from './chat.module.css';
import { Composer } from './Composer.tsx';
import { readDraft, writeDraft } from './drafts.ts';
import { withAttachments } from '@bba/contracts';
import { UserMessage } from './UserMessage.tsx';
import { Welcome } from './Welcome.tsx';

// The feed sticks to the bottom while the person is within this distance of it.
const STICK_PX = 140;

// A new message instead of «Да»/«Нет» cancels the waiting action (spec, scenario 2): the server
// does it when a turn comes without an answer. The AG-UI client refuses such a turn while it holds
// the question, so the question is let go here; the server then marks the action cancelled.
function releaseWaitingQuestions(agent: { pendingInterrupts: unknown[] }): void {
  if (agent.pendingInterrupts.length > 0) agent.pendingInterrupts = [];
}

function Thinking() {
  return (
    <div className={styles.thinking} role="status" aria-label={ru.chat.thinking}>
      <AgentMark />
      <div className={styles.dots} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

// A turn of the agent is every assistant message between two messages of the person.
type Row = { kind: 'user'; message: Message } | { kind: 'agent'; key: string; turn: AgentMessage[] };

function rowsOf(messages: Message[]): Row[] {
  const rows: Row[] = [];
  for (const m of messages) {
    if (m.role === 'user') rows.push({ kind: 'user', message: m });
    if (m.role !== 'assistant') continue;
    const last = rows.at(-1);
    if (last?.kind === 'agent') last.turn.push(m);
    else rows.push({ kind: 'agent', key: m.id, turn: [m] });
  }
  return rows;
}

function Feed({ messages, running }: { messages: Message[]; running: boolean }) {
  const last = messages.at(-1);
  // Until the first words of the answer the agent shows it is working.
  const waiting = running && (last?.role === 'user' || last?.role === 'tool' || (last?.role === 'assistant' && !last.content && !(last).toolCalls?.length));
  const rows = rowsOf(messages);
  return (
    <>
      {rows.map((row, i) =>
        row.kind === 'user' ? (
          <UserMessage key={row.message.id} content={row.message.content} />
        ) : (
          <AssistantTurn key={row.key} turn={row.turn} messages={messages} streaming={running && i === rows.length - 1} />
        ),
      )}
      {waiting ? <Thinking /> : null}
    </>
  );
}

export function ChatView(props: CopilotChatViewProps) {
  const extras = useChatExtras();
  const { agent } = useAgent();
  const { inputValue = '', onInputChange, onSubmitMessage, onStop, isRunning = false, isConnecting = false } = props;
  const messages = props.messages ?? [];
  const restored = useRef(false);
  const wasRunning = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (restored.current || !onInputChange) return;
    restored.current = true;
    const draft = readDraft(extras.agentId, extras.threadId);
    if (draft && !inputValue) onInputChange(draft);
  }, [extras.agentId, extras.threadId, inputValue, onInputChange]);

  useEffect(() => {
    if (wasRunning.current && !isRunning) extras.onRunFinished();
    wasRunning.current = isRunning;
  }, [isRunning, extras]);

  const lastContent = messages.at(-1)?.content;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastContent, isRunning, extras.interrupt]);

  const change = (value: string) => {
    writeDraft(extras.agentId, extras.threadId, value);
    onInputChange?.(value);
  };
  const send = (value: string) => {
    if (!onSubmitMessage || !value.trim()) return;
    releaseWaitingQuestions(agent);
    const text = withAttachments(value.trim(), extras.attachments);
    writeDraft(extras.agentId, extras.threadId, '');
    extras.clearAttachments();
    extras.onSubmitted();
    stick.current = true;
    onSubmitMessage(text);
    onInputChange?.('');
  };

  const empty = messages.length === 0;
  return (
    <div className={styles.view}>
      <div
        ref={scroller}
        className={`${styles.scroll} scroll-thin`}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }}
      >
        <div className={styles.feed}>
          {empty && isConnecting ? (
            <div className={styles.connecting} role="status">
              <span className={styles.spin} />
              {ru.chat.connecting}
            </div>
          ) : null}
          {empty && !isConnecting ? <Welcome agent={extras.agent} onStart={send} /> : null}
          <Feed messages={messages} running={isRunning} />
          {extras.interrupt ? (
            <div className={styles.assistant}>
              <AgentMark />
              <div className={styles.body}>{extras.interrupt}</div>
            </div>
          ) : null}
        </div>
      </div>
      <div className={styles.dock}>
        <div className={styles.dockInner}>
          {extras.error ? <ErrorBanner error={extras.error} /> : null}
          <Composer value={inputValue} onChange={change} onSend={() => send(inputValue)} {...(onStop ? { onStop } : {})} running={isRunning} extra={extras.composerExtra} />
        </div>
      </div>
    </div>
  );
}
