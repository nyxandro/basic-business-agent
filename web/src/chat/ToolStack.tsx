// A stack of status lines between two things the agent shows (decision of the owner 15.11): one line
// that says what the last call does or did, turning while it runs. Each new status turns in like the
// wheel of the iPhone date picker (ui/Ticker.tsx): the old one goes up past the top edge of the line,
// the new one comes from under its bottom edge; so does the number of calls. A stack of one is the
// line of its call — «только чтение», «N найдено», unfolds what was asked and found; a stack of more
// shows how many there are and unfolds into every line, each of which unfolds on its own.
import type { AgentSummary } from '@bba/contracts';
import type { Message as AguiMessage } from '@copilotkit/react-core';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Collapse } from '../ui/Collapse.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Ticker } from '../ui/Ticker.tsx';
import { useUnfinished } from './call-progress.ts';
import styles from './chat.module.css';
import { toolMessageOf } from './messages.ts';
import { ToolDetails } from './ToolRow.tsx';
import { toolSummary, type ToolSummary } from './tool-summary.ts';
import type { ToolCall } from './turn-items.ts';

// The arguments of a call come as JSON text, still unfinished while the model writes them.
function argumentsOf(call: ToolCall): unknown {
  try {
    return JSON.parse(call.function.arguments);
  } catch {
    return null;
  }
}

function StatusIcon({ summary }: { summary: ToolSummary }) {
  if (summary.state === 'running') return <span className={styles.spin} />;
  const icon = summary.state === 'done' ? 'check' : summary.state === 'failed' ? 'alert' : summary.state === 'waiting' ? 'clock' : 'x';
  return <Icon name={icon} size={15} />;
}

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
  const unfinished = useUnfinished();
  const last = calls.at(-1);
  if (!last) throw new Error('a stack of tool lines needs at least one call');
  const result = toolMessageOf(messages, last.id)?.content;
  const args = argumentsOf(last);
  // A call without its result is under way, waits for «Да» or was stopped (call-progress.ts).
  const state = unfinished({ name: last.function.name });
  const status = typeof result === 'string' ? 'complete' : state === 'running' ? 'executing' : state;
  const summary = toolSummary(last.function.name, status, typeof result === 'string' ? result : undefined, agent, args);
  const single = calls.length === 1;
  // One call unfolds once it is done; several unfold any time.
  const unfolds = !single || summary.state === 'done';

  return (
    <div className={styles.tool}>
      <button
        type="button"
        className={cx(styles.toolLine, styles.toolHead, summary.state === 'failed' && styles.toolFailed, !unfolds && styles.toolLineStatic)}
        disabled={!unfolds}
        aria-expanded={unfolds ? open : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Ticker value={`${last.id}:${summary.state}:${summary.text}`}>
          <StatusIcon summary={summary} />
          <span className={cx(styles.toolText, summary.state === 'running' && styles.shimmer)}>{summary.text}</span>
          {single && summary.state === 'done' && summary.readOnly ? <span className={styles.toolTag}>{ru.chat.readOnly}</span> : null}
          {single && summary.state === 'done' && summary.count !== null ? <span className={styles.toolCount}>{ru.chat.found(summary.count)}</span> : null}
        </Ticker>
        {single ? null : (
          <Ticker value={String(calls.length)}>
            <span className={styles.toolCount}>{ru.chat.toolActions(calls.length)}</span>
          </Ticker>
        )}
        {unfolds ? <Icon name="down" size={15} className={cx(styles.toolChevron, open && styles.toolChevronOpen)} /> : null}
      </button>
      {single && summary.state === 'failed' && summary.code === 'APP_CONNECTOR_NOT_CONNECTED' ? <Link to="/settings/connections">{ru.chat.connectInSettings}</Link> : null}
      {single ? (
        <Collapse open={open && summary.state === 'done'} className={styles.toolUnfold}>
          {summary.state === 'done' ? <ToolDetails args={args} value={summary.value} /> : null}
        </Collapse>
      ) : (
        <Collapse open={open} className={styles.toolUnfold}>
          <div className={styles.toolStack}>
            {calls.map((call) => (
              <div key={call.id}>{renderCall(call)}</div>
            ))}
          </div>
        </Collapse>
      )}
    </div>
  );
}
