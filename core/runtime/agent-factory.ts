// Builds the Mastra agent of an agent runtime: model on the employee's key, tools of plugins and
// connected systems, interface blocks, memory, the sandbox and sub-agents.
import { GENUI_TOOL } from '@bba/contracts';
import { Agent, type ModelWithRetries } from '@mastra/core/agent';
import type { ErrorProcessor, InputProcessorOrWorkflow, OutputProcessorOrWorkflow } from '@mastra/core/processors';
import { Workspace } from '@mastra/core/workspace';
import type { Memory } from '@mastra/memory';
import type { ConnectionManager } from '../connections/manager.ts';
import { createGenuiTools } from '../genui/tools.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import type { AgentRuntime } from '../loader/registry.ts';
import { createShowFileTool } from '../sandbox/show-file.ts';
import { createAgentWorkspace, createViewImageTool, type SandboxDeps, VIEW_IMAGE_TOOL } from '../sandbox/workspace.ts';
import type { ModelGateway } from '../models/gateway.ts';
import { logEvent } from '../server/log.ts';
import { optionalContextValue, REQUEST_KEYS, requireContextValue, skillPathsOf } from './request-keys.ts';
import { createStreamRetry, dropShownWords, isGatewayStreamFailure } from './stream-retry.ts';

// With a fallback model set, a primary that sends nothing for this long gives way to it (spec, 8.1).
// Only the first chunk is timed: a total deadline would end the run instead of switching.
export const FALLBACK_FIRST_CHUNK_MS = 60_000;

// One call of the model, its answer read to the end, takes no longer (decision of the owner, 15.11):
// a model that went silent without closing the connection would otherwise hold the answer forever.
export const MODEL_CALL_MAX_MS = 5 * 60_000;

// The agent works until it answers (decision of the owner 15.11): without a stop condition of its
// own Mastra ends an answer after 5 calls of the model, in silence when the last one was a tool call.
// The loop ends when the model answers without calling a tool; what stops a run that goes on too long
// are the spending limits, the limit of one model call and «Стоп».
const UNTIL_THE_ANSWER = () => false;

// Mastra repeats a call that failed with a transient error once before it tries the fallback.
// LiteLLM has already tried the primary's other keys or accounts by then, so with a fallback the
// repeat only delays the switch; without one the repeat stays. A stream that broke after the first
// words is repeated once in both cases (core/runtime/stream-retry.ts).
const RETRY_AS_MASTRA = createStreamRetry({ mastraRetries: true });
const SWITCH_AT_ONCE = createStreamRetry({ mastraRetries: false });

