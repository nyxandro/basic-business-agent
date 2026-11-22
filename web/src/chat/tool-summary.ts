// What a line of a tool call says (spec, section 7): the call runs, was refused or cancelled, failed,
// or did its work — with the system, the action, «только чтение» and how many things it found. The
// line itself (ToolRow) and the head of a stack of lines (ToolStack) say the same.
import { fileBlockResultSchema, GENUI_TOOL, toolTableResultSchema, WIDGET_TOOL, type AgentSummary } from '@bba/contracts';
import { ru } from '../i18n/ru.ts';
import { drawableOperations } from '../widgets/operations.ts';
import { systemOf } from './systems.ts';
import { parseToolResult, type ToolOutcome } from './tool-result.ts';

// CopilotKit's state of a call, or ours for a call without its result that is not under way (call-progress.ts).
export type ToolStatus = 'inProgress' | 'executing' | 'complete' | 'waiting' | 'stopped';

export type ToolSummary =
  | { state: 'running'; text: string }
  | { state: 'waiting'; text: string }
  | { state: 'declined'; text: string }
  | { state: 'failed'; text: string; code: string | null }
  | { state: 'done'; text: string; readOnly: boolean; count: number | null; value: unknown };

// Why an action did not run: the person said «Нет», wrote a new message instead, or the question burnt unanswered.
function declinedText(outcome: Extract<ToolOutcome, { kind: 'declined' }>): string {
  if (outcome.expiredHours !== null) return ru.chat.expiredAction(outcome.expiredHours);
  return outcome.superseded ? ru.chat.supersededAction : ru.chat.declinedAction;
}

const SUBAGENT_CALL = 'agent-';

// The skill tool of Mastra: it gets the name of a skill and gives back its instructions (SKILL.md),
// whose first heading is the name people know (spec, section 8.15; decision of the owner 15.11);
// an unknown name gets Mastra's «Skill "<name>" not found.».
const SKILL_TOOL = 'skill';
const SKILL_NOT_FOUND = /^Skill "(.+?)" not found\./;
const HEADING = /^#\s+(.+)$/m;

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

function skillSummary(status: ToolStatus, result: string | undefined, parameters: unknown): ToolSummary | null {
  if (status !== 'complete') return { state: 'running', text: ru.chat.skillActivating };
  const outcome = parseToolResult(result);
  if (outcome.kind !== 'ok' || typeof outcome.value !== 'string') return null;
  const asked = typeof (parameters as { name?: unknown } | null)?.name === 'string' ? (parameters as { name: string }).name : null;
  const missing = SKILL_NOT_FOUND.exec(outcome.value);
  if (missing) return { state: 'failed', text: ru.chat.skillNotFound(asked ?? missing[1]!), code: null };
  const title = HEADING.exec(outcome.value)?.[1]?.trim() ?? asked;
  return { state: 'done', text: ru.chat.skillActivated(title), readOnly: false, count: null, value: outcome.value };
}

// The memory tools of the agent (spec, section 8.26): the line says what was remembered, changed or removed —
// the text of the entry, or how many when the call made several; the result keeps «было / стало» for the details.
const MEMORY_TOOLS: Record<string, 'project' | 'personal'> = { project_memory: 'project', personal_memory: 'personal' };

interface MemoryResult {
  action: 'add' | 'change' | 'remove';
  text: string;
}

function memorySummary(where: 'project' | 'personal', status: ToolStatus, result: string | undefined): ToolSummary {
  if (status !== 'complete') return { state: 'running', text: ru.chat.memoryRunning };
  const outcome = parseToolResult(result);
  if (outcome.kind === 'declined') return { state: 'declined', text: declinedText(outcome) };
  if (outcome.kind === 'failed') return { state: 'failed', text: ru.chat.memoryFailed(where), code: outcome.code };
  const results = ((outcome.value as { results?: MemoryResult[] } | null)?.results ?? []).filter((r) => typeof r?.text === 'string');
  // A call that ended without our result (the answer broke off in it) remembered nothing the line could name.
  if (results.length === 0) return { state: 'failed', text: ru.chat.memoryFailed(where), code: null };
  const line = { add: ru.chat.memoryAdded, change: ru.chat.memoryChanged, remove: ru.chat.memoryRemoved };
  const actions = new Set(results.map((r) => r.action));
  let text: string;
  if (results.length === 1) text = line[results[0]!.action](where, `«${results[0]!.text}»`);
  else if (actions.size === 1) text = line[results[0]!.action](where, ru.chat.memoryEntries(results.length));
  else text = ru.chat.memoryUpdated(where, results.length);
  return { state: 'done', text, readOnly: false, count: null, value: outcome.value };
}

