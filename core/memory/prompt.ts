// How the memory of a project and of the employee reads in the prompt (spec, section 8.26), and the versions
// of the entries the agent saw there: its tools change an entry only in a version it saw.
import type { MemoryList, SeenVersions } from './entries.ts';

// The versions the agent saw at the start of the turn, then updated by its own calls; set by the prompt layer
// (core/prompts/layers.ts) and read by the memory tools of the same run.
export interface MemorySeen {
  project: SeenVersions | null;
  personal: SeenVersions;
}

const MEMORY_SEEN_KEY = 'bba.memorySeen';

interface ContextStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export function keepMemorySeen(ctx: ContextStore, seen: MemorySeen): void {
  ctx.set(MEMORY_SEEN_KEY, seen);
}

// A run whose prompt carried no memory (none happens in a chat run) saw no entry: every change is a conflict.
export function memorySeenOf(ctx: { get(key: string): unknown } | undefined): MemorySeen {
  const seen = ctx?.get(MEMORY_SEEN_KEY) as MemorySeen | undefined;
  return seen ?? { project: null, personal: new Map() };
}

export function seenVersions(list: MemoryList): SeenVersions {
  return new Map(list.entries.map((e) => [e.number, e.version]));
}

function day(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: timezone }).format(date);
}

const count = (n: number) => new Intl.NumberFormat('ru-RU').format(n);

// In the order of their numbers: the agent finds an entry where it was.
const byNumber = (list: MemoryList) => [...list.entries].sort((a, b) => a.number - b.number);

export function projectMemoryText(list: MemoryList, timezone: string): string {
  const head =
    '## Память проекта\nЗаписи этого проекта; их видят все, кому он открыт. Это подсказка, а не источник: цифры, сроки и реквизиты для документа и точного ответа сверяй с файлами; отвечая по памяти, так и скажи.';
  if (list.entries.length === 0) return '## Память проекта\nПока пусто.';
  const lines = byNumber(list).map((e) => {
    const who = e.author.name ?? 'бывший сотрудник';
    return `- [${e.number}] ${e.text} — ${who} ${e.author.byAgent ? 'через агента' : 'вручную'}, ${day(e.updatedAt, timezone)}`;
  });
  return [head, ...lines, `Занято ${count(list.usedChars)} из ${count(list.maxChars)} знаков.`].join('\n');
}

export function personalMemoryText(list: MemoryList, timezone: string): string {
  const head = '# Что ты помнишь о сотруднике\nЭто видит только сам сотрудник.';
  if (list.entries.length === 0) return `${head}\nПока ничего.`;
  const lines = byNumber(list).map((e) => `- [${e.number}] ${e.text} — ${day(e.updatedAt, timezone)}`);
  return [head, ...lines, `Занято ${count(list.usedChars)} из ${count(list.maxChars)} знаков.`].join('\n');
}
