// An answer of the agent (mockup): one mark on the left for the whole turn — AG-UI splits a turn
// into several messages (the words, then the calls of the step) — and in it, in order, the words as
// Markdown, the blocks the agent draws and the status lines of its calls, those between two things it
// shows gathered into one stack (decision of the owner 15.11; turn-items.ts); under the last words the
// toolbar of the mockup: «Копировать», and «Ответить заново» only under the last answer that broke
// (decision of the owner, 15.11; spec, section 9.1), which also says «Ответ прервался». A light runs
// over the words being written and goes out when they are (AnswerText.tsx).
// CopilotKit draws each tool call with the renderer registered for it (genui/renderers.tsx). What the agent does now is
// in the live line under the answer (LiveLine.tsx); a call comes in here once it is done, and what comes in while the
// answer is written grows into its place instead of appearing at once (decision of the owner 21.11).
import type { AssistantMessage as AgentMessage, Message } from '@copilotkit/react-core';
import { useRenderToolCall } from '@copilotkit/react-core';
import { AnimatePresence, motion } from 'motion/react';
import { useState, type ReactNode } from 'react';
import { ru } from '../i18n/ru.ts';
import { IconButton } from '../ui/Button.tsx';
import { useToast } from '../ui/Toast.tsx';
import { ComplainDialog } from '../feedback/ComplainDialog.tsx';
import { AgentMark } from './AgentMark.tsx';
import { AnswerText } from './AnswerText.tsx';
import { TurnStateContext } from './call-progress.ts';
import { useChatExtras } from './chat-context.ts';
import styles from './chat.module.css';
import { toolMessageOf } from './messages.ts';
import { ToolStack } from './ToolStack.tsx';
import { ToolRow } from './ToolRow.tsx';
import { argumentsOf, showsByResult, turnItems, type ToolCall, type TurnItem } from './turn-items.ts';

const textOfAgent = (m: AgentMessage) => (typeof m.content === 'string' ? m.content : '');

// A line or a block that comes into the answer: from no height, faded, to its place; the gap above it (12 px of .body)
// grows with it. Clipped only while it moves: at rest a focus ring inside must not be cut off. What was in the answer
// when it was drawn first does not move (AnimatePresence, initial={false}).
const ITEM_GAP = 12;
const ITEM_HIDDEN = { height: 0, opacity: 0, marginTop: -ITEM_GAP, overflow: 'hidden' };
const ITEM_SHOWN = { height: 'auto', opacity: 1, marginTop: 0, transitionEnd: { overflow: 'visible' } };

// The live line (LiveLine.tsx) grows in and folds away the same way, a little blurred (decision of the owner 21.11: no
// blinking); clipped while it moves, going it does not lie over the card «Да» that comes under the answer.
const LIVE_HIDDEN = { ...ITEM_HIDDEN, filter: 'blur(4px)' };
const LIVE_SHOWN = { ...ITEM_SHOWN, filter: 'blur(0px)', transitionEnd: { overflow: 'visible', filter: 'none' } };

function Arrives({ children, blurred = false }: { children: ReactNode; blurred?: boolean }) {
  return (
    <motion.div className={styles.arrives} initial={blurred ? LIVE_HIDDEN : ITEM_HIDDEN} animate={blurred ? LIVE_SHOWN : ITEM_SHOWN} exit={blurred ? LIVE_HIDDEN : ITEM_HIDDEN}>
      {children}
    </motion.div>
  );
}

