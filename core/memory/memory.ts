// Personal memory only (spec, section 6 «Память»): Mastra working memory scoped to the employee
// (resource = userId), so all their agents know it; nobody else reads it. Conversations are Mastra
// threads of that employee; a background task has its own thread "bg:<taskId>".
import type { ThreadSummaryDto } from '@bba/contracts';
import { Memory } from '@mastra/memory';
import type { PostgresStore } from '@mastra/pg';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';

export const WORKING_MEMORY_TEMPLATE = `# О сотруднике
- Чем занимается:
- Как с ним удобнее работать:
- Важные договорённости и сроки:
`;
const LAST_MESSAGES = 30;
export const THREAD_TITLE_LENGTH = 60;

// The list of conversations is read by the web interface: the shape lives in contracts.
export type ThreadSummary = ThreadSummaryDto;
export type ThreadKind = ThreadSummaryDto['kind'];

export function createMemory(storage: PostgresStore): Memory {
  return new Memory({
    storage,
    options: {
      lastMessages: LAST_MESSAGES,
      semanticRecall: false,
      generateTitle: false,
      workingMemory: { enabled: true, scope: 'resource', template: WORKING_MEMORY_TEMPLATE },
    },
  });
}

// The admin's draft check writes into a separate memory, never into the admin's own (spec, section 10).
export function draftResourceId(userId: string): string {
  return `draft:${userId}`;
}

export function titleFrom(firstMessage: string): string {
  const line = firstMessage.replace(/\s+/g, ' ').trim();
  return line.length > THREAD_TITLE_LENGTH ? `${line.slice(0, THREAD_TITLE_LENGTH - 1)}…` : line || 'Новый разговор';
}

export async function ensureThread(
  memory: Memory,
  input: { threadId: string; resourceId: string; agentId: string; kind: ThreadKind; title: string },
): Promise<void> {
  const existing = await memory.getThreadById({ threadId: input.threadId });
  if (existing) {
    // Ownership is also enforced by Mastra on every run (step 0, V4); this keeps the error ours.
    if (existing.resourceId !== input.resourceId) throw appError('APP_NOT_FOUND', `thread ${input.threadId} belongs to another resource`, { userMessage: 'Разговор не найден.' });
    return;
  }
  const now = new Date();
  await memory.saveThread({
    thread: { id: input.threadId, resourceId: input.resourceId, title: input.title, metadata: { agentId: input.agentId, kind: input.kind }, createdAt: now, updatedAt: now },
  });
}

// Every conversation is created by ensureThread with its agent: a thread without one is broken data.
function agentOf(thread: { id: string; metadata?: Record<string, unknown> | null }): string {
  const agentId = thread.metadata?.agentId;
  if (typeof agentId !== 'string' || agentId === '') throw new Error(`thread ${thread.id} has no agentId in its metadata`);
  return agentId;
}

// All conversations of the person, of every agent, newest first (ties by id, so pages are stable).
// The project of each conversation is added by core/projects.
export async function listOwnThreads(memory: Memory, userId: string): Promise<Omit<ThreadSummary, 'projectId'>[]> {
  const { threads } = await memory.listThreads({ filter: { resourceId: userId }, perPage: false, orderBy: { field: 'updatedAt', direction: 'DESC' } });
  return threads
    .map((t) => ({
      id: t.id,
      title: t.title ?? 'Без названия',
      kind: (t.metadata?.kind as ThreadKind | undefined) ?? 'chat',
      unread: t.metadata?.unread === true,
      updatedAt: new Date(t.updatedAt).toISOString(),
      agentId: agentOf(t),
    }))
    .sort((a, b) => (a.updatedAt === b.updatedAt ? b.id.localeCompare(a.id) : b.updatedAt.localeCompare(a.updatedAt)));
}

export async function deleteThread(memory: Memory, db: Db, userId: string, threadId: string): Promise<void> {
  const thread = await memory.getThreadById({ threadId });
  if (!thread || thread.resourceId !== userId) throw appError('APP_NOT_FOUND', `thread ${threadId} not found for user`, { userMessage: 'Разговор не найден.' });
  await memory.deleteThread(threadId);
  await db.query('DELETE FROM app.masking_map WHERE thread_id = $1', [threadId]);
  await db.query('DELETE FROM app.thread_projects WHERE thread_id = $1', [threadId]);
}

// The employee's own memory, shown and edited in «Настройки → Моя память».
export async function readMemory(memory: Memory, userId: string): Promise<string> {
  return (await memory.getWorkingMemory({ threadId: `memory-view:${userId}`, resourceId: userId })) ?? '';
}

// Nothing remembered: the memory is blank or still the template the agents fill in.
export function isBlankMemory(text: string): boolean {
  const normalise = (t: string) => t.replace(/\s+/g, ' ').trim();
  return normalise(text) === '' || normalise(text) === normalise(WORKING_MEMORY_TEMPLATE);
}

export async function writeMemory(memory: Memory, userId: string, text: string): Promise<void> {
  await memory.updateWorkingMemory({ threadId: `memory-view:${userId}`, resourceId: userId, workingMemory: text });
}

export async function forgetAll(memory: Memory, userId: string): Promise<void> {
  await writeMemory(memory, userId, WORKING_MEMORY_TEMPLATE);
}
