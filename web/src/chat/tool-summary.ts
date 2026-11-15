// What a line of a tool call says (spec, section 7): the call runs, was refused or cancelled, failed,
// or did its work — with the system, the action, «только чтение» and how many things it found. The
// line itself (ToolRow) and the head of a stack of lines (ToolStack) say the same.
import { toolTableResultSchema, type AgentSummary } from '@bba/contracts';
import { ru } from '../i18n/ru.ts';
import { systemOf } from './systems.ts';
import { parseToolResult } from './tool-result.ts';

export type ToolStatus = 'inProgress' | 'executing' | 'complete';

export type ToolSummary =
  | { state: 'running'; text: string }
  | { state: 'declined'; text: string }
  | { state: 'failed'; text: string; code: string | null }
  | { state: 'done'; text: string; readOnly: boolean; count: number | null; value: unknown };

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

export function toolSummary(name: string, status: ToolStatus, result: string | undefined, agent: Pick<AgentSummary, 'systems' | 'actions'>): ToolSummary {
  const system = systemOf(agent.systems, name);
  const action = agent.actions[name];
  if (status !== 'complete') return { state: 'running', text: system ? ru.chat.toolRunningIn(system) : ru.chat.toolRunning };
  const outcome = parseToolResult(result);
  if (outcome.kind === 'declined') return { state: 'declined', text: outcome.superseded ? ru.chat.supersededAction : ru.chat.declinedAction };
  if (outcome.kind === 'failed') return { state: 'failed', text: ru.chat.toolFailed(system ?? action?.title ?? name), code: outcome.code ?? null };
  return {
    state: 'done',
    text: [system, action?.title ?? name].filter(Boolean).join(' · '),
    readOnly: action?.readOnly === true,
    // A call of a sub-agent (Mastra names it agent-<id>) returns its answer, not found things.
    count: name.startsWith(SUBAGENT_CALL) ? null : countOf(outcome.value),
    value: outcome.value,
  };
}
