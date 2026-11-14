// CopilotKit runtime under /app/api/copilotkit (spec, section 17.5), built per request:
// the AG-UI agent gets the employee from the session (resource id and request context are set
// by the server, never by the browser) and the published — or, for a draft check, the draft —
// version of the agent from Mastra Editor.
import { MastraAgent } from '@ag-ui/mastra';
import { CopilotRuntime, createCopilotRuntimeHandler } from '@copilotkit/runtime';
import type { AbstractAgent } from '@ag-ui/client';
import { resolveAgent, type EditorDeps } from '../editor/prompts.ts';
import { requestContextFor, type PreparedRun } from './run.ts';

export const COPILOT_BASE_PATH = '/app/api/copilotkit';

export type CopilotRequestContext =
  | { kind: 'run'; run: PreparedRun }
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

  async function agentFor(agentId: string, run: PreparedRun): Promise<AbstractAgent> {
    const { agent, modelId } = await resolveAgent(deps.editor, agentId, run.mode);
    return new MastraAgent({ agent, agentId, resourceId: run.resourceId, requestContext: requestContextFor(run, modelId) });
  }

  const runtime = new CopilotRuntime({
    agents: async ({ request }) => {
      const ctx = contexts.get(request);
      if (!ctx) throw new Error('CopilotKit request reached the runtime without a server context');
      if (ctx.kind === 'run') return { [ctx.run.agentId]: await agentFor(ctx.run.agentId, ctx.run) };
      const entries = await Promise.all(
        ctx.agentIds.map(async (id) => [id, await agentFor(id, { agentId: id, userId: ctx.userId, resourceId: ctx.userId, threadId: `listing-${ctx.userId}`, mode: ctx.mode })] as const),
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
