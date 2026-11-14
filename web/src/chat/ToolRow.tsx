// The line of a tool call in the chat (spec, section 7): «Ищу в …» while it runs, a folded line
// with the outcome after it; a table from the result is drawn as is (not retyped by the model).
import { toolTableResultSchema, type AgentSummary } from '@bba/contracts';
import { Link } from 'react-router';
import { TableBlockView } from '../genui/TableBlock.tsx';
import { ru } from '../i18n/ru.ts';
import { systemOf } from './systems.ts';
import { parseToolResult } from './tool-result.ts';

export interface ToolRowProps {
  name: string;
  status: 'inProgress' | 'executing' | 'complete';
  parameters?: unknown;
  result?: string;
  systems: AgentSummary['systems'];
}

export function ToolRow({ name, status, parameters, result, systems }: ToolRowProps) {
  const system = systemOf(systems, name);
  if (status !== 'complete') {
    return <div className="tool-row tool-running">{system ? ru.chat.toolRunningIn(system) : ru.chat.toolRunning}</div>;
  }
  const outcome = parseToolResult(result);
  if (outcome.kind === 'declined') {
    return <div className="tool-row tool-declined">{outcome.superseded ? ru.chat.supersededAction : ru.chat.declinedAction}</div>;
  }
  if (outcome.kind === 'failed') {
    return (
      <div className="tool-row tool-failed" role="status">
        {ru.chat.toolFailed(system ?? name)}
        {outcome.code === 'APP_CONNECTOR_NOT_CONNECTED' ? (
          <>
            {' '}
            <Link to="/settings/connections">{ru.chat.connectInSettings}</Link>
          </>
        ) : null}
        {outcome.code ? <span className="banner-code"> {outcome.code}</span> : null}
      </div>
    );
  }
  const table = toolTableResultSchema.safeParse(outcome.value);
  return (
    <div className="tool-row tool-done">
      <details>
        <summary>{system ? ru.chat.toolDoneIn(system) : ru.chat.toolDone}</summary>
        <pre>{JSON.stringify({ args: parameters, result: outcome.value }, null, 2)}</pre>
      </details>
      {table.success ? <TableBlockView block={table.data.table} /> : null}
    </div>
  );
}
