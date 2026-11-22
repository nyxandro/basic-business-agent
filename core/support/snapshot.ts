// The copy of a conversation in a complaint (docs/specs/[20.11.2026]-feedback-and-value.md, step 2): what the person saw
// of each message — the words, the blocks, the files, the outcomes of «Да» (core/history/transcript.ts), nothing of the
// service — and the files of the conversation copied up to 50 MB a complaint. The copy does not depend on what is done
// with the conversation later: removing it or its files leaves the ticket whole.
import { readFileSync, statSync } from 'node:fs';
import type { SupportSnapshotMessage } from '@bba/contracts';
import { isAppError } from '../errors/app-error.ts';
import type { StoredMessage } from '../history/store.ts';
import { shownFilesOf, visibleOf, type ApprovalOutcome } from '../history/transcript.ts';
import { existingInside } from '../workspace/layout.ts';

export const SUPPORT_FILES_MAX_BYTES = 50 * 1024 * 1024;

export interface Snapshot {
  messages: SupportSnapshotMessage[];
  // How many messages of the person the conversation has: the turns a complaint may be about.
  turns: number;
  // When the turn starts and when the next one does (null — the last turn): the models it used are found by it.
  span: (turn: number) => { from: Date; to: Date | null } | null;
}

export function snapshotOf(messages: readonly StoredMessage[], approvals: ReadonlyMap<string, ApprovalOutcome>): Snapshot {
  const out: SupportSnapshotMessage[] = [];
  const starts: Date[] = [];
  let turn = 0;
  for (const m of messages) {
    if (m.role === 'user') {
      turn += 1;
      starts.push(m.createdAt);
    }
    const seen = visibleOf(m, approvals);
    if (seen.text === '' && seen.marks.length === 0) continue;
    out.push({ role: m.role, at: m.createdAt.toISOString(), text: seen.text, marks: seen.marks, turn });
  }
  return {
    messages: out,
    turns: turn,
    span: (n) => (n >= 1 && n <= starts.length ? { from: starts[n - 1]!, to: starts[n] ?? null } : null),
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
// with its size and the next smaller ones still go. A file removed before the complaint is named so.
export function copyFiles(folder: string, files: readonly { name: string; path: string }[], limit = SUPPORT_FILES_MAX_BYTES): CopiedFile[] {
  let used = 0;
  return files.map((f) => {
    let real: string | null;
    try {
      real = existingInside(folder, f.path);
    } catch (error) {
      // A path out of the folder (a link put there by the agent) is not read.
      if (!isAppError(error)) throw error;
      real = null;
    }
    if (!real) return { ...f, size: null, state: 'gone', content: null };
    const stat = statSync(real);
    if (!stat.isFile()) return { ...f, size: null, state: 'gone', content: null };
    if (used + stat.size > limit) return { ...f, size: stat.size, state: 'too_large', content: null };
    used += stat.size;
    return { ...f, size: stat.size, state: 'copied', content: readFileSync(real) };
  });
}
