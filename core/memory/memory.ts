// Conversations are Mastra threads of the employee (resource = userId); a background task has a thread
// "bg:<taskId>:<userId>" per employee. What the agents remember is not here: the memory of a project and the
// personal memory are entries of core/memory/entries.ts (spec, section 8.26), so Mastra's working memory is
// off — its instruction told the model to store anything in every answer, and its tool was hidden from the chat.
import type { ThreadSummaryDto } from '@bba/contracts';
import { Memory } from '@mastra/memory';
import type { PostgresStore } from '@mastra/pg';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { FIRST_MESSAGE } from './titles.ts';

// How many last stored messages of a conversation Mastra gives the model (one turn of the agent is one message).
export const LAST_MESSAGES = 30;
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
      workingMemory: { enabled: false },
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
  // A conversation of the chat is named after its first message until the model names it (spec, 8.16).
  const metadata = { agentId: input.agentId, kind: input.kind, ...(input.kind === 'chat' ? { titleSource: FIRST_MESSAGE } : {}) };
  await memory.saveThread({ thread: { id: input.threadId, resourceId: input.resourceId, title: input.title, metadata, createdAt: now, updatedAt: now } });
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

// The working memory Mastra kept of the person before 8.26 (`mastra.mastra_resources`), of their conversations
// and of their draft checks of prompts: nothing reads it any more, but it is still the person's memory —
// «Забыть всё» and the removal of the person take it away too. The table is Mastra's: it is there once Mastra's
// storage started.
export async function forgetLegacyWorkingMemory(db: Db, userId: string): Promise<void> {
  const { rows } = await db.query<{ present: boolean }>(`SELECT to_regclass('mastra.mastra_resources') IS NOT NULL AS present`);
  if (rows[0]?.present) await db.query('DELETE FROM mastra.mastra_resources WHERE id = ANY($1)', [[userId, draftResourceId(userId)]]);
}
