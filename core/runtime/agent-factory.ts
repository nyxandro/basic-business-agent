// Builds the Mastra agent of an agent runtime. Later steps add memory, prompt layers,
// approvals journal and the sandbox to the same place.
import { Agent } from '@mastra/core/agent';
import type { InputProcessorOrWorkflow, OutputProcessorOrWorkflow } from '@mastra/core/processors';
import { Workspace } from '@mastra/core/workspace';
import type { AgentRuntime } from '../loader/registry.ts';
import type { ModelGateway } from '../models/gateway.ts';
import { REQUEST_KEYS, requireContextValue } from './request-keys.ts';

export interface AgentFactoryDeps {
  gateway: Pick<ModelGateway, 'modelConfig'>;
  // Per agent, because some layers depend on its passport (e.g. baseRules: false).
  processorsFor(rt: AgentRuntime): { input: InputProcessorOrWorkflow[]; output: OutputProcessorOrWorkflow[] };
}

export function createMastraAgent(rt: AgentRuntime, deps: AgentFactoryDeps): Agent {
  const processors = deps.processorsFor(rt);
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
    tools: rt.tools,
    ...(rt.skillDirs.length > 0 ? { workspace: new Workspace({ skills: rt.skillDirs }) } : {}),
    ...(rt.subagents.length > 0 ? { agents: subagents } : {}),
    inputProcessors: processors.input,
    outputProcessors: processors.output,
  });
}