// The agent's tool of past conversations (spec, section 8.28): the line says what it looked at — the list, a
// search and how many it found, the conversation it read; or which file it took into its folder (8.33).
const CONVERSATIONS_TOOL = 'conversations';

interface ConversationsAsked {
  mode?: unknown;
  query?: unknown;
  conversation?: unknown;
  file?: unknown;
}

interface ConversationsResult {
  total?: unknown;
  conversations?: unknown;
  title?: unknown;
  name?: unknown;
}

function conversationsSummary(status: ToolStatus, result: string | undefined, parameters: unknown): ToolSummary {
  const asked = (parameters ?? {}) as ConversationsAsked;
  const taking = asked.mode === 'take';
  if (status !== 'complete') return { state: 'running', text: taking ? ru.chat.conversationFileTaking : ru.chat.conversationsRunning };
  const outcome = parseToolResult(result);
  if (outcome.kind === 'declined') return { state: 'declined', text: declinedText(outcome) };
  const failedText = taking ? ru.chat.conversationFileFailed : ru.chat.conversationsFailed;
  if (outcome.kind === 'failed') return { state: 'failed', text: failedText, code: outcome.code };
  const value = (typeof outcome.value === 'object' && outcome.value !== null ? outcome.value : null) as ConversationsResult | null;
  // A call that ended without our result (the answer broke off in it) looked at nothing the line could name.
  if (!value) return { state: 'failed', text: failedText, code: null };
  // The name the person knows it by: the copy may be «… (2)».
  if (taking) return { state: 'done', text: ru.chat.conversationFileTaken(typeof asked.file === 'string' ? asked.file : typeof value.name === 'string' ? value.name : ''), readOnly: false, count: null, value: outcome.value };
  const found = Array.isArray(value.conversations) ? value.conversations.length : 0;
  let text: string;
  if (asked.mode === 'read') text = asked.conversation === 'current' ? ru.chat.conversationReadCurrent : ru.chat.conversationRead(typeof value.title === 'string' ? value.title : '');
  else if (asked.mode === 'search') text = ru.chat.conversationsFound(typeof asked.query === 'string' ? asked.query : '', found);
  else text = ru.chat.conversationsListed(typeof value.total === 'number' ? value.total : found);
  return { state: 'done', text, readOnly: true, count: null, value: outcome.value };
}

// The descriptions of the components of a widget (spec, section 8.31): a step of drawing, said in the person's words.
function widgetComponentsSummary(status: ToolStatus, result: string | undefined, parameters: unknown): ToolSummary {
  if (status !== 'complete') return { state: 'running', text: ru.chat.widgetComponentsLoading };
  const outcome = parseToolResult(result);
  if (outcome.kind === 'failed') return { state: 'failed', text: ru.chat.toolFailed(ru.chat.widgetComponentsLoading.replace('…', '')), code: outcome.code };
  const names = (parameters as { names?: unknown } | null)?.names;
  // A step of drawing, not a reading of the person's data: no «только чтение» (owner 20.11).
  return { state: 'done', text: ru.chat.widgetComponents(Array.isArray(names) ? names.length : 0), readOnly: false, count: null, value: null };
}

