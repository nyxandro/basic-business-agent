// What the agent knows of past conversations before it asks (spec, section 8.28; the owner's decision 18.11):
// the names of the person's last conversations in the project, in the project's layer of the prompt — light
// pointers, the content it reads with the tool —, and in a long conversation which of its first messages the
// model no longer sees (Mastra gives it only the last LAST_MESSAGES).
import { dayOf } from './read.ts';
import { refOf, type ConversationRow } from './store.ts';

export const PROMPT_CONVERSATIONS = 20;

export function pastConversationsText(list: { rows: ConversationRow[]; total: number }, opts: { currentAgentId: string; agentName: (id: string) => string; timezone: string }): string | null {
  if (list.rows.length === 0) return null;
  const lines = list.rows.map((c) => {
    const other = c.agentId === opts.currentAgentId ? '' : ` · с агентом «${opts.agentName(c.agentId)}»`;
    const background = c.kind === 'background' ? ' · фоновая задача' : '';
    return `- [${refOf(c.id)}] ${c.title} — ${dayOf(c.last, opts.timezone)}${other}${background}`;
  });
  const more = list.total - list.rows.length;
  return [
    '## Твои прошлые разговоры в этом проекте',
    'Только разговоры этого сотрудника; разговоры коллег тебе недоступны. Найти и прочитать — инструментом conversations.',
    ...lines,
    ...(more > 0 ? [`- и ещё ${more} — conversations, list`] : []),
  ].join('\n');
}

// Added to the person's last message in the request (with the time), not to the system prompt: the number
// grows every turn, and a system prompt that changes is computed anew by the provider every time.
export function hiddenMessagesNote(stored: number, window: number): string | null {
  const hidden = stored - window;
  if (hidden <= 0) return null;
  return `Сообщения ${hidden === 1 ? '1' : `1–${hidden}`} этого разговора тебе не видны; если нужно — conversations, read, conversation: "current".`;
}

const HIDDEN_NOTE_KEY = 'bba.hiddenMessagesNote';

interface ContextStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

// Counted once at the start of a run (the prompt layers), added to every request of the run.
export function keepHiddenNote(ctx: ContextStore, note: string | null): void {
  ctx.set(HIDDEN_NOTE_KEY, note);
}

export function hiddenNoteOf(ctx: Pick<ContextStore, 'get'> | undefined): string | null {
  const note = ctx?.get(HIDDEN_NOTE_KEY);
  return typeof note === 'string' && note !== '' ? note : null;
}
