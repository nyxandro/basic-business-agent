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
import { cx, IconButton } from '../ui/Button.tsx';
import { useToast } from '../ui/Toast.tsx';
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

// An answer that begins with a done action, not with words, grows into its place the same way, the gap of the feed above
// it (22 px) with it: the live line under it goes down gliding. Words come into a row that rises (chat.module.css).
const FEED_GAP = 22;
const ROW_HIDDEN = { height: 0, opacity: 0, marginTop: -FEED_GAP, overflow: 'hidden' };
const ROW_SHOWN = { height: 'auto', opacity: 1, marginTop: 0, transitionEnd: { overflow: 'visible' } };

function Arrives({ children }: { children: ReactNode }) {
  return (
    <motion.div className={styles.arrives} initial={ITEM_HIDDEN} animate={ITEM_SHOWN} exit={ITEM_HIDDEN}>
      {children}
    </motion.div>
  );
}

// Under an answer: the mark of a broken one and the toolbar.
export function TurnFooter({ text, streaming, interrupted, onAnswerAgain }: { text: string; streaming: boolean; interrupted: boolean; onAnswerAgain?: () => void }) {
  const toast = useToast();
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
      {text || onAnswerAgain ? (
        <div className={styles.toolbar}>
          {text ? <IconButton icon="copy" label={ru.chat.copy} size="sm" onClick={() => void copy()} /> : null}
          {onAnswerAgain ? <IconButton icon="redo" label={ru.chat.answerAgain} size="sm" onClick={onAnswerAgain} /> : null}
        </div>
      ) : null}
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
  onAnswerAgain,
}: {
  turn: AgentMessage[];
  messages: readonly Message[];
  streaming: boolean;
  // The calls the answer works on now: they are in the live line, not here (callsUnderWay, call-progress.ts).
  underWay?: ReadonlySet<string>;
  // The answer ended with the question «Да» open under it.
  asking?: boolean;
  interrupted?: boolean;
  onAnswerAgain?: () => void;
}) {
  const renderToolCall = useRenderToolCall();
  const { agent } = useChatExtras();
  const items = turnItems(turn, messages, underWay);
  // How the row came in, settled when it first shows something (it draws nothing while its first action is under way).
  const [arrival, setArrival] = useState<'grows' | 'rises' | null>(null);
  const first = items[0];
  const came = arrival ?? (first ? (streaming && first.kind !== 'text' ? 'grows' : 'rises') : null);
  if (arrival === null && came !== null) setArrival(came);
  // A broken answer stays even when it showed nothing: its mark and «Ответить заново» are its row.
  if (items.length === 0 && !interrupted) return null;
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

  const content = (
    <>
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
          </AnimatePresence>
        </TurnStateContext>
        <TurnFooter text={lastText} streaming={streaming} interrupted={interrupted} {...(onAnswerAgain ? { onAnswerAgain } : {})} />
      </div>
    </>
  );
  return came === 'grows' ? (
    <motion.div className={cx(styles.assistant, styles.assistantGrows)} data-answer-row initial={ROW_HIDDEN} animate={ROW_SHOWN}>
      {content}
    </motion.div>
  ) : (
    <div className={styles.assistant} data-answer-row>
      {content}
    </div>
  );
}
