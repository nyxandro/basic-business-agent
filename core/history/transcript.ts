// What the person saw of a stored message (spec, section 8.28): the words of the person and of the agent, the
// blocks of the interface as lines of text, the files shown, what was written to memory and what came of
// each action that waited for «Да». Everything else — reasoning, commands and files of the sandbox, skills,
// sub-agents, what systems returned — the person did not see, and the agent reading an old conversation
// does not get it either. The rule is a list of what is known: a new block of the interface needs its line
// here (the test fails for one that has none).
import { COMPUTER_TOOLS, GENUI_TOOL, readComputerWriteResult, splitAttachments, tableBlockSchema, WIDGET_TOOL, type TableBlock } from '@bba/contracts';
import { widgetVisibleText } from '../widgets/visible-text.ts';

// How the action of a call ended, from its request for «Да» (app.approval_requests).
export interface ApprovalOutcome {
  status: 'pending' | 'approved' | 'declined' | 'expired' | 'failed';
  errorCode: string | null;
  summary: string;
}

export interface Visible {
  // The words, text parts joined by a line break; the block of attachments goes to the marks.
  text: string;
  // A line per thing shown besides the words: a table (with its rows), a card, a file, an action…
  marks: string[];
}

// Rows of a table read; the person scrolls a big one, the agent gets the start and how many more.
export const TABLE_ROWS_SHOWN = 20;
const SUPERSEDED = 'APP_CHAT_SUPERSEDED';
const TASK_DELETED = 'APP_TASK_DELETED';
const CODE = /\bAPP_[A-Z0-9_]+\b/;

