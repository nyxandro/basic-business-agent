// Keys our run entry points (chat, background task, draft check) put into Mastra's request context.
// Processors and tools read who runs, in which conversation and for which agent from here.
export const REQUEST_KEYS = {
  userId: 'bba.userId',
  threadId: 'bba.threadId',
  agentId: 'bba.agentId',
  // The models chosen by core/models/resolve.ts for this run: the fallback answers when the
  // primary fails or stays silent.
  modelId: 'bba.modelId',
  fallbackModelId: 'bba.fallbackModelId',
  runKind: 'bba.runKind',
  taskId: 'bba.taskId',
  // Project of the conversation, when it is in one: the sandbox then works in the project's files,
  // which live with the project's creator — another person when the project is shared (spec, 8.20).
  projectId: 'bba.projectId',
  projectOwnerId: 'bba.projectOwnerId',
  // JSON { name, reason }: the conversation's project is closed to the person, archived or removed.
  lostProject: 'bba.lostProject',
  // The id of the snapshot of the project's files taken before this answer (core/projects/trash.ts).
  projectSnapshot: 'bba.projectSnapshot',
  // Folders of the skills the employee gets (core/skills-admin/runtime.ts), JSON: fixed for the run,
  // so a skill replaced meanwhile does not change under a running answer.
  skillPaths: 'bba.skillPaths',
  // JSON { web, commands, widgets }: what the agent the person talks to may do (spec, sections 8.30, 8.31), read once at the
  // start of the run; its sub-agents work with the same (core/abilities/abilities.ts).
  abilities: 'bba.abilities',
  // Chat runs only: a function told the id of a message whose words the person already saw when the
  // model call broke and was asked again, so the chat takes them off the screen (spec, 9.1).
  messageDiscarded: 'bba.messageDiscarded',
  // Chat runs only: a function told each step of the researcher of the internet, for the live block of its
  // search in the chat (spec, section 8.30).
  webProgress: 'bba.webProgress',
  // The widgets the agent showed in this answer (core/widgets/tools.ts): a later call may change one in place. Put
  // before the first model call of a request by core/widgets/history.ts — with the screens shown before a pause on
  // «Да» or the browser — or by `render_ui` itself when it runs before any (core/widgets/answer-screens.ts).
  widgetScreens: 'bba.widgetScreens',
} as const;

export type RunKind = 'chat' | 'background' | 'draft';

interface ContextReader {
  get(key: string): unknown;
}

export function optionalContextValue(ctx: ContextReader | undefined, key: string): string | null {
  const value = ctx?.get(key);
  return typeof value === 'string' && value !== '' ? value : null;
}

export function skillPathsOf(ctx: ContextReader | undefined): string[] {
  return JSON.parse(requireContextValue(ctx, REQUEST_KEYS.skillPaths)) as string[];
}

export function requireContextValue(ctx: ContextReader | undefined, key: string): string {
  const value = ctx?.get(key);
  if (typeof value !== 'string' || value === '') throw new Error(`request context has no "${key}": the run was started outside a core entry point`);
  return value;
}
