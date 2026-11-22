// The conversation window, put into CopilotChat's chat view slot: CopilotChat keeps the agent, the
// thread, sending and stopping; this draws everything the person sees (mockup «Чат с агентом»):
// the welcome, the feed, the live line of the answer (LiveLine.tsx), the confirmation card, the error and the input. Files dragged
// onto the window are attached as from the paperclip (FileDrop.tsx).
// It also keeps the draft in the browser, tells the page when a turn ends and handles answers that
// broke (spec, section 9.1): dropped words go off the screen, «Ответить заново» sends the question again.
import type { AssistantMessage as AgentMessage, CopilotChatViewProps, Message } from '@copilotkit/react-core';
import { useAgent } from '@copilotkit/react-core';
import { MotionConfig, useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiRequestError, asApiError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { EASING, MOVE_S } from '../ui/motion.ts';
import { answerAgain, failureSubscriber, lastTurnIds, liveVerdict } from './answer-failures.ts';
import { useAttachQueue } from './attach.ts';
import { AgentMark } from './AgentMark.tsx';
import { AssistantTurn } from './AssistantMessage.tsx';
import { answersInBrowser, callsUnderWay } from './call-progress.ts';
import { useChatExtras } from './chat-context.ts';
import styles from './chat.module.css';
import { Composer } from './Composer.tsx';
import { readDraft, writeDraft } from './drafts.ts';
import { useFileDrop } from './FileDrop.tsx';
import { LiveLine } from './LiveLine.tsx';
import { withAttachments, type AgentSummary } from '@bba/contracts';
import { UserMessage } from './UserMessage.tsx';
import { titleSubscriber } from './title-events.ts';
import { createWebProgressStore, WebProgressContext, webProgressSubscriber } from './web-progress.ts';
import { ChatSendContext } from './chat-send.ts';
import { Welcome } from './Welcome.tsx';

// The feed sticks to the bottom while the person is within this distance of it.
const STICK_PX = 140;

// A new message instead of «Да»/«Нет» cancels the waiting action (spec, scenario 2): the server
// does it when a turn comes without an answer. The AG-UI client refuses such a turn while it holds
// the question, so the question is let go here; the server then marks the action cancelled.
function releaseWaitingQuestions(agent: { pendingInterrupts: unknown[] }): void {
  if (agent.pendingInterrupts.length > 0) agent.pendingInterrupts = [];
}

// A turn of the agent is every assistant message between two messages of the person. Its row is named by the message
// of the person it answers: the row of an answer that has shown nothing yet (its mark and «Работаю», decision of the
// owner 21.11) is the same row once its first words or actions come — the mark stays where it is.
type Row = { kind: 'user'; message: Message } | { kind: 'agent'; key: string; turn: AgentMessage[] };

const answerKey = (rows: readonly Row[]): string => {
  const asked = rows.findLast((r) => r.kind === 'user');
  return `answer-${asked?.kind === 'user' ? asked.message.id : 'start'}`;
};

function rowsOf(messages: Message[]): Row[] {
  const rows: Row[] = [];
  for (const m of messages) {
    if (m.role === 'user') rows.push({ kind: 'user', message: m });
    if (m.role !== 'assistant') continue;
    const last = rows.at(-1);
    if (last?.kind === 'agent') last.turn.push(m);
    else rows.push({ kind: 'agent', key: answerKey(rows), turn: [m] });
  }
  return rows;
}

interface FeedFailures {
  // Earlier answers that broke, by message id.
  interrupted: ReadonlySet<string>;
  // The last answer broke: it is marked «Ответ прервался».
  lastBroken: boolean;
  // …and offers «Ответить заново» when a repeat helps and no action ran in it.
  onAnswerAgain?: (() => void) | undefined;
}

// What the feed draws or waits on. The model's reasoning (`reasoning`) and the layers of the
// environment (`activity`) come as messages of their own and are not drawn.
const FEED_ROLES: ReadonlySet<Message['role']> = new Set(['user', 'assistant', 'tool']);

// `asking` — the question «Да» is open under the last answer.
function Feed({ messages, running, asking, failures, agent }: { messages: Message[]; running: boolean; asking: boolean; failures: FeedFailures; agent: Pick<AgentSummary, 'systems' | 'actions'> }) {
  // What the agent does now is said in one place, the live line (decision of the owner 21.11): the call under way, else
  // «Работаю» until the next thing to see — also while the model reasons, whose reasoning would otherwise be the last
  // message and take «Работаю» away (decision of the owner 15.11). Its words being written say it themselves.
  const underWay = callsUnderWay(messages).filter((call) => running || answersInBrowser(call.function.name));
  const last = messages.findLast((m) => FEED_ROLES.has(m.role));
  const waiting = running && (last?.role === 'user' || last?.role === 'tool' || (last?.role === 'assistant' && !last.content && !(last).toolCalls?.length));
  const liveCall = underWay.at(-1) ?? null;
  // Only the last answer has calls under way: they come after the person's last message.
  const underWayIds = new Set(underWay.map((c) => c.id));
  const lastBroken = failures.lastBroken && !running;
  const live = liveCall || waiting ? <LiveLine call={liveCall} agent={agent} /> : null;
  const rows = rowsOf(messages);
  // The answer has shown nothing yet: its row is its mark and the live line; broken before its first words — the mark,
  // «Ответ прервался» and «Ответить заново».
  if (rows.at(-1)?.kind !== 'agent' && (live || lastBroken)) rows.push({ kind: 'agent', key: answerKey(rows), turn: [] });
  return (
    <>
      {rows.map((row, i) => {
        if (row.kind === 'user') return <UserMessage key={row.message.id} content={row.message.content} />;
        // The answer's turn: the number of the person's messages up to it — the same live and after a reload.
        const turnNumber = rows.slice(0, i).filter((r) => r.kind === 'user').length;
        const isLast = i === rows.length - 1;
        const broken = (isLast && lastBroken) || row.turn.some((m) => failures.interrupted.has(m.id));
        return (
          <AssistantTurn
            key={row.key}
            turn={row.turn}
            messages={messages}
            streaming={running && isLast}
            underWay={underWayIds}
            asking={!running && isLast && asking}
            interrupted={broken}
            live={isLast ? live : null}
            {...(isLast && lastBroken && failures.onAnswerAgain ? { onAnswerAgain: failures.onAnswerAgain } : {})}
            turnNumber={turnNumber}
          />
        );
      })}
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
  const feed = useRef<HTMLDivElement>(null);
  // «Уменьшить движение» in the system: the lines of the answer come and go at once (Motion alone keeps their height
  // and fading moving).
  const still = useReducedMotion() === true;
  const stick = useRef(true);
  // The feed glides to its bottom now (the person's own message): what grows meanwhile does not cut the glide short.
  const gliding = useRef(false);
  const uploads = useAttachQueue();
  const drop = useFileDrop(uploads.attach);

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

  // Before the conversation is connected: its broken answers come in the events of the connection.
  const { onTurnsFailed } = extras;
  useEffect(() => {
    const subscription = agent.subscribe(failureSubscriber(onTurnsFailed));
    return () => subscription.unsubscribe();
  }, [agent, onTurnsFailed]);

  // The steps of searches of the internet, for their live blocks (spec, section 8.30).
  const [webProgress] = useState(createWebProgressStore);
  useEffect(() => {
    const subscription = agent.subscribe(webProgressSubscriber(webProgress));
    return () => subscription.unsubscribe();
  }, [agent, webProgress]);

  // The conversation got its name while the agent answers (spec, section 8.16).
  const { threadId, onThreadTitled } = extras;
  useEffect(() => {
    const subscription = agent.subscribe(titleSubscriber(threadId, onThreadTitled));
    return () => subscription.unsubscribe();
  }, [agent, threadId, onThreadTitled]);

  const lastContent = messages.at(-1)?.content;
  const lastRole = messages.at(-1)?.role;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    // The person's own message glides into view; the words of an answer keep the bottom at once.
    const glide = lastRole === 'user' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    gliding.current = glide;
    el.scrollTo({ top: el.scrollHeight, behavior: glide ? 'smooth' : 'auto' });
  }, [messages.length, lastContent, lastRole, isRunning, extras.interrupt]);

  // The feed also grows between messages — the live line and the lines of the answer grow into their places (decision
  // of the owner 21.11), a widget draws itself: the bottom stays in sight as they grow, gliding if the feed glides.
  useLayoutEffect(() => {
    const el = scroller.current;
    const content = feed.current;
    if (!el || !content) return;
    const keep = new ResizeObserver(() => {
      if (!stick.current || el.scrollHeight - el.scrollTop - el.clientHeight < 1) return;
      el.scrollTo({ top: el.scrollHeight, behavior: gliding.current ? 'smooth' : 'auto' });
    });
    keep.observe(content);
    return () => keep.disconnect();
  }, []);

  const change = (value: string) => {
    writeDraft(extras.agentId, extras.threadId, value);
    onInputChange?.(value);
  };
  const submit = (text: string) => {
    if (!onSubmitMessage) return;
    releaseWaitingQuestions(agent);
    extras.onSubmitted();
    stick.current = true;
    onSubmitMessage(text);
  };
  const send = (value: string) => {
    if (!onSubmitMessage || !value.trim()) return;
    // Moving on from a broken answer keeps its mark; «Ответить заново» is only for the last one.
    if (extras.failure?.broken) extras.keepInterrupted(lastTurnIds(messages));
    writeDraft(extras.agentId, extras.threadId, '');
    extras.clearAttachments();
    submit(withAttachments(value.trim(), extras.attachments));
    onInputChange?.('');
  };
  // A message from outside the input — the marks of the viewer (chat-send.ts): the input, its draft and attachments
  // stay as they are; nothing goes while the agent answers. The viewer calls it after the picture of the marks went
  // up — seconds after the press: it reads the chat as it is then, not as it was at the press.
  const sendText = (text: string): boolean => {
    if (!onSubmitMessage || isRunning) return false;
    if (extras.failure?.broken) extras.keepInterrupted(lastTurnIds(messages));
    submit(text);
    return true;
  };
  const latestSend = useRef(sendText);
  useLayoutEffect(() => {
    latestSend.current = sendText;
  });
  const chatSend = useMemo(() => ({ send: (text: string) => latestSend.current(text), running: isRunning }), [isRunning]);
  // While «Ответить заново» waits for the server the button is gone: a second click cannot take out
  // another turn (the server takes out only the question the person sees anyway).
  const [answeringAgain, setAnsweringAgain] = useState(false);
  const failure = extras.failure;
  const verdict = failure?.broken ? (failure.verdict ?? liveVerdict(failure.error.code, messages, extras.agent.actions)) : null;
  const failures: FeedFailures = {
    interrupted: new Set(extras.interruptedIds),
    lastBroken: failure?.broken === true,
    onAnswerAgain:
      verdict?.answerAgain && !answeringAgain
        ? () => {
            setAnsweringAgain(true);
            answerAgain(extras.threadId, agent, submit)
              .catch((raw: unknown) => extras.onFailure({ error: asApiError(raw), broken: false }))
              .finally(() => setAnsweringAgain(false));
          }
        : undefined,
  };
  // An action already ran in the broken answer: what to do instead of answering it again.
  const bannerError =
    failure && verdict?.actionDone ? new ApiRequestError({ code: failure.error.code, message: failure.error.message, status: failure.error.status, nextStep: ru.chat.actionDoneHint }) : failure?.error;

  const empty = messages.length === 0;
  return (
    <WebProgressContext value={webProgress}>
      <ChatSendContext value={chatSend}>
        <div className={styles.view} data-chat-window onDragEnter={drop.onDragEnter}>
          <div
            ref={scroller}
            className={`${styles.scroll} scroll-thin`}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
            }}
          >
            <div ref={feed} className={styles.feed}>
              {/* Nothing while it connects, the line after a second (spec, section 8.22). */}
              {empty && isConnecting ? <DelayedBar /> : null}
              {empty && !isConnecting ? <Welcome agent={extras.agent} onStart={send} /> : null}
              <MotionConfig reducedMotion="user" transition={{ duration: still ? 0 : MOVE_S, ease: EASING }}>
                <Feed messages={messages} running={isRunning} asking={extras.interrupt !== null} failures={failures} agent={extras.agent} />
              </MotionConfig>
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
              {bannerError ? <ErrorBanner error={bannerError} /> : null}
              {extras.composerNotice}
              <Composer
                value={inputValue}
                onChange={change}
                onSend={() => send(inputValue)}
                {...(onStop ? { onStop } : {})}
                running={isRunning}
                extra={extras.composerExtra}
                uploading={uploads.waiting}
                progress={uploads.progress}
                onAttach={uploads.attach}
              />
            </div>
          </div>
          {drop.overlay}
        </div>
      </ChatSendContext>
    </WebProgressContext>
  );
}