interface Invocation {
  state?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  result?: unknown;
  errorText?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
// A call that failed returns { error: true, message } to the model (Mastra's form for a refused input).
const failed = (result: unknown) => isObject(result) && result.error === true;

function tableLines(table: TableBlock): string[] {
  const head = `таблица${table.title ? ` «${table.title}»` : ''}: ${table.columns.map((c) => c.label).join(' | ')}`;
  const rows = table.rows.slice(0, TABLE_ROWS_SHOWN).map((row) => `  ${table.columns.map((c) => str(row[c.key])).join(' | ')}`);
  const more = table.rows.length - TABLE_ROWS_SHOWN;
  return [head, ...rows, ...(more > 0 ? [`  … ещё ${more} ${more === 1 ? 'строка' : more < 5 ? 'строки' : 'строк'}`] : [])];
}

// The block a tool of the interface drew; null — not a block, or one the person did not see.
function blockLines(name: string, args: Record<string, unknown>, result: unknown): string[] | null {
  switch (name) {
    case GENUI_TOOL.table: {
      const table = tableBlockSchema.safeParse(args);
      return table.success ? tableLines(table.data) : null;
    }
    case GENUI_TOOL.card: {
      const fields = list(args.fields).filter(isObject).map((f) => `${str(f.label)} — ${str(f.value)}`);
      return [`карточка «${str(args.title)}»${args.subtitle ? ` (${str(args.subtitle)})` : ''}${fields.length > 0 ? `: ${fields.join('; ')}` : ''}`];
    }
    case GENUI_TOOL.chart: {
      const series = list(args.series).filter(isObject).map((s) => `${str(s.name)}: ${list(s.values).map(str).join(' · ')}`);
      return [`график${args.title ? ` «${str(args.title)}»` : ''}: ${list(args.labels).map(str).join(' · ')} → ${series.join('; ')}`];
    }
    case GENUI_TOOL.choice:
      return [`вопрос с вариантами: «${str(args.question)}» — ${list(args.options).filter(isObject).map((o) => str(o.label)).join(' / ')}`];
    case GENUI_TOOL.form:
      return [`форма «${str(args.title)}»${list(args.fields).length > 0 ? `: ${list(args.fields).filter(isObject).map((f) => str(f.label)).join(', ')}` : ''}`];
    // A widget (spec, section 8.31): its words, as the search reads them.
    case WIDGET_TOOL.render: {
      const words = widgetVisibleText(args);
      return words ? [`экран: ${words}`] : null;
    }
    case GENUI_TOOL.file: {
      const shown = isObject(result) ? str(result.name) : '';
      return [`файл: ${shown || str(args.path).split('/').pop()}`];
    }
    default:
      return null;
  }
}

// What the line «Запомнил…» in the chat said (spec, section 8.26).
const MEMORY_WHERE: Record<string, string> = { project_memory: 'памяти проекта', personal_memory: 'личной памяти' };
const MEMORY_DONE: Record<string, (where: string) => string> = {
  add: (where) => `записано в ${where === 'памяти проекта' ? 'память проекта' : 'личную память'}`,
  change: (where) => `изменено в ${where}`,
  remove: (where) => `убрано из ${where}`,
};

function memoryLines(where: string, result: unknown): string[] {
  if (!isObject(result)) return [];
  return list(result.results)
    .filter(isObject)
    .filter((r) => typeof r.action === 'string' && MEMORY_DONE[r.action] && typeof r.text === 'string')
    .map((r) => `${MEMORY_DONE[r.action as string]!(where)}: «${r.text as string}»`);
}

// An action that waited for «Да»: the request says what the person decided, the call itself what came of it —
// a request is marked approved before the action runs, and a failure of the action is not written there.
function actionLine(call: Invocation, outcome: ApprovalOutcome): string {
  const { summary } = outcome;
  switch (outcome.status) {
    case 'approved': {
      if (call.state === 'output-error' || failed(call.result)) {
        const code = CODE.exec(str(call.errorText) || JSON.stringify(call.result ?? ''))?.[0];
        return `не выполнено после «Да»: ${summary}${code ? ` (${code})` : ''}`;
      }
      return call.state === 'result' ? `сделано после «Да»: ${summary}` : `после «Да» итог неизвестен: ${summary}`;
    }
    case 'declined':
      if (outcome.errorCode === SUPERSEDED) return `отменено — сотрудник написал новое сообщение: ${summary}`;
      if (outcome.errorCode === TASK_DELETED) return `отменено — фоновую задачу удалили: ${summary}`;
      return `сотрудник отказал: ${summary}`;
    case 'failed':
      return `не выполнено: ${summary}${outcome.errorCode ? ` (${outcome.errorCode})` : ''}`;
    case 'expired':
      return `не подтверждено вовремя: ${summary}`;
    case 'pending':
      return `ждёт «Да»: ${summary}`;
  }
}

// A write onto the person's computer (spec, section 8.25): the browser asked «Да» itself, the result says what came of it.
function computerWriteLines(result: unknown): string[] {
  const parsed = readComputerWriteResult(result);
  if (!parsed) return [];
  if ('declined' in parsed) return ['сотрудник отказался записывать файлы на компьютер'];
  if ('error' in parsed) return [];
  const written = parsed.items.flatMap((i) => (i.written ? [`${i.to}${i.replaced ? ' (заменён прежний файл)' : ''}`] : []));
  const failed = parsed.items.flatMap((i) => (i.written ? [] : [`не записано на компьютер: ${i.to} — ${i.error}`]));
  return [...(written.length > 0 ? [`записано на компьютер в папку «${parsed.folder}»: ${written.join(', ')}`] : []), ...failed];
}

function callLines(call: Invocation, approvals: ReadonlyMap<string, ApprovalOutcome>): string[] {
  const name = str(call.toolName);
  const outcome = approvals.get(str(call.toolCallId));
  if (outcome) return [actionLine(call, outcome)];
  if (name === COMPUTER_TOOLS.write) return call.state === 'result' ? computerWriteLines(call.result) : [];
  // Anything else the person saw only once the call was done, and only if it did not fail.
  if (call.state !== 'result' || failed(call.result)) return [];
  if (MEMORY_WHERE[name]) return memoryLines(MEMORY_WHERE[name], call.result);
  const block = isObject(call.args) ? blockLines(name, call.args, call.result) : null;
  if (block) return block;
  // A tool whose result is a table: the chat draws it under the line of the call.
  const table = isObject(call.result) ? tableBlockSchema.safeParse(call.result.table) : null;
  return table?.success ? tableLines(table.data) : [];
}

function partsOf(content: string): unknown[] {
  if (!content.startsWith('{')) return [];
  try {
    const parsed: unknown = JSON.parse(content);
    return isObject(parsed) ? list(parsed.parts) : [];
  } catch {
    return [];
  }
}

export function visibleOf(message: { role: 'user' | 'assistant'; content: string }, approvals: ReadonlyMap<string, ApprovalOutcome>): Visible {
  const words: string[] = [];
  const marks: string[] = [];
  for (const part of partsOf(message.content)) {
    if (!isObject(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      const { text, files } = message.role === 'user' ? splitAttachments(part.text) : { text: part.text, files: [] };
      if (text.trim() !== '') words.push(text.trim());
      if (files.length > 0) marks.push(`вложения: ${files.map((f) => f.name).join(', ')}`);
    } else if (part.type === 'tool-invocation' && isObject(part.toolInvocation)) {
      marks.push(...callLines(part.toolInvocation, approvals));
    } else if (part.type === 'error') {
      marks.push('ответ прервался');
    }
  }
  return { text: words.join('\n'), marks };
}