// The calls whose result is a block of the answer: under way they are named in the live line, done their line goes into
// the stack like any action and the block comes after it (decision of the owner 21.11) — a refused screen or a file that
// was not there is the line only.
const BLOCKS_UNDER_WAY: Record<string, string> = { [WIDGET_TOOL.render]: ru.chat.widgetDrawing, [GENUI_TOOL.file]: ru.chat.fileShowing };

function shownSummary(name: string, result: string | undefined, parameters: unknown): ToolSummary | null {
  const outcome = parseToolResult(result);
  if (name === WIDGET_TOOL.render) {
    if (outcome.kind === 'failed') return { state: 'failed', text: ru.chat.widgetRefused, code: outcome.code };
    if (outcome.kind !== 'ok') return null;
    // A call that begins with a change of a screen above draws no screen of its own.
    const made = drawableOperations(parameters, '', true).written !== null;
    return { state: 'done', text: made ? ru.chat.widgetMade : ru.chat.widgetChanged, readOnly: false, count: null, value: outcome.value };
  }
  if (outcome.kind === 'declined') return null;
  if (outcome.kind === 'failed') return { state: 'failed', text: ru.chat.fileNotShown, code: outcome.code };
  const file = fileBlockResultSchema.safeParse(outcome.value);
  if (file.success && file.data.shown) return { state: 'done', text: ru.chat.fileShown(file.data.name), readOnly: false, count: null, value: outcome.value };
  return { state: 'failed', text: ru.chat.fileNotShown, code: null };
}

// `parameters` — what the call was asked, for the lines that name it.
export function toolSummary(name: string, status: ToolStatus, result: string | undefined, agent: Pick<AgentSummary, 'systems' | 'actions'>, parameters?: unknown): ToolSummary {
  if (status === 'waiting') return { state: 'waiting', text: ru.chat.toolWaiting };
  if (status === 'stopped') return { state: 'declined', text: ru.chat.toolStopped };
  const block = BLOCKS_UNDER_WAY[name];
  if (block && status !== 'complete') return { state: 'running', text: block };
  const shown = block ? shownSummary(name, result, parameters) : null;
  if (shown) return shown;
  const skill = name === SKILL_TOOL ? skillSummary(status, result, parameters) : null;
  if (skill) return skill;
  const memory = MEMORY_TOOLS[name];
  if (memory) return memorySummary(memory, status, result);
  if (name === CONVERSATIONS_TOOL) return conversationsSummary(status, result, parameters);
  if (name === WIDGET_TOOL.components) return widgetComponentsSummary(status, result, parameters);
  const system = systemOf(agent.systems, name);
  const action = agent.actions[name];
  // Under way: named by its action (owner, 20.11) — «Запись файла…», «Команда в рабочей папке…».
  if (status !== 'complete') return { state: 'running', text: system ? ru.chat.toolRunningIn(system) : action ? ru.chat.toolRunningAction(action.title) : ru.chat.toolRunning };
  const outcome = parseToolResult(result);
  if (outcome.kind === 'declined') return { state: 'declined', text: declinedText(outcome) };
  if (outcome.kind === 'failed') return { state: 'failed', text: ru.chat.toolFailed(system ?? action?.title ?? name), code: outcome.code ?? null };
  // Multi-step approvals: the action went to the approvers — not done yet (docs/specs/[20.11.2026]-multi-step-approvals.md).
  const chain = outcome.value as { status?: unknown; id?: unknown } | null;
  if (chain && (chain.status === 'sent_for_approval' || chain.status === 'already_waiting') && typeof chain.id === 'string') {
    return { state: 'waiting', text: `${[system, action?.title ?? name].filter(Boolean).join(' · ')} — ${chain.status === 'sent_for_approval' ? ru.chains.sentRow(chain.id) : ru.chains.waitingRow(chain.id)}` };
  }
  return {
    state: 'done',
    text: [system, action?.title ?? name].filter(Boolean).join(' · '),
    readOnly: action?.readOnly === true,
    // A call of a sub-agent (Mastra names it agent-<id>) returns its answer, not found things.
    count: name.startsWith(SUBAGENT_CALL) ? null : countOf(outcome.value),
    value: outcome.value,
  };
}
