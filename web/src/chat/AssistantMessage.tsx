// An answer of the agent (mockup): one mark on the left for the whole turn — AG-UI splits a turn
// into several messages (the words, then the calls of the step) — and in it, in order, the words as
// Markdown, the blocks the agent draws and the status lines of its calls, those between two things it
// shows gathered into one stack (decision of the owner 15.11; turn-items.ts); under the last words the
// toolbar of the mockup: «Копировать», and «Ответить заново» only under the last answer that broke
// (decision of the owner, 15.11; spec, section 9.1), which also says «Ответ прервался».
// CopilotKit draws each tool call with the renderer registered for it (genui/renderers.tsx).
import type { AssistantMessage as AgentMessage, Message } from '@copilotkit/react-core';
import { StreamingMarkdownDefaultRenderer, useRenderToolCall } from '@copilotkit/react-core';
import { ru } from '../i18n/ru.ts';
import { IconButton } from '../ui/Button.tsx';
import { useToast } from '../ui/Toast.tsx';
import { AgentMark } from './AgentMark.tsx';
import { useChatExtras } from './chat-context.ts';
import styles from './chat.module.css';
import { toolMessageOf } from './messages.ts';
import { ToolStack } from './ToolStack.tsx';
import { turnItems, type ToolCall } from './turn-items.ts';

const textOfAgent = (m: AgentMessage) => (typeof m.content === 'string' ? m.content : '');

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

export function AssistantTurn({
  turn,
  messages,
  streaming,
  interrupted = false,
  onAnswerAgain,
}: {
  turn: AgentMessage[];
  messages: readonly Message[];
  streaming: boolean;
  interrupted?: boolean;
  onAnswerAgain?: () => void;
}) {
  const renderToolCall = useRenderToolCall();
  const { agent } = useChatExtras();
  const items = turnItems(turn, messages);
  // A broken answer stays even when it showed nothing: its mark and «Ответить заново» are its row.
  if (items.length === 0 && !interrupted) return null;
  const lastText = [...turn].reverse().map(textOfAgent).find(Boolean) ?? '';
  const draw = (call: ToolCall) => renderToolCall({ toolCall: call, toolMessage: toolMessageOf(messages, call.id) });

  return (
    <div className={styles.assistant}>
      <AgentMark />
      <div className={styles.body}>
        {items.map((item) =>
          item.kind === 'text' ? (
            <StreamingMarkdownDefaultRenderer key={`text-${item.id}`} content={item.text} isStreaming={streaming && item.message === turn.at(-1)} className={styles.markdown} />
          ) : item.kind === 'call' ? (
            <div key={item.call.id}>{draw(item.call)}</div>
          ) : (
            <ToolStack key={item.calls[0]!.id} calls={item.calls} messages={messages} agent={agent} renderCall={draw} />
          ),
        )}
        <TurnFooter text={lastText} streaming={streaming} interrupted={interrupted} {...(onAnswerAgain ? { onAnswerAgain } : {})} />
      </div>
    </div>
  );
}
