// CopilotKit runtime under /app/api/copilotkit (spec, section 17.5), built per request:
// the AG-UI agent gets the employee from the session (resource id and request context are set
// by the server, never by the browser) and the published — or, for a draft check, the draft —
// version of the agent from Mastra Editor.
import { MastraAgent } from '@ag-ui/mastra';
import { CopilotRuntime, createCopilotRuntimeHandler } from '@copilotkit/runtime';
import type { AbstractAgent } from '@ag-ui/client';
import { EventType } from '@ag-ui/core';
import { filter, finalize } from 'rxjs';
import { resolveAgent, type EditorDeps } from '../editor/prompts.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { requestContextFor, type PreparedRun } from './run.ts';

export const COPILOT_BASE_PATH = '/app/api/copilotkit';

export type CopilotRequestContext =
  // `onMessageDiscarded` learns the messages whose words a repeated model call dropped (spec, 9.1).
  // `onAgentEnd` is told when the agent itself ends — finished, stopped or failed — which may be well
  // after the browser went away: CopilotKit lets the run go on without it.
  | { kind: 'run'; run: PreparedRun; onMessageDiscarded: (messageId: string) => void; onAgentEnd: () => void }
  // /info and connect: the agents open to the employee, without a conversation-bound context.
  | { kind: 'listing'; userId: string; agentIds: string[]; mode: 'published' | 'draft' };

export interface CopilotHandler {
  handle(request: Request, ctx: CopilotRequestContext): Promise<Response>;
}

// CopilotKit's runtime sends usage events to its servers on every request unless this switch is
// set; it reads the switch at each event. Employees' activity of a closed installation stays
// inside, so the switch is set in code before the runtime exists, not left to deployment settings.
function disableCopilotTelemetry(): void {
  process.env.COPILOTKIT_TELEMETRY_DISABLED = 'true';
}

export function createCopilotHandler(deps: { editor: EditorDeps }): CopilotHandler {
  disableCopilotTelemetry();
  const contexts = new WeakMap<Request, CopilotRequestContext>();

  // A listing never calls a model, so only a run is told about dropped messages.
  async function agentFor(agentId: string, run: PreparedRun, live?: { onMessageDiscarded: (messageId: string) => void; onAgentEnd: () => void }): Promise<AbstractAgent> {
    const agent = await resolveAgent(deps.editor, agentId, run.mode);
    const requestContext = requestContextFor(run);
    const mastraAgent = new MastraAgent({ agent, agentId, resourceId: run.resourceId, requestContext });
    if (!live) return mastraAgent;
    requestContext.set(REQUEST_KEYS.messageDiscarded, live.onMessageDiscarded);
    // A middleware survives the copy of the agent CopilotKit makes for a run; `finalize` fires once
    // the agent's events end — completed, failed or unsubscribed by «Стоп».
    // The «state of the agent» is cut both ways (spec, 8.26): the chat does not use it, and the adapter of
    // Mastra carried the personal memory through it — read past our settings after every run, sent to the
    // browser, and written back from the browser's next run.
    return mastraAgent.use((input, next) => {
      run.agentStarted = true;
      return next
        .run({ ...input, state: {} })
        .pipe(
          filter((event) => event.type !== EventType.STATE_SNAPSHOT && event.type !== EventType.STATE_DELTA),
          finalize(live.onAgentEnd),
        );
    });
  }

  const runtime = new CopilotRuntime({
    agents: async ({ request }) => {
      const ctx = contexts.get(request);
      if (!ctx) throw new Error('CopilotKit request reached the runtime without a server context');
      if (ctx.kind === 'run') return { [ctx.run.agentId]: await agentFor(ctx.run.agentId, ctx.run, { onMessageDiscarded: ctx.onMessageDiscarded, onAgentEnd: ctx.onAgentEnd }) };
      const entries = await Promise.all(
        ctx.agentIds.map(async (id) => [id, await agentFor(id, { agentId: id, userId: ctx.userId, resourceId: ctx.userId, threadId: `listing-${ctx.userId}`, mode: ctx.mode, projectId: null, projectOwnerId: null, lostProject: null, snapshot: null, agentStarted: false, models: null, skillPaths: [], release: null })] as const),
      );
      return Object.fromEntries(entries);
    },
  });
  const handler = createCopilotRuntimeHandler({ runtime, basePath: COPILOT_BASE_PATH, cors: false, activateChannels: false });

  return {
    handle(request, ctx) {
      contexts.set(request, ctx);
      return handler(request);
    },
  };
}
