// Keys our run entry points (chat, background task, draft check) put into Mastra's request context.
// Processors and tools read who runs, in which conversation and for which agent from here.
export const REQUEST_KEYS = {
  userId: 'bba.userId',
  threadId: 'bba.threadId',
  agentId: 'bba.agentId',
  modelId: 'bba.modelId',
  runKind: 'bba.runKind',
  taskId: 'bba.taskId',
  // Project of the conversation, when it is in one: the sandbox then works in the project's files.
  projectId: 'bba.projectId',
} as const;

export type RunKind = 'chat' | 'background' | 'draft';

interface ContextReader {
  get(key: string): unknown;
}

export function optionalContextValue(ctx: ContextReader | undefined, key: string): string | null {
  const value = ctx?.get(key);
  return typeof value === 'string' && value !== '' ? value : null;
}

export function requireContextValue(ctx: ContextReader | undefined, key: string): string {
  const value = ctx?.get(key);
  if (typeof value !== 'string' || value === '') throw new Error(`request context has no "${key}": the run was started outside a core entry point`);
  return value;
}
