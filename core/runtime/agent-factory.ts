// Builds the Mastra agent of an agent runtime. Later steps add memory, prompt layers,
// approvals journal and the sandbox to the same place.
import { Agent } from '@mastra/core/agent';
import type { InputProcessorOrWorkflow, OutputProcessorOrWorkflow } from '@mastra/core/processors';
import { Workspace } from '@mastra/core/workspace';
import type { Memory } from '@mastra/memory';
import type { ConnectionManager } from '../connections/manager.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import type { AgentRuntime } from '../loader/registry.ts';
import { createAgentWorkspace, createViewImageTool, type SandboxDeps, VIEW_IMAGE_TOOL } from '../sandbox/workspace.ts';
import type { ModelGateway } from '../models/gateway.ts';
import { REQUEST_KEYS, requireContextValue } from './request-keys.ts';

export interface AgentFactoryDeps {
  gateway: Pick<ModelGateway, 'modelConfig'>;
  memory?: Memory;
  connections?: Pick<ConnectionManager, 'toolsFor'>;
  // Files and commands of the employee's own folder; without it the agent only reads skills.
  sandbox?: { deps: SandboxDeps; isolation: 'bwrap' | 'seatbelt' };
  // Per agent, because some layers depend on its passport (e.g. baseRules: false).
  processorsFor(rt: AgentRuntime): { input: InputProcessorOrWorkflow[]; output: OutputProcessorOrWorkflow[] };
}

export function createMastraAgent(rt: AgentRuntime, deps: AgentFactoryDeps): Agent {
  const processors = deps.processorsFor(rt);
  const staticTools: Record<string, AnyTool> = { ...rt.tools };
  if (deps.sandbox) staticTools[VIEW_IMAGE_TOOL] = createViewImageTool(deps.sandbox.deps.workspaceRoot);
  const workspace = deps.sandbox
    ? createAgentWorkspace(rt, deps.sandbox.deps, deps.sandbox.isolation)
    : rt.skillDirs.length > 0
      ? new Workspace({ skills: rt.skillDirs })
      : undefined;
  const subagents = Object.fromEntries(rt.subagents.map((s) => [s.passport.id, createMastraAgent(s, deps)]));
  return new Agent({
    id: rt.passport.id,
    name: rt.passport.name,
    description: rt.passport.description,
    instructions: rt.instructions,
    // Each call runs on the employee's own LiteLLM key; the model is the passport's unless the
    // admin chose another one allowed by the passport (set by the entry point of the run).
    model: async ({ requestContext }) => {
      const chosen = requestContext.get(REQUEST_KEYS.modelId);
      const modelId = typeof chosen === 'string' && chosen ? chosen : rt.passport.model;
      return deps.gateway.modelConfig(modelId, requireContextValue(requestContext, REQUEST_KEYS.userId), rt.passport.id);
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
    ...(workspace ? { workspace } : {}),
    ...(rt.subagents.length > 0 ? { agents: subagents } : {}),
    inputProcessors: processors.input,
    outputProcessors: processors.output,
  });
}
