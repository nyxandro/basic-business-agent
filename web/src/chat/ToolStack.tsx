// A stack of status lines between two things the agent shows (decision of the owner 15.11): one line
// that says what the last call does or did, turning while it runs, with how many there are; it
// unfolds into every line, each of which unfolds on its own.
import type { AgentSummary } from '@bba/contracts';
import type { Message as AguiMessage } from '@copilotkit/react-core';
import { useState, type ReactNode } from 'react';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import styles from './chat.module.css';
import { toolMessageOf } from './messages.ts';
import { toolSummary } from './tool-summary.ts';
import type { ToolCall } from './turn-items.ts';

export function ToolStack({
  calls,
  messages,
  agent,
  renderCall,
}: {
  calls: ToolCall[];
  messages: readonly AguiMessage[];
  agent: Pick<AgentSummary, 'systems' | 'actions'>;
  renderCall: (call: ToolCall) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const last = calls.at(-1);
  if (!last) throw new Error('a stack of tool lines needs at least one call');
  const result = toolMessageOf(messages, last.id)?.content;
  // A call without its result yet is still under way (or waits for «Да»).
  const summary = toolSummary(last.function.name, typeof result === 'string' ? 'complete' : 'executing', typeof result === 'string' ? result : undefined, agent);

  return (
    <div className={styles.tool}>
      <button type="button" className={cx(styles.toolLine, summary.state === 'failed' && styles.toolFailed)} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {summary.state === 'running' ? <span className={styles.spin} /> : <Icon name={summary.state === 'done' ? 'check' : summary.state === 'failed' ? 'alert' : 'x'} size={15} />}
        <span className={cx(styles.toolText, summary.state === 'running' && styles.shimmer)}>{summary.text}</span>
        <span className={styles.toolCount}>{ru.chat.toolActions(calls.length)}</span>
        <Icon name={open ? 'up' : 'down'} size={15} />
      </button>
      {open ? (
        <div className={styles.toolStack}>
          {calls.map((call) => (
            <div key={call.id}>{renderCall(call)}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