// Under an answer: the mark of a broken one and the toolbar. «Пожаловаться» (docs/specs/[20.11.2026]-feedback-and-value.md):
// under an answer that ended — not one being written, broken or waiting for «Да» — with the turn it is (`complaint`).
export function TurnFooter({ text, streaming, interrupted, onAnswerAgain, complaint }: { text: string; streaming: boolean; interrupted: boolean; onAnswerAgain?: () => void; complaint?: { threadId: string; turn: number } }) {
  const toast = useToast();
  const [complaining, setComplaining] = useState(false);
  if (streaming) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast(ru.chat.copied);
    } catch (error) {
      console.warn('copy failed', error);
    }
  }

  return (
    <>
      {interrupted ? <p className={styles.interrupted}>{ru.chat.answerInterrupted}</p> : null}
      {text || onAnswerAgain || complaint ? (
        <div className={styles.toolbar}>
          {text ? <IconButton icon="copy" label={ru.chat.copy} size="sm" onClick={() => void copy()} /> : null}
          {onAnswerAgain ? <IconButton icon="redo" label={ru.chat.answerAgain} size="sm" onClick={onAnswerAgain} /> : null}
          {complaint ? <IconButton icon="alert" label={ru.feedback.complaint.menu} size="sm" onClick={() => setComplaining(true)} /> : null}
        </div>
      ) : null}
      {complaint ? <ComplainDialog open={complaining} threadId={complaint.threadId} turn={complaint.turn} onClose={() => setComplaining(false)} /> : null}
    </>
  );
}

const NONE: ReadonlySet<string> = new Set();

export function AssistantTurn({
  turn,
  messages,
  streaming,
  underWay = NONE,
  asking = false,
  interrupted = false,
  live = null,
  onAnswerAgain,
  turnNumber = 0,
}: {
  turn: AgentMessage[];
  messages: readonly Message[];
  streaming: boolean;
  // The calls the answer works on now: they are in the live line, not here (callsUnderWay, call-progress.ts).
  underWay?: ReadonlySet<string>;
  // The answer ended with the question «Да» open under it.
  asking?: boolean;
  interrupted?: boolean;
  // The live line of the answer being written: under what it has shown, beside its mark from its first moment.
  live?: ReactNode;
  onAnswerAgain?: () => void;
  // The number of the person's message the answer is to (0 — the opening line of a task's conversation).
  turnNumber?: number;
}) {
  const renderToolCall = useRenderToolCall();
  const { agent, threadId, draft } = useChatExtras();
  const items = turnItems(turn, messages, underWay);
  // A broken answer stays even when it showed nothing: its mark and «Ответить заново» are its row; so does one being
  // written: its mark and its live line.
  if (items.length === 0 && !interrupted && !live) return null;
  const lastText = [...turn].reverse().map(textOfAgent).find(Boolean) ?? '';
  const draw = (call: ToolCall) => renderToolCall({ toolCall: call, toolMessage: toolMessageOf(messages, call.id) });
  // In a stack a widget or a file is its line: the screen or the file stands after the stack (turn-items.ts).
  const drawLine = (call: ToolCall) => {
    if (!showsByResult(call)) return draw(call);
    const result = toolMessageOf(messages, call.id)?.content;
    return <ToolRow name={call.function.name} status="complete" parameters={argumentsOf(call)} {...(typeof result === 'string' ? { result } : {})} agent={agent} />;
  };
  // Words are still being written only while nothing came after them: the calls of a step come on
  // the message of its words, and the next step is a message of its own.
  const writing = (item: TurnItem) => streaming && item === items.at(-1) && item.kind === 'text' && item.message === turn.at(-1);

  return (
    <div className={styles.assistant}>
      <AgentMark />
      <div className={styles.body}>
        <TurnStateContext value={streaming ? 'answering' : asking ? 'asking' : 'ended'}>
          <AnimatePresence initial={false}>
            {items.map((item) =>
              item.kind === 'text' ? (
                <AnswerText key={`text-${item.id}`} text={item.text} streaming={writing(item)} failed={interrupted} />
              ) : item.kind === 'call' ? (
                <Arrives key={item.call.id}>{draw(item.call)}</Arrives>
              ) : (
                <Arrives key={item.key}>
                  <ToolStack calls={item.calls} messages={messages} agent={agent} renderCall={drawLine} />
                </Arrives>
              ),
            )}
            {live ? (
              <Arrives key="live" blurred>
                {live}
              </Arrives>
            ) : null}
          </AnimatePresence>
        </TurnStateContext>
        <TurnFooter
          text={lastText}
          streaming={streaming}
          interrupted={interrupted}
          {...(onAnswerAgain ? { onAnswerAgain } : {})}
          {...(!draft && turnNumber > 0 && !interrupted && !asking && items.length > 0 ? { complaint: { threadId, turn: turnNumber } } : {})}
        />
      </div>
    </div>
  );
}