// Mastra has no event of the switch itself; the failure of the primary that causes it reaches the
// error processors first. Only the first failure of a request is the primary's. A failure the
// gateway reports inside the stream never switches (Mastra ends the answer with it, a broken stream
// is asked again on the primary). Words the primary already showed are dropped: the fallback answers
// in a message of its own.
const FALLBACK_SWITCH: ErrorProcessor = {
  id: 'bba-model-fallback-switch',
  processAPIError(args) {
    const { error, requestContext, state } = args;
    if (state.logged || isGatewayStreamFailure(error)) return;
    state.logged = true;
    dropShownWords(args);
    logEvent('warn', 'model_fallback_used', {
      agentId: optionalContextValue(requestContext, REQUEST_KEYS.agentId),
      primary: optionalContextValue(requestContext, REQUEST_KEYS.modelId),
      fallback: optionalContextValue(requestContext, REQUEST_KEYS.fallbackModelId),
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
  },
};

export interface AgentFactoryDeps {
  gateway: Pick<ModelGateway, 'modelConfig'>;
  // FALLBACK_FIRST_CHUNK_MS in an installation; tests shorten it.
  firstChunkMs: number;
  // MODEL_CALL_MAX_MS in an installation; tests shorten it.
  stepMs: number;
  memory?: Memory;
  connections?: Pick<ConnectionManager, 'toolsFor'>;
  // Files and commands of the employee's own folder; without it the agent only reads skills.
  sandbox?: { deps: SandboxDeps; isolation: 'bwrap' | 'seatbelt' };
  // Per agent, because some layers depend on its passport (e.g. baseRules: false) and some only
  // belong to the agent the person talks to (a sub-agent's chunks also pass through its parent).
  processorsFor(rt: AgentRuntime, level: 'top' | 'sub'): { input: InputProcessorOrWorkflow[]; output: OutputProcessorOrWorkflow[] };
}

export function createMastraAgent(rt: AgentRuntime, deps: AgentFactoryDeps): Agent {
  return buildAgent(rt, deps, 'top');
}

// Interface blocks are given only to the agent the person talks to: what a sub-agent "shows"
// would reach its parent agent, not the screen.
function buildAgent(rt: AgentRuntime, deps: AgentFactoryDeps, level: 'top' | 'sub'): Agent {
  const processors = deps.processorsFor(rt, level);
  const staticTools: Record<string, AnyTool> = { ...rt.tools, ...(level === 'top' ? createGenuiTools() : {}) };
  if (deps.sandbox) staticTools[VIEW_IMAGE_TOOL] = createViewImageTool(deps.sandbox.deps.workspaceRoot);
  // The file block, like the other blocks, only for the agent the person talks to (spec, section 8.18).
  if (deps.sandbox && level === 'top') staticTools[GENUI_TOOL.file] = createShowFileTool(deps.sandbox.deps.workspaceRoot);
  // Skills are the employee's own set for the run (core/skills-admin/runtime.ts).
  const workspace = deps.sandbox ? createAgentWorkspace(deps.sandbox.deps, deps.sandbox.isolation) : new Workspace({ skills: ({ requestContext }) => skillPathsOf(requestContext) });
  const subagents = Object.fromEntries(rt.subagents.map((s) => [s.passport.id, buildAgent(s, deps, 'sub')]));
  return new Agent({
    id: rt.passport.id,
    name: rt.passport.name,
    description: rt.passport.description,
    instructions: rt.instructions,
    // Each call runs on the employee's own LiteLLM key, on the models the entry point of the run
    // chose (core/models/resolve.ts).
    model: async ({ requestContext }): Promise<Awaited<ReturnType<ModelGateway['modelConfig']>> | ModelWithRetries[]> => {
      const userId = requireContextValue(requestContext, REQUEST_KEYS.userId);
      const primaryId = requireContextValue(requestContext, REQUEST_KEYS.modelId);
      const fallbackId = optionalContextValue(requestContext, REQUEST_KEYS.fallbackModelId);
      const primary = await deps.gateway.modelConfig(primaryId, userId, rt.passport.id);
      if (!fallbackId) return primary;
      // LiteLLM already retries within a model's pool, so Mastra does not retry a model itself.
      return [
        { id: primaryId, model: primary, maxRetries: 0, modelSettings: { timeout: { firstChunkMs: deps.firstChunkMs } } },
        { id: fallbackId, model: await deps.gateway.modelConfig(fallbackId, userId, rt.passport.id), maxRetries: 0 },
      ];
    },
    // Tools of connected systems are built per employee and request (their personal access).
    tools:
      rt.connectorIds.length > 0 && deps.connections
        ? async ({ requestContext }) => ({
            ...staticTools,
            ...(await deps.connections!.toolsFor(requireContextValue(requestContext, REQUEST_KEYS.userId), rt.connectorIds)),
          })
        : staticTools,
    ...(deps.memory ? { memory: deps.memory } : {}),
    // Every entry point (chat, background tasks, sub-agents) gets the limit; with a fallback model a
    // primary over it gives way to the fallback (Mastra).
    defaultOptions: { modelSettings: { timeout: { stepMs: deps.stepMs } }, stopWhen: UNTIL_THE_ANSWER },
    workspace,
    ...(rt.subagents.length > 0 ? { agents: subagents } : {}),
    inputProcessors: processors.input,
    outputProcessors: processors.output,
    errorProcessors: ({ requestContext }) => (optionalContextValue(requestContext, REQUEST_KEYS.fallbackModelId) ? [FALLBACK_SWITCH, SWITCH_AT_ONCE] : [RETRY_AS_MASTRA]),
  });
}
