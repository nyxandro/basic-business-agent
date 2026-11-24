// The files a stored message showed the person — attached to it, or shown by the agent with «Скачать» (spec,
// sections 8.28 and 8.33): the agent reading an old conversation takes them by their path, and the lists of
// conversations say how many files each one brought.
import { GENUI_TOOL, splitAttachments } from '@bba/contracts';
import type { Db } from '../db/pool.ts';

// The word of the block of attachments (contracts/src/chat.ts, withAttachments): stored JSON escapes the
// line breaks around it, so the database looks for the word alone.
const ATTACHMENTS_WORD = 'Вложения:';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// The parts of a message stored by Mastra (format 2); anything else has none.
function partsOf(content: string): unknown[] {
  if (!content.startsWith('{')) return [];
  try {
    const parsed: unknown = JSON.parse(content);
    return isObject(parsed) && Array.isArray(parsed.parts) ? parsed.parts : [];
  } catch {
    return [];
  }
}

export function shownFilesOf(message: { role: 'user' | 'assistant'; content: string }): { name: string; path: string }[] {
  const files: { name: string; path: string }[] = [];
  for (const part of partsOf(message.content)) {
    if (!isObject(part)) continue;
    if (part.type === 'text' && message.role === 'user' && typeof part.text === 'string') files.push(...splitAttachments(part.text).files);
    if (part.type !== 'tool-invocation' || !isObject(part.toolInvocation) || part.toolInvocation.toolName !== GENUI_TOOL.file) continue;
    const result = part.toolInvocation.result;
    if (isObject(result) && result.shown === true && typeof result.path === 'string' && result.path !== '') {
      files.push({ name: typeof result.name === 'string' && result.name !== '' ? result.name : (result.path.split('/').pop() ?? result.path), path: result.path });
    }
  }
  return files;
}

// How many files each of the person's conversations `threadIds` brought, each path once; a conversation of someone
// else counts nothing. Only messages that can hold a file are read: the person's with the block of attachments
// and those with a call of show_file.
export async function fileCountsOf(db: Db, userId: string, threadIds: readonly string[]): Promise<Map<string, number>> {
  const paths = new Map<string, Set<string>>(threadIds.map((id) => [id, new Set<string>()]));
  if (threadIds.length === 0) return new Map();
  const { rows } = await db.query<{ thread_id: string; role: string; content: string }>(
    `SELECT m.thread_id, m.role, m.content FROM mastra.mastra_messages m JOIN mastra.mastra_threads t ON t.id = m.thread_id
      WHERE m.thread_id = ANY($1) AND t."resourceId" = $2
        AND (position($3 in m.content) > 0 OR (m.role = 'user' AND position($4 in m.content) > 0))`,
    [threadIds, userId, GENUI_TOOL.file, ATTACHMENTS_WORD],
  );
  for (const r of rows) {
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    for (const f of shownFilesOf({ role: r.role, content: r.content })) paths.get(r.thread_id)?.add(f.path);
  }
  return new Map([...paths].map(([id, set]) => [id, set.size]));
}
