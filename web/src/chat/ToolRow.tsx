// The line of a tool call (spec, section 7; mockup): «Ищу в «Битрикс24»…» while it runs; then
// «✓ Битрикс24 · поиск сделок [только чтение] 12 найдено ⌄» that unfolds what was asked and found;
// a refusal or a failure in plain words. A table from the result is drawn as is. What the line says
// comes from tool-summary.ts.
import { toolTableResultSchema, type AgentSummary } from '@bba/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { TableBlockView } from '../genui/TableBlock.tsx';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Collapse } from '../ui/Collapse.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useUnfinished } from '../answer/call-progress.ts';
import styles from './chat.module.css';
import { toolSummary, type ToolStatus } from './tool-summary.ts';

export interface ToolRowProps {
  name: string;
  status: ToolStatus;
  parameters?: unknown;
  result?: string;
  agent: Pick<AgentSummary, 'systems' | 'actions'>;
}

// What a call was asked and what it found; drawn only while unfolded, a result can be large.
export function ToolDetails({ args, value }: { args: unknown; value: unknown }) {
  return <pre className={styles.toolDetails}>{JSON.stringify({ args, result: value }, null, 2)}</pre>;
}

export function ToolRow({ name, status, parameters, result, agent }: ToolRowProps) {
  const [open, setOpen] = useState(false);
  const unfinished = useUnfinished()({ name });
  // A call without its result that is not under way waits for «Да» or was stopped (call-progress.ts).
  const shown = status === 'complete' || status === 'executing' || unfinished === 'running' ? status : unfinished;
  const summary = toolSummary(name, shown, result, agent, parameters);

  if (summary.state === 'running') {
    return (
      <div className={styles.tool}>
        <div className={cx(styles.toolLine, styles.toolLineStatic)} role="status">
          <span className={styles.spin} />
          <span className={cx(styles.toolText, styles.shimmer)}>{summary.text}</span>
        </div>
      </div>
    );
  }
  if (summary.state === 'declined' || summary.state === 'waiting') {
    return (
      <div className={styles.tool}>
        <div className={cx(styles.toolLine, styles.toolLineStatic)}>
          <Icon name={summary.state === 'waiting' ? 'clock' : 'x'} size={15} />
          <span className={styles.toolText}>{summary.text}</span>
        </div>
      </div>
    );
  }
  if (summary.state === 'failed') {
    return (
      <div className={styles.tool}>
        <div className={cx(styles.toolLine, styles.toolLineStatic, styles.toolFailed)} role="status">
          <Icon name="alert" size={15} />
          <span className={styles.toolText}>
            {summary.text}
            {summary.code ? ` ${summary.code}` : ''}
          </span>
          {summary.code === 'APP_CONNECTOR_NOT_CONNECTED' ? <Link to="/settings/connections">{ru.chat.connectInSettings}</Link> : null}
        </div>
      </div>
    );
  }
  const table = toolTableResultSchema.safeParse(summary.value);
  return (
    <div className={styles.tool}>
      <button type="button" className={styles.toolLine} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="check" size={15} />
        <span className={styles.toolText}>{summary.text}</span>
        {summary.readOnly ? <span className={styles.toolTag}>{ru.chat.readOnly}</span> : null}
        {summary.count !== null ? <span className={styles.toolCount}>{ru.chat.found(summary.count)}</span> : null}
        <Icon name="down" size={15} className={cx(styles.toolChevron, open && styles.toolChevronOpen)} />
      </button>
      <Collapse open={open} className={styles.toolUnfold}>
        <ToolDetails args={parameters} value={summary.value} />
      </Collapse>
      {table.success ? <TableBlockView block={table.data.table} /> : null}
    </div>
  );
}
