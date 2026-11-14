// An answer of the agent (mockup): one mark on the left for the whole turn — AG-UI splits a turn
// into several messages (a tool call, then the text) — and in it, in order, the lines of the tool
// calls (and the blocks they draw) and the text as Markdown; under the last text the toolbar of the
// mockup: «Копировать», and «Ответить заново» only under the last answer that broke (decision of the
// owner, 15.11; spec, section 9.1), which also says «Ответ прервался».
// CopilotKit draws each tool call with the renderer registered for it (genui/renderers.tsx).
import type { AssistantMessage as AgentMessage, Message } from '@copilotkit/react-core';
import { StreamingMarkdownDefaultRenderer, useRenderToolCall } from '@copilotkit/react-core';
import { ru } from '../i18n/ru.ts';
import { IconButton } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useToast } from '../ui/Toast.tsx';
import styles from './chat.module.css';
import { toolMessageOf } from './messages.ts';

export function AgentMark() {
  return (
    <span className={styles.avatar} aria-hidden="true">
      <Icon name="spark" size={16} />
    </span>
  );
}

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
  const parts = turn.filter((m) => textOfAgent(m) || (m.toolCalls?.length ?? 0) > 0);
  // A broken answer stays even when it showed nothing: its mark and «Ответить заново» are its row.
  if (parts.length === 0 && !interrupted) return null;
  const lastText = [...parts].reverse().map(textOfAgent).find(Boolean) ?? '';

  return (
    <div className={styles.assistant}>
      <AgentMark />
      <div className={styles.body}>
        {parts.map((m) => (
          <div key={m.id} className={styles.body}>
            {(m.toolCalls ?? []).map((call) => (
              <div key={call.id}>{renderToolCall({ toolCall: call, toolMessage: toolMessageOf(messages, call.id) })}</div>
            ))}
            {textOfAgent(m) ? <StreamingMarkdownDefaultRenderer content={textOfAgent(m)} isStreaming={streaming && m === turn.at(-1)} className={styles.markdown} /> : null}
          </div>
        ))}
        <TurnFooter text={lastText} streaming={streaming} interrupted={interrupted} {...(onAnswerAgain ? { onAnswerAgain } : {})} />
      </div>
    </div>
  );
}
