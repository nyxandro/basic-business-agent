// Keys our run entry points (chat, background task, draft check) put into Mastra's request context.
// Processors and tools read who runs, in which conversation and for which agent from here.
export const REQUEST_KEYS = {
  userId: 'bba.userId',
  threadId: 'bba.threadId',
  agentId: 'bba.agentId',
  modelId: 'bba.modelId',
  runKind: 'bba.runKind',
  taskId: 'bba.taskId',
} as const;

export type RunKind = 'chat' | 'background' | 'draft';

interface ContextReader {
  get(key: string): unknown;
}

export function requireContextValue(ctx: ContextReader | undefined, key: string): string {
  const value = ctx?.get(key);
  if (typeof value !== 'string' || value === '') throw new Error(`request context has no "${key}": the run was started outside a core entry point`);
  return value;
}
