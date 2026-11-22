// The copy of a conversation in a complaint (docs/specs/[20.11.2026]-feedback-and-value.md, step 2): what the person saw
// of each message — the words, the blocks, the files, the outcomes of «Да» (core/history/transcript.ts), nothing of the
// service — and the files of the conversation copied up to 50 MB a complaint. The copy does not depend on what is done
// with the conversation later: removing it or its files leaves the ticket whole.
import type { SupportSnapshotMessage } from '@bba/contracts';
import { isAppError } from '../errors/app-error.ts';
import type { StoredMessage } from '../history/store.ts';
import { isServiceTurn } from '../chat/service-turns.ts';
import { shownFilesOf, visibleOf, type ApprovalOutcome } from '../history/transcript.ts';
import { readFileInside } from '../workspace/layout.ts';

export const SUPPORT_FILES_MAX_BYTES = 50 * 1024 * 1024;
const TURN_TAIL_MS = 60_000;

export interface Snapshot {
  messages: SupportSnapshotMessage[];
  // How many messages of the person the conversation has: the turns a complaint may be about.
  turns: number;
  // When the turn starts and when the next one does (null — the last turn): the models it used are found by it.
  span: (turn: number) => { from: Date; to: Date } | null;
}

export function snapshotOf(messages: readonly StoredMessage[], approvals: ReadonlyMap<string, ApprovalOutcome>): Snapshot {
  const out: SupportSnapshotMessage[] = [];
  const starts: Date[] = [];
  let turn = 0;
  let last: Date | null = null;
  const ends: (Date | null)[] = [];
  for (const m of messages) {
    const seen = visibleOf(m, approvals);
    // A turn the server started on the person's behalf (core/chat/service-turns.ts) is not counted and not shown: the
    // browser does not count it either.
    if (m.role === 'user' && isServiceTurn(seen.text)) continue;
    if (m.role === 'user') {
      if (turn > 0) ends.push(last);
      turn += 1;
      starts.push(m.createdAt);
    }
    last = m.createdAt;
    if (seen.text === '' && seen.marks.length === 0) continue;
    out.push({ role: m.role, at: m.createdAt.toISOString(), text: seen.text, marks: seen.marks, turn });
  }
  if (turn > 0) ends.push(last);
  return {
    messages: out,
    turns: turn,
    // A turn ends with its last message (a minute later: the spend of a call is written after its words): the models of a
    // conversation used since then, elsewhere, are not this turn's.
    span: (n) => (n >= 1 && n <= starts.length ? { from: starts[n - 1]!, to: new Date((ends[n - 1] ?? starts[n - 1]!).getTime() + TURN_TAIL_MS) } : null),
  };
}

export interface CopiedFile {
  name: string;
  path: string;
  size: number | null;
  state: 'copied' | 'too_large' | 'gone';
  content: Buffer | null;
}

// Every file the conversation showed — attached by the person or shown by the agent — once, by its path; the latest
// name wins.
export function filesOfConversation(messages: readonly StoredMessage[]): { name: string; path: string }[] {
  const byPath = new Map<string, string>();
  for (const m of messages) for (const f of shownFilesOf(m)) byPath.set(f.path, f.name);
  return [...byPath].map(([path, name]) => ({ name, path }));
}

// The files read from the conversation's folder in order, while they fit in the limit; one that does not fit is named
// with its size and the next smaller ones still go. A file removed before the complaint is named so; so is one the agent
// turned into a link out of the folder or a pipe (read from the checked descriptor, never by its path again).
export function copyFiles(folder: string, files: readonly { name: string; path: string }[], limit = SUPPORT_FILES_MAX_BYTES): CopiedFile[] {
  let used = 0;
  return files.map((f) => {
    let read: { size: number; bytes: Buffer | null } | null;
    try {
      read = readFileInside(folder, f.path, limit - used);
    } catch (error) {
      if (!isAppError(error)) throw error;
      read = null;
    }
    if (!read) return { ...f, size: null, state: 'gone', content: null };
    if (!read.bytes) return { ...f, size: read.size, state: 'too_large', content: null };
    used += read.bytes.length;
    return { ...f, size: read.bytes.length, state: 'copied', content: read.bytes };
  });
}
