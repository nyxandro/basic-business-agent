// The project of a conversation and where its files are (spec, sections 8.9 and 8.20): the project's folder — with its
// creator — when the person sees the project, otherwise the person's own. Only the person's own conversation or their
// draft check of a prompt; a conversation not saved yet (a file attached before the first message) is their own.
// The chat's file routes, the copy of a conversation's files in a complaint and a sample take the folder from here.
import { relative } from 'node:path';
import type { Memory } from '@mastra/memory';
import type { Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { draftResourceId } from '../memory/memory.ts';
import { threadProjectState, type ThreadProjectState } from '../projects/access.ts';
import { areaOf, filesPrefix, type Area } from '../storage/areas.ts';
import type { FileStorage } from '../storage/engine.ts';
import { chatPath, chatRoot, conversationRoot, filesRoot, resolveInside } from '../workspace/layout.ts';

export interface ThreadFolders {
  state: ThreadProjectState;
  area: Area;
  // Made on first use, so only while the area is held.
  folder: () => string;
  // A path from the conversation's folder as the path of the area (core/storage).
  inArea: (path: string) => string;
}

export async function threadFoldersOf(deps: { memory: Memory; db: Db; workspaceRoot: string }, userId: string, threadId: string): Promise<ThreadFolders> {
  const thread = await deps.memory.getThreadById({ threadId });
  if (thread && thread.resourceId !== userId && thread.resourceId !== draftResourceId(userId)) {
    throw new AppError({ code: 'APP_NOT_FOUND', message: 'foreign thread', userMessage: 'Разговор не найден.', status: 404 });
  }
  const state = await threadProjectState(deps.db, userId, threadId);
  const area = areaOf(userId, state.state === 'active' ? state.project : null);
  // The project's folder, or the conversation's own (spec, section 8.33).
  const project = state.state === 'active' ? { id: state.project.id, ownerId: state.project.user_id } : null;
  const files = project ? filesRoot(deps.workspaceRoot, project.ownerId, project.id) : chatRoot(deps.workspaceRoot, userId, threadId);
  const inFiles = project ? filesPrefix(area) : `${chatPath(threadId)}/`;
  return {
    state,
    area,
    folder: () => conversationRoot(deps.workspaceRoot, { userId, threadId, project }),
    inArea: (path: string) => `${inFiles}${relative(files, resolveInside(files, path))}`,
  };
}

// The folder is on the disk while `work` runs (an S3 bucket keeps the files, spec section 8.23).
export async function inThreadFolder<T>(storage: Pick<FileStorage, 'hold'>, found: { area: Area; folder: () => string }, how: 'read' | 'write', work: (folder: string) => T | Promise<T>): Promise<T> {
  const release = await storage.hold(found.area, how);
  try {
    return await work(found.folder());
  } finally {
    await release();
  }
}
