// An answer of the agent (mockup): one mark on the left for the whole turn — AG-UI splits a turn
// into several messages (a tool call, then the text) — and in it, in order, the lines of the tool
// calls (and the blocks they draw) and the text as Markdown; «Копировать» under the last text.
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

export function AssistantTurn({ turn, messages, streaming }: { turn: AgentMessage[]; messages: readonly Message[]; streaming: boolean }) {
  const renderToolCall = useRenderToolCall();
  const toast = useToast();
  const parts = turn.filter((m) => textOfAgent(m) || (m.toolCalls?.length ?? 0) > 0);
  if (parts.length === 0) return null;
  const lastText = [...parts].reverse().map(textOfAgent).find(Boolean) ?? '';

  async function copy() {
    try {
      await navigator.clipboard.writeText(lastText);
      toast(ru.chat.copied);
    } catch (error) {
      console.warn('copy failed', error);
    }
  }

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
        {lastText && !streaming ? (
          <div className={styles.toolbar}>
            <IconButton icon="copy" label={ru.chat.copy} size="sm" onClick={() => void copy()} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
