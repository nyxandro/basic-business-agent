// The line of a tool call (spec, section 7; mockup): «Ищу в «Битрикс24»…» while it runs; then
// «✓ Битрикс24 · поиск сделок [только чтение] 12 найдено ⌄» that unfolds what was asked and found;
// a refusal or a failure in plain words. A table from the result is drawn as is.
import { toolTableResultSchema, type AgentSummary } from '@bba/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { TableBlockView } from '../genui/TableBlock.tsx';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import styles from './chat.module.css';
import { systemOf } from './systems.ts';
import { parseToolResult } from './tool-result.ts';

export interface ToolRowProps {
  name: string;
  status: 'inProgress' | 'executing' | 'complete';
  parameters?: unknown;
  result?: string;
  agent: Pick<AgentSummary, 'systems' | 'actions'>;
}

const SUBAGENT_CALL = 'agent-';

// How many things a result holds, when it is a list or a table: «12 найдено».
function countOf(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  const table = toolTableResultSchema.safeParse(value);
  if (table.success) return table.data.table.rows.length;
  if (value && typeof value === 'object') {
    const lists = Object.values(value).filter(Array.isArray);
    if (lists.length === 1) return (lists[0] as unknown[]).length;
  }
  return null;
}

export function ToolRow({ name, status, parameters, result, agent }: ToolRowProps) {
  const [open, setOpen] = useState(false);
  const system = systemOf(agent.systems, name);
  const action = agent.actions[name];
  const what = [system, action?.title ?? name].filter(Boolean).join(' · ');

  if (status !== 'complete') {
    return (
      <div className={styles.tool}>
        <div className={cx(styles.toolLine, styles.toolLineStatic)} role="status">
          <span className={styles.spin} />
          <span className={cx(styles.toolText, styles.shimmer)}>{system ? ru.chat.toolRunningIn(system) : ru.chat.toolRunning}</span>
        </div>
      </div>
    );
  }
  const outcome = parseToolResult(result);
  if (outcome.kind === 'declined') {
    return (
      <div className={styles.tool}>
        <div className={cx(styles.toolLine, styles.toolLineStatic)}>
          <Icon name="x" size={15} />
          <span className={styles.toolText}>{outcome.superseded ? ru.chat.supersededAction : ru.chat.declinedAction}</span>
        </div>
      </div>
    );
  }
  if (outcome.kind === 'failed') {
    return (
      <div className={styles.tool}>
        <div className={cx(styles.toolLine, styles.toolLineStatic, styles.toolFailed)} role="status">
          <Icon name="alert" size={15} />
          <span className={styles.toolText}>
            {ru.chat.toolFailed(system ?? action?.title ?? name)}
            {outcome.code ? ` ${outcome.code}` : ''}
          </span>
          {outcome.code === 'APP_CONNECTOR_NOT_CONNECTED' ? <Link to="/settings/connections">{ru.chat.connectInSettings}</Link> : null}
        </div>
      </div>
    );
  }
  const table = toolTableResultSchema.safeParse(outcome.value);
  // A call of a sub-agent (Mastra names it agent-<id>) returns its answer, not found things.
  const count = name.startsWith(SUBAGENT_CALL) ? null : countOf(outcome.value);
  return (
    <div className={styles.tool}>
      <button type="button" className={styles.toolLine} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="check" size={15} />
        <span className={styles.toolText}>{what}</span>
        {action?.readOnly ? <span className={styles.toolTag}>{ru.chat.readOnly}</span> : null}
        {count !== null ? <span className={styles.toolCount}>{ru.chat.found(count)}</span> : null}
        <Icon name={open ? 'up' : 'down'} size={15} />
      </button>
      {open ? <pre className={styles.toolDetails}>{JSON.stringify({ args: parameters, result: outcome.value }, null, 2)}</pre> : null}
      {table.success ? <TableBlockView block={table.data.table} /> : null}
    </div>
  );
}
